/**
 * The writers are wired to the durable, serialized primitives (findings D8/D9).
 *
 * The atomic-write and path-mutex suites prove the primitives in isolation. These
 * run the real EnvironmentManager against a real collection on disk, which is the
 * only way to show the defect is actually gone rather than merely fixable: two
 * concurrent edits to the same environment must both survive.
 */

import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EnvironmentManager } from '../../../src/bruno/environment';
import { generateBruEnvironmentFull } from '../../../src/bruno/bru-parser';

describe('environment writes are durable and serialized', () => {
  let collection: string;
  let manager: EnvironmentManager;

  beforeEach(async () => {
    collection = await mkdtemp(path.join(tmpdir(), 'bruno-collection-'));
    await writeFile(
      path.join(collection, 'bruno.json'),
      JSON.stringify({ version: '1', name: 'test', type: 'collection' }, null, 2),
    );
    await mkdir(path.join(collection, 'environments'));
    await writeFile(
      path.join(collection, 'environments', 'dev.bru'),
      generateBruEnvironmentFull([{ name: 'base', value: 'seed' }]),
    );
    manager = new EnvironmentManager();
  });

  afterEach(async () => {
    await rm(collection, { recursive: true, force: true });
  });

  const readVars = async () => {
    const raw = await manager.loadEnvironmentRaw(collection, 'dev');
    return Object.fromEntries(raw.map((v) => [v.name, String(v.value)]));
  };

  it('keeps both edits when two variables are set concurrently', async () => {
    // Unserialised, both calls read the same starting state and the second write
    // discards the first variable — the lost update D8 describes.
    await Promise.all([
      manager.setEnvironmentVariable(collection, 'dev', 'alpha', 'a-value'),
      manager.setEnvironmentVariable(collection, 'dev', 'beta', 'b-value'),
    ]);

    const vars = await readVars();
    expect(vars.alpha).toBe('a-value');
    expect(vars.beta).toBe('b-value');
    expect(vars.base).toBe('seed');
  });

  it('keeps every edit when many are applied concurrently', async () => {
    const keys = Array.from({ length: 12 }, (_, i) => `key${i}`);

    await Promise.all(keys.map((k) => manager.setEnvironmentVariable(collection, 'dev', k, k)));

    const vars = await readVars();
    for (const k of keys) {
      expect(vars[k]).toBe(k);
    }
  });

  it('does not lose a concurrent set when a removal runs against the same file', async () => {
    await manager.setEnvironmentVariable(collection, 'dev', 'doomed', 'x');

    await Promise.all([
      manager.removeEnvironmentVariable(collection, 'dev', 'doomed'),
      manager.setEnvironmentVariable(collection, 'dev', 'kept', 'y'),
    ]);

    const vars = await readVars();
    expect(vars.kept).toBe('y');
    expect(vars.doomed).toBeUndefined();
  });

  it('leaves no temporary files in the environments directory', async () => {
    await manager.setEnvironmentVariable(collection, 'dev', 'alpha', 'a');

    await expect(readdir(path.join(collection, 'environments'))).resolves.toEqual(['dev.bru']);
  });

  it('never leaves the environment file empty or truncated', async () => {
    await Promise.all([
      manager.setEnvironmentVariable(collection, 'dev', 'alpha', 'a'),
      manager.setEnvironmentVariable(collection, 'dev', 'beta', 'b'),
    ]);

    const content = await readFile(path.join(collection, 'environments', 'dev.bru'), 'utf-8');
    expect(content.trim()).not.toBe('');
    expect(content).toContain('vars');
  });
});
