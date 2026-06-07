import { readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { parseYamlRequest } from './yaml-parser.js';
import { loadEnvironment, substitute } from './env-loader.js';
import { TestRunner } from './test-runner.js';
import { wrapFetchResponse } from './response-wrapper.js';
import { validateUrl } from './url-validator.js';
import type {
  YamlRequest,
  CollectionRunResult,
  RequestExecutionResult,
  TestResult,
} from './types.js';

interface ExecutionOptions {
  environment?: string;
  collectionRoot?: string;
  requestPath?: string;
}

interface ParsedRequest {
  yaml: YamlRequest;
  filePath: string;
}

interface DiscoveryResult {
  requests: ParsedRequest[];
  parseErrors: number;
}

const EXCLUDED_FILES = new Set([
  'folder.yml',
  'opencollection.yml',
]);

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'environments',
]);

async function findYmlFilesRecursive(dirPath: string, results: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory() && !EXCLUDED_DIRS.has(entry.name)) {
      await findYmlFilesRecursive(fullPath, results);
    } else if (entry.isFile() && entry.name.endsWith('.yml')) {
      if (!EXCLUDED_FILES.has(entry.name.toLowerCase())) {
        results.push(fullPath);
      }
    }
  }
}

async function discoverRequests(dirPath: string): Promise<DiscoveryResult> {
  const ymlFiles: string[] = [];
  await findYmlFilesRecursive(dirPath, ymlFiles);

  const requests: ParsedRequest[] = [];
  let parseErrors = 0;

  for (const filePath of ymlFiles) {
    try {
      const content = await readFile(filePath, 'utf-8');
      const yaml = parseYamlRequest(content);
      requests.push({ yaml, filePath });
    } catch {
      parseErrors++;
    }
  }

  requests.sort((a, b) => {
    const seqA = a.yaml.info.seq ?? Number.MAX_SAFE_INTEGER;
    const seqB = b.yaml.info.seq ?? Number.MAX_SAFE_INTEGER;
    return seqA - seqB;
  });

  return { requests, parseErrors };
}

function buildFetchOptions(
  yaml: YamlRequest,
  vars: Map<string, string>,
): { url: string; options: RequestInit } {
  const url = substitute(yaml.http.url, vars);

  const headers: Record<string, string> = {};
  if (yaml.http.headers) {
    for (const h of yaml.http.headers) {
      headers[h.name] = substitute(h.value, vars);
    }
  }

  const options: RequestInit = {
    method: yaml.http.method,
    headers,
  };

  if (yaml.http.body?.data) {
    options.body = substitute(yaml.http.body.data, vars);
  }

  return { url, options };
}

function getAfterResponseScript(yaml: YamlRequest): string | null {
  if (!yaml.runtime?.scripts) return null;

  const afterScripts = yaml.runtime.scripts
    .filter(s => s.type === 'after-response')
    .map(s => s.code);

  return afterScripts.length > 0 ? afterScripts.join('\n') : null;
}

async function executeSingleRequest(
  yaml: YamlRequest,
  vars: Map<string, string>,
): Promise<RequestExecutionResult> {
  const { url, options } = buildFetchOptions(yaml, vars);
  const name = yaml.info.name;
  const method = yaml.http.method;

  // SSRF protection: validate URL before making the request
  const urlCheck = validateUrl(url);
  if (!urlCheck.valid) {
    return {
      name,
      method,
      url,
      status: 0,
      duration_ms: 0,
      tests: [],
      error: 'SSRF blocked: ' + urlCheck.reason,
    };
  }

  // Apply timeout from YAML settings or default 30s
  // Use ?? instead of || so that timeout: 0 is respected (disables timeout)
  const timeout = yaml.settings?.timeout ?? 30000;
  const fetchOpts = { ...options, redirect: 'manual' as RequestRedirect, signal: AbortSignal.timeout(timeout) };

  const startTime = Date.now();

  const MAX_REDIRECTS = 10;

  try {
    let response = await fetch(url, fetchOpts);
    let currentUrl = url;
    let redirectCount = 0;

    while (response.status >= 300 && response.status < 400 && redirectCount < MAX_REDIRECTS) {
      const location = response.headers.get('location');
      if (!location) break;

      // Resolve relative redirects against current URL
      const redirectUrl = new URL(location, currentUrl).toString();

      // SSRF check on redirect target
      const redirectCheck = validateUrl(redirectUrl);
      if (!redirectCheck.valid) {
        return {
          name,
          method,
          url,
          status: 0,
          duration_ms: Date.now() - startTime,
          tests: [],
          error: `Redirect to ${redirectUrl} blocked: ${redirectCheck.reason}`,
        };
      }

      response = await fetch(redirectUrl, fetchOpts);
      currentUrl = redirectUrl;
      redirectCount++;
    }

    if (redirectCount >= MAX_REDIRECTS) {
      return {
        name,
        method,
        url,
        status: 0,
        duration_ms: Date.now() - startTime,
        tests: [],
        error: `Too many redirects (max ${MAX_REDIRECTS})`,
      };
    }

    const durationMs = Date.now() - startTime;

    const wrappedResponse = await wrapFetchResponse(response, durationMs);

    let tests: TestResult[] = [];
    const testScript = getAfterResponseScript(yaml);
    if (testScript) {
      tests = await TestRunner.runScript(testScript, wrappedResponse);
    }

    return {
      name,
      method,
      url,
      status: response.status,
      duration_ms: durationMs,
      tests,
    };
  } catch (error: unknown) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      name,
      method,
      url,
      status: 0,
      duration_ms: durationMs,
      tests: [],
      error: errorMessage,
    };
  }
}

export class RequestExecutor {
  static async executeCollection(
    collectionPath: string,
    options?: ExecutionOptions,
  ): Promise<CollectionRunResult> {
    const startTime = Date.now();

    let vars = new Map<string, string>();
    if (options?.environment) {
      const envRoot = options.collectionRoot ?? collectionPath;
      vars = await loadEnvironment(envRoot, options.environment);
    }

    let requests: ParsedRequest[];
    let parseErrors = 0;

    if (options?.requestPath) {
      const content = await readFile(options.requestPath, 'utf-8');
      const yaml = parseYamlRequest(content);
      requests = [{ yaml, filePath: options.requestPath }];
    } else {
      const discovery = await discoverRequests(collectionPath);
      requests = discovery.requests;
      parseErrors = discovery.parseErrors;
    }

    const results: RequestExecutionResult[] = [];
    for (const req of requests) {
      const result = await executeSingleRequest(req.yaml, vars);
      results.push(result);
    }

    const totalDuration = Date.now() - startTime;
    const failed = results.filter(
      r => r.error !== undefined || r.tests.some(t => t.status === 'fail'),
    ).length;

    return {
      summary: {
        total: results.length,
        passed: results.length - failed,
        failed,
        duration_ms: totalDuration,
      },
      results,
      parseErrors,
    };
  }
}
