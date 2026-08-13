/**
 * Relocating a request file.
 *
 * Real files throughout, in a temporary directory. The whole claim of this
 * module is about bytes on disk and about which of two paths holds them
 * afterwards, and a mocked `fs` would assert only that the calls were made in
 * the order the implementation makes them.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { moveRequestFile } from '../../../src/bruno/request-move';

/**
 * A `.bru` request carrying a block neither dialect models, which is what makes
 * a verbatim move rather than a round-trip the requirement: regenerating this
 * file would drop `vendor`.
 */
function bru(seq: number): string {
  return `meta {\n  name: Get Users\n  type: http\n  seq: ${seq}\n}\n\n`
    + `get {\n  url: https://api.test/users\n}\n\n`
    + `vendor {\n  ticket: ABC-1\n}\n`;
}

function yml(seq: number): string {
  return `info:\n  name: Get Users\n  type: http\n  seq: ${seq}\n`
    + `http:\n  method: GET\n  url: https://api.test/users\n`;
}

let root: string;
/** Collection root for the single-collection cases. */
let collection: string;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'bruno-move-'));
  collection = join(root, 'collection');
  await fs.mkdir(collection, { recursive: true });
  await fs.writeFile(join(collection, 'bruno.json'), '{"version":"1","name":"c"}\n');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('moving a request within its collection', () => {
  it('puts the file in the target folder and takes it out of the old one', async () => {
    const source = join(collection, 'get-users.yml');
    await fs.writeFile(source, yml(1));
    await fs.mkdir(join(collection, 'users'));

    const result = await moveRequestFile({
      filePath: source,
      targetCollectionPath: collection,
      targetFolder: 'users',
    });

    expect(result.success).toBe(true);
    expect(result.path).toBe(join(collection, 'users', 'get-users.yml'));
    await expect(fs.readFile(result.path as string, 'utf-8')).resolves.toBe(yml(1));
    await expect(fs.access(source)).rejects.toThrow();
  });

  it('carries a block the parsers do not model through unchanged', async () => {
    // The reason nothing is parsed and rewritten. A round-trip through the
    // `.bru` writer drops `vendor` entirely.
    const source = join(collection, 'get-users.bru');
    await fs.writeFile(source, bru(1));
    await fs.mkdir(join(collection, 'users'));

    const result = await moveRequestFile({
      filePath: source,
      targetCollectionPath: collection,
      targetFolder: 'users',
    });

    expect(result.success).toBe(true);
    await expect(fs.readFile(result.path as string, 'utf-8')).resolves.toBe(bru(1));
  });

  it('moves to the collection root when no folder is named', async () => {
    const source = join(collection, 'users', 'get-users.yml');
    await fs.mkdir(join(collection, 'users'));
    await fs.writeFile(source, yml(1));

    const result = await moveRequestFile({
      filePath: source,
      targetCollectionPath: collection,
    });

    expect(result.path).toBe(join(collection, 'get-users.yml'));
    await expect(fs.access(join(collection, 'get-users.yml'))).resolves.toBeUndefined();
  });

  it('creates the target folder, and says it did', async () => {
    const source = join(collection, 'get-users.yml');
    await fs.writeFile(source, yml(1));

    const result = await moveRequestFile({
      filePath: source,
      targetCollectionPath: collection,
      targetFolder: join('auth', 'login'),
    });

    expect(result.success).toBe(true);
    expect(result.path).toBe(join(collection, 'auth', 'login', 'get-users.yml'));
    // Named because a folder with no settings file carries no folder-level auth,
    // headers or scripts — the caller has to know it is now that kind of folder.
    expect(result.warnings.join('\n')).toContain('Created folder');
    expect(result.warnings.join('\n')).toContain(join('auth', 'login'));
  });

  it('says nothing about creating a folder that was already there', async () => {
    const source = join(collection, 'get-users.yml');
    await fs.writeFile(source, yml(1));
    await fs.mkdir(join(collection, 'users'));

    const result = await moveRequestFile({
      filePath: source,
      targetCollectionPath: collection,
      targetFolder: 'users',
    });

    expect(result.warnings).toEqual([]);
  });
});

