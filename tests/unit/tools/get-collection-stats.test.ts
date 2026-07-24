/**
 * Tests for get_collection_stats tool — YAML-aware collection statistics.
 *
 * Uses fixture data under tests/fixtures/sample-collection that mirrors
 * a real Bruno opencollection layout:
 *   sample-collection/
 *     opencollection.yml
 *     environments/dev.yml
 *     Context-Url/
 *       folder.yml
 *       Schema.yml          (GET,  seq 1, has tests)
 *       Set for Project.yml  (POST, seq 2, has tests)
 *       Get for Project.yml  (POST, seq 3, has tests)
 *       Delete for Project.yml (POST, seq 4, NO tests)
 */

import { join } from 'path';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { getCollectionStats } from '../../../src/bruno/collection-stats.js';
import { BrunoError } from '../../../src/bruno/types.js';

const FIXTURES = join(__dirname, '..', '..', 'fixtures');
const SAMPLE = join(FIXTURES, 'sample-collection');
const EMPTY = join(FIXTURES, 'empty-collection');

describe('getCollectionStats', () => {
  // -----------------------------------------------------------------------
  // Happy path — real fixture with 4 requests in one folder
  // -----------------------------------------------------------------------
  describe('sample collection with requests', () => {
    let stats: Awaited<ReturnType<typeof getCollectionStats>>;

    beforeAll(async () => {
      stats = await getCollectionStats(SAMPLE);
    });

    it('counts total requests correctly (excluding folder.yml, opencollection.yml, env files)', () => {
      expect(stats.totalRequests).toBe(4);
    });

    it('counts requests by HTTP method', () => {
      expect(stats.requestsByMethod).toEqual({
        GET: 1,
        POST: 3,
      });
    });

    it('lists folders found in collection', () => {
      expect(stats.folders).toEqual(['Context-Url']);
    });

    it('lists environments found in collection', () => {
      expect(stats.environments).toEqual(['dev']);
    });

    it('returns per-request details', () => {
      expect(stats.requests).toHaveLength(4);
    });

    it('includes correct fields on each request detail', () => {
      for (const req of stats.requests) {
        expect(req).toHaveProperty('name');
        expect(req).toHaveProperty('method');
        expect(req).toHaveProperty('seq');
        expect(req).toHaveProperty('folder');
        expect(req).toHaveProperty('hasTests');
        expect(req).toHaveProperty('filePath');
      }
    });

    it('includes filePath as absolute path to .yml file on each request', () => {
      for (const req of stats.requests) {
        expect(req.filePath).toBeDefined();
        expect(req.filePath).toMatch(/\.(yml|bru)$/);
        expect(req.filePath).toMatch(/^\//); // absolute path
      }
    });

    it('detects hasTests correctly — Schema.yml has test scripts', () => {
      const schema = stats.requests.find((r) => r.name === 'Schema');
      expect(schema).toBeDefined();
      expect(schema!.hasTests).toBe(true);
    });

    it('detects hasTests correctly — Set for Project has test scripts', () => {
      const req = stats.requests.find((r) => r.name === 'Set for Project');
      expect(req).toBeDefined();
      expect(req!.hasTests).toBe(true);
    });

    it('detects hasTests correctly — Delete for Project has NO test scripts', () => {
      const req = stats.requests.find((r) => r.name === 'Delete for Project');
      expect(req).toBeDefined();
      expect(req!.hasTests).toBe(false);
    });

    it('records correct method for each request', () => {
      const schema = stats.requests.find((r) => r.name === 'Schema');
      expect(schema!.method).toBe('GET');

      const setReq = stats.requests.find((r) => r.name === 'Set for Project');
      expect(setReq!.method).toBe('POST');
    });

    it('records correct seq for each request', () => {
      const schema = stats.requests.find((r) => r.name === 'Schema');
      expect(schema!.seq).toBe(1);

      const del = stats.requests.find((r) => r.name === 'Delete for Project');
      expect(del!.seq).toBe(4);
    });

    it('records correct folder for each request', () => {
      for (const req of stats.requests) {
        expect(req.folder).toBe('Context-Url');
      }
    });

    it('sorts requests by seq', () => {
      const seqs = stats.requests.map((r) => r.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    });
  });

  // -----------------------------------------------------------------------
  // Empty collection — only opencollection.yml, no request files
  // -----------------------------------------------------------------------
  describe('empty collection', () => {
    let stats: Awaited<ReturnType<typeof getCollectionStats>>;

    beforeAll(async () => {
      stats = await getCollectionStats(EMPTY);
    });

    it('returns totalRequests 0', () => {
      expect(stats.totalRequests).toBe(0);
    });

    it('returns empty requestsByMethod', () => {
      expect(stats.requestsByMethod).toEqual({});
    });

    it('returns empty folders array', () => {
      expect(stats.folders).toEqual([]);
    });

    it('returns empty environments array', () => {
      expect(stats.environments).toEqual([]);
    });

    it('returns empty requests array', () => {
      expect(stats.requests).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Error case — non-existent path
  // -----------------------------------------------------------------------
  describe('non-existent collection path', () => {
    it('throws a meaningful error', async () => {
      await expect(
        getCollectionStats('/tmp/does-not-exist-collection-xyz'),
      ).rejects.toThrow(/does not exist|ENOENT|not found/i);
    });

    it('throws a BrunoError with code NOT_FOUND', async () => {
      try {
        await getCollectionStats('/tmp/does-not-exist-collection-xyz');
        fail('Expected BrunoError to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(BrunoError);
        expect((err as BrunoError).code).toBe('NOT_FOUND');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases driven with a real temp dir — exercise .bru parsing and the
  // error/guard paths (readdir fails, readFile fails, parse fails).
  // -----------------------------------------------------------------------
  describe('temp-dir edge cases', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fsp.mkdtemp(join(tmpdir(), 'bruno-stats-'));
    });

    afterEach(async () => {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    it('returns empty stats when the path is a file, not a directory (readdir fails)', async () => {
      const filePath = join(tmpDir, 'not-a-dir.txt');
      await fsp.writeFile(filePath, 'plain');

      const stats = await getCollectionStats(filePath);

      expect(stats.totalRequests).toBe(0);
      expect(stats.folders).toEqual([]);
      expect(stats.environments).toEqual([]);
      expect(stats.requests).toEqual([]);
    });

    it('parses .bru request files (bru branch) including method, seq and tests', async () => {
      const bru = [
        'meta {',
        '  name: My Bru Request',
        '  type: http',
        '  seq: 2',
        '}',
        '',
        'get {',
        '  url: https://example.com',
        '}',
        '',
        'tests {',
        "  test('ok', function() { expect(1).to.equal(1); });",
        '}',
        '',
      ].join('\n');
      await fsp.writeFile(join(tmpDir, 'req.bru'), bru);

      const stats = await getCollectionStats(tmpDir);

      expect(stats.totalRequests).toBe(1);
      expect(stats.requests[0].name).toBe('My Bru Request');
      expect(stats.requests[0].method).toBe('GET');
      expect(stats.requests[0].seq).toBe(2);
      expect(stats.requests[0].hasTests).toBe(true);
      expect(stats.requestsByMethod).toEqual({ GET: 1 });
    });

    it('skips a request file that cannot be read (readFile error)', async () => {
      await fsp.writeFile(
        join(tmpDir, 'req.yml'),
        'info:\n  name: X\nhttp:\n  method: get\n  url: https://x.com\n',
      );
      const spy = jest.spyOn(fsp, 'readFile').mockRejectedValue(new Error('EACCES'));

      const stats = await getCollectionStats(tmpDir);

      expect(stats.totalRequests).toBe(0);
      spy.mockRestore();
    });

    it('skips a request file whose contents fail to parse (parse error)', async () => {
      // Valid YAML object but missing the required info/http sections, so
      // parseYamlRequest throws and the request is skipped.
      await fsp.writeFile(join(tmpDir, 'bad.yml'), 'random: content\n');

      const stats = await getCollectionStats(tmpDir);

      expect(stats.totalRequests).toBe(0);
    });

    it('reports hasTests false for a .bru request without a tests block', async () => {
      const bru = [
        'meta {',
        '  name: NoTests',
        '  type: http',
        '}',
        '',
        'get {',
        '  url: https://example.com',
        '}',
        '',
      ].join('\n');
      await fsp.writeFile(join(tmpDir, 'notests.bru'), bru);

      const stats = await getCollectionStats(tmpDir);

      expect(stats.requests[0].name).toBe('NoTests');
      expect(stats.requests[0].method).toBe('GET');
      expect(stats.requests[0].hasTests).toBe(false);
      expect(typeof stats.requests[0].seq).toBe('number');
    });

    it('defaults seq to 0 for a .yml request without a seq field', async () => {
      await fsp.writeFile(
        join(tmpDir, 'noseq.yml'),
        'info:\n  name: NoSeq\nhttp:\n  method: get\n  url: https://x.com\n',
      );

      const stats = await getCollectionStats(tmpDir);

      expect(stats.requests[0].seq).toBe(0);
    });

    it('lists only .yml/.bru files as environments, ignoring subdirs and other files', async () => {
      const envDir = join(tmpDir, 'environments');
      await fsp.mkdir(envDir, { recursive: true });
      await fsp.writeFile(join(envDir, 'dev.yml'), 'name: dev\n');
      await fsp.writeFile(join(envDir, 'notes.txt'), 'ignore me');
      await fsp.mkdir(join(envDir, 'nested'), { recursive: true });

      const stats = await getCollectionStats(tmpDir);

      expect(stats.environments).toEqual(['dev']);
    });
  });
});
