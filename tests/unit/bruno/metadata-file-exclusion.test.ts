/**
 * Bruno's own metadata files must never be reported or executed as requests.
 *
 * Real Bruno collections carry `collection.bru` (or `collection.yml`) at the
 * root and `folder.bru` in folders. Three separate walkers here each kept their
 * own exclusion list and all three missed those names, so `list_requests` on a
 * genuine collection returned phantom requests and `run_collection` tried to
 * execute files that declare no method and no URL. All three now share one
 * classifier, which is why the same fixture is asserted against each of them.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isMetadataFile,
  COLLECTION_ROOT_BASENAMES,
  FOLDER_ROOT_BASENAMES,
} from '../../../src/bruno/metadata-files';
import { createCollectionManager } from '../../../src/bruno/collection';
import { getCollectionStats } from '../../../src/bruno/collection-stats';
import { RequestExecutor } from '../../../src/bruno/request-executor';

const ROOT = '/collections/Demo';

const REAL_BRU = `meta {
  name: Ping
  type: http
  seq: 1
}

get {
  url: https://example.test/ping
  body: none
  auth: none
}
`;

const COLLECTION_BRU = `auth {
  mode: none
}
`;

const FOLDER_BRU = `meta {
  name: Nested
  seq: 1
}
`;

/**
 * Seeds a collection shaped like one Bruno itself would write: metadata at the
 * root and in a folder, alongside exactly one real request per level.
 */
async function seedCollection(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'bruno-metadata-'));
  const nested = join(root, 'Nested');
  await fs.mkdir(nested, { recursive: true });

  await fs.writeFile(join(root, 'collection.bru'), COLLECTION_BRU, 'utf-8');
  await fs.writeFile(join(root, 'ping.bru'), REAL_BRU, 'utf-8');
  await fs.writeFile(join(nested, 'folder.bru'), FOLDER_BRU, 'utf-8');
  await fs.writeFile(join(nested, 'inner.bru'), REAL_BRU, 'utf-8');

  return root;
}

describe('isMetadataFile', () => {
  it.each([...COLLECTION_ROOT_BASENAMES])('treats %s at the collection root as metadata', (name) => {
    expect(isMetadataFile(join(ROOT, name), ROOT)).toBe(true);
  });

  it.each([...FOLDER_ROOT_BASENAMES])('treats %s as metadata at any depth', (name) => {
    expect(isMetadataFile(join(ROOT, name), ROOT)).toBe(true);
    expect(isMetadataFile(join(ROOT, 'Deep', 'Deeper', name), ROOT)).toBe(true);
  });

  it('treats a collection-root basename inside a folder as an ordinary request', () => {
    // Bruno only recognises a collection root at the top level, so a file that
    // happens to carry the name deeper down is a request to it, and to us.
    expect(isMetadataFile(join(ROOT, 'Nested', 'collection.bru'), ROOT)).toBe(false);
  });

  it('treats bruno.json as metadata only at the collection root', () => {
    expect(isMetadataFile(join(ROOT, 'bruno.json'), ROOT)).toBe(true);
    expect(isMetadataFile(join(ROOT, 'Nested', 'bruno.json'), ROOT)).toBe(false);
  });

  it('matches case-sensitively, as Bruno does', () => {
    expect(isMetadataFile(join(ROOT, 'Collection.bru'), ROOT)).toBe(false);
  });

  it('does not claim an ordinary request file', () => {
    expect(isMetadataFile(join(ROOT, 'ping.bru'), ROOT)).toBe(false);
    expect(isMetadataFile(join(ROOT, 'Nested', 'inner.yml'), ROOT)).toBe(false);
  });
});

describe('metadata files are excluded from every collection walk', () => {
  let root: string;

  beforeAll(async () => {
    root = await seedCollection();
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('list_requests reports only the real requests', async () => {
    const listed = await createCollectionManager().listRequests(root);
    const names = listed.map((p) => p.slice(root.length + 1));

    expect(names.sort()).toEqual([join('Nested', 'inner.bru'), 'ping.bru']);
  });

  it('collection stats count only the real requests', async () => {
    const stats = await getCollectionStats(root);

    expect(stats.totalRequests).toBe(2);
    expect(stats.requests.map((r) => r.name).sort()).toEqual(['Ping', 'Ping']);
  });

  it('run_collection does not try to execute metadata files', async () => {
    // A metadata-only collection has nothing to send, so a run must produce zero
    // results and zero parse errors rather than attempting a request with no URL.
    const empty = await fs.mkdtemp(join(tmpdir(), 'bruno-metadata-only-'));
    try {
      await fs.writeFile(join(empty, 'collection.bru'), COLLECTION_BRU, 'utf-8');
      await fs.writeFile(join(empty, 'folder.bru'), FOLDER_BRU, 'utf-8');

      const result = await RequestExecutor.executeCollection(empty);

      expect(result.groups[0]!.results).toEqual([]);
      expect(result.parseErrors ?? 0).toBe(0);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
});
