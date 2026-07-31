/**
 * Tests for reading collection.bru / folder.bru and the YAML root files.
 *
 * These files were previously known only as things to exclude from request
 * discovery, so a collection-wide header or auth vanished without a word. What
 * matters here is that both dialects are read, that the nearest definition wins,
 * and that a setting which is read but NOT yet applied says so — silence is the
 * defect being closed.
 */

import { createRootLoader } from '../../../src/bruno/collection-roots';
import * as fs from 'node:fs/promises';

jest.mock('node:fs/promises');
const mockedFs = jest.mocked(fs);

const COLLECTION_BRU = `headers {
  x-collection: from-collection
  authorization: Bearer collection-token
  x-off: nope
  ~x-disabled: dropped
}

auth {
  mode: bearer
}

auth:bearer {
  token: {{collection_token}}
}
`;

const FOLDER_BRU = `meta {
  name: nested
}

headers {
  x-folder: from-folder
  x-collection: folder-overrides-collection
}
`;

const OPENCOLLECTION_YML = `opencollection: "1.0.0"
info:
  name: yml-collection
request:
  headers:
    - name: x-collection
      value: from-yml-collection
    - name: x-skipped
      value: nope
      disabled: true
  auth:
    mode: basic
    basic:
      username: u
      password: p
`;

