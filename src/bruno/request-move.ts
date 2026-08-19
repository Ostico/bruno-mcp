/**
 * Relocating a request file, within a collection or between two of them.
 *
 * The bytes are moved verbatim. Nothing is parsed and rewritten, which is the
 * whole design: a round-trip through the parsers would drop the keys neither
 * dialect models — a `.bru` file's unknown top-level blocks do not survive
 * regeneration — and losing part of a request to relocating it would be a worse
 * bug than the one this closes. A copy is the same operation without the unlink.
 *
 * The consequence is that `seq` arrives unchanged, so a request can land next to
 * a sibling that already claims its number. That is reported rather than
 * repaired: Bruno breaks such a tie by filename, so the ordering is defined, and
 * the alternative — renumbering — is exactly the parse-and-rewrite this avoids.
 *
 * Renaming is not part of this. `write_request` renames a request and its file;
 * this moves a file and keeps its name. Each operation stays one call, the way
 * Bruno's own rename and drag-and-drop are separate.
 */

import { constants, promises as fs } from 'fs';
import { basename, isAbsolute, join, relative } from 'path';
import { withPathLock } from './path-mutex.js';
import { validatePath } from './path-validator.js';
import { readRequestSequence, requestSequencesIn } from './request-sequence.js';

export interface MoveRequestInput {
  /** Absolute path to the request file to relocate. */
  filePath: string;
  /**
   * Absolute path to the root of the collection it lands in — the directory
   * holding `bruno.json` or `opencollection.yml`, already resolved by the
   * caller.
   */
  targetCollectionPath: string;
  /** Folder inside that collection, relative to its root. Omitted means the root. */
  targetFolder?: string;
  /** Leave the original where it is. */
  copy?: boolean;
}

export interface MoveRequestResult {
  success: boolean;
  /** Where the file now is, present only on success. */
  path?: string;
  error?: string;
  warnings: string[];
}

export async function moveRequestFile(input: MoveRequestInput): Promise<MoveRequestResult> {
  // Locked on the source, which is the path another writer would be holding: an
  // injection that had already read this file must not write it back after the
  // unlink and resurrect a request reported as moved. The destination is a path
  // no one else knows about yet, and taking a second lock here could deadlock
  // against a caller moving the other way.
  return withPathLock(input.filePath, () => moveLocked(input));
}

async function moveLocked(input: MoveRequestInput): Promise<MoveRequestResult> {
  const { filePath, targetCollectionPath, targetFolder, copy } = input;
  const warnings: string[] = [];

  const folder = (targetFolder ?? '').trim();
  if (isAbsolute(folder)) {
    return {
      success: false,
      error: 'targetFolder must be relative to the collection root, not an absolute path.',
      warnings,
    };
  }

  const destinationDirectory = join(targetCollectionPath, folder);
  const confinement = validatePath(destinationDirectory, targetCollectionPath);
  if (!confinement.valid) {
    return {
      success: false,
      error: `Invalid targetFolder: ${confinement.reason}.`,
      warnings,
    };
  }

  const target = join(destinationDirectory, basename(filePath));
  if (target === filePath) {
    return {
      success: false,
      error: copy === true
        ? 'A copy would land on the request itself. The file keeps its name, so a copy '
          + 'needs a different folder or collection.'
        : 'The request is already in that folder.',
      warnings,
    };
  }

  try {
    // Read before the copy: afterwards the file is one of the siblings, and
    // would collide with itself.
    const sequence = await readRequestSequence(filePath);
    const taken = await requestSequencesIn(destinationDirectory, targetCollectionPath);
    if (sequence !== undefined && taken.includes(sequence)) {
      warnings.push(
        `The request arrives with seq ${sequence}, which a request already in that folder `
          + 'also declares. Bruno breaks the tie by filename, so the order is defined but may '
          + 'not be the one you want. Nothing was renumbered, because rewriting the file to '
          + 'change one number would drop any block this server does not model.',
      );
    }

    // `recursive` reports the first directory it had to create, so this both
    // makes the folder and answers whether it existed, with no separate stat to
    // race against.
    const created = await fs.mkdir(destinationDirectory, { recursive: true });
    if (created !== undefined) {
      warnings.push(
        `Created folder ${relative(targetCollectionPath, destinationDirectory)} in the target `
          + 'collection. It has no folder settings file, so it carries no folder-level auth, '
          + 'headers or scripts, and it sorts among its siblings by name.',
      );
    }

    // EXCL rather than a preceding stat: the check and the write are one
    // syscall, so a file that appears in between cannot be overwritten.
    await fs.copyFile(filePath, target, constants.COPYFILE_EXCL);

    if (copy !== true) {
      // After the copy, never before. If this order were reversed and the copy
      // failed, the request would be gone.
      await fs.unlink(filePath);
    }

    return { success: true, path: target, warnings };
  } catch (error) {
    if (isErrorWithCode(error) && error.code === 'EEXIST') {
      return {
        success: false,
        error: `"${basename(target)}" already exists in that folder. Nothing was moved.`,
        warnings,
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      warnings,
    };
  }
}

/**
 * `instanceof Error` is false for a builtin thrown from another realm, which is
 * what happens under jest, so the code is read structurally.
 */
function isErrorWithCode(error: unknown): error is { code?: string } {
  return typeof error === 'object' && error !== null && 'code' in error;
}
