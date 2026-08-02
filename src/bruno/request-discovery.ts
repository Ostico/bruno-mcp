import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'path';
import { parseYamlRequest } from './yaml-parser.js';
import { parseBruRequest } from './bru-parser.js';
import { bruFileToYamlRequest } from './bru-to-yaml.js';
import { isMetadataFile } from './metadata-files.js';
import { readFolderSeq, sortFoldersByNameThenSequence } from './request-order.js';
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

/**
 * One directory's own request files, in the order that directory contributes
 * them to the run.
 */
interface DirectoryGroup {
  dirPath: string;
  files: string[];
}

/**
 * Walk the tree, returning directories in the order they contribute requests.
 *
 * A directory's subfolders are emitted before the directory itself, because
 * upstream's `traverse` returns `folders.concat(requests)` — so a request at
 * the collection root runs after every folder. See `request-order.ts` for why
 * this is a port rather than a design.
 */
async function walkInExecutionOrder(
  dirPath: string,
  collectionPath: string,
  groups: DirectoryGroup[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  const subdirectories = entries.filter(
    (entry) => entry.isDirectory() && !EXCLUDED_DIRS.has(entry.name),
  );
  const files = entries
    .filter((entry) => entry.isFile() && isRequestFile(entry.name))
    .map((entry) => join(dirPath, entry.name))
    .filter((fullPath) => !isMetadataFile(fullPath, collectionPath));

  const ordered = sortFoldersByNameThenSequence(
    await Promise.all(
      subdirectories.map(async (entry) => ({
        name: entry.name,
        path: join(dirPath, entry.name),
        seq: await readFolderSeq(join(dirPath, entry.name)),
      })),
    ),
  );

  for (const folder of ordered) {
    await walkInExecutionOrder(folder.path, collectionPath, groups);
  }

  groups.push({ dirPath, files });
}

export async function discoverRequests(dirPath: string): Promise<DiscoveryResult> {
  const groups: DirectoryGroup[] = [];
  await walkInExecutionOrder(dirPath, dirPath, groups);

  const requests: ParsedRequest[] = [];
  const parseFailures: ParseFailure[] = [];
  const allFiles: string[] = [];

  for (const group of groups) {
    const inThisDirectory: ParsedRequest[] = [];

    for (const filePath of group.files) {
      allFiles.push(filePath);
      try {
        const content = await readFile(filePath, 'utf-8');
        let yaml: YamlRequest;
        if (isYamlRequestFile(filePath)) {
          yaml = parseYamlRequest(content);
        } else {
          yaml = bruFileToYamlRequest(parseBruRequest(content));
        }
        inThisDirectory.push({ yaml, filePath });
      } catch (error) {
        parseFailures.push(describeParseFailure(filePath, error));
      }
    }

    // Sorted per directory, because `seq` is scoped to a folder. Ties break on
    // filename, which upstream does not do: it leaves them in `readdir` order.
    // That is a deliberate divergence — an arbitrary-but-stable order is the
    // point of this fix, and two requests sharing a `seq` have no intended
    // order to preserve, so nothing observable is lost by making it repeatable.
    inThisDirectory.sort((a, b) => {
      const seqA = a.yaml.info.seq ?? Number.MAX_SAFE_INTEGER;
      const seqB = b.yaml.info.seq ?? Number.MAX_SAFE_INTEGER;
      return seqA - seqB || a.filePath.localeCompare(b.filePath);
    });

    requests.push(...inThisDirectory);
  }

  return {
    requests,
    parseFailures,
    // Every discovered file, not only the ones that parsed: a `.yaml` file that
    // also failed to parse is still a `.yaml` file the user should rename.
    warnings: unconventionalExtensionWarning(allFiles),
  };
}

/**
 * Say so when a directory walk found nothing to run.
 *
 * A run over an empty directory otherwise reports zero requests, zero failures
 * and no explanation, which reads as a pass. The directory exists — it is a
 * misaimed subset, not a bad path — so this is a warning on the result rather
 * than a thrown error.
 */
function warnIfNothingToRun(result: DiscoveryResult, dirPath: string): DiscoveryResult {
  if (result.requests.length > 0) {
    return result;
  }
  return {
    ...result,
    warnings: [
      ...result.warnings,
      `No runnable requests were found under ${dirPath}, so this run executed nothing. ` +
        'Zero requests is not a pass.',
    ],
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
    return warnIfNothingToRun(await discoverRequests(collectionPath), collectionPath);
  }

  if (!isRequestFile(requestPath)) {
    // Not a recognised extension — the one remaining thing it can be is a
    // directory, and anything else is unrunnable.
    const pathStat = await stat(requestPath);
    if (!pathStat.isDirectory()) {
      throw new Error(`Unsupported request file format: ${requestPath}`);
    }
    return warnIfNothingToRun(await discoverRequests(requestPath), requestPath);
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
