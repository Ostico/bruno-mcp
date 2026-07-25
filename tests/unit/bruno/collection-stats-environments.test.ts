/**
 * Tests for environmentDetails on getCollectionStats.
 *
 * Before this, a caller could see THAT an environment existed but not what it
 * declared, which made set_environment_variable's "MERGES into the environment"
 * a promise about state the caller had no way to observe. Names are exposed;
 * values are not, because environments routinely hold tokens.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getCollectionStats } from '../../../src/bruno/collection-stats';

const FIXTURES = join(__dirname, '..', '..', 'fixtures');
const SAMPLE = join(FIXTURES, 'sample-collection');
const EMPTY = join(FIXTURES, 'empty-collection');

describe('getCollectionStats environmentDetails', () => {
  it('lists the variable names declared by each environment', async () => {
    const stats = await getCollectionStats(SAMPLE);
    const dev = stats.environmentDetails.find((e) => e.name === 'dev');

    expect(dev).toBeDefined();
    expect(dev!.variables).toEqual(['url', 'api-key', 'disabled-var']);
  });

  it('includes disabled variables, since they still occupy the name', async () => {
    // A caller merging into this environment needs to know the key is taken,
    // whether or not it is currently enabled.
    const stats = await getCollectionStats(SAMPLE);
    const dev = stats.environmentDetails.find((e) => e.name === 'dev')!;
    expect(dev.variables).toContain('disabled-var');
  });

  it('does not leak variable values', async () => {
    const stats = await getCollectionStats(SAMPLE);
    const serialized = JSON.stringify(stats.environmentDetails);

    expect(serialized).not.toContain('abc123');
    expect(serialized).not.toContain('https://dev.matecat.com');
  });

  it('stays consistent with the plain environments listing', async () => {
    const stats = await getCollectionStats(SAMPLE);
    expect(stats.environmentDetails.map((e) => e.name)).toEqual(stats.environments);
  });

  it('is an empty array for a collection with no environments directory', async () => {
    const stats = await getCollectionStats(EMPTY);
    expect(stats.environmentDetails).toEqual([]);
  });
});

describe('getCollectionStats environmentDetails — edge cases', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'bruno-envdetails-'));
    await fs.mkdir(join(dir, 'environments'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reports a malformed environment with no variables rather than dropping it', async () => {
    await fs.writeFile(join(dir, 'environments', 'broken.yml'), ':\n  not: [valid', 'utf-8');

    const stats = await getCollectionStats(dir);
    expect(stats.environmentDetails).toEqual([{ name: 'broken', variables: [] }]);
  });

  it('reports an environment with no variables key as empty', async () => {
    await fs.writeFile(join(dir, 'environments', 'bare.yml'), 'name: bare\n', 'utf-8');

    const stats = await getCollectionStats(dir);
    expect(stats.environmentDetails).toEqual([{ name: 'bare', variables: [] }]);
  });

  it('sorts environments by name', async () => {
    for (const n of ['staging', 'dev', 'prod']) {
      await fs.writeFile(
        join(dir, 'environments', `${n}.yml`),
        `variables:\n  - name: host\n    value: x\n`,
        'utf-8',
      );
    }

    const stats = await getCollectionStats(dir);
    expect(stats.environmentDetails.map((e) => e.name)).toEqual(['dev', 'prod', 'staging']);
  });

  it('reads .bru environments as well as .yml', async () => {
    await fs.writeFile(
      join(dir, 'environments', 'legacy.bru'),
      'vars {\n  token: abc\n  region: eu\n}\n',
      'utf-8',
    );

    const stats = await getCollectionStats(dir);
    const legacy = stats.environmentDetails.find((e) => e.name === 'legacy');
    expect(legacy!.variables).toEqual(['token', 'region']);
  });

  it('ignores non-environment files in the directory', async () => {
    await fs.writeFile(join(dir, 'environments', 'notes.txt'), 'ignore me', 'utf-8');
    await fs.writeFile(
      join(dir, 'environments', 'dev.yml'),
      'variables:\n  - name: host\n    value: x\n',
      'utf-8',
    );

    const stats = await getCollectionStats(dir);
    expect(stats.environmentDetails.map((e) => e.name)).toEqual(['dev']);
  });
});
