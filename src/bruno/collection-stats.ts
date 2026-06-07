import { promises as fs } from 'fs';
import { join, basename, relative, dirname } from 'path';
import { parseYamlRequest } from './yaml-parser.js';
import { BrunoError } from './types.js';
import type { CollectionStats, RequestDetail } from './types.js';

const EXCLUDED_FILENAMES = new Set([
  'folder.yml',
  'opencollection.yml',
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

async function findYmlFiles(dirPath: string, results: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
      await findYmlFiles(fullPath, results);
    } else if (entry.isFile() && entry.name.endsWith('.yml')) {
      results.push(fullPath);
    }
  }
}

async function listEnvironments(collectionPath: string): Promise<string[]> {
  const envDir = join(collectionPath, 'environments');
  try {
    const entries = await fs.readdir(envDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.yml'))
      .map((e) => e.name.replace(/\.yml$/, ''))
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
    return false;
  }
}

export async function getCollectionStats(collectionPath: string): Promise<CollectionStats> {
  try {
    await fs.access(collectionPath);
  } catch {
    throw new BrunoError(`Collection path does not exist: ${collectionPath}`, 'NOT_FOUND');
  }

  const allYmlFiles: string[] = [];
  await findYmlFiles(collectionPath, allYmlFiles);

  const requestFiles = allYmlFiles.filter((filePath) => {
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

    let parsed;
    try {
      parsed = parseYamlRequest(content);
    } catch {
      continue;
    }

    const method = parsed.http.method.toUpperCase();
    requestsByMethod[method] = (requestsByMethod[method] || 0) + 1;

    const folder = getFolderName(filePath, collectionPath);

    requests.push({
      name: parsed.info.name,
      method,
      seq: parsed.info.seq ?? 0,
      folder,
      hasTests: hasTestScripts(content),
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
