/**
 * Turning a run's two subset arguments into the one path the executor takes.
 *
 * `requestPath` and `folder` name the same thing — a subset of the collection to
 * run — so they resolve through a single place. Two properties this guarantees
 * that neither argument had on its own:
 *
 *   - A relative value is anchored to the collection root, not to the server
 *     process's working directory. The caller knows where the collection is;
 *     the cwd is wherever the MCP client happened to launch the server, so
 *     resolving against it made `"Auth"` mean different things (usually
 *     nothing) from one host to the next.
 *   - A value that names nothing, or names the wrong kind of thing, is an error
 *     that says so. Falling through to a whole-collection run is the one
 *     failure a caller cannot detect from the outside, because the run looks
 *     like it did what was asked.
 */

import path from 'path';
import { stat } from 'node:fs/promises';
import { validateToolPath } from './tool-path.js';

export type RunTargetResolution =
  | { ok: true; requestPath: string | undefined }
  | { ok: false; message: string };

/**
 * Resolve `requestPath` / `folder` to the absolute path the executor should run,
 * or `undefined` for the whole collection.
 *
 * Supplying both is rejected rather than reconciled. A precedence rule would
 * mean quietly discarding one of two arguments the caller stated explicitly,
 * which is the same class of silence this resolution exists to remove — and the
 * cost of rejecting is one corrected call.
 */
export async function resolveRunTarget(
  collectionPath: string,
  requestPath: string | undefined,
  folder: string | undefined,
): Promise<RunTargetResolution> {
  if (requestPath !== undefined && folder !== undefined) {
    return {
      ok: false,
      message:
        'Provide requestPath or folder, not both: they select the same thing, and ' +
        'choosing one for you would silently ignore the other. ' +
        `Got requestPath="${requestPath}" and folder="${folder}". ` +
        'Use folder for a directory, requestPath for a single request file.',
    };
  }

  const argName = folder !== undefined ? 'folder' : 'requestPath';
  const given = folder ?? requestPath;
  if (given === undefined) {
    return { ok: true, requestPath: undefined };
  }

  // Absolute is taken as given; relative is anchored to the collection.
  const resolved = path.isAbsolute(given)
    ? given
    : path.resolve(collectionPath, given);

  const check = validateToolPath(resolved, collectionPath);
  if (!check.valid) {
    return { ok: false, message: `Invalid ${argName}: ${check.reason}` };
  }

  let target;
  try {
    target = await stat(resolved);
  } catch {
    return {
      ok: false,
      message:
        `${argName} does not exist: ${resolved}. ` +
        'Name a request file or folder that is present in the collection — ' +
        'list_requests reports both. A relative value is resolved against ' +
        'collectionPath, not the working directory.',
    };
  }

  if (folder !== undefined && !target.isDirectory()) {
    return {
      ok: false,
      message:
        `folder must name a directory, but ${resolved} is a file. ` +
        'Pass a single request file as requestPath instead.',
    };
  }

  return { ok: true, requestPath: resolved };
}
