/**
 * Taking one entry out of a workspace registry.
 *
 * The file belongs to the Bruno app, so these assert on exact bytes rather than
 * on a re-parse: a round-trip that happened to preserve the entries would still
 * have rewritten the app's quoting and turned its empty `specs:` key into
 * `specs: null`.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unregisterCollectionFromWorkspace } from '../../../src/bruno/workspace-unregistrar';

const HEAD = 'opencollection: 1.0.0\ninfo:\n  name: "W"\n  type: workspace\n\ncollections:\n';
const TAIL = '\nspecs:\n\ndocs: \'\'\n';

let dir: string;
let workspacePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'unregister-'));
  workspacePath = join(dir, 'workspace.yml');
});

function entry(name: string, path: string): string {
  return `  - name: "${name}"\n    path: "${path}"\n`;
}

describe('an entry that is listed', () => {
  it('is removed, leaving every other byte as the app wrote it', async () => {
    const before = HEAD + entry('First', '/a') + entry('Second', '/b') + entry('Third', '/c') + TAIL;
    await writeFile(workspacePath, before);

    const result = await unregisterCollectionFromWorkspace(workspacePath, '/b');

    expect(result).toEqual({ outcome: 'removed', workspacePath, name: 'Second' });
    expect(await readFile(workspacePath, 'utf-8'))
      .toBe(HEAD + entry('First', '/a') + entry('Third', '/c') + TAIL);
  });

  it('is matched by resolved path, so a trailing slash still finds it', async () => {
    await writeFile(workspacePath, HEAD + entry('First', '/a/b') + TAIL);

    const result = await unregisterCollectionFromWorkspace(workspacePath, '/a/b/');

    expect(result.outcome).toBe('removed');
    expect(await readFile(workspacePath, 'utf-8')).toBe(HEAD + TAIL);
  });

  it('is matched by path and not by name, since two entries may share one', async () => {
    await writeFile(workspacePath, HEAD + entry('Same', '/a') + entry('Same', '/b') + TAIL);

    await unregisterCollectionFromWorkspace(workspacePath, '/b');

    expect(await readFile(workspacePath, 'utf-8')).toBe(HEAD + entry('Same', '/a') + TAIL);
  });

  it('takes its whole item, however many keys it spans', async () => {
    const wide = '  - name: "Wide"\n    path: "/b"\n    extra: "something the app wrote"\n';
    await writeFile(workspacePath, HEAD + entry('First', '/a') + wide + TAIL);

    await unregisterCollectionFromWorkspace(workspacePath, '/b');

    expect(await readFile(workspacePath, 'utf-8')).toBe(HEAD + entry('First', '/a') + TAIL);
  });

  it('leaves a comment in the block where the app put it', async () => {
    const before = HEAD + '  # the app writes these\n' + entry('First', '/a') + entry('Second', '/b') + TAIL;
    await writeFile(workspacePath, before);

    const result = await unregisterCollectionFromWorkspace(workspacePath, '/a');

    expect(result.outcome).toBe('removed');
    expect(await readFile(workspacePath, 'utf-8'))
      .toBe(HEAD + '  # the app writes these\n' + entry('Second', '/b') + TAIL);
  });

  it('reports no name when the entry has none to report', async () => {
    await writeFile(workspacePath, `${HEAD}  - path: "/a"\n${TAIL}`);

    const result = await unregisterCollectionFromWorkspace(workspacePath, '/a');

    expect(result).toEqual({ outcome: 'removed', workspacePath, name: '' });
    expect(await readFile(workspacePath, 'utf-8')).toBe(HEAD + TAIL);
  });

  it('is the last one, and what follows the block is left where it was', async () => {
    await writeFile(workspacePath, HEAD + entry('First', '/a') + entry('Last', '/b') + TAIL);

    await unregisterCollectionFromWorkspace(workspacePath, '/b');

    // TAIL opens with the blank line that separated the block from `specs:`. A
    // trailing blank line belongs to what follows, not to the item above it.
    expect(await readFile(workspacePath, 'utf-8')).toBe(HEAD + entry('First', '/a') + TAIL);
  });
});

describe('an entry that is not there', () => {
  it('is reported as not listed, and nothing is written', async () => {
    const before = HEAD + entry('First', '/a') + TAIL;
    await writeFile(workspacePath, before);

    const result = await unregisterCollectionFromWorkspace(workspacePath, '/elsewhere');

    expect(result).toEqual({ outcome: 'not-listed', workspacePath });
    expect(await readFile(workspacePath, 'utf-8')).toBe(before);
  });

  it('is reported as not listed when the file is empty', async () => {
    await writeFile(workspacePath, '');

    expect(await unregisterCollectionFromWorkspace(workspacePath, '/a'))
      .toEqual({ outcome: 'not-listed', workspacePath });
  });

  it('is reported as not listed when the workspace has no registry at all', async () => {
    await writeFile(workspacePath, 'opencollection: 1.0.0\ninfo:\n  name: "W"\n');

    expect(await unregisterCollectionFromWorkspace(workspacePath, '/a'))
      .toEqual({ outcome: 'not-listed', workspacePath });
  });

  it('is reported as not listed when the registry is an empty flow list', async () => {
    await writeFile(workspacePath, 'collections: []\n');

    const result = await unregisterCollectionFromWorkspace(workspacePath, '/a');

    // Not 'skipped': an empty list has no entry to remove, which is a plain
    // answer rather than a shape this declines to edit.
    expect(result).toEqual({ outcome: 'not-listed', workspacePath });
  });
});

describe('a workspace this cannot edit a line at a time', () => {
  it('is skipped when there is no file there', async () => {
    const result = await unregisterCollectionFromWorkspace(join(dir, 'absent.yml'), '/a');

    expect(result).toEqual({
      outcome: 'skipped',
      workspacePath: join(dir, 'absent.yml'),
      reason: 'no workspace file there to remove it from',
    });
  });

  it('is skipped when the list is written inline', async () => {
    const before = 'collections: [{name: "First", path: "/a"}]\n';
    await writeFile(workspacePath, before);

    const result = await unregisterCollectionFromWorkspace(workspacePath, '/a');

    expect(result.outcome).toBe('skipped');
    expect((result as { reason: string }).reason).toContain('without rewriting the file');
    expect(await readFile(workspacePath, 'utf-8')).toBe(before);
  });

  it('is skipped when the key is not written as this reads it', async () => {
    // Both are the key `collections` to a YAML parser, so the entry is found —
    // and then the text has no line to remove, which has to be a refusal rather
    // than a removal of the wrong lines.
    const before = `"collections":\n${entry('First', '/a')}`;
    await writeFile(workspacePath, before);

    const result = await unregisterCollectionFromWorkspace(workspacePath, '/a');

    expect(result.outcome).toBe('skipped');
    expect(await readFile(workspacePath, 'utf-8')).toBe(before);
  });

  it('is skipped when an item holds a dash of its own', async () => {
    // The dash inside the block scalar is text, not an item, so counting items by
    // line would find three where the parser finds two — and splice out lines
    // belonging to a different entry.
    const before = HEAD
      + '  - name: "First"\n    path: "/a"\n    docs: |\n      - a bullet, not an entry\n'
      + entry('Second', '/b')
      + TAIL;
    await writeFile(workspacePath, before);

    const result = await unregisterCollectionFromWorkspace(workspacePath, '/b');

    expect(result.outcome).toBe('skipped');
    expect((result as { reason: string }).reason).toContain('without rewriting the file');
    expect(await readFile(workspacePath, 'utf-8')).toBe(before);
  });

  it('is skipped when the list carries an anchor on its own line', async () => {
    const before = `collections:\n  &registry\n${entry('First', '/a')}`;
    await writeFile(workspacePath, before);

    const result = await unregisterCollectionFromWorkspace(workspacePath, '/a');

    expect(result.outcome).toBe('skipped');
    expect(await readFile(workspacePath, 'utf-8')).toBe(before);
  });

  it('is skipped when its YAML cannot be read at all', async () => {
    const before = 'collections:\n  - name: "First"\n   path: "/a"\n';
    await writeFile(workspacePath, before);

    const result = await unregisterCollectionFromWorkspace(workspacePath, '/a');

    expect(result.outcome).toBe('skipped');
    expect((result as { reason: string }).reason).toContain('its YAML could not be read');
    expect(await readFile(workspacePath, 'utf-8')).toBe(before);
  });
});
