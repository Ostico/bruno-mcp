import { promises as fs } from 'fs';
import { join } from 'path';
import { WorkspaceResolver, createWorkspaceResolver } from '../../../src/bruno/workspace.js';

jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    access: jest.fn(),
  },
}));

const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;

const SAMPLE_WORKSPACE_YML = `opencollection: 1.0.0
info:
  name: "My Workspace"
  type: workspace

collections:
  - name: "MateCat"
    path: "/Users/test/bruno/MateCat"
  - name: "MyMemory"
    path: "/Users/test/bruno/MyMemory"
  - name: "ESTest"
    path: "/Users/test/bruno/ESTest"

specs:

docs: ''
`;

const EMPTY_WORKSPACE_YML = `opencollection: 1.0.0
info:
  name: "Empty Workspace"
  type: workspace

collections:

specs:

docs: ''
`;

const WORKSPACE_NO_COLLECTIONS_KEY = `opencollection: 1.0.0
info:
  name: "Bare Workspace"
  type: workspace
`;

describe('WorkspaceResolver', () => {
  let resolver: WorkspaceResolver;
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resolver = new WorkspaceResolver();
    jest.clearAllMocks();
    delete process.env.BRUNO_WORKSPACE_PATH;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    process.env = { ...originalEnv };
  });

  describe('resolve()', () => {
    describe('Cascade priority: explicit arg > env var > platform default', () => {
      it('should use explicit path argument when provided', async () => {
        const explicitPath = '/custom/path/workspace.yml';
        mockReadFile.mockResolvedValueOnce(SAMPLE_WORKSPACE_YML);

        const result = await resolver.resolve(explicitPath);

        expect(mockReadFile).toHaveBeenCalledWith(explicitPath, 'utf-8');
        expect(result).toHaveLength(3);
        expect(result[0]).toEqual({ name: 'MateCat', path: '/Users/test/bruno/MateCat' });
      });

      it('should prefer explicit path over env var', async () => {
        const explicitPath = '/custom/path/workspace.yml';
        process.env.BRUNO_WORKSPACE_PATH = '/env/path/workspace.yml';
        mockReadFile.mockResolvedValueOnce(SAMPLE_WORKSPACE_YML);

        const result = await resolver.resolve(explicitPath);

        expect(mockReadFile).toHaveBeenCalledWith(explicitPath, 'utf-8');
        expect(mockReadFile).not.toHaveBeenCalledWith('/env/path/workspace.yml', 'utf-8');
        expect(result).toHaveLength(3);
      });

      it('should use BRUNO_WORKSPACE_PATH env var when no explicit arg', async () => {
        process.env.BRUNO_WORKSPACE_PATH = '/env/workspace/workspace.yml';
        mockReadFile.mockResolvedValueOnce(SAMPLE_WORKSPACE_YML);

        const result = await resolver.resolve();

        expect(mockReadFile).toHaveBeenCalledWith('/env/workspace/workspace.yml', 'utf-8');
        expect(result).toHaveLength(3);
      });

      it('should use platform default when no explicit arg and no env var', async () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        const expectedPath = join(
          process.env.HOME || '',
          'Library/Application Support/bruno/default-workspace/workspace.yml'
        );
        mockReadFile.mockResolvedValueOnce(SAMPLE_WORKSPACE_YML);

        const result = await resolver.resolve();

        expect(mockReadFile).toHaveBeenCalledWith(expectedPath, 'utf-8');
        expect(result).toHaveLength(3);
      });
    });

    describe('Platform default paths', () => {
      it('should resolve macOS default path', async () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        mockReadFile.mockResolvedValueOnce(SAMPLE_WORKSPACE_YML);

        await resolver.resolve();

        const calledPath = (mockReadFile.mock.calls[0] as unknown[])[0] as string;
        expect(calledPath).toContain('Library/Application Support/bruno/default-workspace/workspace.yml');
      });

      it('should resolve Linux default path', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        mockReadFile.mockResolvedValueOnce(SAMPLE_WORKSPACE_YML);

        await resolver.resolve();

        const calledPath = (mockReadFile.mock.calls[0] as unknown[])[0] as string;
        expect(calledPath).toContain('.config/bruno/default-workspace/workspace.yml');
      });

      it('should resolve Windows default path', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        const originalAppData = process.env.APPDATA;
        process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming';
        mockReadFile.mockResolvedValueOnce(SAMPLE_WORKSPACE_YML);

        await resolver.resolve();

        const calledPath = (mockReadFile.mock.calls[0] as unknown[])[0] as string;
        expect(calledPath).toContain('bruno/default-workspace/workspace.yml');
        expect(calledPath).toContain('AppData');

        if (originalAppData !== undefined) {
          process.env.APPDATA = originalAppData;
        } else {
          delete process.env.APPDATA;
        }
      });
    });

    describe('Parsing workspace.yml', () => {
      it('should return array of collections with name and path', async () => {
        mockReadFile.mockResolvedValueOnce(SAMPLE_WORKSPACE_YML);

        const result = await resolver.resolve('/test/workspace.yml');

        expect(result).toEqual([
          { name: 'MateCat', path: '/Users/test/bruno/MateCat' },
          { name: 'MyMemory', path: '/Users/test/bruno/MyMemory' },
          { name: 'ESTest', path: '/Users/test/bruno/ESTest' },
        ]);
      });

      it('should return empty array when collections list is empty/null', async () => {
        mockReadFile.mockResolvedValueOnce(EMPTY_WORKSPACE_YML);

        const result = await resolver.resolve('/test/workspace.yml');

        expect(result).toEqual([]);
      });

      it('should return empty array when collections key is missing', async () => {
        mockReadFile.mockResolvedValueOnce(WORKSPACE_NO_COLLECTIONS_KEY);

        const result = await resolver.resolve('/test/workspace.yml');

        expect(result).toEqual([]);
      });
    });

    describe('Error handling', () => {
      it('should return empty array when workspace.yml does not exist (ENOENT)', async () => {
        const error = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        mockReadFile.mockRejectedValueOnce(error);

        const result = await resolver.resolve('/nonexistent/workspace.yml');

        expect(result).toEqual([]);
      });

      it('should return empty array when all cascade paths fail', async () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        mockReadFile.mockRejectedValueOnce(error);

        const result = await resolver.resolve();

        expect(result).toEqual([]);
      });

      it('should return empty array on invalid YAML content', async () => {
        mockReadFile.mockResolvedValueOnce('not: valid\ncollections: nope');

        const result = await resolver.resolve('/test/workspace.yml');

        expect(result).toEqual([]);
      });

      it('should return empty array on permission error', async () => {
        const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        mockReadFile.mockRejectedValueOnce(error);

        const result = await resolver.resolve('/protected/workspace.yml');

        expect(result).toEqual([]);
      });
    });

    describe('getDefaultPath()', () => {
      it('should return the correct default path for the current platform', () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        const path = resolver.getDefaultPath();
        expect(path).toContain('Library/Application Support/bruno/default-workspace/workspace.yml');
      });

      it('should return Linux path for linux platform', () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        const path = resolver.getDefaultPath();
        expect(path).toContain('.config/bruno/default-workspace/workspace.yml');
      });

      it('should return Windows path for win32 platform', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        const originalAppData = process.env.APPDATA;
        process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming';

        const path = resolver.getDefaultPath();
        expect(path).toContain('bruno/default-workspace/workspace.yml');

        if (originalAppData !== undefined) {
          process.env.APPDATA = originalAppData;
        } else {
          delete process.env.APPDATA;
        }
      });
    });

    describe('win32 default path without APPDATA env var', () => {
      it('should fall back to the AppData/Roaming path under home', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        const originalAppData = process.env.APPDATA;
        delete process.env.APPDATA;

        const path = resolver.getDefaultPath();
        expect(path).toContain('AppData');
        expect(path).toContain('Roaming');

        if (originalAppData !== undefined) {
          process.env.APPDATA = originalAppData;
        }
      });
    });

    describe('parseWorkspaceYaml filtering', () => {
      it('drops collection entries missing a name or path', () => {
        const yaml = [
          'collections:',
          '  - name: "Valid"',
          '    path: "/abs/valid"',
          '  - name: "NoPath"',
          '  - path: "/abs/no-name"',
          '  - "just-a-string"',
        ].join('\n');

        const result = resolver.parseWorkspaceYaml(yaml);

        expect(result).toEqual([{ name: 'Valid', path: '/abs/valid' }]);
      });
    });
  });

  describe('createWorkspaceResolver()', () => {
    it('returns a WorkspaceResolver instance', () => {
      const instance = createWorkspaceResolver();
      expect(instance).toBeInstanceOf(WorkspaceResolver);
    });
  });
});
