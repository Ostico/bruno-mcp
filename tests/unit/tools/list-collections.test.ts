/**
 * Tests for list_collections tool
 *
 * Strategy: We test the listCollections handler function directly,
 * mocking the WorkspaceResolver and fs.access for exists checks.
 */

import { promises as fs } from 'fs';
import { WorkspaceResolver } from '../../../src/bruno/workspace.js';
import { listCollectionsHandler } from '../../../src/bruno/list-collections-handler.js';

// Mock the workspace module
jest.mock('../../../src/bruno/workspace.js');

// Mock fs.access for path-existence checks
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      access: jest.fn(),
    },
  };
});

const MockedWorkspaceResolver = WorkspaceResolver as jest.MockedClass<typeof WorkspaceResolver>;
const mockedAccess = fs.access as jest.MockedFunction<typeof fs.access>;

describe('list_collections tool', () => {
  let mockResolver: jest.Mocked<WorkspaceResolver>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create a mocked resolver instance
    mockResolver = new MockedWorkspaceResolver() as jest.Mocked<WorkspaceResolver>;
  });

  describe('auto-discovery (no arguments)', () => {
    it('should return collections from workspace.yml with exists flag', async () => {
      mockResolver.resolve.mockResolvedValue([
        { name: 'MateCat', path: '/Users/test/bruno/MateCat' },
        { name: 'MateSub', path: '/Users/test/bruno/MateSub' },
      ]);

      // MateCat exists, MateSub does not
      mockedAccess
        .mockResolvedValueOnce(undefined) // MateCat exists
        .mockRejectedValueOnce(new Error('ENOENT')); // MateSub does not

      const result = await listCollectionsHandler(mockResolver, {});

      expect(mockResolver.resolve).toHaveBeenCalledWith(undefined);
      expect(result).toEqual([
        { name: 'MateCat', path: '/Users/test/bruno/MateCat', exists: true },
        { name: 'MateSub', path: '/Users/test/bruno/MateSub', exists: false },
      ]);
    });

    it('should return empty array when workspace.yml is not found', async () => {
      mockResolver.resolve.mockResolvedValue([]);

      const result = await listCollectionsHandler(mockResolver, {});

      expect(result).toEqual([]);
    });
  });

  describe('explicit workspacePath argument', () => {
    it('should pass workspacePath to resolver', async () => {
      const customPath = '/custom/workspace.yml';
      mockResolver.resolve.mockResolvedValue([
        { name: 'MyAPI', path: '/projects/MyAPI' },
      ]);
      mockedAccess.mockResolvedValueOnce(undefined);

      const result = await listCollectionsHandler(mockResolver, {
        workspacePath: customPath,
      });

      expect(mockResolver.resolve).toHaveBeenCalledWith(customPath);
      expect(result).toEqual([
        { name: 'MyAPI', path: '/projects/MyAPI', exists: true },
      ]);
    });
  });

  describe('collection path existence check', () => {
    it('should mark all collections as exists: true when all paths exist', async () => {
      mockResolver.resolve.mockResolvedValue([
        { name: 'A', path: '/a' },
        { name: 'B', path: '/b' },
        { name: 'C', path: '/c' },
      ]);

      mockedAccess
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);

      const result = await listCollectionsHandler(mockResolver, {});

      expect(result).toHaveLength(3);
      expect(result.every((c) => c.exists)).toBe(true);
    });

    it('should mark collections as exists: false when paths do not exist', async () => {
      mockResolver.resolve.mockResolvedValue([
        { name: 'Missing', path: '/nonexistent/path' },
      ]);

      mockedAccess.mockRejectedValueOnce(new Error('ENOENT'));

      const result = await listCollectionsHandler(mockResolver, {});

      expect(result).toEqual([
        { name: 'Missing', path: '/nonexistent/path', exists: false },
      ]);
    });
  });

  describe('edge cases', () => {
    it('should handle workspace with single collection', async () => {
      mockResolver.resolve.mockResolvedValue([
        { name: 'Solo', path: '/solo' },
      ]);
      mockedAccess.mockResolvedValueOnce(undefined);

      const result = await listCollectionsHandler(mockResolver, {});

      expect(result).toEqual([{ name: 'Solo', path: '/solo', exists: true }]);
    });

    it('should handle many collections efficiently', async () => {
      const collections = Array.from({ length: 20 }, (_, i) => ({
        name: `Collection${i}`,
        path: `/path/col${i}`,
      }));
      mockResolver.resolve.mockResolvedValue(collections);

      // All exist
      for (let i = 0; i < 20; i++) {
        mockedAccess.mockResolvedValueOnce(undefined);
      }

      const result = await listCollectionsHandler(mockResolver, {});

      expect(result).toHaveLength(20);
      expect(result[0].name).toBe('Collection0');
      expect(result[19].name).toBe('Collection19');
    });
  });
});
