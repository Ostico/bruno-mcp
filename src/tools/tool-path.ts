/**
 * Path checks shared by every tool.
 *
 * Extracted verbatim from BrunoMcpServer; neither function ever touched
 * instance state, so they were only methods by habit.
 */

import path from 'path';
import { validatePath } from '../bruno/path-validator.js';
import { findCollectionRoot, detectFormat } from '../bruno/format-detector.js';
import {
  isRequestExtension,
  isYamlExtension,
  REQUEST_EXTENSIONS,
} from '../bruno/request-extensions.js';
import type { CollectionFormat } from '../bruno/format-detector.js';

export function validateToolPath(
  inputPath: string,
  basePath?: string,
): { valid: boolean; resolved: string; reason?: string } {
  if (!inputPath) {
    return { valid: false, resolved: '', reason: 'Path is required' };
  }
  // Reject null bytes
  if (inputPath.includes('\0')) {
    return { valid: false, resolved: '', reason: 'Path contains null bytes' };
  }
  // If basePath provided, validate path is within it
  if (basePath) {
    return validatePath(inputPath, basePath);
  }
  // Otherwise just validate no obvious traversal
  const resolved = path.resolve(inputPath);
  if (inputPath.includes('..')) {
    return { valid: false, resolved, reason: 'Path traversal not allowed' };
  }
  return { valid: true, resolved };
}

export async function resolveRequestFile(
  filePath: string,
  argName: string,
): Promise<
  | { ok: true; format: CollectionFormat }
  | { ok: false; message: string }
> {
  const pathCheck = validateToolPath(filePath);
  if (!pathCheck.valid) {
    return { ok: false, message: `Invalid ${argName}: ${pathCheck.reason}` };
  }

  // Lowercased, as this gate has always been: it validates an argument a caller
  // typed, where `.YML` is a typo rather than a different file. The collection
  // walks stay case-sensitive — see request-extensions.ts.
  const ext = path.extname(filePath).toLowerCase();
  if (!isRequestExtension(ext)) {
    return {
      ok: false,
      message: `Invalid file extension "${ext}": expected ${REQUEST_EXTENSIONS.join(', ')}`,
    };
  }

  const collectionRoot = await findCollectionRoot(filePath);
  if (!collectionRoot) {
    return {
      ok: false,
      message:
        'Could not determine collection format: no opencollection.yml or bruno.json found within 10 parent directories',
    };
  }

  const detection = await detectFormat(collectionRoot);
  const wantsYaml = detection.format === 'yaml';
  // `.yaml` satisfies a YAML collection: it is a dialect spelling, not a
  // different format. The run path warns that Bruno itself will not read it.
  if (wantsYaml !== isYamlExtension(ext)) {
    const expectedExt = wantsYaml ? '.yml' : '.bru';
    return {
      ok: false,
      message: `File extension "${ext}" does not match collection format "${detection.format}" (expected "${expectedExt}")`,
    };
  }

  return { ok: true, format: detection.format };
}
