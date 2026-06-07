import { BrunoMcpServer } from '../../../src/server';

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
jest.mock('../../../src/bruno/request', () => ({
  createRequestBuilder: jest.fn(() => ({
    createRequest: jest.fn(),
    createCrudRequests: jest.fn(),
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

function getHandler(server: BrunoMcpServer, toolName: string): Function {
  const mcpServer = (server as any).server;
  const tool = mcpServer._tools.get(toolName);
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);
  return tool.handler;
}

describe('write-tool path validation', () => {
  let server: BrunoMcpServer;

  beforeEach(() => {
    jest.clearAllMocks();
    server = new BrunoMcpServer();
  });

  describe('create_collection — outputPath', () => {
    it('rejects path with .. traversal', async () => {
      const handler = getHandler(server, 'create_collection');
      const response = await handler({
        name: 'Test',
        outputPath: '/workspace/../etc/passwd',
      });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toMatch(/outputPath/i);
    });

    it('rejects path with null bytes', async () => {
      const handler = getHandler(server, 'create_collection');
      const response = await handler({
        name: 'Test',
        outputPath: '/workspace/collection\0malicious',
      });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toMatch(/outputPath/i);
    });
  });

  describe('create_environment — collectionPath', () => {
    it('rejects path with .. traversal', async () => {
      const handler = getHandler(server, 'create_environment');
      const response = await handler({
        collectionPath: '/workspace/../etc/passwd',
        name: 'dev',
        variables: {},
      });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toMatch(/collectionPath/i);
    });

    it('rejects path with null bytes', async () => {
      const handler = getHandler(server, 'create_environment');
      const response = await handler({
        collectionPath: '/workspace/collection\0evil',
        name: 'dev',
        variables: {},
      });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toMatch(/collectionPath/i);
    });
  });

  describe('create_request — collectionPath', () => {
    it('rejects path with .. traversal', async () => {
      const handler = getHandler(server, 'create_request');
      const response = await handler({
        collectionPath: '/workspace/../etc',
        name: 'GetUsers',
        method: 'GET',
        url: 'https://api.example.com/users',
      });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toMatch(/collectionPath/i);
    });

    it('rejects path with null bytes', async () => {
      const handler = getHandler(server, 'create_request');
      const response = await handler({
        collectionPath: '/workspace/col\0lection',
        name: 'GetUsers',
        method: 'GET',
        url: 'https://api.example.com/users',
      });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toMatch(/collectionPath/i);
    });
  });

  describe('add_test_script — bruFilePath', () => {
    it('rejects path with .. traversal', async () => {
      const handler = getHandler(server, 'add_test_script');
      const response = await handler({
        bruFilePath: '/workspace/../etc/passwd',
        scriptType: 'tests',
        script: 'bru.test("ok", () => {})',
      });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toMatch(/bruFilePath/i);
    });

    it('rejects path with null bytes', async () => {
      const handler = getHandler(server, 'add_test_script');
      const response = await handler({
        bruFilePath: '/workspace/request\0.bru',
        scriptType: 'tests',
        script: 'bru.test("ok", () => {})',
      });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toMatch(/bruFilePath/i);
    });

    it('validates script content for null bytes', async () => {
      const handler = getHandler(server, 'add_test_script');
      const response = await handler({
        bruFilePath: '/workspace/collection/request.bru',
        scriptType: 'tests',
        script: 'bru.test("ok", () => {})\x00',
      });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toMatch(/null/i);
    });
  });

  describe('create_test_suite — collectionPath', () => {
    it('rejects path with .. traversal', async () => {
      const handler = getHandler(server, 'create_test_suite');
      const response = await handler({
        collectionPath: '/workspace/../etc',
        suiteName: 'MySuite',
        requests: [],
      });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toMatch(/collectionPath/i);
    });

    it('rejects path with null bytes', async () => {
      const handler = getHandler(server, 'create_test_suite');
      const response = await handler({
        collectionPath: '/workspace/col\0lection',
        suiteName: 'MySuite',
        requests: [],
      });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toMatch(/collectionPath/i);
    });
  });

  describe('create_crud_requests — collectionPath', () => {
    it('rejects path with .. traversal', async () => {
      const handler = getHandler(server, 'create_crud_requests');
      const response = await handler({
        collectionPath: '/workspace/../etc',
        entityName: 'User',
        baseUrl: 'https://api.example.com',
      });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toMatch(/collectionPath/i);
    });

    it('rejects path with null bytes', async () => {
      const handler = getHandler(server, 'create_crud_requests');
      const response = await handler({
        collectionPath: '/workspace/col\0lection',
        entityName: 'User',
        baseUrl: 'https://api.example.com',
      });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toMatch(/collectionPath/i);
    });
  });
});
