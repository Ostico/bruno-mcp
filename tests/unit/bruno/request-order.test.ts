/**
 * The ordering primitives, away from the filesystem walk that uses them.
 *
 * `execution-order.test.ts` covers what a run ends up executing; this covers
 * the two pieces it is built from — placing sibling folders, and reading a
 * folder's `seq` off its root file in either dialect.
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFolderSeq, sortFoldersByNameThenSequence } from '../../../src/bruno/request-order';

async function folderWith(fileName: string | null, content?: string): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'folder-seq-'));
  if (fileName !== null && content !== undefined) {
    await fs.writeFile(join(dir, fileName), content);
  }
  return dir;
}

describe('placing sibling folders', () => {
  it('falls back to alphabetical when no folder declares a seq', () => {
    const ordered = sortFoldersByNameThenSequence([
      { name: 'charlie' },
      { name: 'alpha' },
      { name: 'bravo' },
    ]);

    expect(ordered.map((f) => f.name)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('treats seq as the position to land in, not a key to sort on', () => {
    // 'zulu' sorts last alphabetically but claims position 1.
    const ordered = sortFoldersByNameThenSequence([
      { name: 'alpha' },
      { name: 'bravo' },
      { name: 'zulu', seq: 1 },
    ]);

    expect(ordered.map((f) => f.name)).toEqual(['zulu', 'alpha', 'bravo']);
  });

  it('inserts into a list that is already growing', () => {
    // The second insert lands relative to the list the first one changed, which
    // is why this is a port of a positional insert and not a sort.
    const ordered = sortFoldersByNameThenSequence([
      { name: 'alpha' },
      { name: 'bravo' },
      { name: 'charlie' },
      { name: 'xray', seq: 1 },
      { name: 'yankee', seq: 3 },
    ]);

    expect(ordered.map((f) => f.name)).toEqual(['xray', 'alpha', 'yankee', 'bravo', 'charlie']);
  });

  it('groups folders that claim the same position instead of displacing', () => {
    const ordered = sortFoldersByNameThenSequence([
      { name: 'alpha' },
      { name: 'yankee', seq: 1 },
      { name: 'zulu', seq: 1 },
    ]);

    expect(ordered.map((f) => f.name)).toEqual(['yankee', 'zulu', 'alpha']);
  });

  it('appends rather than throwing when a seq points past the end', () => {
    const ordered = sortFoldersByNameThenSequence([
      { name: 'alpha' },
      { name: 'zulu', seq: 99 },
    ]);

    expect(ordered.map((f) => f.name)).toEqual(['alpha', 'zulu']);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'leaves a folder in the alphabetical run when its seq is %p',
    (seq) => {
      const ordered = sortFoldersByNameThenSequence([
        { name: 'zulu', seq: seq as number },
        { name: 'alpha' },
      ]);

      expect(ordered.map((f) => f.name)).toEqual(['alpha', 'zulu']);
    },
  );

  it('leaves the caller its own array', () => {
    const input = [{ name: 'bravo' }, { name: 'alpha' }];
    sortFoldersByNameThenSequence(input);

    expect(input.map((f) => f.name)).toEqual(['bravo', 'alpha']);
  });
});

describe('reading a folder seq off its root file', () => {
  it('reads meta.seq from folder.bru, coercing the string the grammar yields', async () => {
    // collectionBruToJson returns seq: "2" — the .bru grammar has no numbers.
    const dir = await folderWith('folder.bru', 'meta {\n  name: x\n  seq: 2\n}\n');

    expect(await readFolderSeq(dir)).toBe(2);
  });

  it('reads info.seq from folder.yml, the key our own dialect writes', async () => {
    const dir = await folderWith('folder.yml', 'info:\n  name: x\n  seq: 4\n');

    expect(await readFolderSeq(dir)).toBe(4);
  });

  it('reads meta.seq from folder.yml, the key upstream writes', async () => {
    const dir = await folderWith('folder.yml', 'meta:\n  name: x\n  seq: 5\n');

    expect(await readFolderSeq(dir)).toBe(5);
  });

  it('prefers meta over info when a folder.yml carries both', async () => {
    const dir = await folderWith('folder.yml', 'meta:\n  seq: 1\ninfo:\n  seq: 9\n');

    expect(await readFolderSeq(dir)).toBe(1);
  });

  it('returns undefined when the folder has no root file', async () => {
    const dir = await folderWith(null);

    expect(await readFolderSeq(dir)).toBeUndefined();
  });

  it('returns undefined when the root file declares no seq', async () => {
    const dir = await folderWith('folder.bru', 'meta {\n  name: x\n}\n');

    expect(await readFolderSeq(dir)).toBeUndefined();
  });

  it.each([
    ['folder.bru', 'this is not { valid bru'],
    ['folder.yml', 'key: [unclosed'],
  ])('returns undefined rather than throwing when %s will not parse', async (name, content) => {
    // Ordering must not be able to fail a run: an unparseable folder root leaves
    // the folder unplaced. The parse failure itself surfaces from the
    // request-level read, where a user can act on it.
    const dir = await folderWith(name, content);

    await expect(readFolderSeq(dir)).resolves.toBeUndefined();
  });

  it('returns undefined for a seq that will not coerce to a number', async () => {
    const dir = await folderWith('folder.yml', 'info:\n  seq: "later"\n');

    expect(await readFolderSeq(dir)).toBeUndefined();
  });

  it('returns undefined for an empty seq rather than reading it as zero', async () => {
    // Number('') is 0, which would place the folder at index -1.
    const dir = await folderWith('folder.yml', 'info:\n  seq: ""\n');

    expect(await readFolderSeq(dir)).toBeUndefined();
  });
});
