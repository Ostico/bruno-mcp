/**
 * Adding a collection to a workspace registry.
 *
 * The file belongs to the Bruno app, so these tests read the bytes back rather
 * than parsing them: a round-trip through the YAML library would happily accept
 * a file it had rewritten, and rewriting the user's workspace is the failure this
 * is guarding against.
 */
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCollectionInWorkspace } from '../../../src/bruno/workspace-registrar';

/** The shape the app writes: quoted scalars, an empty key, a trailing blank line. */
const REAL = `opencollection: 1.0.0
info:
  name: "My Workspace"
  type: workspace

collections:
  - name: "Sample API Collection"
    path: "/Users/someone/bruno/Sample API Collection"
  - name: "ESTest"
    path: "/Users/someone/bruno/ESTest"

specs:

docs: ''
`;

async function workspace(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-registrar-'));
  const path = join(dir, 'workspace.yml');
  await writeFile(path, content);
  return path;
}

describe('a registry with entries already in it', () => {
  it('puts the new entry after the last one and changes nothing else', async () => {
    const path = await workspace(REAL);

    const result = await registerCollectionInWorkspace(path, {
      name: 'Fresh',
      path: '/tmp/collections/Fresh',
    });

    expect(result.outcome).toBe('added');
    expect(await readFile(path, 'utf-8')).toBe(`opencollection: 1.0.0
info:
  name: "My Workspace"
  type: workspace

collections:
  - name: "Sample API Collection"
    path: "/Users/someone/bruno/Sample API Collection"
  - name: "ESTest"
    path: "/Users/someone/bruno/ESTest"
  - name: "Fresh"
    path: "/tmp/collections/Fresh"

specs:

docs: ''
`);
  });

  it('leaves the file alone when that path is already listed', async () => {
    const path = await workspace(REAL);

    const result = await registerCollectionInWorkspace(path, {
      name: 'Renamed since',
      path: '/Users/someone/bruno/ESTest',
    });

    expect(result.outcome).toBe('already-listed');
    expect(await readFile(path, 'utf-8')).toBe(REAL);
  });

  it('compares paths, not spellings of them', async () => {
    const path = await workspace(REAL);

    const result = await registerCollectionInWorkspace(path, {
      name: 'ESTest',
      path: '/Users/someone/bruno/../bruno/ESTest',
    });

    // Two spellings of one directory would otherwise become two entries, and the
    // app shows both.
    expect(result.outcome).toBe('already-listed');
  });

  it('adds a second entry under a name that is already used', async () => {
    const path = await workspace(REAL);

    const result = await registerCollectionInWorkspace(path, {
      name: 'ESTest',
      path: '/elsewhere/ESTest',
    });

    // The app's own file has duplicate names for collections in different
    // directories, so a name clash is not a reason to refuse.
    expect(result.outcome).toBe('added');
    expect(await readFile(path, 'utf-8')).toContain('    path: "/elsewhere/ESTest"\n\nspecs:');
  });
});

describe('a registry in another shape', () => {
  it('turns an empty flow list into a block list', async () => {
    const path = await workspace('collections: []\ndocs: \'\'\n');

    const result = await registerCollectionInWorkspace(path, { name: 'One', path: '/c/One' });

    expect(result.outcome).toBe('added');
    expect(await readFile(path, 'utf-8')).toBe(
      'collections:\n  - name: "One"\n    path: "/c/One"\ndocs: \'\'\n',
    );
  });

  it('adds the key when the file has no collections at all', async () => {
    const path = await workspace('opencollection: 1.0.0\n');

    const result = await registerCollectionInWorkspace(path, { name: 'One', path: '/c/One' });

    expect(result.outcome).toBe('added');
    expect(await readFile(path, 'utf-8')).toBe(
      'opencollection: 1.0.0\ncollections:\n  - name: "One"\n    path: "/c/One"\n',
    );
  });

  it('ends the last line first when the file has no trailing newline', async () => {
    const path = await workspace('opencollection: 1.0.0');

    await registerCollectionInWorkspace(path, { name: 'One', path: '/c/One' });

    expect(await readFile(path, 'utf-8')).toBe(
      'opencollection: 1.0.0\ncollections:\n  - name: "One"\n    path: "/c/One"\n',
    );
  });

  it('ignores a key that merely starts with the same letters', async () => {
    const path = await workspace(
      'collections_backup: "/old/list.yml"\ncollections:\n  - name: "A"\n    path: "/c/A"\n',
    );

    const result = await registerCollectionInWorkspace(path, { name: 'B', path: '/c/B' });

    expect(result.outcome).toBe('added');
    expect(await readFile(path, 'utf-8')).toBe(
      'collections_backup: "/old/list.yml"\ncollections:\n  - name: "A"\n    path: "/c/A"\n'
      + '  - name: "B"\n    path: "/c/B"\n',
    );
  });

  it('refuses a populated flow list rather than rewriting it', async () => {
    const original = 'collections: [{name: A, path: /c/A}]\n';
    const path = await workspace(original);

    const result = await registerCollectionInWorkspace(path, { name: 'B', path: '/c/B' });

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toContain('shape this cannot extend');
    expect(await readFile(path, 'utf-8')).toBe(original);
  });

  it('keeps CRLF endings when the file uses them', async () => {
    const path = await workspace('collections:\r\n  - name: "A"\r\n    path: "/c/A"\r\n');

    await registerCollectionInWorkspace(path, { name: 'B', path: '/c/B' });

    expect(await readFile(path, 'utf-8')).toBe(
      'collections:\r\n  - name: "A"\r\n    path: "/c/A"\r\n  - name: "B"\r\n    path: "/c/B"\r\n',
    );
  });
});

describe('what it refuses', () => {
  it('does not create a workspace that is not there', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workspace-registrar-'));
    const path = join(dir, 'workspace.yml');

    const result = await registerCollectionInWorkspace(path, { name: 'One', path: '/c/One' });

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toContain('no workspace file');
    await expect(readFile(path, 'utf-8')).rejects.toThrow();
  });

  it('refuses a name that would not fit on one line', async () => {
    const path = await workspace(REAL);

    const result = await registerCollectionInWorkspace(path, {
      name: 'two\nlines',
      path: '/c/One',
    });

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toContain('line break');
    expect(await readFile(path, 'utf-8')).toBe(REAL);
  });

  it('refuses a path that would not fit on one line', async () => {
    const path = await workspace(REAL);

    const result = await registerCollectionInWorkspace(path, {
      name: 'One',
      path: '/c/two\nlines',
    });

    expect(result.outcome).toBe('skipped');
    expect(await readFile(path, 'utf-8')).toBe(REAL);
  });
});

describe('quoting', () => {
  it('escapes a quote and a backslash so the file still parses', async () => {
    const path = await workspace('collections:\n');

    await registerCollectionInWorkspace(path, {
      name: 'He said "hi"',
      path: 'C:\\collections\\One',
    });

    const written = await readFile(path, 'utf-8');
    expect(written).toBe(
      'collections:\n  - name: "He said \\"hi\\""\n    path: "C:\\\\collections\\\\One"\n',
    );
    // Proven by reading it back through the parser the listing uses, not by
    // trusting that the escaping looked right.
    const { createWorkspaceResolver } = await import('../../../src/bruno/workspace');
    expect(createWorkspaceResolver().parseWorkspaceYaml(written)).toEqual([
      { name: 'He said "hi"', path: 'C:\\collections\\One' },
    ]);
  });
});
