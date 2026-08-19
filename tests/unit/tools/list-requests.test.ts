/**
 * Tests for list_requests tool
 *
 * Strategy: We test the tool handler registered on the MCP server,
 * mocking the CollectionManager.listRequests method.
 */

import { BrunoMcpServer } from '../../../src/server';

jest.mock('../../../src/bruno/collection', () => ({
  createCollectionManager: jest.fn(() => ({
    createCollection: jest.fn(),
    getCollectionStats: jest.fn(),
    listRequests: jest.fn(),
  })),
}));
jest.mock('../../../src/bruno/environment', () => ({
  createEnvironmentManager: jest.fn(() => ({
    createEnvironment: jest.fn(),
  })),
}));
jest.mock('../../../src/bruno/request', () => ({
  createRequestBuilder: jest.fn(() => ({
    createRequest: jest.fn(),
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
jest.mock('../../../src/bruno/request-executor', () => ({
  RequestExecutor: { executeCollection: jest.fn() },
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

function getRegisteredTool(server: BrunoMcpServer): { config: any; handler: Function } | undefined {
  const mcpServer = (server as any).server;
  return mcpServer._tools.get('list_requests');
}

function getCollectionManager(server: BrunoMcpServer) {
  return (server as any).collectionManager;
}

describe('list_requests tool', () => {
  let server: BrunoMcpServer;

  beforeEach(() => {
    jest.clearAllMocks();
    server = new BrunoMcpServer();
  });

  it('should be registered as a tool on the MCP server', () => {
    const tool = getRegisteredTool(server);
    expect(tool).toBeDefined();
    expect(tool!.config.title).toBeDefined();
    expect(tool!.config.description).toBeDefined();
    expect(tool!.config.inputSchema).toBeDefined();
    expect(tool!.config.inputSchema.collectionPath).toBeDefined();
  });

  it('should have descriptive description mentioning file paths and run_collection', () => {
    const tool = getRegisteredTool(server)!;
    expect(tool.config.description).toContain('request files');
    expect(tool.config.description).toContain('run_collection');
  });

  describe('successful execution', () => {
    it('should return array of absolute file paths', async () => {
      const mockRequests = [
        '/path/to/collection/Get Users.yml',
        '/path/to/collection/Create User.yml',
      ];
      getCollectionManager(server).listRequests.mockResolvedValue(mockRequests);

      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: '/path/to/collection',
      });

      expect(response.content).toBeDefined();
      expect(response.content[0].type).toBe('text');

      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.requests).toEqual(mockRequests);
    });

    it('should return empty array for collection with no requests', async () => {
      getCollectionManager(server).listRequests.mockResolvedValue([]);

      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: '/path/to/empty-collection',
      });

      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.requests).toEqual([]);
    });
  });

  describe('error handling', () => {
    it('should return error when collection path is invalid', async () => {
      getCollectionManager(server).listRequests.mockRejectedValue(
        new Error('Failed to list requests in collection /bad/path'),
      );

      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: '/bad/path',
      });

      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('Error listing requests');
    });
  });

  describe('path validation', () => {
    it('should reject collectionPath with traversal segments', async () => {
      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: '/workspace/../etc/passwd',
      });

      expect(response.isError).toBe(true);
      expect(response.content[0].text).toMatch(/path|traversal/i);
    });

    it('should reject collectionPath with null bytes', async () => {
      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: '/workspace/collection\0malicious',
      });

      expect(response.isError).toBe(true);
      expect(response.content[0].text).toMatch(/null/i);
    });
  });
});
