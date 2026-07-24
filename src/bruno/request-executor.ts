import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { parseYamlRequest } from './yaml-parser.js';
import { parseBruRequest } from './bru-parser.js';
import { loadEnvironment, substitute } from './env-loader.js';
import { TestRunner } from './test-runner.js';
import { wrapFetchResponse } from './response-wrapper.js';
import { validateUrl } from './url-validator.js';
import { VariableStore } from './variable-store.js';
import type {
  BruFile,
  YamlRequest,
  CollectionRunResult,
  RequestExecutionResult,
  TestResult,
  MultipartFormPart,
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
  'bruno.json',
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
    } else if (entry.isFile() && (entry.name.endsWith('.yml') || entry.name.endsWith('.bru'))) {
      if (!EXCLUDED_FILES.has(entry.name.toLowerCase())) {
        results.push(fullPath);
      }
    }
  }
}

function bruFileToYamlRequest(bru: BruFile): YamlRequest {
  const scripts: YamlRequest['runtime'] = { scripts: [] };
  if (bru.script?.['pre-request']?.exec) {
    scripts.scripts.push({ type: 'before-request', code: bru.script['pre-request'].exec.join('\n') });
  }
  if (bru.script?.['post-response']?.exec) {
    scripts.scripts.push({ type: 'after-response', code: bru.script['post-response'].exec.join('\n') });
  }
  if (bru.tests?.exec) {
    scripts.scripts.push({ type: 'after-response', code: bru.tests.exec.join('\n') });
  }

  const headers = bru.headers
    ? Object.entries(bru.headers).map(([name, value]) => ({ name, value }))
    : undefined;

  let body: YamlRequest['http']['body'];
  if (bru.body?.formData && bru.body.formData.length > 0) {
    body = {
      type: 'multipart-form',
      data: bru.body.formData.map((part): MultipartFormPart => {
        const item: MultipartFormPart = {
          name: part.name,
          value: part.value,
          type: part.type ?? 'text',
        };
        if (part.contentType) item.contentType = part.contentType;
        return item;
      }),
    };
  } else if (bru.body?.content) {
    body = { type: bru.body.type, data: bru.body.content };
  }

  return {
    info: { name: bru.meta.name, type: bru.meta.type, seq: bru.meta.seq },
    http: { method: bru.http.method, url: bru.http.url, headers, body },
    runtime: scripts.scripts.length > 0 ? scripts : undefined,
    docs: bru.docs,
  };
}

async function discoverRequests(dirPath: string): Promise<DiscoveryResult> {
  const requestFiles: string[] = [];
  await findYmlFilesRecursive(dirPath, requestFiles);

  const requests: ParsedRequest[] = [];
  let parseErrors = 0;

  for (const filePath of requestFiles) {
    try {
      const content = await readFile(filePath, 'utf-8');
      let yaml: YamlRequest;
      if (filePath.endsWith('.yml')) {
        yaml = parseYamlRequest(content);
      } else if (filePath.endsWith('.bru')) {
        yaml = bruFileToYamlRequest(parseBruRequest(content));
      } else {
        continue;
      }
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

function isMultipartBody(body: YamlRequest['http']['body']): boolean {
  return (
    !!body &&
    (body.type === 'multipart-form' || body.type === 'form-data') &&
    Array.isArray(body.data)
  );
}

export async function buildFetchOptions(
  yaml: YamlRequest,
  vars: Map<string, string>,
): Promise<{ url: string; options: RequestInit }> {
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

  const body = yaml.http.body;
  if (isMultipartBody(body)) {
    const form = new FormData();
    const parts = body!.data as MultipartFormPart[];

    for (const part of parts) {
      const contentType = part.contentType
        ? substitute(part.contentType, vars)
        : undefined;

      if (part.type === 'file') {
        const paths = Array.isArray(part.value) ? part.value : [part.value];
        for (const rawPath of paths) {
          const filePath = substitute(String(rawPath), vars);
          const buf = await readFile(filePath);
          form.append(
            part.name,
            new Blob([buf], { type: contentType || 'application/octet-stream' }),
            basename(filePath),
          );
        }
      } else {
        const values = Array.isArray(part.value) ? part.value : [part.value];
        for (const rawValue of values) {
          const value = substitute(String(rawValue), vars);
          if (contentType) {
            form.append(part.name, new Blob([value], { type: contentType }));
          } else {
            form.append(part.name, value);
          }
        }
      }
    }

    options.body = form;

    // undici sets the multipart boundary itself; a user-provided Content-Type
    // header would clobber the boundary, so strip it.
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-type') {
        delete headers[key];
      }
    }
  } else if (typeof body?.data === 'string') {
    options.body = substitute(body.data, vars);
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
  variableStore?: VariableStore,
): Promise<RequestExecutionResult> {
  // Merge env vars with runtime vars (runtime takes precedence)
  const effectiveVars = variableStore ? variableStore.merge(vars) : vars;

  const { url, options } = await buildFetchOptions(yaml, effectiveVars);
  const name = yaml.info.name;
  const method = yaml.http.method;

  // SSRF protection: validate URL before making the request
  const urlCheck = await validateUrl(url);
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

  // timeout: 0 means "no timeout" in Bruno; omit signal entirely
  const timeout = yaml.settings?.timeout ?? 30000;
  const fetchOpts: RequestInit = { ...options, redirect: 'manual' as RequestRedirect };
  if (timeout > 0) {
    fetchOpts.signal = AbortSignal.timeout(timeout);
  }

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
      const redirectCheck = await validateUrl(redirectUrl);
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
      const scriptResult = await TestRunner.runScript(testScript, wrappedResponse);
      tests = scriptResult.results;

      // Feed extracted variables into the store for cross-request propagation
      if (variableStore) {
        for (const [k, v] of Object.entries(scriptResult.variables)) {
          variableStore.set(k, v as string | number | boolean);
        }
      }
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
      const isFile = options.requestPath.endsWith('.yml') || options.requestPath.endsWith('.bru');
      if (!isFile) {
        // Not a recognized file extension — check if it's a directory
        const pathStat = await stat(options.requestPath);
        if (pathStat.isDirectory()) {
          const discovery = await discoverRequests(options.requestPath);
          requests = discovery.requests;
          parseErrors = discovery.parseErrors;
        } else {
          throw new Error(`Unsupported request file format: ${options.requestPath}`);
        }
      } else {
        const content = await readFile(options.requestPath, 'utf-8');
        let yaml: YamlRequest;
        if (options.requestPath.endsWith('.yml')) {
          yaml = parseYamlRequest(content);
        } else {
          yaml = bruFileToYamlRequest(parseBruRequest(content));
        }
        requests = [{ yaml, filePath: options.requestPath }];
      }
    } else {
      const discovery = await discoverRequests(collectionPath);
      requests = discovery.requests;
      parseErrors = discovery.parseErrors;
    }

    // Create a fresh variable store per run for cross-request variable propagation
    const variableStore = new VariableStore();

    const results: RequestExecutionResult[] = [];
    for (const req of requests) {
      const result = await executeSingleRequest(req.yaml, vars, variableStore);
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
