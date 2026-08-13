/**
 * Renaming a request's file, which is a separate operation from renaming the
 * request.
 *
 * Bruno keeps the two apart. Its rename-item-name path rewrites the name inside
 * the file and never touches the file itself; a second rename-item-filename
 * path takes a new basename and moves the file, writing the name only because
 * the caller supplied it in the same message. This module is the second one, so
 * that editing a request's name no longer leaves a file whose basename
 * contradicts it with no way to correct it.
 *
 * The accepted set of names is ported from upstream's filename validator rather
 * than invented, so a file this server renames is one Bruno would also have
 * accepted: no path separator, none of the characters Windows forbids, no
 * leading space or hyphen, no trailing dot or space, no reserved device name,
 * and at most 255 characters. The collision check likewise allows the one case
 * where the target already exists and is nonetheless the same file — a rename
 * that changes only letter case on a case-insensitive filesystem.
 */

import { promises as fs } from 'fs';
import { basename, dirname, extname, join } from 'path';

/** The extensions a request file can carry, in either dialect. */
const REQUEST_EXTENSIONS = ['.yml', '.yaml', '.bru'];

/** Characters upstream's validator refuses anywhere in a filename. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARACTERS = /[<>:"|?*\x00-\x1F]/;

/** Windows device names, which cannot be used as a filename on any drive. */
const RESERVED_DEVICE_NAMES = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i;

/** The longest basename every filesystem we target accepts. */
const MAX_FILENAME_LENGTH = 255;

export type RenameTarget =
  | { ok: true; target: string }
  | { ok: false; reason: string };

export type RenameTargetAvailability =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Turn a caller-supplied basename into the absolute path the request would move
 * to, or explain why it cannot be one.
 *
 * The extension is not the caller's choice: a collection carries one dialect and
 * Bruno scans for that extension alone, so a request in a `.yml` collection
 * renamed to `login.bru` would simply vanish from the sidebar. Supplying the
 * collection's own extension is accepted (and normalised to the case the rest of
 * the collection uses), supplying a different one is refused, and supplying none
 * appends it.
 */
export function resolveRenameTarget(currentPath: string, filename: string): RenameTarget {
  if (filename.length === 0) {
    return { ok: false, reason: 'the new filename is empty' };
  }
  if (filename.includes('/') || filename.includes('\\')) {
    return {
      ok: false,
      reason: 'a filename cannot contain a path separator, because a rename stays '
        + "in the request's own folder",
    };
  }
  if (FORBIDDEN_CHARACTERS.test(filename)) {
    return {
      ok: false,
      reason: 'a filename cannot contain any of < > : " | ? * or a control character',
    };
  }
  if (/^[\s-]/.test(filename)) {
    return { ok: false, reason: 'a filename cannot start with a space or a hyphen' };
  }
  if (/[.\s]$/.test(filename)) {
    return { ok: false, reason: 'a filename cannot end with a dot or a space' };
  }

  const extension = extname(currentPath).toLowerCase();
  const lowered = filename.toLowerCase();
  const supplied = REQUEST_EXTENSIONS.find((candidate) => lowered.endsWith(candidate));
  if (supplied !== undefined && supplied !== extension) {
    return {
      ok: false,
      reason: `the requests in this collection are ${extension} files, and a collection `
        + `carries one format only, so it cannot become a ${supplied} file`,
    };
  }
  const stem = supplied === undefined
    ? filename
    : filename.slice(0, filename.length - supplied.length);
  if (stem.length === 0) {
    return { ok: false, reason: 'the new filename is nothing but an extension' };
  }
  if (RESERVED_DEVICE_NAMES.test(stem)) {
    return { ok: false, reason: `"${stem}" is a reserved device name on Windows` };
  }

  const target = stem + extension;
  if (target.length > MAX_FILENAME_LENGTH) {
    return {
      ok: false,
      reason: `a filename can be at most ${MAX_FILENAME_LENGTH} characters, `
        + `and "${target}" is ${target.length}`,
    };
  }

  return { ok: true, target: join(dirname(currentPath), target) };
}

/**
 * Refuse a rename that would overwrite another request.
 *
 * A target that already exists is still allowed when it is the very file being
 * renamed, which is what a case-only rename looks like on a case-insensitive
 * filesystem. That is decided by inode, and an inode of 0 — which some Windows
 * filesystems report for every file — is treated as "cannot tell", so the
 * rename is refused rather than silently replacing a different request.
 */
export async function ensureRenameTargetFree(
  currentPath: string,
  target: string,
): Promise<RenameTargetAvailability> {
  let existing;
  try {
    existing = await fs.stat(target);
  } catch {
    return { ok: true };
  }
  const current = await fs.stat(currentPath);
  if (current.ino !== 0 && existing.ino === current.ino && existing.dev === current.dev) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `"${basename(target)}" already exists in that folder`,
  };
}
