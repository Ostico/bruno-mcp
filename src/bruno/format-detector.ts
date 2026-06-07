/**
 * Format Detector — detects collection format from marker files.
 *
 * - `opencollection.yml` present → YAML format
 * - `bruno.json` present → BRU format
 * - Neither → defaults to YAML
 */

import { promises as fs } from 'fs';
import { join, dirname, basename } from 'path';
import { parse as parseYaml } from 'yaml';

export type CollectionFormat = 'yaml' | 'bru';

export interface FormatDetectionResult {
  format: CollectionFormat;
  configPath: string;
  collectionName: string;
}

const formatCache = new Map<string, FormatDetectionResult>();

export function clearFormatCache(): void {
  formatCache.clear();
}

/**
 * Detect the format of a Bruno collection by checking for marker files.
 * Results are cached per collectionPath — call clearFormatCache() in tests.
 */
export async function detectFormat(
  collectionPath: string,
): Promise<FormatDetectionResult> {
  const cached = formatCache.get(collectionPath);
  if (cached) return cached;

  let result: FormatDetectionResult;

  // Check for opencollection.yml first (YAML format takes priority)
  const yamlConfigPath = join(collectionPath, 'opencollection.yml');
  try {
    const content = await fs.readFile(yamlConfigPath, 'utf-8');
    const parsed = parseYaml(content);
    const name =
      parsed && typeof parsed === 'object' && parsed.info && typeof parsed.info.name === 'string'
        ? parsed.info.name
        : basename(collectionPath);
    result = { format: 'yaml', configPath: yamlConfigPath, collectionName: name };
    formatCache.set(collectionPath, result);
    return result;
  } catch {
    // opencollection.yml not found or unreadable — try bruno.json
  }

  // Check for bruno.json (BRU format)
  const bruConfigPath = join(collectionPath, 'bruno.json');
  try {
    const content = await fs.readFile(bruConfigPath, 'utf-8');
    const parsed = JSON.parse(content);
    const name =
      parsed && typeof parsed === 'object' && typeof parsed.name === 'string'
        ? parsed.name
        : basename(collectionPath);
    result = { format: 'bru', configPath: bruConfigPath, collectionName: name };
    formatCache.set(collectionPath, result);
    return result;
  } catch {
    // bruno.json not found or unreadable — default to yaml
  }

  result = { format: 'yaml', configPath: '', collectionName: basename(collectionPath) };
  formatCache.set(collectionPath, result);
  return result;
}

/**
 * Walk parent directories from `filePath` to find the collection root.
 *
 * Stops at filesystem root or after 10 levels of parent traversal.
 *
 * @param filePath  Absolute path to a file inside a collection
 * @returns The directory containing the marker file, or `null` if not found
 */
export async function findCollectionRoot(filePath: string): Promise<string | null> {
  let current = dirname(filePath);
  const MAX_LEVELS = 10;

  for (let i = 0; i < MAX_LEVELS; i++) {
    try {
      await fs.access(join(current, 'opencollection.yml'));
      return current;
    } catch {
      // not found at this level
    }
    try {
      await fs.access(join(current, 'bruno.json'));
      return current;
    } catch {
      // not found at this level
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return null;
}
