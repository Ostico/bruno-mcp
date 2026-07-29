/**
 * Multipart file-part path confinement.
 *
 * A multipart `file` part's path is collection-controlled. It used to be passed
 * straight to readFile(), so a collection could reference `/etc/passwd`,
 * `~/.ssh/id_rsa`, an env file, etc. and POST its contents to any public host —
 * arbitrary file read + exfiltration in a single request.
 *
 * The read is now allowed only under a trusted upload location — the collection
 * root, the user's home, the OS temp dir (and /tmp), or a BRUNO_UPLOAD_DIRS
 * entry — AND never through a `.`-prefixed (hidden) path segment, so dotfiles
 * like ~/.ssh / .aws / .env stay unreadable even though home is allowed.
 */

import { promises as fs } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import {
  buildFetchOptions,
  resetUploadDirsCache,
} from '../../../src/bruno/request-executor';
import type { YamlRequest } from '../../../src/bruno/types';

describe('buildFetchOptions — multipart file-part confinement', () => {
  let tmpDir: string;
  let collectionRoot: string;
  let insideFile: string; // inside the collection
  let looseTmpFile: string; // outside the collection but under the OS temp root
  let hiddenInside: string; // hidden file inside the collection

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(join(tmpdir(), 'bruno-s05-'));
    collectionRoot = join(tmpDir, 'collection');
    await fs.mkdir(collectionRoot, { recursive: true });
    insideFile = join(collectionRoot, 'upload.txt');
    await fs.writeFile(insideFile, 'legit-payload');
    looseTmpFile = join(tmpDir, 'loose.txt');
    await fs.writeFile(looseTmpFile, 'tmp-payload');
    hiddenInside = join(collectionRoot, '.env');
    await fs.writeFile(hiddenInside, 'SECRET=1');
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    delete process.env.BRUNO_UPLOAD_DIRS;
    resetUploadDirsCache();
  });

  afterEach(() => {
    delete process.env.BRUNO_UPLOAD_DIRS;
    resetUploadDirsCache();
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

  it('refuses a path outside every allowed upload directory', async () => {
    await expect(
      buildFetchOptions(fileYaml('/etc/passwd'), new Map(), collectionRoot),
    ).rejects.toThrow(/outside the allowed upload directories/i);
  });

  it('refuses a hidden file even inside the collection root', async () => {
    await expect(
      buildFetchOptions(fileYaml(hiddenInside), new Map(), collectionRoot),
    ).rejects.toThrow(/hidden file or directory/i);
  });

  it('refuses a dot-directory such as a home .ssh key (home allowed, hidden denied)', async () => {
    // Resolves under the allowed home root, but the `.ssh` segment is hidden.
    await expect(
      buildFetchOptions(fileYaml(join(homedir(), '.ssh', 'id_rsa')), new Map(), collectionRoot),
    ).rejects.toThrow(/hidden file or directory/i);
  });

  it('refuses a file part when no collection root is known', async () => {
    await expect(
      buildFetchOptions(fileYaml(insideFile), new Map()),
    ).rejects.toThrow(/no collection root/i);
  });

  it('reads a non-hidden file inside the collection root', async () => {
    const { options } = await buildFetchOptions(fileYaml(insideFile), new Map(), collectionRoot);
    expect(await ((options.body as FormData).get('f') as File).text()).toBe('legit-payload');
  });

  it('reads a file referenced relative to the collection root', async () => {
    const { options } = await buildFetchOptions(fileYaml('upload.txt'), new Map(), collectionRoot);
    expect(await ((options.body as FormData).get('f') as File).text()).toBe('legit-payload');
  });

  it('reads a non-hidden file outside the collection but under the OS temp root', async () => {
    const { options } = await buildFetchOptions(fileYaml(looseTmpFile), new Map(), collectionRoot);
    expect(await ((options.body as FormData).get('f') as File).text()).toBe('tmp-payload');
  });

  it('allows a file under an operator-configured BRUNO_UPLOAD_DIRS entry', async () => {
    // home/tmp already allow broadly, so this primarily exercises the config
    // plumbing (parse + cache + inclusion in the allowed roots).
    process.env.BRUNO_UPLOAD_DIRS = `${collectionRoot},${tmpDir}`;
    resetUploadDirsCache();
    const { options } = await buildFetchOptions(fileYaml(looseTmpFile), new Map(), collectionRoot);
    expect(await ((options.body as FormData).get('f') as File).text()).toBe('tmp-payload');
  });

  it('substitutes a variable in the path and still enforces confinement', async () => {
    await expect(
      buildFetchOptions(fileYaml('{{p}}'), new Map([['p', '/etc/passwd']]), collectionRoot),
    ).rejects.toThrow(/outside the allowed upload directories/i);
  });
});
