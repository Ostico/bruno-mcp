/**
 * Atomic, durable file writes (findings D9 / S24).
 *
 * A plain `writeFile` truncates the target and then streams into it, so a crash,
 * a full disk, or a killed process midway leaves a truncated or empty file where
 * the user's collection or environment used to be. The old content is gone and
 * the new content was never complete.
 *
 * This writes to a temporary file first, flushes it to disk, and then renames it
 * over the target. `rename(2)` is atomic within a filesystem, so a reader (and a
 * crash) sees either the whole old file or the whole new one, never a partial
 * write.
 *
 * The temporary file placement is security-relevant (S24):
 *  - It lives in the *target's own directory*, not the system temp dir. A shared
 *    `/tmp` is world-readable, and bruno environment files carry secrets. It also
 *    keeps the rename on one filesystem — across a boundary `rename` fails with
 *    EXDEV and the atomicity is lost.
 *  - It is created with O_EXCL and a random suffix, so an attacker cannot
 *    pre-plant the name: a symlink or an existing file at that path makes the
 *    create fail rather than be followed.
 *  - It is created 0o600, so the content is never world-readable, not even for
 *    the instant before the rename.
 *
 * Permissions on the result are unchanged from a plain write: an existing file
 * keeps its own mode, and a new file gets 0o644.
 *
 * Boundary: the file's data is fsync'd before the rename, which is what makes a
 * crash mid-write survivable. The directory entry itself is not fsync'd, so an
 * abrupt power loss can still lose the *rename* (leaving the intact old file).
 * Directory fsync is not portable, and losing the old file was the defect here.
 */

import { constants as fsConstants } from 'node:fs';
import { open, rename, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';

/** Mode a newly created file ends up with, matching writeFile under a 022 umask. */
const DEFAULT_FILE_MODE = 0o644;

/** Mode the temporary file is created with, before it is renamed into place. */
const TEMP_FILE_MODE = 0o600;

/**
 * Write `data` to `filePath` atomically and durably.
 *
 * On any failure the temporary file is removed and the original target is left
 * untouched.
 */
export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${randomBytes(8).toString('hex')}.tmp`,
  );

  const mode = await targetMode(filePath);

  let handle: FileHandle | undefined;
  try {
    // O_EXCL: refuse to write through a pre-existing file or symlink at this
    // name. Combined with the random suffix, the temp path cannot be predicted
    // and hijacked.
    handle = await open(
      tempPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      TEMP_FILE_MODE,
    );
    await handle.writeFile(data, 'utf-8');
    // The rename only orders against data that actually reached the disk.
    await handle.sync();
    // Match what a plain write would have produced, now that the content is safe.
    await handle.chmod(mode);
    await handle.close();
    handle = undefined;

    await rename(tempPath, filePath);
  } catch (err) {
    // Leave nothing behind, and let the original failure be the one that
    // surfaces — cleanup problems must not mask it.
    await handle?.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw err;
  }
}

/**
 * The mode the finished file should carry: an existing target's own permissions,
 * so a deliberate choice by the user is neither tightened nor loosened, and the
 * conventional default for a file that does not exist yet.
 */
async function targetMode(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return DEFAULT_FILE_MODE;
    }
    throw err;
  }
}
