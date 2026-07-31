/**
 * Choosing the `seq` for a new request.
 *
 * Creating a request without an explicit sequence wrote no `seq` at all, and the
 * run order treats a missing `seq` as MAX_SAFE_INTEGER — so every request
 * created that way tied for last and ran in an order decided by nothing. "Add a
 * request" means after the others, which is what this computes.
 */

import { nextRequestSequence } from '../../../src/bruno/request-sequence';
import * as fs from 'node:fs/promises';

jest.mock('node:fs/promises');
const mockedFs = jest.mocked(fs);

function bru(seq?: number): string {
  const seqLine = seq === undefined ? '' : `  seq: ${seq}\n`;
  return `meta {\n  name: R\n  type: http\n${seqLine}}\n\nget {\n  url: https://api.test/x\n}\n`;
}

function yml(seq?: number): string {
  const seqLine = seq === undefined ? '' : `  seq: ${seq}\n`;
  return `info:\n  name: R\n  type: http\n${seqLine}http:\n  method: GET\n  url: https://api.test/x\n`;
}

/** Only the named files exist; readdir lists exactly their basenames. */
function fsWith(dir: string, files: Record<string, string>): void {
  mockedFs.readdir.mockImplementation(async (dirPath: any) => {
    if (String(dirPath) !== dir) {
      const err = new Error(`ENOENT: ${dirPath}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return Object.keys(files).map(name => ({
      name,
      isFile: () => true,
      isDirectory: () => false,
    })) as never;
  });

  mockedFs.readFile.mockImplementation(async (filePath: any) => {
    const content = files[String(filePath).split('/').pop() as string];
    if (content === undefined) {
      throw new Error(`ENOENT: ${filePath}`);
    }
    return content;
  });
}

describe('nextRequestSequence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('starts at 1 in an empty folder', async () => {
    // 1, not 0 — Bruno's sequences are 1-based.
    fsWith('/c', {});

    expect(await nextRequestSequence('/c', '/c')).toBe(1);
  });

  it('starts at 1 when the folder cannot be listed at all', async () => {
    fsWith('/c', {});

    expect(await nextRequestSequence('/c/missing', '/c')).toBe(1);
  });

  it('goes one past the highest existing sequence', async () => {
    fsWith('/c', { 'a.bru': bru(1), 'b.bru': bru(2), 'c.bru': bru(3) });

    expect(await nextRequestSequence('/c', '/c')).toBe(4);
  });

  it('uses the highest, not the count, when the sequences have gaps', async () => {
    // The divergence from upstream, and the reason for it: Bruno assigns
    // `items.length + 1`, which here would be 4 — a number b.bru already holds.
    // Two requests with one `seq` sort against each other arbitrarily.
    fsWith('/c', { 'a.bru': bru(1), 'b.bru': bru(4), 'c.bru': bru(9) });

    expect(await nextRequestSequence('/c', '/c')).toBe(10);
  });

  it('reads sequences from both dialects', async () => {
    fsWith('/c', { 'a.bru': bru(2), 'b.yml': yml(5), 'c.yaml': yml(7) });

    expect(await nextRequestSequence('/c', '/c')).toBe(8);
  });

  it('ignores the collection and folder metadata files', async () => {
    // A root file has no `seq` to contribute, and parsing it as a request would
    // throw. It must not be counted either way.
    fsWith('/c', {
      'collection.bru': 'auth {\n  mode: none\n}\n',
      'folder.bru': 'meta {\n  name: f\n  seq: 99\n}\n',
      'a.bru': bru(2),
    });

    expect(await nextRequestSequence('/c', '/c')).toBe(3);
  });

  it('ignores files that are not requests', async () => {
    fsWith('/c', { 'notes.md': '# seq: 50', 'a.bru': bru(2) });

    expect(await nextRequestSequence('/c', '/c')).toBe(3);
  });

  it('skips a sibling that will not parse rather than failing', async () => {
    // Refusing to create a request because an unrelated file in the folder is
    // malformed would be the worse trade.
    fsWith('/c', { 'broken.bru': 'meta {\n  unclosed: yes\n', 'a.bru': bru(4) });

    expect(await nextRequestSequence('/c', '/c')).toBe(5);
  });

  it('treats a request with no sequence as contributing nothing', async () => {
    fsWith('/c', { 'a.bru': bru(), 'b.bru': bru(2) });

    expect(await nextRequestSequence('/c', '/c')).toBe(3);
  });

  it('ignores a sequence that is not a usable number', async () => {
    // `seq: abc` comes back from the parser as `undefined`, not as NaN or as the
    // string — checked against both dialects rather than guessed, which is why
    // there is no revalidation in readSequence.
    fsWith('/c', {
      'junk.bru': 'meta {\n  name: R\n  type: http\n  seq: abc\n}\n\nget {\n  url: https://x\n}\n',
      'a.bru': bru(6),
    });

    expect(await nextRequestSequence('/c', '/c')).toBe(7);
  });

  it('ignores a zero or negative sequence', async () => {
    // Both parse to real numbers, so this is the running maximum starting at 0
    // doing the work rather than a guard.
    fsWith('/c', { 'a.bru': bru(0), 'b.bru': bru(-4) });

    expect(await nextRequestSequence('/c', '/c')).toBe(1);
  });

  it('counts only the target folder, not a nested one', async () => {
    // readdir is not recursive here on purpose: `seq` orders siblings, so a
    // deeper folder's numbering is none of this folder's business.
    fsWith('/c', { 'a.bru': bru(2) });

    expect(await nextRequestSequence('/c', '/c')).toBe(3);
    expect(mockedFs.readdir).toHaveBeenCalledTimes(1);
  });
});
