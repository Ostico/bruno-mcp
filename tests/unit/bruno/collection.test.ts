import { CollectionManager, createCollectionManager } from '../../../src/bruno/collection';
import { BrunoError, BruFileError, BruValidationError } from '../../../src/bruno/types';
import { withPathLock } from '../../../src/bruno/path-mutex';

// Writers now go through writeFileAtomic instead of a plain fs write. Route it
// back to the same fs mock so these tests keep asserting on the content and path
// written; the write mechanism itself is covered by the atomic-write suites.
jest.mock('../../../src/bruno/atomic-write.js', () => ({
  writeFileAtomic: (...args: unknown[]) =>
    (jest.requireMock('fs') as { promises: { writeFile: (...a: unknown[]) => Promise<void> } })
      .promises.writeFile(...args),
}));

jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    readdir: jest.fn(),
    mkdir: jest.fn(),
    access: jest.fn(),
  },
}));

jest.mock('../../../src/bruno/yaml-generator.js', () => ({
  generateYamlCollection: jest.fn(() => 'opencollection: "1"\ninfo:\n  name: test\n'),
}));

jest.mock('../../../src/bruno/format-detector.js', () => ({
  detectFormat: jest.fn(),
}));

jest.mock('../../../src/bruno/yaml-parser.js', () => ({
  parseYamlCollection: jest.fn(),
}));

const fs = require('fs').promises;
const { detectFormat } = require('../../../src/bruno/format-detector.js');
const { parseYamlCollection } = require('../../../src/bruno/yaml-parser.js');

describe('BruValidationError (types)', () => {
  it('sets code VALIDATION_ERROR, name, message and details', () => {
    const err = new BruValidationError('bad input', { field: 'name' });
    expect(err).toBeInstanceOf(BrunoError);
    expect(err.name).toBe('BruValidationError');
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('bad input');
    expect(err.details).toEqual({ field: 'name' });
  });
});

