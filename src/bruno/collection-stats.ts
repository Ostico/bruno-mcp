import { promises as fs } from 'fs';
import { join, basename, relative, dirname } from 'path';
import { parseYamlRequest } from './yaml-parser.js';
import { parseBruRequest } from './bru-parser.js';
import { BrunoError } from './types.js';
import type { CollectionStats, RequestDetail } from './types.js';

const EXCLUDED_FILENAMES = new Set([
  'folder.yml',
  'opencollection.yml',
  'bruno.json',
]);

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
    } else if (entry.isFile() && (entry.name.endsWith('.yml') || entry.name.endsWith('.bru'))) {
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

export async function getCollectionStats(collectionPath: string): Promise<CollectionStats> {
  try {
    await fs.access(collectionPath);
  } catch {
    throw new BrunoError(`Collection path does not exist: ${collectionPath}`, 'NOT_FOUND');
  }

  const allFiles: string[] = [];
  await findRequestFiles(collectionPath, allFiles);

  const requestFiles = allFiles.filter((filePath) => {
    const name = basename(filePath);
    if (EXCLUDED_FILENAMES.has(name)) return false;
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

    try {
      if (filePath.endsWith('.bru')) {
        const parsed = parseBruRequest(content);
        name = parsed.meta.name;
        method = parsed.http.method.toUpperCase();
        seq = parsed.meta.seq ?? 0;
        testsFound = (parsed.tests?.exec?.length ?? 0) > 0;
      } else if (filePath.endsWith('.yml')) {
        const parsed = parseYamlRequest(content);
        name = parsed.info.name;
        method = parsed.http.method.toUpperCase();
        seq = parsed.info.seq ?? 0;
        testsFound = hasTestScripts(content);
      } else {
        /* istanbul ignore next -- unreachable: findRequestFiles only ever collects files ending in .yml or .bru, so this else can never execute */
        continue;
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
    });
  }

  requests.sort((a, b) => a.seq - b.seq);

  const folders = await listFolders(collectionPath);
  const environments = await listEnvironments(collectionPath);

  return {
    totalRequests: requests.length,
    requestsByMethod,
    folders,
    environments,
    requests,
  };
}
