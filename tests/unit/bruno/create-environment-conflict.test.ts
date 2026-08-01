/**
 * What `create_environment` does when the name is already taken, and what it can
 * express when it is not.
 *
 * Two defects sit behind these tests. The call writes the WHOLE file, and it used
 * to do so unconditionally: an existing environment was silently replaced, so any
 * variable the caller did not list was deleted and a secret could not be put back
 * from the file alone, because no format stores a secret's value. It also skipped
 * the read that every other write path performs, so keys the model does not name
 * were deleted on each overwrite even though the machinery to keep them existed.
 * Separately, the input was a flat `name -> scalar` map, so `secret`, `disabled`
 * and `dataType` were unreachable at create time.
 *
 * Real files in a real temp directory, on purpose. The mocked environment suite
 * cannot see any of this: a `jest.fn()` `readFile` resolves `undefined` rather
 * than rejecting, which reads as "the file exists and is empty" to anything that
 * checks existence by reading — the failure mode that hid this behaviour when the
 * fix first went in.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EnvironmentManager } from '../../../src/bruno/environment.js';
import { clearFormatCache } from '../../../src/bruno/format-detector.js';

let manager: EnvironmentManager;

beforeEach(() => {
  manager = new EnvironmentManager();
  clearFormatCache();
});

/** A collection directory in the requested on-disk dialect. */
async function collection(label: string, format: 'yaml' | 'bru'): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), `bruno-createenv-${label}-`));
  if (format === 'yaml') {
    await fs.writeFile(join(dir, 'opencollection.yml'), 'info:\n  name: c\n');
  } else {
    await fs.writeFile(
      join(dir, 'bruno.json'),
      JSON.stringify({ version: '1', name: 'c', type: 'collection' }),
    );
  }
  return dir;
}

/** Hand-write an environment file, as Bruno itself would. */
async function seedEnv(dir: string, fileName: string, body: string): Promise<string> {
  const envDir = join(dir, 'environments');
  await fs.mkdir(envDir, { recursive: true });
  const path = join(envDir, fileName);
  await fs.writeFile(path, body);
  return path;
}

describe('create_environment refuses a name that already exists', () => {
  it('does not write, and reports the conflict rather than a bare failure', async () => {
    const dir = await collection('refuse', 'yaml');
    const before = 'name: dev\nvariables:\n  - name: keepMe\n    value: original\n';
    const envPath = await seedEnv(dir, 'dev.yml', before);

    const result = await manager.createEnvironment({
      collectionPath: dir,
      name: 'dev',
      variables: { other: 'x' },
    });

    expect(result.success).toBe(false);
    expect(result.conflict).toBeDefined();
    // The file is exactly as it was: a refusal must not half-write.
    expect(await fs.readFile(envPath, 'utf-8')).toBe(before);
  });

  it('classifies the caller request against the file, so merge-or-new is decidable', async () => {
    const dir = await collection('classify', 'yaml');
    await seedEnv(
      dir,
      'dev.yml',
      'name: dev\nvariables:\n  - name: shared\n    value: a\n  - name: onlyOnDisk\n    value: b\n',
    );

    const result = await manager.createEnvironment({
      collectionPath: dir,
      name: 'dev',
      variables: { shared: 'new', onlyInRequest: 'c' },
    });

    expect(result.conflict?.alreadyPresent).toEqual(['shared']);
    expect(result.conflict?.added).toEqual(['onlyInRequest']);
    // The list that decides it: replacing would delete this one.
    expect(result.conflict?.wouldBeLost).toEqual(['onlyOnDisk']);
  });

  it('reports names and flags of what is already there, and never a value', async () => {
    const dir = await collection('flags', 'yaml');
    await seedEnv(
      dir,
      'dev.yml',
      'name: dev\nvariables:\n'
        + '  - name: token\n    secret: true\n'
        + '  - name: retired\n    value: SUPERSECRETVALUE\n    disabled: true\n',
    );

    const result = await manager.createEnvironment({
      collectionPath: dir,
      name: 'dev',
      variables: { other: 'x' },
    });

    expect(result.conflict?.existing).toEqual([
      { name: 'token', secret: true },
      { name: 'retired', disabled: true },
    ]);
    // An error message is the wrong channel for a value, secret or not.
    expect(result.error).not.toContain('SUPERSECRETVALUE');
    expect(result.error).toContain('token (secret)');
    expect(result.error).toContain('retired (disabled)');
  });

  it('says a replace is safe when the request is a superset', async () => {
    const dir = await collection('superset', 'yaml');
    await seedEnv(dir, 'dev.yml', 'name: dev\nvariables:\n  - name: a\n    value: 1\n');

    const result = await manager.createEnvironment({
      collectionPath: dir,
      name: 'dev',
      variables: { a: '2', b: '3' },
    });

    expect(result.conflict?.wouldBeLost).toEqual([]);
    expect(result.error).toContain('overwrite: true');
    expect(result.error).not.toContain('DELETE');
  });

  it('still refuses when the existing file cannot be parsed', async () => {
    // Refusing to clobber is the whole point, so an unreadable file counts as
    // present. Reporting no variables is honest about what could be read.
    const dir = await collection('unparseable', 'yaml');
    const before = 'name: dev\nvariables:\n  - this is not: [valid\n';
    const envPath = await seedEnv(dir, 'dev.yml', before);

    const result = await manager.createEnvironment({
      collectionPath: dir,
      name: 'dev',
      variables: { a: '1' },
    });

    expect(result.success).toBe(false);
    expect(await fs.readFile(envPath, 'utf-8')).toBe(before);
  });

  it('creates normally when the name is free', async () => {
    const dir = await collection('free', 'yaml');
    const result = await manager.createEnvironment({
      collectionPath: dir,
      name: 'dev',
      variables: { baseUrl: 'https://example.test' },
    });

    expect(result.success).toBe(true);
    expect(result.conflict).toBeUndefined();
    expect(await fs.readFile(result.path as string, 'utf-8')).toContain('baseUrl');
  });
});