describe('CollectionManager', () => {
  let manager: CollectionManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = createCollectionManager();
    fs.access.mockRejectedValue(new Error('ENOENT'));
    fs.mkdir.mockResolvedValue(undefined);
    fs.writeFile.mockResolvedValue(undefined);
  });

  describe('createCollection()', () => {
    it('should create yaml collection (default format)', async () => {
      const result = await manager.createCollection({
        name: 'my-api',
        outputPath: '/workspace',
      });

      expect(result.success).toBe(true);
      expect(result.path).toBe('/workspace/my-api');
      expect(fs.writeFile).toHaveBeenCalledWith(
        '/workspace/my-api/opencollection.yml',
        expect.any(String),
      );
    });

    it('should create bru collection when format=bru', async () => {
      const result = await manager.createCollection({
        name: 'my-api',
        outputPath: '/workspace',
        format: 'bru',
      });

      expect(result.success).toBe(true);
      expect(fs.writeFile).toHaveBeenCalledWith(
        '/workspace/my-api/bruno.json',
        expect.stringContaining('"name": "my-api"'),
      );
    });

    it('should create bru collection with custom ignore', async () => {
      await manager.createCollection({
        name: 'api',
        outputPath: '/ws',
        format: 'bru',
        ignore: ['dist', '.cache'],
      });

      const call = fs.writeFile.mock.calls.find((c: any[]) => c[0].endsWith('bruno.json'));
      const config = JSON.parse(call[1]);
      expect(config.ignore).toEqual(['dist', '.cache']);
    });

    it('should create environments dir, gitignore, and readme', async () => {
      await manager.createCollection({
        name: 'test',
        outputPath: '/ws',
      });

      expect(fs.mkdir).toHaveBeenCalledWith('/ws/test/environments', { recursive: true });
      const writeCalls = fs.writeFile.mock.calls.map((c: any[]) => c[0]);
      expect(writeCalls).toContain('/ws/test/.gitignore');
      expect(writeCalls).toContain('/ws/test/README.md');
    });

    it('should skip gitignore if already exists', async () => {
      fs.access.mockImplementation((p: string) => {
        if (p.endsWith('.gitignore')) return Promise.resolve();
        return Promise.reject(new Error('ENOENT'));
      });

      await manager.createCollection({ name: 'test', outputPath: '/ws' });

      const gitignoreWrites = fs.writeFile.mock.calls.filter(
        (c: any[]) => c[0].endsWith('.gitignore'),
      );
      expect(gitignoreWrites).toHaveLength(0);
    });

    it('should include description and baseUrl in readme', async () => {
      await manager.createCollection({
        name: 'api',
        outputPath: '/ws',
        description: 'My API tests',
        baseUrl: 'https://api.example.com',
      });

      const readmeCall = fs.writeFile.mock.calls.find((c: any[]) => c[0].endsWith('README.md'));
      expect(readmeCall[1]).toContain('My API tests');
      expect(readmeCall[1]).toContain('https://api.example.com');
    });

    it('should return error on empty name', async () => {
      const result = await manager.createCollection({
        name: '',
        outputPath: '/ws',
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/name is required/i);
    });

    it('should return error on empty outputPath', async () => {
      const result = await manager.createCollection({
        name: 'test',
        outputPath: '',
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/output path is required/i);
    });

    it('should return error on invalid chars in name', async () => {
      const result = await manager.createCollection({
        name: 'my<api>',
        outputPath: '/ws',
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/invalid characters/i);
    });

    it('should return error on fs failure', async () => {
      fs.mkdir.mockRejectedValue(new Error('EPERM'));
      const result = await manager.createCollection({
        name: 'test',
        outputPath: '/ws',
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('EPERM');
    });
  });

  describe('loadCollection()', () => {
    it('should load yaml collection', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml', configPath: '/c/opencollection.yml', collectionName: 'api' });
      fs.readFile.mockResolvedValue('opencollection: "1"\ninfo:\n  name: api\n');
      parseYamlCollection.mockReturnValue({
        opencollection: '1',
        info: { name: 'api' },
      });

      const config = await manager.loadCollection('/c');
      expect(config.name).toBe('api');
      expect(config.version).toBe('1');
      expect(config.type).toBe('collection');
    });

    it('should load yaml collection with extensions.bruno.ignore', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml', configPath: '/c/opencollection.yml', collectionName: 'api' });
      fs.readFile.mockResolvedValue('');
      parseYamlCollection.mockReturnValue({
        opencollection: '1',
        info: { name: 'api' },
        extensions: { bruno: { ignore: ['dist'] } },
      });

      const config = await manager.loadCollection('/c');
      expect(config.ignore).toEqual(['dist']);
    });

    it('should load bru collection', async () => {
      detectFormat.mockResolvedValue({ format: 'bru', configPath: '/c/bruno.json', collectionName: 'api' });
      fs.readFile.mockResolvedValue(JSON.stringify({
        version: '1',
        name: 'api',
        type: 'collection',
      }));

      const config = await manager.loadCollection('/c');
      expect(config.name).toBe('api');
    });

    it('should throw BruFileError on invalid config', async () => {
      detectFormat.mockResolvedValue({ format: 'bru', configPath: '/c/bruno.json', collectionName: 'api' });
      fs.readFile.mockResolvedValue(JSON.stringify({
        version: '1',
        name: 'api',
        type: 'wrong',
      }));

      await expect(manager.loadCollection('/c')).rejects.toThrow(BruFileError);
    });

    it('should throw BruFileError on read failure', async () => {
      detectFormat.mockRejectedValue(new Error('ENOENT'));
      await expect(manager.loadCollection('/missing')).rejects.toThrow(BruFileError);
    });
  });

  describe('updateCollection()', () => {
    it('should update yaml collection', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml', configPath: '/c/opencollection.yml', collectionName: 'api' });
      fs.readFile.mockResolvedValue('');
      parseYamlCollection.mockReturnValue({
        opencollection: '1',
        info: { name: 'api' },
      });

      const result = await manager.updateCollection('/c', { name: 'updated-api' });
      expect(result.success).toBe(true);
      expect(fs.writeFile).toHaveBeenCalledWith(
        '/c/opencollection.yml',
        expect.any(String),
      );
    });

    it('should update bru collection', async () => {
      detectFormat.mockResolvedValue({ format: 'bru', configPath: '/c/bruno.json', collectionName: 'api' });
      fs.readFile.mockResolvedValue(JSON.stringify({
        version: '1',
        name: 'api',
        type: 'collection',
      }));

      const result = await manager.updateCollection('/c', { name: 'updated' });
      expect(result.success).toBe(true);
      expect(result.path).toBe('/c/bruno.json');
    });

    it('should return error on failure', async () => {
      detectFormat.mockRejectedValue(new Error('fail'));
      const result = await manager.updateCollection('/c', { name: 'x' });
      expect(result.success).toBe(false);
    });

    it('should return error when the updated name is empty', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml', configPath: '/c/opencollection.yml', collectionName: 'api' });
      fs.readFile.mockResolvedValue('');
      parseYamlCollection.mockReturnValue({
        opencollection: '1',
        info: { name: 'api' },
      });

      const result = await manager.updateCollection('/c', { name: '   ' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/name is required/i);
    });

    it('should return error when the updated version is empty', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml', configPath: '/c/opencollection.yml', collectionName: 'api' });
      fs.readFile.mockResolvedValue('');
      parseYamlCollection.mockReturnValue({
        opencollection: '1',
        info: { name: 'api' },
      });

      const result = await manager.updateCollection('/c', { version: '' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/version is required/i);
    });
  });

  describe('listRequests()', () => {
    it('should find .bru and .yml files recursively', async () => {
      fs.readdir.mockImplementation((dir: string) => {
        if (dir === '/c') {
          return Promise.resolve([
            { name: 'get-users.bru', isFile: () => true, isDirectory: () => false },
            { name: 'sub', isFile: () => false, isDirectory: () => true },
            { name: 'opencollection.yml', isFile: () => true, isDirectory: () => false },
            { name: 'folder.yml', isFile: () => true, isDirectory: () => false },
          ]);
        }
        if (dir === '/c/sub') {
          return Promise.resolve([
            { name: 'create.yml', isFile: () => true, isDirectory: () => false },
          ]);
        }
        return Promise.resolve([]);
      });

      const result = await manager.listRequests('/c');
      expect(result).toContain('/c/get-users.bru');
      expect(result).toContain('/c/sub/create.yml');
      expect(result).not.toContain('/c/opencollection.yml');
      expect(result).not.toContain('/c/folder.yml');
    });

    it('should skip node_modules, .git, environments dirs', async () => {
      fs.readdir.mockResolvedValue([
        { name: 'node_modules', isFile: () => false, isDirectory: () => true },
        { name: '.git', isFile: () => false, isDirectory: () => true },
        { name: 'environments', isFile: () => false, isDirectory: () => true },
        { name: 'test.bru', isFile: () => true, isDirectory: () => false },
      ]);

      const result = await manager.listRequests('/c');
      expect(result).toEqual(['/c/test.bru']);
      expect(fs.readdir).toHaveBeenCalledTimes(1);
    });

    it('should throw BruFileError on failure', async () => {
      fs.readdir.mockRejectedValue(new Error('EACCES'));
      await expect(manager.listRequests('/c')).rejects.toThrow(BruFileError);
    });
  });

  describe('createFolder()', () => {
    it('should create folder within collection', async () => {
      const result = await manager.createFolder('/c', 'auth/login');
      expect(result.success).toBe(true);
      expect(result.path).toBe('/c/auth/login');
    });

    it('should return error on failure', async () => {
      fs.mkdir.mockRejectedValue(new Error('EPERM'));
      fs.access.mockRejectedValue(new Error('ENOENT'));
      const result = await manager.createFolder('/c', 'test');
      expect(result.success).toBe(false);
    });
  });

  describe('getCollectionStats()', () => {
    it('should return stats with requests, folders, environments', async () => {
      fs.readdir.mockImplementation((dir: string) => {
        if (dir.endsWith('environments')) {
          return Promise.resolve([
            { name: 'dev.yml', isFile: () => true, isDirectory: () => false },
            { name: 'prod.bru', isFile: () => true, isDirectory: () => false },
          ]);
        }
        if (dir === '/c') {
          return Promise.resolve([
            { name: 'test.bru', isFile: () => true, isDirectory: () => false },
            { name: 'auth', isFile: () => false, isDirectory: () => true },
            { name: 'environments', isFile: () => false, isDirectory: () => true },
            { name: '.git', isFile: () => false, isDirectory: () => true },
          ]);
        }
        return Promise.resolve([]);
      });

      const stats = await manager.getCollectionStats('/c');
      expect(stats.totalRequests).toBe(1);
      expect(stats.folders).toEqual(['auth']);
      expect(stats.environments).toEqual(['dev', 'prod']);
    });

    it('should return empty environments if dir missing', async () => {
      fs.readdir.mockImplementation((dir: string) => {
        if (dir.endsWith('environments')) {
          return Promise.reject(new Error('ENOENT'));
        }
        return Promise.resolve([
          { name: 'req.bru', isFile: () => true, isDirectory: () => false },
        ]);
      });

      const stats = await manager.getCollectionStats('/c');
      expect(stats.environments).toEqual([]);
    });

    it('should throw BruFileError on failure', async () => {
      fs.readdir.mockRejectedValue(new Error('EACCES'));
      await expect(manager.getCollectionStats('/c')).rejects.toThrow(BruFileError);
    });
  });

  /**
   * updateCollection serializes its read-modify-write on the collection
   * directory. Creation writes the same config file, so it has to queue on that
   * key too — otherwise a create against an existing collection can land between
   * an update's read and write and be overwritten by the older config.
   */
  describe('serialization against updateCollection', () => {
    it('does not write the config while the collection is locked', async () => {
      let resolveGate!: () => void;
      const gate = new Promise<void>((res) => {
        resolveGate = res;
      });
      const held = withPathLock('/out/Orders', () => gate);

      const creating = manager.createCollection({ outputPath: '/out', name: 'Orders' });

      // Every dependency is a resolved mock, so an unserialised create would
      // already have written by the time microtasks and one macrotask have run.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(fs.writeFile).not.toHaveBeenCalled();

      resolveGate();
      await held;
      await expect(creating).resolves.toMatchObject({ success: true });
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('still reports invalid input as a result rather than throwing', async () => {
      // The lock key is built from outputPath and name, the same fields the
      // validator requires, so validation has to run before the key is derived.
      const result = await manager.createCollection({ outputPath: '/out', name: '' });
      expect(result.success).toBe(false);
      expect(fs.writeFile).not.toHaveBeenCalled();
    });
  });
});
