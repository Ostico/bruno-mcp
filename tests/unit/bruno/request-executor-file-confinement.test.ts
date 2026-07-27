/**
 * Multipart file-part path confinement (finding S05).
 *
 * A multipart `file` part's path is collection-controlled. It used to be passed
 * straight to readFile(), so a collection could reference `/etc/passwd`,
 * `~/.ssh/id_rsa`, an env file, etc. and POST its contents to any public host —
 * arbitrary file read + exfiltration in a single request. These assert the read
 * is now confined to the collection root: an absolute or traversal path that
 * escapes the root is refused, a path inside it still works, and a file part
 * with no known collection root is refused rather than read from anywhere.
 */

import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildFetchOptions } from '../../../src/bruno/request-executor';
import type { YamlRequest } from '../../../src/bruno/types';

describe('buildFetchOptions — multipart file-part confinement (S05)', () => {
  let tmpDir: string;
  let collectionRoot: string;
  let outsideSecret: string;
  let insideFile: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(join(tmpdir(), 'bruno-s05-'));
    collectionRoot = join(tmpDir, 'collection');
    await fs.mkdir(collectionRoot, { recursive: true });
    // A sensitive file OUTSIDE the collection root.
    outsideSecret = join(tmpDir, 'outside-secret.txt');
    await fs.writeFile(outsideSecret, 'TOP-SECRET');
    // A legitimate upload INSIDE the collection root.
    insideFile = join(collectionRoot, 'upload.txt');
    await fs.writeFile(insideFile, 'legit-payload');
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function fileYaml(value: string | string[]): YamlRequest {
    return {
      info: { name: 'Upload', type: 'http' },
      http: {
        method: 'POST',
        url: 'https://example.com/upload',
        body: { type: 'multipart-form', data: [{ name: 'f', value, type: 'file' }] },
      },
    } as YamlRequest;
  }

  it('refuses an absolute path that escapes the collection root', async () => {
    await expect(
      buildFetchOptions(fileYaml(outsideSecret), new Map(), collectionRoot),
    ).rejects.toThrow(/outside the collection/i);
  });

  it('refuses a ../ traversal path that escapes the collection root', async () => {
    await expect(
      buildFetchOptions(fileYaml('../outside-secret.txt'), new Map(), collectionRoot),
    ).rejects.toThrow(/outside the collection/i);
  });

  it('refuses a file part when no collection root is known', async () => {
    await expect(
      buildFetchOptions(fileYaml(insideFile), new Map()),
    ).rejects.toThrow(/no collection root/i);
  });

  it('reads a file that resolves inside the collection root (absolute)', async () => {
    const { options } = await buildFetchOptions(fileYaml(insideFile), new Map(), collectionRoot);
    const form = options.body as FormData;
    expect(await (form.get('f') as File).text()).toBe('legit-payload');
  });

  it('reads a file referenced relative to the collection root', async () => {
    const { options } = await buildFetchOptions(fileYaml('upload.txt'), new Map(), collectionRoot);
    const form = options.body as FormData;
    expect(await (form.get('f') as File).text()).toBe('legit-payload');
  });

  it('substitutes a variable in the path and still enforces confinement', async () => {
    await expect(
      buildFetchOptions(
        fileYaml('{{p}}'),
        new Map([['p', outsideSecret]]),
        collectionRoot,
      ),
    ).rejects.toThrow(/outside the collection/i);
  });
});
