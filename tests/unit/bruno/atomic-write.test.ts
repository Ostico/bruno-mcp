/**
 * Behaviour of writeFileAtomic against a real filesystem (findings D9 / S24).
 */

import { mkdtemp, readFile, writeFile, stat, chmod, readdir, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { writeFileAtomic } from '../../../src/bruno/atomic-write';

describe('writeFileAtomic', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'bruno-atomic-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  const target = () => path.join(workspace, 'request.bru');

  it('creates a file with the given content', async () => {
    await writeFileAtomic(target(), 'meta { name: Get }');

    await expect(readFile(target(), 'utf-8')).resolves.toBe('meta { name: Get }');
  });

  it('replaces the content of an existing file', async () => {
    await writeFile(target(), 'old content');

    await writeFileAtomic(target(), 'new content');

    await expect(readFile(target(), 'utf-8')).resolves.toBe('new content');
  });

  it('leaves no temporary file behind on success', async () => {
    await writeFileAtomic(target(), 'content');

    await expect(readdir(workspace)).resolves.toEqual(['request.bru']);
  });

  it('gives a newly created file the conventional 0o644', async () => {
    await writeFileAtomic(target(), 'content');

    const mode = (await stat(target())).mode & 0o777;
    expect(mode.toString(8)).toBe('644');
  });

  it('never widens permissions the user deliberately narrowed', async () => {
    // An environment file holding secrets may well be 0o600 — rewriting it must
    // not hand it back as world-readable.
    await writeFile(target(), 'secret: value');
    await chmod(target(), 0o600);

    await writeFileAtomic(target(), 'secret: rotated');

    const mode = (await stat(target())).mode & 0o777;
    expect(mode.toString(8)).toBe('600');
  });

  it('preserves a deliberately widened mode too', async () => {
    await writeFile(target(), 'shared');
    await chmod(target(), 0o664);

    await writeFileAtomic(target(), 'shared again');

    const mode = (await stat(target())).mode & 0o777;
    expect(mode.toString(8)).toBe('664');
  });

  it('keeps the original file intact when the write cannot complete', async () => {
    // A directory at the target path makes the final rename fail, standing in
    // for any late failure: the caller must see the error and lose nothing.
    const blocked = path.join(workspace, 'blocked');
    await mkdir(blocked);
    await writeFile(path.join(blocked, 'sentinel'), 'still here');

    await expect(writeFileAtomic(blocked, 'clobber')).rejects.toThrow();

    await expect(readFile(path.join(blocked, 'sentinel'), 'utf-8')).resolves.toBe('still here');
    // and no debris in the parent directory
    await expect(readdir(workspace)).resolves.toEqual(['blocked']);
  });

  it('rejects rather than creating anything when the directory does not exist', async () => {
    const missing = path.join(workspace, 'nope', 'request.bru');

    await expect(writeFileAtomic(missing, 'content')).rejects.toThrow();

    await expect(readdir(workspace)).resolves.toEqual([]);
  });

  it('serialises concurrent writes into one intact winner, never a blend', async () => {
    const a = 'A'.repeat(200_000);
    const b = 'B'.repeat(200_000);

    await Promise.all([writeFileAtomic(target(), a), writeFileAtomic(target(), b)]);

    // Whichever rename landed last wins whole; a torn file would be neither.
    const result = await readFile(target(), 'utf-8');
    expect([a, b]).toContain(result);
    await expect(readdir(workspace)).resolves.toEqual(['request.bru']);
  });
});
