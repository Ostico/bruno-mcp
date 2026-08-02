import { readFile } from 'node:fs/promises';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { collectionBruToJson } from '@usebruno/lang';

/**
 * Execution order: which request runs before which.
 *
 * Ordering used to be one global `Array.sort` on `info.seq` over every file
 * found anywhere in the collection. `seq` is scoped to a folder in Bruno, so a
 * global sort interleaves folders — two requests both numbered `seq: 1` in
 * different folders came out in whatever order the directory walk happened to
 * reach them, which is `readdir` order and therefore filesystem-dependent. A
 * whole-collection run had no order a user could predict or reproduce, which
 * matters most where state flows from one request to the next.
 *
 * This is a port of Bruno's own ordering (`bruno-cli/src/utils/collection.js`),
 * not a reimplementation, so a collection runs here in the order it runs there.
 * Three rules, and the second is the surprising one:
 *
 *  1. Requests are ordered **within their own directory** by `seq`.
 *  2. Within a directory, **subfolders come before that directory's own loose
 *     requests** — upstream's `traverse` ends `return folders.concat(requests)`.
 *     So a request sitting at the collection root runs *after* every folder,
 *     however low its `seq`.
 *  3. Sibling folders are ordered by `sortFoldersByNameThenSequence` below.
 */

/** A folder's own `seq`, once read off its root file. */
export interface OrderableFolder {
  name: string;
  seq?: number;
}

/**
 * Upstream's rule for whether a folder's `seq` counts at all.
 *
 * Anything that is not a positive whole number leaves the folder in the
 * alphabetical run rather than being placed. Note this rejects a numeric
 * *string*: upstream's filestore coerces `seq` with `Number()` before ordering
 * sees it, and so does `readFolderSeq` below, so by this point a valid `seq` is
 * a real number.
 */
function isSeqValid(seq: number | undefined): seq is number {
  return typeof seq === 'number' && Number.isFinite(seq) && Number.isInteger(seq) && seq > 0;
}

/**
 * Order sibling folders the way Bruno does: alphabetical, then placed.
 *
 * This is a **positional insert**, not a sort, and porting it as a sort would
 * get different answers. Folders without a valid `seq` stay in alphabetical
 * order and form the baseline list. Folders that have one are then inserted at
 * index `seq - 1` of that list, in ascending `seq` order — so `seq` names the
 * position a folder lands in, not a key it is compared on.
 *
 * Two consequences worth stating, both upstream's:
 *
 *  - Insertion happens into a list that is *growing*, so an earlier insert
 *    shifts the index a later one lands at.
 *  - A `seq` past the end of the list appends rather than erroring, because
 *    `splice` clamps.
 *
 * Same-`seq` folders are grouped: the second one inserts directly after the
 * first rather than displacing it.
 */
export function sortFoldersByNameThenSequence<T extends OrderableFolder>(folders: T[]): T[] {
  const alphabetical = [...folders].sort((a, b) => a.name.localeCompare(b.name));

  const withoutSeq = alphabetical.filter((folder) => !isSeqValid(folder.seq));
  const withSeq = alphabetical
    .filter((folder): folder is T & { seq: number } => isSeqValid(folder.seq))
    .sort((a, b) => a.seq - b.seq);

  const ordered = withoutSeq;
  for (const folder of withSeq) {
    let target = folder.seq - 1;
    // Group equal seqs instead of letting the later one take the position: walk
    // past any already-placed folder sitting there with the same seq.
    while (ordered[target] !== undefined && isSeqValid(ordered[target].seq) && ordered[target].seq === folder.seq) {
      target += 1;
    }
    ordered.splice(target, 0, folder);
  }

  return ordered;
}

/** `meta.seq` for `.bru`, `info.seq` (or `meta.seq`) for `.yml`. */
function seqFromFolderFile(fileName: string, content: string): number | undefined {
  let raw: unknown;

  if (fileName.endsWith('.bru')) {
    raw = (collectionBruToJson(content) as { meta?: { seq?: unknown } })?.meta?.seq;
  } else {
    const doc = parseYaml(content) as { meta?: { seq?: unknown }; info?: { seq?: unknown } } | null;
    raw = doc?.meta?.seq ?? doc?.info?.seq;
  }

  if (raw === undefined || raw === null || raw === '') return undefined;

  // `.bru` yields the string "3" — the grammar has no numbers — so coercing is
  // required, not defensive. Upstream's filestore does the same before ordering
  // runs. A value that will not coerce becomes NaN, which isSeqValid rejects.
  const seq = Number(raw);
  return Number.isNaN(seq) ? undefined : seq;
}

const FOLDER_ROOT_FILES = ['folder.bru', 'folder.yml'] as const;

/**
 * Read a folder's `seq` from its root file, if it has one.
 *
 * Returns `undefined` for every failure — no root file, unreadable, malformed,
 * no `seq` — because ordering must not be able to fail a run. A folder whose
 * root file will not parse is simply unplaced, and lands in the alphabetical
 * run. The parse failure itself surfaces from the request-level read, which is
 * where a user can act on it.
 */
export async function readFolderSeq(dirPath: string): Promise<number | undefined> {
  for (const fileName of FOLDER_ROOT_FILES) {
    let content: string;
    try {
      content = await readFile(join(dirPath, fileName), 'utf-8');
    } catch {
      continue;
    }

    try {
      return seqFromFolderFile(fileName, content);
    } catch {
      return undefined;
    }
  }

  return undefined;
}
