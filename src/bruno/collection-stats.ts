import { promises as fs } from 'fs';
import type { Dirent } from 'fs';
import { join, relative, dirname } from 'path';
import { parse as parseYaml } from 'yaml';
import { parseYamlRequest } from './yaml-parser.js';
import { parseBruRequest, parseBruEnvironmentRaw } from './bru-parser.js';
import { isMetadataFile } from './metadata-files.js';
import { isRequestFile, isBruRequestFile } from './request-extensions.js';
import { BrunoError } from './types.js';
import type {
  CollectionStats,
  EnvironmentDetail,
  EnvFile,
  RequestDetail,
  RequestDetailFilter,
} from './types.js';

function isEnvironmentFile(filePath: string, collectionPath: string): boolean {
  const rel = relative(collectionPath, filePath);
  const parts = rel.split(/[/\\]/);
  return parts.includes('environments');
}

function getFolderName(filePath: string, collectionPath: string): string {
  const rel = relative(collectionPath, filePath);
  const dir = dirname(rel);
  return dir === '.' ? '' : dir;
}

/**
 * The first target any transport block actually carries.
 *
 * Both parsers hand back a `url` of `''` for a request whose block is missing or
 * has no url line, so a plain `??` chain stops at the empty string and reports a
 * request as having a blank target instead of none.
 */
function firstUrl(...candidates: (string | undefined)[]): string | undefined {
  return candidates.find((candidate) => candidate !== undefined && candidate !== '');
}

async function findRequestFiles(dirPath: string, results: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
      await findRequestFiles(fullPath, results);
    } else if (entry.isFile() && isRequestFile(entry.name)) {
      results.push(fullPath);
    }
  }
}

