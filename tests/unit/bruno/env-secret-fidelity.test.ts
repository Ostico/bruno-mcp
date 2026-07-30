/**
 * A secret environment variable must never have its value written to a file.
 *
 * Neither on-disk format stores one. `.bru` lists the bare name inside
 * `vars:secret [ ... ]`; `.yml` writes `secret: true` with the name and no
 * `value` key at all. Bruno keeps the value in its own store, outside the
 * collection. Verified against the serializers Bruno itself uses:
 * `@usebruno/lang/v2/src/jsonToEnv.js` (the `vars:secret` array is built from
 * names only) and `bruno-filestore/src/formats/yml/stringifyEnvironment.ts`
 * (a `v.secret === true` variable becomes `{ secret: true, name }`).
 *
 * Every assertion here reads the bytes on disk. Reading back through our own
 * parser would not do: the parser is tolerant of our own output, so a
 * round-trip test passes while the file still holds the credential.
 *
 * The flag spans two ends of one data path and both are covered below, because
 * fixing either alone still loses secrets: the authoring end (a variable marked
 * secret must be written as one) and the read-modify-write end (an unrelated
 * edit must not demote an existing secret variable to plaintext).
 *
 * Fixtures use an obvious placeholder for the value so a leak shows up as that
 * literal string rather than as anything resembling a real credential.
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EnvironmentManager } from '../../../src/bruno/environment';
import { generateYamlEnvironment } from '../../../src/bruno/yaml-generator';
import { generateBruEnvironmentFull, parseBruEnvironmentFile } from '../../../src/bruno/bru-parser';

/** Value that must never reach a file once a variable is marked secret. */
const LEAK_CANARY = 'MUST_NOT_REACH_DISK';

let collection: string;
let manager: EnvironmentManager;

const envPath = (name: string) => path.join(collection, 'environments', name);
const readEnv = (name: string) => readFile(envPath(name), 'utf-8');

async function makeCollection(format: 'yaml' | 'bru'): Promise<void> {
  collection = await mkdtemp(path.join(tmpdir(), 'bruno-env-secret-'));
  // The format is decided by which config file the collection root carries:
  // opencollection.yml means the .yml dialect, bruno.json means .bru.
  if (format === 'yaml') {
    await writeFile(path.join(collection, 'opencollection.yml'), 'name: test\n');
  } else {
    await writeFile(
      path.join(collection, 'bruno.json'),
      JSON.stringify({ version: '1', name: 'test', type: 'collection' }, null, 2),
    );
  }
  await mkdir(path.join(collection, 'environments'));
  manager = new EnvironmentManager();
}

afterEach(async () => {
  await rm(collection, { recursive: true, force: true });
});

