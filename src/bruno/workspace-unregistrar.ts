import { promises as fs } from 'fs';
import { resolve as resolvePath } from 'path';
import { parse as parseYaml } from 'yaml';

/**
 * `workspacePath` is on every outcome so a report can name the file it
 * considered, and a removal carries the name it took out so the caller can see
 * which entry went — a stale registry often holds several entries whose paths
 * differ only in a temp directory suffix.
 */
export type UnregistrationResult =
  /** The entry was taken out. */
  | { outcome: 'removed'; workspacePath: string; name: string }
  /** No entry in that workspace points at that path. */
  | { outcome: 'not-listed'; workspacePath: string }
  /** Nothing was written. */
  | { outcome: 'skipped'; workspacePath: string; reason: string };

/** One `- name: …` item in the `collections` block, as a line range. */
interface ItemRange {
  start: number;
  /** Inclusive, and never a trailing blank line: those belong to what follows. */
  end: number;
}

/**
 * Remove a collection from a workspace's registry.
 *
 * The counterpart of registerCollectionInWorkspace, and textual for the same
 * reason: the workspace belongs to the Bruno app, which quotes every scalar
 * and keeps an empty `specs:` key that a YAML round-trip would rewrite as
 * `specs: null`. Deleting the lines of one entry leaves every other byte as the
 * app wrote it.
 *
 * Matching is by resolved path rather than by name, because the path is what
 * identifies a collection to everything that reads the registry, and two entries
 * are allowed to share a name.
 */
export async function unregisterCollectionFromWorkspace(
  workspacePath: string,
  collectionPath: string,
): Promise<UnregistrationResult> {
  let content: string;
  try {
    content = await fs.readFile(workspacePath, 'utf-8');
  } catch {
    return { outcome: 'skipped', workspacePath, reason: 'no workspace file there to remove it from' };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (reason) {
    // `String` rather than a message-or-not branch: the parser's own toString
    // already reads as "YAMLParseError: …", and a branch nothing can reach is a
    // branch no test can defend.
    return {
      outcome: 'skipped',
      workspacePath,
      reason: `its YAML could not be read: ${String(reason)}`,
    };
  }

  // The raw list, not the filtered one `list_collections` reads: an entry this
  // cannot understand still occupies a line, and dropping it here would put the
  // index out of step with the text below.
  const entries = isRecord(parsed) && Array.isArray(parsed.collections) ? parsed.collections : [];
  const target = resolvePath(collectionPath);
  const index = entries.findIndex(
    (entry) => isRecord(entry) && typeof entry.path === 'string' && resolvePath(entry.path) === target,
  );
  if (index === -1) {
    return { outcome: 'not-listed', workspacePath };
  }

  const lines = content.split(/(?<=\n)/);
  const items = itemRanges(lines);
  if (items === undefined || items.length !== entries.length) {
    // Either the list is not a block list, or the text holds a different number
    // of items than the parse found — a flow list, an anchor, or an alias. All
    // of them would need the file rewritten, which is the thing this avoids.
    return {
      outcome: 'skipped',
      workspacePath,
      reason: 'its collections list is written in a shape this cannot edit without rewriting the file',
    };
  }

  const { start, end } = items[index]!;
  const entry = entries[index];
  const name = isRecord(entry) && typeof entry.name === 'string' ? entry.name : '';
  lines.splice(start, end - start + 1);

  await fs.writeFile(workspacePath, lines.join(''), 'utf-8');
  return { outcome: 'removed', workspacePath, name };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The line range of each item in the top-level `collections` block, in file
 * order, or undefined if the block is not a block list this can edit a line at a
 * time.
 */
function itemRanges(lines: string[]): ItemRange[] | undefined {
  const keyIndex = lines.findIndex((line) => /^collections:(?=[ \t]|\r?\n?$)/.test(line));
  if (keyIndex === -1) {
    return undefined;
  }

  const value = /^collections:[ \t]*(.*?)[ \t]*\r?\n?$/.exec(lines[keyIndex]!)![1]!;
  if (value !== '') {
    // A flow list, an anchor or an alias. `collections: []` lands here too, and
    // correctly: it holds no entry to remove.
    return undefined;
  }

  const ranges: ItemRange[] = [];
  for (let i = keyIndex + 1; i < lines.length && !/^\S/.test(lines[i]!); i += 1) {
    const line = lines[i]!;
    if (/^[ \t]*-(?=[ \t]|\r?\n?$)/.test(line)) {
      ranges.push({ start: i, end: i });
      continue;
    }
    if (line.trim() === '' || /^[ \t]*#/.test(line)) {
      // Neither a blank line nor a comment extends the item above it: that keeps a
      // blank line with whatever follows the block, and keeps a comment from being
      // deleted along with the entry it happens to sit under.
      continue;
    }

    const current = ranges[ranges.length - 1];
    if (current === undefined) {
      // Indented content before the first `-` — a tag or an anchor written on its
      // own line. Not a shape this can count items in.
      return undefined;
    }
    // A continuation of the item above: its second key.
    current.end = i;
  }

  return ranges;
}
