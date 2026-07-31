import { readFile, readdir } from 'node:fs/promises';
import { join } from 'path';
import { parseYamlRequest } from './yaml-parser.js';
import { parseBruRequest } from './bru-parser.js';
import { bruFileToYamlRequest } from './bru-to-yaml.js';
import { isMetadataFile } from './metadata-files.js';
import { describeParseFailure } from './parse-failure.js';
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
    } else if (entry.isFile() && (entry.name.endsWith('.yml') || entry.name.endsWith('.bru'))) {
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
      if (filePath.endsWith('.yml')) {
        yaml = parseYamlRequest(content);
      } else if (filePath.endsWith('.bru')) {
        yaml = bruFileToYamlRequest(parseBruRequest(content));
      } else {
        /* istanbul ignore next -- unreachable: findYmlFilesRecursive only yields .yml/.bru paths, so this defensive else is dead code */
        continue;
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

  return { requests, parseFailures };
}
