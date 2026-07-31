import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'path';
import { parseYamlRequest } from './yaml-parser.js';
import { parseBruRequest } from './bru-parser.js';
import { bruFileToYamlRequest } from './bru-to-yaml.js';
import { isMetadataFile } from './metadata-files.js';
import { describeParseFailure } from './parse-failure.js';
import {
  isRequestFile,
  isYamlRequestFile,
  unconventionalExtensionWarning,
} from './request-extensions.js';
import type { YamlRequest, ParseFailure } from './types.js';

/**
 * Finding the request files in a collection and parsing them.
 *
 * Its own module because `request-executor.ts` sits on the repo-wide max-lines
 * ceiling; discovery is the most self-contained thing in it — a filesystem walk
 * and a parse, with no execution state.
 */
export interface ParsedRequest {
  yaml: YamlRequest;
  filePath: string;
}

export interface DiscoveryResult {
  requests: ParsedRequest[];
  parseFailures: ParseFailure[];
  /**
   * Notes about the discovered set as a whole, rather than about one request.
   * Currently only the `.yaml`-extension divergence — see
   * `request-extensions.ts` for why reading those files is right and why saying
   * so is necessary.
   */
  warnings: string[];
}

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'environments',
]);

async function findYmlFilesRecursive(dirPath: string, results: string[], collectionPath: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory() && !EXCLUDED_DIRS.has(entry.name)) {
      await findYmlFilesRecursive(fullPath, results, collectionPath);
    } else if (entry.isFile() && isRequestFile(entry.name)) {
      if (!isMetadataFile(fullPath, collectionPath)) {
        results.push(fullPath);
      }
    }
  }
}

export async function discoverRequests(dirPath: string): Promise<DiscoveryResult> {
  const requestFiles: string[] = [];
  await findYmlFilesRecursive(dirPath, requestFiles, dirPath);

  const requests: ParsedRequest[] = [];
  const parseFailures: ParseFailure[] = [];

  for (const filePath of requestFiles) {
    try {
      const content = await readFile(filePath, 'utf-8');
      let yaml: YamlRequest;
      if (isYamlRequestFile(filePath)) {
        yaml = parseYamlRequest(content);
      } else {
        yaml = bruFileToYamlRequest(parseBruRequest(content));
      }
      requests.push({ yaml, filePath });
    } catch (error) {
      parseFailures.push(describeParseFailure(filePath, error));
    }
  }

  requests.sort((a, b) => {
    const seqA = a.yaml.info.seq ?? Number.MAX_SAFE_INTEGER;
    const seqB = b.yaml.info.seq ?? Number.MAX_SAFE_INTEGER;
    return seqA - seqB;
  });

  return {
    requests,
    parseFailures,
    // Every discovered file, not only the ones that parsed: a `.yaml` file that
    // also failed to parse is still a `.yaml` file the user should rename.
    warnings: unconventionalExtensionWarning(requestFiles),
  };
}

/**
 * What a run should execute: one named request, one named directory, or the
 * whole collection.
 *
 * This lived in the executor, which put all three "is this a request file"
 * decisions next to the execution loop rather than next to the walk that makes
 * the same decision. Resolving what to run is discovery's job, and the executor
 * sits on the repo-wide max-lines ceiling.
 *
 * `requestPath` may name a file or a directory. A directory is discovered like a
 * collection; a file is parsed on its own, and a file that will not parse
 * **throws** rather than being tallied — nothing else was asked for, so there is
 * no partial run to report.
 */
export async function resolveRunTargets(
  requestPath: string | undefined,
  collectionPath: string,
): Promise<DiscoveryResult> {
  if (!requestPath) {
    return discoverRequests(collectionPath);
  }

  if (!isRequestFile(requestPath)) {
    // Not a recognised extension — the one remaining thing it can be is a
    // directory, and anything else is unrunnable.
    const pathStat = await stat(requestPath);
    if (!pathStat.isDirectory()) {
      throw new Error(`Unsupported request file format: ${requestPath}`);
    }
    return discoverRequests(requestPath);
  }

  const content = await readFile(requestPath, 'utf-8');
  let yaml: YamlRequest;
  try {
    yaml = isYamlRequestFile(requestPath)
      ? parseYamlRequest(content)
      : bruFileToYamlRequest(parseBruRequest(content));
  } catch (error) {
    // The parser names the reason but not the file, and the caller's own
    // argument is not in the message it gets back.
    const failure = describeParseFailure(requestPath, error);
    throw new Error(`Failed to parse ${failure.file}: ${failure.message}`);
  }

  return {
    requests: [{ yaml, filePath: requestPath }],
    parseFailures: [],
    warnings: unconventionalExtensionWarning([requestPath]),
  };
}
