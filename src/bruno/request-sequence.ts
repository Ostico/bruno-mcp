import { readFile, readdir } from 'node:fs/promises';
import { join } from 'path';
import { parseYamlRequest } from './yaml-parser.js';
import { parseBruRequest } from './bru-parser.js';
import { isMetadataFile } from './metadata-files.js';
import { isRequestFile, isYamlRequestFile } from './request-extensions.js';

/**
 * Choosing the `seq` for a newly created request.
 *
 * `seq` is what orders requests in a run. Creating one without a `seq` left the
 * field out of the file altogether, and the run order treats a missing `seq` as
 * `MAX_SAFE_INTEGER` — so every request created without an explicit sequence
 * piled up at the end, in an order decided by nothing. "Add a request" means add
 * it after the others, which is what this computes.
 */

/**
 * One past the highest `seq` among the request files already in `dirPath`.
 *
 * Returns 1 for a folder with no requests, so the first request in a collection
 * is `seq: 1` rather than `seq: 0` — Bruno's sequences are 1-based.
 *
 * **Highest + 1, where Bruno uses count + 1.** Upstream assigns
 * `items.length + 1` when it creates a request, which is the same number in any
 * collection Bruno itself wrote, because it keeps sequences dense and rewrites
 * them on reorder. The two differ only where a collection has gaps — a
 * hand-edited file, or a sibling created by a tool that skipped a number — and
 * there `count + 1` returns a `seq` some existing request already holds. Two
 * requests with one `seq` sort against each other arbitrarily, which is the
 * defect this function exists to remove, so it takes the maximum instead.
 *
 * Not atomic against a concurrent create in the same folder. The per-path lock
 * that guards writing is keyed on the new file's own path, so two creations of
 * *different* files in one folder do not exclude each other and can choose the
 * same `seq`. That is the same collision Bruno's own `length + 1` allows, and it
 * is no worse than the missing `seq` it replaces; a folder-level lock would have
 * to nest inside the path lock, which is not reentrant.
 */
export async function nextRequestSequence(
  dirPath: string,
  collectionPath: string,
): Promise<number> {
  const sequences = await requestSequencesIn(dirPath, collectionPath);
  return sequences.reduce((highest, seq) => (seq > highest ? seq : highest), 0) + 1;
}

/**
 * Every `seq` declared by the request files in one folder, in readdir order.
 *
 * A folder that cannot be listed yields none, so a caller ordering against it
 * behaves as it would for an empty folder. A sibling that will not parse is
 * skipped rather than fatal: failing an operation because an unrelated file in
 * the folder is malformed would be a worse trade than a `seq` that ignores it.
 *
 * Folder metadata files are excluded — a `folder.bru` carries the folder's own
 * sequence among its siblings, which is a different number in a different scale
 * from the requests inside it.
 */
export async function requestSequencesIn(
  dirPath: string,
  collectionPath: string,
): Promise<number[]> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const sequences: number[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isRequestFile(entry.name)) {
      continue;
    }

    const fullPath = join(dirPath, entry.name);
    if (isMetadataFile(fullPath, collectionPath)) {
      continue;
    }

    const seq = await readRequestSequence(fullPath);
    if (seq !== undefined) {
      sequences.push(seq);
    }
  }

  return sequences;
}

/**
 * The `seq` a request file declares, or `undefined` if it has none.
 *
 * No revalidation of the value: both parsers already yield `number | undefined`
 * and neither can hand back a string or a NaN. Measured rather than assumed —
 * `seq: abc` comes back `undefined` from both dialects, and a quoted `seq: "5"`
 * is rejected by the YAML parser too. A guard here would have been unreachable
 * code that looked like caution.
 *
 * A `seq` of 0 or below needs no special case either: the running maximum starts
 * at 0, so it never wins the comparison.
 */
export async function readRequestSequence(filePath: string): Promise<number | undefined> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return isYamlRequestFile(filePath)
      ? parseYamlRequest(content).info.seq
      : parseBruRequest(content).meta.seq;
  } catch {
    return undefined;
  }
}