/** Only files named here exist; everything else raises ENOENT. */
function fsWith(files: Record<string, string>): void {
  mockedFs.readFile.mockImplementation(async (filePath: any) => {
    const p = typeof filePath === 'string' ? filePath : filePath.toString();
    if (files[p] !== undefined) {
      return files[p];
    }
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
}

describe('createRootLoader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns an empty chain when a collection has no root files', async () => {
    fsWith({});
    const loader = createRootLoader('/c');

    const chain = await loader.forRequest('/c/Request.yml');

    expect(chain).toEqual({ headers: [], auth: undefined, unapplied: [] });
  });

  it('reads headers and auth from collection.bru', async () => {
    fsWith({ '/c/collection.bru': COLLECTION_BRU });
    const loader = createRootLoader('/c');

    const chain = await loader.forRequest('/c/Request.yml');

    expect(chain.headers).toEqual([
      { name: 'x-collection', value: 'from-collection' },
      { name: 'authorization', value: 'Bearer collection-token' },
      { name: 'x-off', value: 'nope' },
    ]);
    // `~name` is Bruno's disabled marker; sending it would be wrong.
    expect(chain.headers.map(h => h.name)).not.toContain('x-disabled');
    expect(chain.auth).toEqual({ type: 'bearer', token: '{{collection_token}}' });
  });

  it('lets a folder root override the collection, ordering collection first', async () => {
    fsWith({
      '/c/collection.bru': COLLECTION_BRU,
      '/c/nested/folder.bru': FOLDER_BRU,
    });
    const loader = createRootLoader('/c');

    const chain = await loader.forRequest('/c/nested/Request.yml');

    // Order is the contract: the consumer keeps the LAST value for a name.
    const names = chain.headers.map(h => h.name);
    expect(names.indexOf('x-collection')).toBeLessThan(names.lastIndexOf('x-collection'));
    expect(chain.headers[chain.headers.length - 1]).toEqual({
      name: 'x-collection',
      value: 'folder-overrides-collection',
    });
  });

  it('walks every folder between the collection and the request', async () => {
    fsWith({
      '/c/collection.bru': COLLECTION_BRU,
      '/c/a/folder.bru': 'headers {\n  x-a: from-a\n}\n',
      '/c/a/b/folder.bru': 'headers {\n  x-b: from-b\n}\n',
    });
    const loader = createRootLoader('/c');

    const chain = await loader.forRequest('/c/a/b/Request.yml');

    expect(chain.headers.map(h => h.name)).toEqual(
      expect.arrayContaining(['x-collection', 'x-a', 'x-b']),
    );
  });

  it('takes auth from the nearest root that defines it', async () => {
    fsWith({
      '/c/collection.bru': COLLECTION_BRU,
      '/c/nested/folder.bru': 'auth {\n  mode: basic\n}\n\nauth:basic {\n  username: folder-user\n  password: pw\n}\n',
    });
    const loader = createRootLoader('/c');

    const chain = await loader.forRequest('/c/nested/Request.yml');

    expect(chain.auth).toEqual({ type: 'basic', username: 'folder-user', password: 'pw' });
  });

  it('keeps the collection\'s auth when a folder root defines none', async () => {
    fsWith({
      '/c/collection.bru': COLLECTION_BRU,
      '/c/nested/folder.bru': FOLDER_BRU,
    });
    const loader = createRootLoader('/c');

    const chain = await loader.forRequest('/c/nested/Request.yml');

    expect(chain.auth).toEqual({ type: 'bearer', token: '{{collection_token}}' });
  });

  it('reads the YAML dialect, including a disabled header', async () => {
    fsWith({ '/c/opencollection.yml': OPENCOLLECTION_YML });
    const loader = createRootLoader('/c');

    const chain = await loader.forRequest('/c/Request.yml');

    expect(chain.headers).toEqual([{ name: 'x-collection', value: 'from-yml-collection' }]);
    expect(chain.auth).toMatchObject({ type: 'basic' });
  });

  it('reports what a root declares but does not apply', async () => {
    fsWith({
      '/c/collection.bru': `vars:pre-request {
  collection_var: value
}

script:pre-request {
  bru.setVar('x', 1);
}

tests {
  test("t", function() {});
}
`,
    });
    const loader = createRootLoader('/c');

    const chain = await loader.forRequest('/c/Request.yml');

    // Named individually so a caller knows which setting is missing, not just
    // that something is.
    expect(chain.unapplied.join(' | ')).toContain('pre-request variables');
    expect(chain.unapplied.join(' | ')).toContain('a pre-request script');
    expect(chain.unapplied.join(' | ')).toContain('tests');
    expect(chain.unapplied.every(note => note.startsWith('collection.bru'))).toBe(true);
  });

  it('says nothing when a root declares only what is applied', async () => {
    fsWith({ '/c/collection.bru': COLLECTION_BRU });
    const loader = createRootLoader('/c');

    const chain = await loader.forRequest('/c/Request.yml');

    expect(chain.unapplied).toEqual([]);
  });

  it('survives a root file that will not parse, and says why', async () => {
    fsWith({ '/c/collection.bru': 'headers {\n  unclosed: yes\n' });
    const loader = createRootLoader('/c');

    const chain = await loader.forRequest('/c/Request.yml');

    // The requests are still runnable; they just do not get its settings.
    expect(chain.headers).toEqual([]);
    expect(chain.unapplied).toHaveLength(1);
    expect(chain.unapplied[0]).toContain('could not be parsed');
    expect(chain.unapplied[0]).not.toContain('\n');
  });

  it('reads each root file once, however many requests ask for it', async () => {
    fsWith({ '/c/collection.bru': COLLECTION_BRU });
    const loader = createRootLoader('/c');

    await loader.forRequest('/c/One.yml');
    await loader.forRequest('/c/Two.yml');
    await loader.forRequest('/c/Three.yml');

    const collectionReads = mockedFs.readFile.mock.calls
      .filter(([p]) => String(p).endsWith('collection.bru'));
    expect(collectionReads).toHaveLength(1);
  });

  it('ignores junk entries in a YAML header list instead of sending them', async () => {
    // A hand-edited root file can put anything in that list. None of these can
    // become a header, and none of them may take the run down either.
    fsWith({
      '/c/collection.yml': `info:
  name: c
request:
  headers:
    - "just a string"
    - null
    - value: nameless
    - name: ""
      value: empty-name
    - name: keeper
      value: kept
`,
    });
    const loader = createRootLoader('/c');

    const chain = await loader.forRequest('/c/Request.yml');

    expect(chain.headers).toEqual([{ name: 'keeper', value: 'kept' }]);
  });

  it('treats auth mode none, and a root with no auth block, as no auth', async () => {
    fsWith({
      '/c/collection.bru': 'auth {\n  mode: none\n}\n',
      '/c/nested/folder.bru': 'headers {\n  x: y\n}\n',
    });
    const loader = createRootLoader('/c');

    expect((await loader.forRequest('/c/Request.yml')).auth).toBeUndefined();
    expect((await loader.forRequest('/c/nested/Request.yml')).auth).toBeUndefined();
  });

  it('reads no folder roots for a request outside the collection path', async () => {
    fsWith({ '/c/collection.bru': COLLECTION_BRU });
    const loader = createRootLoader('/c');

    // `relative()` climbs out with `..`, so there is no folder chain to walk.
    const chain = await loader.forRequest('/elsewhere/Request.yml');

    expect(chain.headers[0]).toEqual({ name: 'x-collection', value: 'from-collection' });
    const folderReads = mockedFs.readFile.mock.calls
      .filter(([p]) => String(p).includes('folder.'));
    expect(folderReads).toHaveLength(0);
  });

  it('prefers collection.bru over the YAML root when both exist', async () => {
    fsWith({
      '/c/collection.bru': COLLECTION_BRU,
      '/c/opencollection.yml': OPENCOLLECTION_YML,
    });
    const loader = createRootLoader('/c');

    const chain = await loader.forRequest('/c/Request.yml');

    expect(chain.headers[0]).toEqual({ name: 'x-collection', value: 'from-collection' });
  });
});
