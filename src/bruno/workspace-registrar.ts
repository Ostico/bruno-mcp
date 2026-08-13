import { promises as fs } from 'fs';
import { resolve as resolvePath } from 'path';
import { createWorkspaceResolver } from './workspace.js';

/**
 * `workspacePath` is on every outcome so that a report can name the file it
 * considered. A skip always carries its reason, rather than an optional one a
 * caller has to invent a fallback for.
 */
export type RegistrationResult =
  /** The entry was written. */
  | { outcome: 'added'; workspacePath: string }
  /** The workspace already lists a collection at that path. */
  | { outcome: 'already-listed'; workspacePath: string }
  /** Nothing was written. */
  | { outcome: 'skipped'; workspacePath: string; reason: string };

/**
 * Add a collection to a workspace's registry.
 *
 * The file is edited textually rather than parsed and re-serialised. A workspace
 * belongs to the Bruno app, not to us: the one on this machine quotes every
 * scalar, carries an `opencollection` version, and holds an empty `specs:` key
 * that a YAML round-trip would rewrite as `specs: null`. Inserting a line leaves
 * every other byte exactly as the app wrote it.
 *
 * Reading, by contrast, goes through the same parser `list_collections` uses, so
 * "is it already listed" is answered by the same rules that decide whether it
 * shows up.
 */
export async function registerCollectionInWorkspace(
  workspacePath: string,
  collection: { name: string; path: string },
): Promise<RegistrationResult> {
  if (collection.name.includes('\n') || collection.path.includes('\n')) {
    return {
      outcome: 'skipped',
      workspacePath,
      reason: 'a collection name or path containing a line break cannot be written as one entry',
    };
  }

  let content: string;
  try {
    content = await fs.readFile(workspacePath, 'utf-8');
  } catch {
    return {
      outcome: 'skipped',
      workspacePath,
      // Creating the file would mean inventing a workspace name and version on
      // the app's behalf, and a workspace the app does not know about is not a
      // place a collection becomes visible.
      reason: 'no workspace file there to add it to',
    };
  }

  const listed = createWorkspaceResolver().parseWorkspaceYaml(content);
  const target = resolvePath(collection.path);
  if (listed.some((entry) => resolvePath(entry.path) === target)) {
    return { outcome: 'already-listed', workspacePath };
  }

  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const entry = `  - name: ${quote(collection.name)}${newline}    path: ${quote(collection.path)}${newline}`;

  const inserted = insertEntry(content, entry, newline);
  if (inserted === undefined) {
    return {
      outcome: 'skipped',
      workspacePath,
      reason: 'its collections list is written in a shape this cannot extend without rewriting the file',
    };
  }

  await fs.writeFile(workspacePath, inserted, 'utf-8');
  return { outcome: 'added', workspacePath };
}

/** A double-quoted YAML scalar, which is the style the app itself writes. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Put `entry` at the end of the `collections:` block, or return undefined if the
 * block is in a shape that cannot be extended a line at a time.
 */
function insertEntry(content: string, entry: string, newline: string): string | undefined {
  const lines = content.split(/(?<=\n)/);
  // Any top-level `collections:`, whatever follows it. Matching only the shapes
  // this knows how to extend would send the rest down the append path and write a
  // second key into a file that already had one.
  const keyIndex = lines.findIndex((line) => /^collections:(?=[ \t]|\r?\n?$)/.test(line));

  if (keyIndex === -1) {
    // No registry at all. Appending one is additive, and a workspace with no
    // `collections` key lists nothing either way.
    const separator = content.length === 0 || content.endsWith('\n') ? '' : newline;
    return `${content}${separator}collections:${newline}${entry}`;
  }

  const value = /^collections:[ \t]*(.*?)[ \t]*\r?\n?$/.exec(lines[keyIndex]!)![1]!;
  if (value === '[]') {
    // An empty flow list becomes a block list, which is what every non-empty
    // registry on disk looks like.
    lines[keyIndex] = `collections:${newline}`;
    lines.splice(keyIndex + 1, 0, entry);
    return lines.join('');
  }
  if (value !== '') {
    // A populated flow list, an anchor, or an alias. Extending it means
    // rewriting it, which is the thing this avoids.
    return undefined;
  }

  // The block runs to the next line that starts a key of its own. Trailing blank
  // lines belong to whatever follows, so the entry goes above them.
  let end = keyIndex + 1;
  let lastItem = keyIndex;
  while (end < lines.length && !/^\S/.test(lines[end]!)) {
    if (lines[end]!.trim() !== '') {
      lastItem = end;
    }
    end += 1;
  }

  lines.splice(lastItem + 1, 0, entry);
  return lines.join('');
}
