/**
 * Path Validator — Traversal Protection
 *
 * Validates that file paths stay within expected directory boundaries.
 * Prevents path traversal attacks (e.g. ../../etc/passwd) and null byte
 * injection in paths supplied to the MCP server.
 *
 * NOTE: Symlink resolution is out of scope for v1 (documented in plan).
 */

import path from 'path';
import type { PathValidationResult, CollectionPathValidationResult } from './types.js';

/**
 * Validates that `inputPath` resolves to a location within `allowedBase`.
 *
 * - Normalises both paths with `path.resolve`.
 * - Rejects null bytes in either argument.
 * - Uses a separator-aware prefix check so `/workspace-evil` is not
 *   confused with a child of `/workspace`.
 */
export function validatePath(
  inputPath: string,
  allowedBase: string,
): PathValidationResult {
  // Reject null bytes in either argument
  if (inputPath.includes('\0')) {
    return { valid: false, resolved: '', reason: 'Path contains null byte' };
  }
  if (allowedBase.includes('\0')) {
    return { valid: false, resolved: '', reason: 'Base path contains null byte' };
  }

  const resolved = path.resolve(inputPath);
  const resolvedBase = path.resolve(allowedBase);

  // Exact match — the path *is* the base
  if (resolved === resolvedBase) {
    return { valid: true, resolved };
  }

  // Ensure the resolved path is a proper child by checking it starts with
  // the base followed by the platform path separator.  This prevents
  // `/workspace-evil` from being accepted when the base is `/workspace`.
  if (!resolved.startsWith(resolvedBase + path.sep)) {
    return {
      valid: false,
      resolved,
      reason: `Path resolves outside the allowed base directory`,
    };
  }

  return { valid: true, resolved };
}

/**
 * Validates that `collectionPath` is within one of the known workspace
 * collections.
 *
 * - Rejects null bytes.
 * - Resolves the input path and checks it against each collection.
 * - Uses the same separator-aware prefix check as `validatePath`.
 */
export function validateCollectionPath(
  collectionPath: string,
  workspaceCollections: Array<{ path: string }>,
): CollectionPathValidationResult {
  // Reject null bytes
  if (collectionPath.includes('\0')) {
    return { valid: false, reason: 'Path contains null byte' };
  }

  if (workspaceCollections.length === 0) {
    return { valid: false, reason: 'No workspace collections configured' };
  }

  const resolved = path.resolve(collectionPath);

  for (const collection of workspaceCollections) {
    const resolvedCollection = path.resolve(collection.path);

    // Exact match — the path is the collection root itself
    if (resolved === resolvedCollection) {
      return { valid: true };
    }

    // Proper child of this collection
    if (resolved.startsWith(resolvedCollection + path.sep)) {
      return { valid: true };
    }
  }

  return {
    valid: false,
    reason: 'Path is not within any known workspace collection',
  };
}
