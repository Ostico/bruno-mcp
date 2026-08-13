/**
 * The move_request tool handler.
 *
 * What belongs here is the layer the module below cannot see: which collection
 * root the move is resolved against, and what the caller is told afterwards.
 * `tests/unit/bruno/request-move.test.ts` covers the bytes with real files.
 *
 * Mocks:
 *  - format-detector  (findCollectionRoot, findCollectionRootFromDirectory, detectFormat)
 *  - request-move     (moveRequestFile)
 *  - the Bruno modules the server constructs but this tool does not use
 *  - MCP SDK (captures registered handlers)
 */

import { BrunoMcpServer } from '../../../src/server';

// ── Module mocks ─────────────────────────────────────────────────────────────

const mockFindCollectionRoot = jest.fn();
const mockFindCollectionRootFromDirectory = jest.fn();
const mockDetectFormat = jest.fn();
jest.mock('../../../src/bruno/format-detector', () => ({
  findCollectionRoot: (...args: unknown[]) => mockFindCollectionRoot(...args),
  findCollectionRootFromDirectory: (...args: unknown[]) =>
    mockFindCollectionRootFromDirectory(...args),
  detectFormat: (...args: unknown[]) => mockDetectFormat(...args),
}));

const mockMoveRequestFile = jest.fn();
jest.mock('../../../src/bruno/request-move', () => ({
  moveRequestFile: (...args: unknown[]) => mockMoveRequestFile(...args),
}));

jest.mock('../../../src/bruno/format-factory', () => ({
  createWriter: jest.fn(() => ({
    generateRequest: jest.fn(),
    generateEnvironment: jest.fn(),
    injectScript: jest.fn(),
    getRequestExtension: jest.fn(() => '.yml'),
  })),
  createReader: jest.fn(),
  mapScriptType: jest.fn(),
}));

jest.mock('../../../src/bruno/request', () => ({
  createRequestBuilder: jest.fn(() => ({
    createRequest: jest.fn(),
    createCrudRequests: jest.fn(),
    updateRequest: jest.fn(),
  })),
}));

jest.mock('../../../src/bruno/request-executor');
jest.mock('../../../src/bruno/collection', () => ({
  createCollectionManager: jest.fn(() => ({
    createCollection: jest.fn(),
    getCollectionStats: jest.fn(),
  })),
}));
jest.mock('../../../src/bruno/environment', () => ({
  createEnvironmentManager: jest.fn(() => ({
    createEnvironment: jest.fn(),
  })),
}));
jest.mock('../../../src/bruno/workspace', () => ({
  createWorkspaceResolver: jest.fn(() => ({
    resolve: jest.fn(),
    resolveWorkspacePath: jest.fn(),
    getDefaultPath: jest.fn(),
    parseWorkspaceYaml: jest.fn(),
  })),
}));
jest.mock('../../../src/bruno/list-collections-handler', () => ({
  listCollectionsHandler: jest.fn(),
}));
jest.mock('../../../src/bruno/collection-stats', () => ({
  getCollectionStats: jest.fn(),
}));

jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  const tools: Map<string, { config: any; handler: Function }> = new Map();
  return {
    McpServer: jest.fn().mockImplementation(() => ({
      registerTool: jest.fn((name: string, config: any, handler: Function) => {
        tools.set(name, { config, handler });
      }),
      connect: jest.fn(),
      _tools: tools,
    })),
  };
});
jest.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: jest.fn(),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function getHandler(server: BrunoMcpServer, toolName: string): Function {
  const mcpServer = (server as any).server;
  const tool = mcpServer._tools.get(toolName);
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);
  return tool.handler;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('move_request tool handler', () => {
  let server: BrunoMcpServer;
  let handler: Function;

  beforeEach(() => {
    jest.clearAllMocks();
    server = new BrunoMcpServer();
    handler = getHandler(server, 'move_request');

    mockFindCollectionRoot.mockResolvedValue('/workspace/collection');
    mockFindCollectionRootFromDirectory.mockResolvedValue('/workspace/other');
    mockDetectFormat.mockResolvedValue({
      format: 'yaml',
      configPath: '/workspace/collection/opencollection.yml',
      collectionName: 'TestCollection',
    });
    mockMoveRequestFile.mockResolvedValue({
      success: true,
      path: '/workspace/collection/users/get-users.yml',
      warnings: [],
    });
  });

  it('registers the move_request tool', () => {
    const mcpServer = (server as any).server;
    expect(mcpServer._tools.has('move_request')).toBe(true);
  });

  describe('resolving the target collection', () => {
    it("uses the request's own collection when none is named", async () => {
      await handler({
        filePath: '/workspace/collection/get-users.yml',
        targetFolder: 'users',
      });

      expect(mockFindCollectionRootFromDirectory).not.toHaveBeenCalled();
      expect(mockMoveRequestFile).toHaveBeenCalledWith({
        filePath: '/workspace/collection/get-users.yml',
        targetCollectionPath: '/workspace/collection',
        targetFolder: 'users',
        copy: undefined,
      });
    });

    it('walks up from the named directory, not from a file inside it', async () => {
      // The marker usually sits in the very directory the caller names, which the
      // file-based walk would start one level above and miss.
      await handler({
        filePath: '/workspace/collection/get-users.yml',
        targetCollectionPath: '/workspace/other',
      });

      expect(mockFindCollectionRootFromDirectory).toHaveBeenCalledWith('/workspace/other');
      expect(mockMoveRequestFile).toHaveBeenCalledWith(
        expect.objectContaining({ targetCollectionPath: '/workspace/other' }),
      );
    });

    it('refuses a targetCollectionPath that is not a collection', async () => {
      mockFindCollectionRootFromDirectory.mockResolvedValue(null);

      const res = await handler({
        filePath: '/workspace/collection/get-users.yml',
        targetCollectionPath: '/workspace/not-a-collection',
      });

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Could not determine the target collection');
      expect(mockMoveRequestFile).not.toHaveBeenCalled();
    });

    it('refuses a targetCollectionPath that traverses', async () => {
      const res = await handler({
        filePath: '/workspace/collection/get-users.yml',
        targetCollectionPath: '/workspace/../etc',
      });

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Invalid targetCollectionPath');
      expect(mockMoveRequestFile).not.toHaveBeenCalled();
    });

    it('refuses a filePath that is not a request file', async () => {
      const res = await handler({ filePath: '/workspace/collection/notes.md' });

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Invalid file extension');
      expect(mockMoveRequestFile).not.toHaveBeenCalled();
    });
  });

  describe('what the caller is told', () => {
    it('names the new path and says to use it from now on', async () => {
      const res = await handler({
        filePath: '/workspace/collection/get-users.yml',
        targetFolder: 'users',
      });

      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).toContain('Moved request "get-users.yml"');
      expect(res.content[0].text).toContain('/workspace/collection/users/get-users.yml');
      expect(res.content[0].text).toContain('pass that as filePath from now on');
    });

    it('says copied, and does not tell the caller to switch paths', async () => {
      // The original is still there and still valid, so telling them the old
      // path is gone would be false.
      const res = await handler({
        filePath: '/workspace/collection/get-users.yml',
        targetFolder: 'users',
        copy: true,
      });

      expect(res.content[0].text).toContain('Copied request "get-users.yml"');
      expect(res.content[0].text).not.toContain('from now on');
      expect(mockMoveRequestFile).toHaveBeenCalledWith(
        expect.objectContaining({ copy: true }),
      );
    });

    it("passes the module's own warnings through", async () => {
      mockMoveRequestFile.mockResolvedValue({
        success: true,
        path: '/workspace/collection/users/get-users.yml',
        warnings: ['The request arrives with seq 3, which a request already in that folder also declares.'],
      });

      const res = await handler({
        filePath: '/workspace/collection/get-users.yml',
        targetFolder: 'users',
      });

      expect(res.content[0].text).toContain('arrives with seq 3');
    });

    it('warns when the request lands in a collection whose dialect ignores it', async () => {
      // Read against the collection it landed in: a `.yml` request moved into a
      // `bruno.json` collection is invisible to Bruno there, and was not
      // invisible where it came from.
      mockDetectFormat.mockResolvedValue({
        format: 'bru',
        configPath: '/workspace/other/bruno.json',
        collectionName: 'Other',
      });
      mockMoveRequestFile.mockResolvedValue({
        success: true,
        path: '/workspace/other/get-users.yml',
        warnings: [],
      });

      const res = await handler({
        filePath: '/workspace/collection/get-users.yml',
        targetCollectionPath: '/workspace/other',
      });

      expect(mockDetectFormat).toHaveBeenLastCalledWith('/workspace/other');
      expect(res.content[0].text).toContain('dialect does not read');
    });

    it('reports a refusal from the module', async () => {
      mockMoveRequestFile.mockResolvedValue({
        success: false,
        error: '"get-users.yml" already exists in that folder. Nothing was moved.',
        warnings: [],
      });

      const res = await handler({
        filePath: '/workspace/collection/get-users.yml',
        targetFolder: 'users',
      });

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Failed to move request');
      expect(res.content[0].text).toContain('already exists in that folder');
    });

    it('reports a thrown error rather than propagating it', async () => {
      mockMoveRequestFile.mockRejectedValue(new Error('EACCES: permission denied'));

      const res = await handler({
        filePath: '/workspace/collection/get-users.yml',
        targetFolder: 'users',
      });

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Error moving request');
      expect(res.content[0].text).toContain('EACCES');
    });
  });
});