describe('copying instead of moving', () => {
  it('leaves the original where it was', async () => {
    const source = join(collection, 'get-users.yml');
    await fs.writeFile(source, yml(1));

    const result = await moveRequestFile({
      filePath: source,
      targetCollectionPath: collection,
      targetFolder: 'users',
      copy: true,
    });

    expect(result.success).toBe(true);
    await expect(fs.readFile(source, 'utf-8')).resolves.toBe(yml(1));
    await expect(fs.readFile(result.path as string, 'utf-8')).resolves.toBe(yml(1));
  });

  it('refuses a copy that would land on the request itself', async () => {
    // The file keeps its name, so same folder plus same name is the same file.
    // Without this the COPYFILE_EXCL below would report a collision with itself,
    // which explains nothing.
    const source = join(collection, 'get-users.yml');
    await fs.writeFile(source, yml(1));

    const result = await moveRequestFile({
      filePath: source,
      targetCollectionPath: collection,
      copy: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('different folder or collection');
    await expect(fs.readFile(source, 'utf-8')).resolves.toBe(yml(1));
  });
});

describe('moving between collections', () => {
  it('moves the file into the other collection', async () => {
    const other = join(root, 'other');
    await fs.mkdir(other);
    await fs.writeFile(join(other, 'bruno.json'), '{"version":"1","name":"o"}\n');
    const source = join(collection, 'get-users.yml');
    await fs.writeFile(source, yml(1));

    const result = await moveRequestFile({
      filePath: source,
      targetCollectionPath: other,
    });

    expect(result.path).toBe(join(other, 'get-users.yml'));
    await expect(fs.access(source)).rejects.toThrow();
  });
});

describe('what it refuses', () => {
  it('refuses a move into the folder the request is already in', async () => {
    const source = join(collection, 'get-users.yml');
    await fs.writeFile(source, yml(1));

    const result = await moveRequestFile({
      filePath: source,
      targetCollectionPath: collection,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('already in that folder');
  });

  it('refuses when a request of that name is already there, and moves nothing', async () => {
    const source = join(collection, 'get-users.yml');
    await fs.writeFile(source, yml(1));
    await fs.mkdir(join(collection, 'users'));
    await fs.writeFile(join(collection, 'users', 'get-users.yml'), yml(9));

    const result = await moveRequestFile({
      filePath: source,
      targetCollectionPath: collection,
      targetFolder: 'users',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists in that folder');
    // Both files still hold their own bytes: the source was not unlinked and the
    // occupant was not overwritten.
    await expect(fs.readFile(source, 'utf-8')).resolves.toBe(yml(1));
    await expect(fs.readFile(join(collection, 'users', 'get-users.yml'), 'utf-8'))
      .resolves.toBe(yml(9));
  });

  it('refuses an absolute targetFolder', async () => {
    const source = join(collection, 'get-users.yml');
    await fs.writeFile(source, yml(1));

    const result = await moveRequestFile({
      filePath: source,
      targetCollectionPath: collection,
      targetFolder: join(root, 'elsewhere'),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('relative to the collection root');
    await expect(fs.access(join(root, 'elsewhere'))).rejects.toThrow();
  });

  it('refuses a targetFolder that climbs out of the collection', async () => {
    const source = join(collection, 'get-users.yml');
    await fs.writeFile(source, yml(1));

    const result = await moveRequestFile({
      filePath: source,
      targetCollectionPath: collection,
      targetFolder: join('..', 'escaped'),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid targetFolder');
    // Inside the temp root on purpose: a mutant that lifts the confinement check
    // writes here, and this is the assertion that catches it.
    await expect(fs.access(join(root, 'escaped'))).rejects.toThrow();
    await expect(fs.readFile(source, 'utf-8')).resolves.toBe(yml(1));
  });
});

describe('reporting a sequence that is already taken', () => {
  it('warns when a request in the target folder declares the same seq', async () => {
    const source = join(collection, 'get-users.yml');
    await fs.writeFile(source, yml(3));
    await fs.mkdir(join(collection, 'users'));
    await fs.writeFile(join(collection, 'users', 'list.yml'), yml(3));

    const result = await moveRequestFile({
      filePath: source,
      targetCollectionPath: collection,
      targetFolder: 'users',
    });

    expect(result.success).toBe(true);
    expect(result.warnings.join('\n')).toContain('seq 3');
    expect(result.warnings.join('\n')).toContain('breaks the tie by filename');
  });

  it('says nothing when the sequence is free in the target folder', async () => {
    const source = join(collection, 'get-users.yml');
    await fs.writeFile(source, yml(3));
    await fs.mkdir(join(collection, 'users'));
    await fs.writeFile(join(collection, 'users', 'list.yml'), yml(4));

    const result = await moveRequestFile({
      filePath: source,
      targetCollectionPath: collection,
      targetFolder: 'users',
    });

    expect(result.warnings).toEqual([]);
  });

  it('does not report the request colliding with itself', async () => {
    // The sequences are read before the copy for exactly this reason: afterwards
    // the moved file is one of the folder's own requests and declares the seq it
    // would be compared against.
    const source = join(collection, 'get-users.yml');
    await fs.writeFile(source, yml(3));
    await fs.mkdir(join(collection, 'users'));

    const result = await moveRequestFile({
      filePath: source,
      targetCollectionPath: collection,
      targetFolder: 'users',
    });

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('does not read a sequence out of the folder settings file', async () => {
    // A `folder.bru` carries the folder's own place among its siblings, which is
    // a different number in a different scale from the requests inside it.
    const source = join(collection, 'get-users.yml');
    await fs.writeFile(source, yml(3));
    await fs.mkdir(join(collection, 'users'));
    await fs.writeFile(join(collection, 'users', 'folder.bru'), 'meta {\n  name: users\n  seq: 3\n}\n');

    const result = await moveRequestFile({
      filePath: source,
      targetCollectionPath: collection,
      targetFolder: 'users',
    });

    expect(result.warnings).toEqual([]);
  });
});