describe('.yml environments', () => {
  beforeEach(async () => {
    await makeCollection('yaml');
  });

  const seed = (body: string) => writeFile(envPath('dev.yml'), body);

  it('writes a newly authored secret variable as the flag and the name, with no value', async () => {
    await seed('name: dev\nvariables:\n  - name: baseUrl\n    value: https://api.example.com\n');

    const result = await manager.setEnvironmentVariable(
      collection, 'dev', 'API_KEY', LEAK_CANARY, undefined, true,
    );
    expect(result.success).toBe(true);

    const bytes = await readEnv('dev.yml');
    expect(bytes).not.toContain(LEAK_CANARY);
    expect(bytes).toContain('- secret: true\n    name: API_KEY');
    // The non-secret neighbour still carries its value.
    expect(bytes).toContain('value: https://api.example.com');
  });

  it('does not demote an existing secret variable when another variable is edited', async () => {
    await seed('name: dev\nvariables:\n  - secret: true\n    name: API_KEY\n');

    await manager.setEnvironmentVariable(collection, 'dev', 'baseUrl', 'https://api.example.com');

    const bytes = await readEnv('dev.yml');
    expect(bytes).toContain('- secret: true\n    name: API_KEY');
    expect(bytes).not.toMatch(/name: API_KEY\n\s+value:/);
  });

  it('does not demote an existing secret variable when update_environment merges over it', async () => {
    await seed('name: dev\nvariables:\n  - secret: true\n    name: API_KEY\n');

    await manager.mergeEnvironment(collection, 'dev', { API_KEY: LEAK_CANARY });

    const bytes = await readEnv('dev.yml');
    expect(bytes).not.toContain(LEAK_CANARY);
    expect(bytes).toContain('secret: true');
  });

  it('keeps the disabled flag on a secret variable, after the name', async () => {
    await seed('name: dev\nvariables:\n  - secret: true\n    name: API_KEY\n    disabled: true\n');

    await manager.setEnvironmentVariable(collection, 'dev', 'other', 'v');

    expect(await readEnv('dev.yml')).toContain(
      '- secret: true\n    name: API_KEY\n    disabled: true',
    );
  });

  it('converts a secret variable back to a plain one when secret=false is passed', async () => {
    await seed('name: dev\nvariables:\n  - secret: true\n    name: API_KEY\n');

    await manager.setEnvironmentVariable(collection, 'dev', 'API_KEY', 'plain', undefined, false);

    const bytes = await readEnv('dev.yml');
    expect(bytes).not.toContain('secret: true');
    expect(bytes).toContain('- name: API_KEY\n    value: plain');
  });

  it('drops a value that a previous plaintext write left on a secret variable', async () => {
    // What the old generator produced: the flag AND the credential.
    await seed(`name: dev\nvariables:\n  - name: API_KEY\n    value: ${LEAK_CANARY}\n    secret: true\n`);

    await manager.setEnvironmentVariable(collection, 'dev', 'other', 'v');

    expect(await readEnv('dev.yml')).not.toContain(LEAK_CANARY);
  });

  it('preserves the top-level color key across a merge', async () => {
    await seed('name: dev\ncolor: "#ff0000"\nvariables:\n  - name: a\n    value: "1"\n');

    await manager.mergeEnvironment(collection, 'dev', { b: '2' });

    const bytes = await readEnv('dev.yml');
    expect(bytes).toContain('color: "#ff0000"');
    expect(bytes).toContain('name: b');
    // Bruno's order is name, color, variables.
    expect(bytes.indexOf('name: dev')).toBeLessThan(bytes.indexOf('color:'));
    expect(bytes.indexOf('color:')).toBeLessThan(bytes.indexOf('variables:'));
  });

  it('preserves an unmodelled per-variable key across an edit', async () => {
    await seed('name: dev\nvariables:\n  - name: a\n    value: "1"\n    description: what a is for\n');

    await manager.setEnvironmentVariable(collection, 'dev', 'a', '2');

    const bytes = await readEnv('dev.yml');
    expect(bytes).toContain('description: what a is for');
    expect(bytes).toContain('value: "2"');
  });

  it('preserves color when a variable is removed', async () => {
    await seed('name: dev\ncolor: "#00ff00"\nvariables:\n  - name: a\n    value: "1"\n  - name: b\n    value: "2"\n');

    await manager.removeEnvironmentVariable(collection, 'dev', 'a');

    const bytes = await readEnv('dev.yml');
    expect(bytes).toContain('color: "#00ff00"');
    expect(bytes).not.toContain('name: a');
  });

  it('preserves color when the whole variable list is replaced', async () => {
    await seed('name: dev\ncolor: "#0000ff"\nvariables:\n  - name: a\n    value: "1"\n');

    await manager.updateEnvironmentVariables(collection, 'dev', [{ name: 'z', value: '9' }]);

    const bytes = await readEnv('dev.yml');
    expect(bytes).toContain('color: "#0000ff"');
    expect(bytes).toContain('name: z');
  });

  it('preserves color when updateEnvironment replaces the variables', async () => {
    await seed('name: dev\ncolor: "#123456"\nvariables:\n  - name: a\n    value: "1"\n');

    await manager.updateEnvironment(collection, 'dev', { z: '9' });

    expect(await readEnv('dev.yml')).toContain('color: "#123456"');
  });

  it('still reports NOT_FOUND for a missing environment', async () => {
    const result = await manager.updateEnvironmentVariables(collection, 'ghost', [
      { name: 'a', value: '1' },
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not exist/i);
  });

  it('treats an empty environment file as having no variables', async () => {
    await seed('');

    const envFile = await manager.loadEnvironmentFile(collection, 'dev');

    expect(envFile).toEqual({ name: 'dev', variables: [] });
  });

  it('handles a file with no variables key', async () => {
    await seed('name: dev\ncolor: "#ff0000"\n');

    const result = await manager.setEnvironmentVariable(collection, 'dev', 'a', '1');

    expect(result.success).toBe(true);
    const bytes = await readEnv('dev.yml');
    expect(bytes).toContain('color: "#ff0000"');
    expect(bytes).toContain('name: a');
  });

  it('reads the secret flag and the unmodelled keys back into the file model', async () => {
    await seed('name: dev\ncolor: "#ff0000"\nvariables:\n  - secret: true\n    name: API_KEY\n    type: number\n');

    const envFile = await manager.loadEnvironmentFile(collection, 'dev');

    expect(envFile.extra).toEqual({ color: '#ff0000' });
    expect(envFile.variables).toEqual([
      { name: 'API_KEY', value: '', secret: true, extra: { type: 'number' } },
    ]);
  });
});

describe('.bru environments', () => {
  beforeEach(async () => {
    await makeCollection('bru');
  });

  const seed = (body: string) => writeFile(envPath('dev.bru'), body);

  it('writes a newly authored secret variable into vars:secret, with no value', async () => {
    await seed('vars {\n  baseUrl: https://api.example.com\n}\n');

    const result = await manager.setEnvironmentVariable(
      collection, 'dev', 'API_KEY', LEAK_CANARY, undefined, true,
    );
    expect(result.success).toBe(true);

    const bytes = await readEnv('dev.bru');
    expect(bytes).not.toContain(LEAK_CANARY);
    expect(bytes).toContain('vars:secret [');
    expect(bytes).toMatch(/vars:secret \[\n {2}API_KEY\n\]/);
    expect(bytes).toContain('baseUrl: https://api.example.com');
  });

  it('does not demote an existing secret variable when another variable is edited', async () => {
    await seed('vars {\n  baseUrl: https://api.example.com\n}\n\nvars:secret [\n  API_KEY\n]\n');

    await manager.setEnvironmentVariable(collection, 'dev', 'other', 'v');

    const bytes = await readEnv('dev.bru');
    expect(bytes).toMatch(/vars:secret \[\n {2}API_KEY\n\]/);
    expect(bytes).not.toMatch(/^ {2}API_KEY:/m);
  });

  it('does not demote an existing secret variable when update_environment merges over it', async () => {
    await seed('vars:secret [\n  API_KEY\n]\n');

    await manager.mergeEnvironment(collection, 'dev', { API_KEY: LEAK_CANARY });

    const bytes = await readEnv('dev.bru');
    expect(bytes).not.toContain(LEAK_CANARY);
    expect(bytes).toMatch(/vars:secret \[\n {2}API_KEY\n\]/);
  });

  it('marks a disabled secret variable with the ~ prefix', async () => {
    await seed('vars:secret [\n  ~API_KEY\n]\n');

    await manager.setEnvironmentVariable(collection, 'dev', 'other', 'v');

    expect(await readEnv('dev.bru')).toMatch(/vars:secret \[\n {2}~API_KEY\n\]/);
  });

  it('converts a secret variable back to a plain one when secret=false is passed', async () => {
    await seed('vars:secret [\n  API_KEY\n]\n');

    await manager.setEnvironmentVariable(collection, 'dev', 'API_KEY', 'plain', undefined, false);

    const bytes = await readEnv('dev.bru');
    expect(bytes).not.toContain('vars:secret');
    expect(bytes).toContain('API_KEY: plain');
  });

  it('preserves the top-level color key across a merge', async () => {
    await seed('vars {\n  a: 1\n}\n\ncolor: #ff0000\n');

    await manager.mergeEnvironment(collection, 'dev', { b: '2' });

    const bytes = await readEnv('dev.bru');
    expect(bytes).toContain('color: #ff0000');
    expect(bytes).toContain('b: 2');
  });

  it('preserves color when a variable is removed', async () => {
    await seed('vars {\n  a: 1\n  b: 2\n}\n\ncolor: #00ff00\n');

    await manager.removeEnvironmentVariable(collection, 'dev', 'a');

    const bytes = await readEnv('dev.bru');
    expect(bytes).toContain('color: #00ff00');
    expect(bytes).not.toMatch(/^ {2}a:/m);
  });

  it('preserves color when the whole variable list is replaced', async () => {
    await seed('vars {\n  a: 1\n}\n\ncolor: #0000ff\n');

    await manager.updateEnvironmentVariables(collection, 'dev', [{ name: 'z', value: '9' }]);

    expect(await readEnv('dev.bru')).toContain('color: #0000ff');
  });

  it('reads the secret flag and color back into the file model', async () => {
    await seed('vars {\n  a: 1\n}\n\nvars:secret [\n  API_KEY\n]\n\ncolor: #ff0000\n');

    const envFile = await manager.loadEnvironmentFile(collection, 'dev');

    expect(envFile.extra).toEqual({ color: '#ff0000' });
    expect(envFile.variables).toEqual([
      { name: 'a', value: '1' },
      { name: 'API_KEY', value: '', secret: true },
    ]);
  });
});

describe('carried-through keys cannot overwrite a modelled key', () => {
  // The carry-through is what preserves `color` and `description`, and it is
  // also the one place a stale `value` could be reintroduced next to a
  // `secret: true` flag. These go straight at the generators.

  beforeEach(async () => {
    await makeCollection('bru');
  });

  it('a carried value and secret flag cannot reach a .yml variable', () => {
    const yml = generateYamlEnvironment({
      name: 'dev',
      variables: [
        {
          name: 'API_KEY',
          secret: true,
          extra: { value: LEAK_CANARY, secret: false, name: 'spoofed', description: 'kept' },
        },
      ],
    });

    expect(yml).not.toContain(LEAK_CANARY);
    expect(yml).not.toContain('spoofed');
    expect(yml).not.toContain('secret: false');
    expect(yml).toContain('secret: true');
    expect(yml).toContain('description: kept');
  });

  it('carried top-level keys cannot replace the .yml name or variables', () => {
    const yml = generateYamlEnvironment({
      name: 'dev',
      variables: [{ name: 'a', value: '1' }],
      extra: { name: 'spoofed', variables: [{ name: 'injected' }], color: '#ff0000' },
    });

    expect(yml).toContain('name: dev');
    expect(yml).not.toContain('spoofed');
    expect(yml).not.toContain('injected');
    expect(yml).toContain('color: "#ff0000"');
  });

  it('carried top-level keys cannot replace the .bru variables', () => {
    const bru = generateBruEnvironmentFull(
      [{ name: 'a', value: '1' }],
      { variables: [{ name: 'injected', value: 'x' }], color: '#ff0000' },
    );

    expect(bru).toContain('a: 1');
    expect(bru).not.toContain('injected');
    expect(bru).toContain('color: #ff0000');
  });

  it('skips a nameless .bru variable rather than writing an empty key back', () => {
    const parsed = parseBruEnvironmentFile('vars {\n  : orphan\n  real: 1\n}\n');

    expect(parsed.variables).toEqual([{ name: 'real', value: '1' }]);
  });

  it('omits a .yml variable value that is undefined rather than writing an empty key', () => {
    const yml = generateYamlEnvironment({ name: 'dev', variables: [{ name: 'a' }] });

    expect(yml).toContain('- name: a');
    expect(yml).not.toContain('value:');
  });
});

describe('update_environment serializes concurrent writers', () => {
  beforeEach(async () => {
    await makeCollection('bru');
    await writeFile(envPath('dev.bru'), 'vars {\n  base: seed\n}\n');
  });

  const readVars = async () => {
    const raw = await manager.loadEnvironmentRaw(collection, 'dev');
    return Object.fromEntries(raw.map((v) => [v.name, String(v.value)]));
  };

  it('keeps both edits when two merges run concurrently', async () => {
    // Unserialised, both calls read the same starting state and the second
    // write discards the first variable — a lost update.
    await Promise.all([
      manager.mergeEnvironment(collection, 'dev', { alpha: 'a-value' }),
      manager.mergeEnvironment(collection, 'dev', { beta: 'b-value' }),
    ]);

    const vars = await readVars();
    expect(vars.alpha).toBe('a-value');
    expect(vars.beta).toBe('b-value');
    expect(vars.base).toBe('seed');
  });

  it('keeps every edit when many merges are applied concurrently', async () => {
    const keys = Array.from({ length: 12 }, (_, i) => `key${i}`);

    await Promise.all(keys.map((k) => manager.mergeEnvironment(collection, 'dev', { [k]: k })));

    const vars = await readVars();
    for (const k of keys) {
      expect(vars[k]).toBe(k);
    }
  });

  it('does not lose a concurrent merge when a set runs against the same file', async () => {
    await Promise.all([
      manager.mergeEnvironment(collection, 'dev', { merged: 'm' }),
      manager.setEnvironmentVariable(collection, 'dev', 'setVar', 's'),
    ]);

    const vars = await readVars();
    expect(vars.merged).toBe('m');
    expect(vars.setVar).toBe('s');
  });

  it('reports an error for a missing environment', async () => {
    const result = await manager.mergeEnvironment(collection, 'ghost', { a: '1' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Failed to load environment ghost/);
  });
});
