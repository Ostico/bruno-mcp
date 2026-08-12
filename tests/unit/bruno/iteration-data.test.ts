/**
 * Where a data-driven run's rows come from, and what it refuses.
 *
 * Real files in a real temporary directory throughout. A mocked `readFile`
 * resolves `undefined` rather than rejecting, which fakes an existing file and
 * would make the confinement and absence tests pass against a collection that
 * was never there.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_ITERATION_ROWS,
  readDataFile,
  resolveRows,
} from '../../../src/bruno/iteration-data.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bruno-iteration-data-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('reading a data file', () => {
  it('reads rows from a path relative to the collection', async () => {
    await writeFile(join(root, 'users.csv'), 'user,password\nalice,a1\nbob,b2\n', 'utf8');

    expect(await readDataFile('users.csv', root)).toEqual([
      { user: 'alice', password: 'a1' },
      { user: 'bob', password: 'b2' },
    ]);
  });

  it('reads a file in a subdirectory of the collection', async () => {
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(join(root, 'data', 'users.csv'), 'user\nalice\n', 'utf8');

    expect(await readDataFile('data/users.csv', root)).toEqual([{ user: 'alice' }]);
  });

  it('accepts an absolute path that lands inside the collection', async () => {
    await writeFile(join(root, 'users.csv'), 'user\nalice\n', 'utf8');

    expect(await readDataFile(join(root, 'users.csv'), root)).toEqual([{ user: 'alice' }]);
  });

  it('refuses a relative path that escapes the collection', async () => {
    // The escape target is written inside the temp root the test owns, so a
    // regression that lifts the check reads a file this test put there rather
    // than whatever happens to sit beside the collection on the machine.
    const outside = await mkdtemp(join(tmpdir(), 'bruno-iteration-outside-'));
    const collection = join(outside, 'collection');
    await mkdir(collection, { recursive: true });
    await writeFile(join(outside, 'secrets.csv'), 'token\nhunter2\n', 'utf8');

    try {
      await expect(readDataFile('../secrets.csv', collection)).rejects.toThrow(
        /outside the collection/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses an absolute path outside the collection', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'bruno-iteration-outside-'));
    await writeFile(join(outside, 'secrets.csv'), 'token\nhunter2\n', 'utf8');

    try {
      await expect(readDataFile(join(outside, 'secrets.csv'), root)).rejects.toThrow(
        /outside the collection/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a file that is not there, naming the errno and that nothing ran', async () => {
    await expect(readDataFile('missing.csv', root)).rejects.toThrow(/ENOENT/);
    await expect(readDataFile('missing.csv', root)).rejects.toThrow(/Nothing was run/);
  });

  it("passes the parser's own refusal through with the file named", async () => {
    // The parser names the line and the column count, which is what whoever has
    // to repair the file needs; a summary of it would name neither.
    await writeFile(join(root, 'ragged.csv'), 'user,password\nalice\n', 'utf8');

    await expect(readDataFile('ragged.csv', root)).rejects.toThrow(
      /Data file "ragged\.csv": Line 2: this row has 1 field but the header row names 2 columns/,
    );
  });

  it('refuses a file with a header and no rows', async () => {
    await writeFile(join(root, 'empty.csv'), 'user,password\n', 'utf8');

    await expect(readDataFile('empty.csv', root)).rejects.toThrow(/no rows of values/);
  });
});

describe('resolving one scope\'s rows', () => {
  it('returns undefined when the scope names neither source', async () => {
    expect(await resolveRows({}, root, 'The run')).toBeUndefined();
  });

  it('returns inline rows as given', async () => {
    expect(await resolveRows({ data: [{ user: 'alice' }] }, root, 'The run')).toEqual([
      { user: 'alice' },
    ]);
  });

  it('reads rows from the named file', async () => {
    await writeFile(join(root, 'users.csv'), 'user\nalice\n', 'utf8');

    expect(await resolveRows({ dataFile: 'users.csv' }, root, 'The run')).toEqual([
      { user: 'alice' },
    ]);
  });

  it('refuses both sources at once, naming the scope', async () => {
    await expect(
      resolveRows({ data: [{ user: 'alice' }], dataFile: 'users.csv' }, root, 'Group login'),
    ).rejects.toThrow(/Group login gives both `data` and `dataFile`/);
  });

  it('does not read the file when both sources were given', async () => {
    // The refusal comes first, so a `dataFile` that would itself throw — absent,
    // or outside the collection — still reports the contradiction the caller can
    // act on rather than a second-order complaint about a file they meant to drop.
    await expect(
      resolveRows({ data: [{ user: 'alice' }], dataFile: '../escape.csv' }, root, 'The run'),
    ).rejects.toThrow(/gives both/);
  });

  it('refuses an empty inline row list', async () => {
    await expect(resolveRows({ data: [] }, root, 'The run')).rejects.toThrow(
      /The run gives no rows/,
    );
  });

  it('accepts exactly the ceiling', async () => {
    const rows = Array.from({ length: MAX_ITERATION_ROWS }, (_, n) => ({ n: String(n) }));

    expect(await resolveRows({ data: rows }, root, 'The run')).toHaveLength(MAX_ITERATION_ROWS);
  });

  it('refuses one row over the ceiling, naming the count and the multiplication', async () => {
    const rows = Array.from({ length: MAX_ITERATION_ROWS + 1 }, (_, n) => ({ n: String(n) }));

    await expect(resolveRows({ data: rows }, root, 'The run')).rejects.toThrow(
      new RegExp(`gives ${MAX_ITERATION_ROWS + 1} rows, over the ${MAX_ITERATION_ROWS}-row ceiling`),
    );
    await expect(resolveRows({ data: rows }, root, 'The run')).rejects.toThrow(
      /runs every request in the group/,
    );
  });

  it('applies the ceiling to rows that came from a file', async () => {
    const lines = ['n', ...Array.from({ length: MAX_ITERATION_ROWS + 1 }, (_, n) => String(n))];
    await writeFile(join(root, 'many.csv'), `${lines.join('\n')}\n`, 'utf8');

    await expect(resolveRows({ dataFile: 'many.csv' }, root, 'The run')).rejects.toThrow(
      /over the 1000-row ceiling/,
    );
  });
});
