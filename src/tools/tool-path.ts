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
  collectionDialectWarnings,
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
  | { ok: true; format: CollectionFormat; warnings: string[] }
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

  // The dialect follows the FILE, not the collection. These can disagree — a
  // `.yml` request can sit in a `bruno.json` collection — and when they do, the
  // file's own extension is the only safe answer: taking the collection's would
  // serialise `.bru` text into a file named `.yml`, destroying it.
  //
  // `.yaml` counts as YAML here: it is a dialect spelling, not a different
  // format.
  const format: CollectionFormat = isYamlExtension(ext) ? 'yaml' : 'bru';

  // A disagreement is reported, not refused. The run path already reads such a
  // file, so refusing to write it left the caller able to run a request they
  // could not repair — and the repair is usually a rename, which needs the tool
  // to accept the path it is renaming. This is the same decision
  // `unconventionalExtensionWarning` makes for `.yaml`, applied to the other way
  // a request can be invisible to Bruno.
  return {
    ok: true,
    format,
    warnings: collectionDialectWarnings([filePath], detection.format),
  };
}