describe('create_environment with overwrite: true', () => {
  it('replaces the variables but keeps keys the model does not name', async () => {
    // The bug this closes: every other write path reads the file first so these
    // survive, and this one did not, so an overwrite deleted them.
    const dir = await collection('overwrite', 'yaml');
    const envPath = await seedEnv(
      dir,
      'dev.yml',
      'name: dev\ncolor: "#ff0000"\nexternalSecrets:\n  provider: vault\n'
        + 'variables:\n  - name: gone\n    value: x\n',
    );

    const result = await manager.createEnvironment({
      collectionPath: dir,
      name: 'dev',
      variables: { fresh: 'y' },
      overwrite: true,
    });

    expect(result.success).toBe(true);
    const after = await fs.readFile(envPath, 'utf-8');
    expect(after).toContain('fresh');
    expect(after).not.toContain('gone');
    expect(after).toContain('color:');
    expect(after).toContain('externalSecrets:');
    expect(after).toContain('provider: vault');
  });

  it('creates the file when there is nothing to overwrite', async () => {
    const dir = await collection('overwrite-fresh', 'yaml');
    const result = await manager.createEnvironment({
      collectionPath: dir,
      name: 'dev',
      variables: { a: '1' },
      overwrite: true,
    });
    expect(result.success).toBe(true);
  });
});

describe('create_environment can express the whole variable model', () => {
  it('declares a secret at create time on .yml, as a name with no value', async () => {
    const dir = await collection('secret-yml', 'yaml');
    const result = await manager.createEnvironment({
      collectionPath: dir,
      name: 'dev',
      variables: [
        { name: 'token', value: 'must-not-be-written', secret: true },
        { name: 'baseUrl', value: 'https://example.test' },
      ],
    });

    expect(result.success).toBe(true);
    const written = await fs.readFile(result.path as string, 'utf-8');
    expect(written).toContain('secret: true');
    expect(written).toContain('token');
    // No format persists a secret's value; writing one would put it on disk.
    expect(written).not.toContain('must-not-be-written');
    expect(written).toContain('https://example.test');
  });

  it('declares a secret at create time on .bru too', async () => {
    // The flat-map input could not express this, so the .bru writer received
    // `secret: false` for every variable it was ever given at create time.
    const dir = await collection('secret-bru', 'bru');
    const result = await manager.createEnvironment({
      collectionPath: dir,
      name: 'dev',
      variables: [{ name: 'token', value: 'must-not-be-written', secret: true }],
    });

    expect(result.success).toBe(true);
    const written = await fs.readFile(result.path as string, 'utf-8');
    expect(written).toContain('vars:secret');
    expect(written).toContain('token');
    expect(written).not.toContain('must-not-be-written');
  });

  it('declares a disabled variable at create time', async () => {
    const dir = await collection('disabled', 'yaml');
    const result = await manager.createEnvironment({
      collectionPath: dir,
      name: 'dev',
      variables: [{ name: 'retired', value: 'x', disabled: true }],
    });

    expect(result.success).toBe(true);
    expect(await fs.readFile(result.path as string, 'utf-8')).toContain('disabled: true');
  });

  it('still accepts the flat map it has always taken', async () => {
    const dir = await collection('flat', 'yaml');
    const result = await manager.createEnvironment({
      collectionPath: dir,
      name: 'dev',
      variables: { baseUrl: 'https://example.test', retries: 3, verbose: true },
    });

    expect(result.success).toBe(true);
    const written = await fs.readFile(result.path as string, 'utf-8');
    expect(written).toContain('baseUrl');
    expect(written).toContain('retries');
    expect(written).toContain('verbose');
  });

  it('indexes the list form by name, not by array position', async () => {
    // An array is also an object, so an `Object.entries` branch placed above the
    // array check would write variables called `0`, `1`, `2` — from the very
    // shape the richer callers pass.
    const dir = await collection('by-name', 'yaml');
    const result = await manager.createEnvironment({
      collectionPath: dir,
      name: 'dev',
      variables: [{ name: 'first', value: 'a' }, { name: 'second', value: 'b' }],
    });

    const written = await fs.readFile(result.path as string, 'utf-8');
    expect(written).toContain('name: first');
    expect(written).toContain('name: second');
    expect(written).not.toMatch(/name: '?0'?$/m);
  });

  it('drops a nameless entry rather than writing an empty variable', async () => {
    const dir = await collection('nameless', 'yaml');
    const result = await manager.createEnvironment({
      collectionPath: dir,
      name: 'dev',
      variables: [{ name: '', value: 'a' }, { name: 'real', value: 'b' }],
    });

    expect(result.success).toBe(true);
    const written = await fs.readFile(result.path as string, 'utf-8');
    expect(written).toContain('real');
    expect(written).not.toMatch(/name: ''/);
  });
});