async function listEnvironments(collectionPath: string): Promise<string[]> {
  const envDir = join(collectionPath, 'environments');
  try {
    const entries = await fs.readdir(envDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && (e.name.endsWith('.yml') || e.name.endsWith('.bru')))
      .map((e) => e.name.replace(/\.(yml|bru)$/, ''))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Variable names declared by each environment.
 *
 * Without this a caller can see that an environment exists but not what is in
 * it, which makes set_environment_variable's merge semantics a promise about
 * state the caller cannot observe. Names only — see EnvironmentDetail.
 */
async function listEnvironmentDetails(collectionPath: string): Promise<EnvironmentDetail[]> {
  const envDir = join(collectionPath, 'environments');

  let entries: Dirent[];
  try {
    entries = await fs.readdir(envDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const details: EnvironmentDetail[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const isYaml = entry.name.endsWith('.yml');
    if (!isYaml && !entry.name.endsWith('.bru')) continue;

    const name = entry.name.replace(/\.(yml|bru)$/, '');
    let variables: string[] = [];

    try {
      const content = await fs.readFile(join(envDir, entry.name), 'utf-8');
      variables = isYaml
        ? ((parseYaml(content) as EnvFile | null)?.variables ?? [])
            .filter((v) => v && typeof v.name === 'string')
            .map((v) => v.name)
        : parseBruEnvironmentRaw(content).map((v) => v.name);
    } catch {
      // An unreadable or malformed environment still exists; report it with no
      // variables rather than dropping it from the listing entirely.
      variables = [];
    }

    details.push({ name, variables });
  }

  return details.sort((a, b) => a.name.localeCompare(b.name));
}

async function listFolders(collectionPath: string): Promise<string[]> {
  const folders: string[] = [];
  try {
    const entries = await fs.readdir(collectionPath, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        entry.name !== 'environments' &&
        entry.name !== 'node_modules' &&
        entry.name !== '.git'
      ) {
        folders.push(entry.name);
      }
    }
  } catch {
    // ignore
  }
  return folders.sort();
}

function hasTestScripts(content: string): boolean {
  try {
    const parsed = parseYamlRequest(content);
    if (!parsed.runtime?.scripts) return false;
    return parsed.runtime.scripts.some(
      (s) => s.type === 'after-response' && s.code.trim().length > 0,
    );
  } catch {
    /* istanbul ignore next -- unreachable: in getCollectionStats this runs only after parseYamlRequest already succeeded on identical content, and parseRuntime coerces every script code to a string so .trim() cannot throw */
    return false;
  }
}

/**
 * Folder paths compare on a single separator, whichever one the platform
 * produced. `.` becomes the empty string, since `getFolderName` spells the
 * collection root that way and a caller who names it `.` means the same place.
 */
function normaliseFolder(folder: string): string {
  const slashed = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return slashed === '.' ? '' : slashed;
}

/**
 * Narrows the per-request array of an already-gathered stats result.
 *
 * Separate from `getCollectionStats` on purpose: the scan has to see every file
 * to count the collection and to judge its dialect, so filtering has to happen
 * after it, on the way out. The counts are left describing the whole
 * collection — a filter that also shrank `totalRequests` would answer "how big
 * is this collection" with the size of the caller's own question.
 */
export function filterCollectionStats(
  stats: CollectionStats,
  filter: RequestDetailFilter,
): CollectionStats {
  const wantedFolder = filter.folder === undefined ? undefined : normaliseFolder(filter.folder);
  const wantedMethod = filter.method?.toUpperCase();
  const wantedName = filter.nameContains?.toLowerCase();
  const narrowed = wantedFolder !== undefined
    || wantedMethod !== undefined
    || wantedName !== undefined;

  if (!narrowed && filter.includeRequests !== false) {
    return stats;
  }

  const matched = stats.requests.filter((request) => {
    // `request.method` is already uppercase: the scan above uppercases every
    // method and every kind label. Only the caller's side needs folding.
    if (wantedMethod !== undefined && request.method !== wantedMethod) {
      return false;
    }
    if (wantedName !== undefined && !request.name.toLowerCase().includes(wantedName)) {
      return false;
    }
    if (wantedFolder !== undefined) {
      const folder = normaliseFolder(request.folder);
      // An exact match or anything nested below it: asking for "auth" and being
      // given nothing from "auth/oauth2" would be a filter that hides the very
      // requests it was aimed at. The empty string means the collection root,
      // which nests everything.
      const nested = wantedFolder === ''
        || folder === wantedFolder
        || folder.startsWith(`${wantedFolder}/`);
      if (!nested) {
        return false;
      }
    }
    return true;
  });

  return {
    ...stats,
    requests: filter.includeRequests === false ? [] : matched,
    ...(narrowed ? { matchedRequests: matched.length } : {}),
    ...(filter.includeRequests === false ? { requestsOmitted: true as const } : {}),
  };
}

export async function getCollectionStats(collectionPath: string): Promise<CollectionStats> {
  try {
    await fs.access(collectionPath);
  } catch {
    throw new BrunoError(`Collection path does not exist: ${collectionPath}`, 'NOT_FOUND');
  }

  const allFiles: string[] = [];
  await findRequestFiles(collectionPath, allFiles);

  const requestFiles = allFiles.filter((filePath) => {
    if (isMetadataFile(filePath, collectionPath)) return false;
    if (isEnvironmentFile(filePath, collectionPath)) return false;
    return true;
  });

  const requestsByMethod: Record<string, number> = {};
  const requests: RequestDetail[] = [];

  for (const filePath of requestFiles) {
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    let name: string;
    let method: string;
    let seq: number;
    let testsFound: boolean;
    // Whichever transport block carries one. A grpc or ws request keeps its URL
    // somewhere other than `http`, so reading only that block would report the
    // two kinds as having no target at all.
    let url: string | undefined;

    try {
      if (isBruRequestFile(filePath)) {
        const parsed = parseBruRequest(content);
        name = parsed.meta.name;
        // A grpc or ws request has no method. Bucketed under its kind rather than
        // skipped: this loop swallows errors with `catch { continue; }`, so
        // anything not handled here disappears from the stats silently.
        method = parsed.http?.method.toUpperCase() ?? parsed.meta.type.toUpperCase();
        seq = parsed.meta.seq ?? 0;
        testsFound = (parsed.tests?.exec?.length ?? 0) > 0;
        url = firstUrl(parsed.http?.url, parsed.grpc?.url, parsed.ws?.url);
      } else {
        const parsed = parseYamlRequest(content);
        name = parsed.info.name;
        method = parsed.http?.method.toUpperCase() ?? (parsed.info.type ?? 'http').toUpperCase();
        seq = parsed.info.seq ?? 0;
        testsFound = hasTestScripts(content);
        url = firstUrl(parsed.http?.url, parsed.grpc?.url, parsed.websocket?.url);
      }
    } catch {
      continue;
    }

    requestsByMethod[method] = (requestsByMethod[method] || 0) + 1;

    const folder = getFolderName(filePath, collectionPath);

    requests.push({
      name,
      method,
      seq,
      folder,
      hasTests: testsFound,
      filePath,
      ...(url === undefined ? {} : { url }),
    });
  }

  requests.sort((a, b) => a.seq - b.seq);

  const folders = await listFolders(collectionPath);
  const environments = await listEnvironments(collectionPath);
  const environmentDetails = await listEnvironmentDetails(collectionPath);

  return {
    totalRequests: requests.length,
    requestsByMethod,
    folders,
    environments,
    environmentDetails,
    requests,
  };
}
