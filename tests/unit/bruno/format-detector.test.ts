import {
  detectFormat,
  findCollectionRoot,
  clearFormatCache,
} from '../../../src/bruno/format-detector';

jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    access: jest.fn(),
  },
}));

const fs = require('fs').promises;

describe('format-detector', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearFormatCache();
  });

  describe('detectFormat()', () => {
    it('should detect yaml format from opencollection.yml', async () => {
      fs.readFile.mockImplementation((p: string) => {
        if (p.endsWith('opencollection.yml')) {
          return Promise.resolve('opencollection: "1"\ninfo:\n  name: my-api\n');
        }
        return Promise.reject(new Error('ENOENT'));
      });

      const result = await detectFormat('/col');
      expect(result.format).toBe('yaml');
      expect(result.collectionName).toBe('my-api');
    });

    it('should detect bru format from bruno.json', async () => {
      fs.readFile.mockImplementation((p: string) => {
        if (p.endsWith('opencollection.yml')) {
          return Promise.reject(new Error('ENOENT'));
        }
        if (p.endsWith('bruno.json')) {
          return Promise.resolve(JSON.stringify({ name: 'my-bru', version: '1' }));
        }
        return Promise.reject(new Error('ENOENT'));
      });

      const result = await detectFormat('/col');
      expect(result.format).toBe('bru');
      expect(result.collectionName).toBe('my-bru');
    });

    it('should default to yaml when neither file found', async () => {
      fs.readFile.mockRejectedValue(new Error('ENOENT'));

      const result = await detectFormat('/empty');
      expect(result.format).toBe('yaml');
      expect(result.configPath).toBe('');
    });

    it('should use basename when yaml has no info.name', async () => {
      fs.readFile.mockImplementation((p: string) => {
        if (p.endsWith('opencollection.yml')) {
          return Promise.resolve('opencollection: "1"\n');
        }
        return Promise.reject(new Error('ENOENT'));
      });

      const result = await detectFormat('/path/to/my-collection');
      expect(result.collectionName).toBe('my-collection');
    });

    it('should use basename when bruno.json has no name', async () => {
      fs.readFile.mockImplementation((p: string) => {
        if (p.endsWith('opencollection.yml')) {
          return Promise.reject(new Error('ENOENT'));
        }
        if (p.endsWith('bruno.json')) {
          return Promise.resolve(JSON.stringify({ version: '1' }));
        }
        return Promise.reject(new Error('ENOENT'));
      });

      const result = await detectFormat('/path/to/bru-col');
      expect(result.collectionName).toBe('bru-col');
    });

    it('should cache results', async () => {
      fs.readFile.mockRejectedValue(new Error('ENOENT'));

      await detectFormat('/cached');
      await detectFormat('/cached');

      // readFile called only for first invocation (2 calls: yml + json)
      // second invocation returns cache
      const callsForCached = fs.readFile.mock.calls.filter(
        (c: any[]) => c[0].startsWith('/cached'),
      );
      expect(callsForCached.length).toBeLessThanOrEqual(2);
    });

    it('should return fresh results after clearFormatCache', async () => {
      fs.readFile.mockRejectedValue(new Error('ENOENT'));

      await detectFormat('/clear-test');
      clearFormatCache();
      await detectFormat('/clear-test');

      const calls = fs.readFile.mock.calls.filter(
        (c: any[]) => c[0].startsWith('/clear-test'),
      );
      expect(calls.length).toBe(4); // 2 per invocation
    });
  });

  describe('findCollectionRoot()', () => {
    it('should find root with opencollection.yml', async () => {
      fs.access.mockImplementation((p: string) => {
        if (p === '/project/api/opencollection.yml') return Promise.resolve();
        return Promise.reject(new Error('ENOENT'));
      });

      const root = await findCollectionRoot('/project/api/requests/get.yml');
      expect(root).toBe('/project/api');
    });

    it('should find root with bruno.json', async () => {
      fs.access.mockImplementation((p: string) => {
        if (p === '/project/col/bruno.json') return Promise.resolve();
        return Promise.reject(new Error('ENOENT'));
      });

      const root = await findCollectionRoot('/project/col/sub/req.bru');
      expect(root).toBe('/project/col');
    });

    it('should return null when no marker found within 10 levels', async () => {
      fs.access.mockRejectedValue(new Error('ENOENT'));

      const root = await findCollectionRoot('/a/b/c/d/e/f/g/h/i/j/k/file.yml');
      expect(root).toBeNull();
    });

    it('should stop at filesystem root', async () => {
      fs.access.mockRejectedValue(new Error('ENOENT'));

      const root = await findCollectionRoot('/short/file.yml');
      expect(root).toBeNull();
    });

    it('should prefer opencollection.yml over bruno.json at same level', async () => {
      fs.access.mockImplementation((p: string) => {
        if (p === '/col/opencollection.yml') return Promise.resolve();
        if (p === '/col/bruno.json') return Promise.resolve();
        return Promise.reject(new Error('ENOENT'));
      });

      const root = await findCollectionRoot('/col/req.bru');
      expect(root).toBe('/col');
    });
  });
});
