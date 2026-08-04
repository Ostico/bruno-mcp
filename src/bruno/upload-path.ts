/**
 * Confining a collection-supplied upload path to a location the host trusts.
 *
 * Split out of request-executor.ts, which had grown past the max-lines ceiling,
 * and shared from there: a multipart part and a `file`-mode body both name a
 * path the collection controls, and both have to be confined the same way.
 */

import { basename, relative, resolve, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';

let uploadDirsCache: string[] | null = null;

/**
 * Extra upload directories the operator trusts, from BRUNO_UPLOAD_DIRS
 * (comma-separated absolute paths). Read once and cached.
 */
function operatorUploadDirs(): string[] {
  if (uploadDirsCache === null) {
    uploadDirsCache = (process.env.BRUNO_UPLOAD_DIRS ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => resolve(s));
  }
  return uploadDirsCache;
}

/** Reset the cached BRUNO_UPLOAD_DIRS. Exported for testing. */
export function resetUploadDirsCache(): void {
  uploadDirsCache = null;
}

/** True if `p` is within `root` (lexically; `root` itself does not count). */
function isWithin(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Resolve a collection-supplied upload path and confine it to a trusted upload
 * location.
 *
 * The path comes from the (untrusted) collection, so without confinement a
 * collection could name `/etc/passwd`, `~/.ssh/id_rsa`, an env file, etc. and
 * have its contents POSTed to any host — arbitrary file read + exfiltration
 *.
 *
 * The read is allowed only when the resolved path sits under one of: the
 * collection root, the user's home directory, the OS temp dir (and `/tmp`), or
 * an operator-configured `BRUNO_UPLOAD_DIRS` entry. On top of that, ANY path
 * component starting with `.` is refused — so even though home is allowed,
 * dotfiles and dot-directories (`~/.ssh`, `.aws`, `.env`, `.git`, …) are not
 * readable. Relative paths resolve against the collection root; a file part
 * with no known collection root is refused (no trusted base).
 *
 * `kind` names the thing being read in the refusal messages, because a caller
 * shown "multipart file part" for a `file`-mode body would go looking for a
 * part that does not exist.
 */
export function confineUploadPath(
  filePath: string,
  collectionRoot: string | undefined,
  kind = 'multipart file part',
): string {
  if (!collectionRoot) {
    throw new Error(
      `Refusing to read ${kind} "${basename(filePath)}": no collection root to confine it to`,
    );
  }
  const root = resolve(collectionRoot);
  const resolved = resolve(root, filePath);

  const allowedRoots = [root, resolve(homedir()), resolve(tmpdir()), resolve('/tmp'), ...operatorUploadDirs()];
  // Match against the most specific (longest) allowed root, so the hidden-segment
  // check runs only below that root — a collection legitimately nested under a
  // hidden ancestor (e.g. ~/.config/bruno/coll) still works.
  const matched = allowedRoots
    .filter(r => isWithin(r, resolved))
    .sort((a, b) => b.length - a.length)[0];
  if (!matched) {
    throw new Error(
      `Refusing to read ${kind} outside the allowed upload directories: "${filePath}"`,
    );
  }

  const belowRoot = relative(matched, resolved).split(/[\\/]+/);
  if (belowRoot.some(seg => seg.startsWith('.'))) {
    throw new Error(
      `Refusing to read a hidden file or directory as a ${kind}: "${filePath}"`,
    );
  }
  return resolved;
}
