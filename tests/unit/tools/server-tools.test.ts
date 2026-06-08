import { BrunoMcpServer } from '../../../src/server';

jest.mock('../../../src/bruno/collection', () => ({
  createCollectionManager: () => ({
    createCollection: jest.fn(),
  }),
}));
jest.mock('../../../src/bruno/environment', () => ({
  createEnvironmentManager: () => ({
    createEnvironment: jest.fn(),
  }),
}));
jest.mock('../../../src/bruno/request', () => ({
  createRequestBuilder: () => ({
    createRequest: jest.fn(),
    createCrudRequests: jest.fn(),
  }),
}));
jest.mock('../../../src/bruno/workspace', () => ({
  createWorkspaceResolver: () => ({
    resolve: jest.fn(),
    resolveWorkspacePath: jest.fn(),
    getDefaultPath: jest.fn(),
    parseWorkspaceYaml: jest.fn(),
  }),
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
jest.mock('../../../src/bruno/format-detector', () => ({
  findCollectionRoot: jest.fn(),
  detectFormat: jest.fn(),
}));
jest.mock('../../../src/bruno/format-factory', () => ({
  createWriter: jest.fn(),
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

const { listCollectionsHandler } = require('../../../src/bruno/list-collections-handler');
const { getCollectionStats } = require('../../../src/bruno/collection-stats');
const { RequestExecutor } = require('../../../src/bruno/request-executor');

function getHandler(server: BrunoMcpServer, toolName: string): Function {
  const mcpServer = (server as any).server;
  const tool = mcpServer._tools.get(toolName);
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);
  return tool.handler;
}

function getManagerMock(server: BrunoMcpServer, field: string, method: string): jest.Mock {
  return (server as any)[field][method];
}

describe('Server tool handlers', () => {
  let server: BrunoMcpServer;

  beforeEach(() => {
    jest.clearAllMocks();
    server = new BrunoMcpServer();
  });

  describe('create_collection', () => {
    it('should return success message', async () => {
      getManagerMock(server, 'collectionManager', 'createCollection')
        .mockResolvedValue({ success: true, path: '/ws/my-api' });
      const handler = getHandler(server, 'create_collection');
      const result = await handler({ name: 'my-api', outputPath: '/ws' });
      expect(result.content[0].text).toContain('my-api');
      expect(result.content[0].text).toContain('/ws/my-api');
      expect(result.isError).toBeUndefined();
    });

    it('should return error on failure', async () => {
      getManagerMock(server, 'collectionManager', 'createCollection')
        .mockResolvedValue({ success: false, error: 'disk full' });
      const handler = getHandler(server, 'create_collection');
      const result = await handler({ name: 'test', outputPath: '/ws' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('disk full');
    });

    it('should catch thrown errors', async () => {
      getManagerMock(server, 'collectionManager', 'createCollection')
        .mockRejectedValue(new Error('unexpected'));
      const handler = getHandler(server, 'create_collection');
      const result = await handler({ name: 'test', outputPath: '/ws' });
      expect(result.isError).toBe(true);
    });
  });

  describe('create_environment', () => {
    it('should return success message', async () => {
      getManagerMock(server, 'environmentManager', 'createEnvironment')
        .mockResolvedValue({ success: true, path: '/col/environments/dev.yml' });
      const handler = getHandler(server, 'create_environment');
      const result = await handler({
        collectionPath: '/col', name: 'dev', variables: { baseUrl: 'http://localhost' },
      });
      expect(result.content[0].text).toContain('dev');
      expect(result.isError).toBeUndefined();
    });

    it('should return error on failure', async () => {
      getManagerMock(server, 'environmentManager', 'createEnvironment')
        .mockResolvedValue({ success: false, error: 'fail' });
      const handler = getHandler(server, 'create_environment');
      const result = await handler({ collectionPath: '/col', name: 'dev', variables: {} });
      expect(result.isError).toBe(true);
    });

    it('should catch thrown errors', async () => {
      getManagerMock(server, 'environmentManager', 'createEnvironment')
        .mockRejectedValue(new Error('boom'));
      const handler = getHandler(server, 'create_environment');
      const result = await handler({ collectionPath: '/col', name: 'dev', variables: {} });
      expect(result.isError).toBe(true);
    });
  });

  describe('create_request', () => {
    it('should return success message', async () => {
      getManagerMock(server, 'requestBuilder', 'createRequest')
        .mockResolvedValue({ success: true, path: '/col/get-users.yml' });
      const handler = getHandler(server, 'create_request');
      const result = await handler({
        collectionPath: '/col', name: 'Get Users', method: 'GET',
        url: 'https://api.example.com/users',
      });
      expect(result.content[0].text).toContain('Get Users');
      expect(result.isError).toBeUndefined();
    });

    it('should pass body and auth to builder', async () => {
      const mock = getManagerMock(server, 'requestBuilder', 'createRequest');
      mock.mockResolvedValue({ success: true, path: '/col/test.yml' });
      const handler = getHandler(server, 'create_request');
      await handler({
        collectionPath: '/col', name: 'Test', method: 'POST',
        url: 'https://example.com',
        headers: { 'Content-Type': 'application/json' },
        body: { type: 'json', content: '{}' },
        auth: { type: 'bearer', config: { token: 'tok' } },
        query: { page: '1' }, folder: 'test', sequence: 1,
      });
      expect(mock).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: { type: 'json', content: '{}' },
          auth: { type: 'bearer', config: { token: 'tok' } },
        }),
      );
    });

    it('should return error on failure', async () => {
      getManagerMock(server, 'requestBuilder', 'createRequest')
        .mockResolvedValue({ success: false, error: 'invalid' });
      const handler = getHandler(server, 'create_request');
      const result = await handler({
        collectionPath: '/col', name: 'T', method: 'GET', url: 'https://example.com',
      });
      expect(result.isError).toBe(true);
    });

    it('should catch thrown errors', async () => {
      getManagerMock(server, 'requestBuilder', 'createRequest')
        .mockRejectedValue(new Error('boom'));
      const handler = getHandler(server, 'create_request');
      const result = await handler({
        collectionPath: '/col', name: 'T', method: 'GET', url: 'https://example.com',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('create_test_suite', () => {
    it('should create all requests in suite', async () => {
      const mock = getManagerMock(server, 'requestBuilder', 'createRequest');
      mock.mockResolvedValue({ success: true, path: '/col/test.yml' });
      const handler = getHandler(server, 'create_test_suite');
      const result = await handler({
        collectionPath: '/col', suiteName: 'Auth Tests',
        requests: [
          { name: 'Login', method: 'POST', url: 'https://api.com/login' },
          { name: 'Profile', method: 'GET', url: 'https://api.com/profile' },
        ],
      });
      expect(result.content[0].text).toContain('Auth Tests');
      expect(result.content[0].text).toContain('2 requests');
    });

    it('should report partial failures', async () => {
      const mock = getManagerMock(server, 'requestBuilder', 'createRequest');
      mock.mockResolvedValueOnce({ success: true, path: '/col/a.yml' })
        .mockResolvedValueOnce({ success: false, error: 'fail' });
      const handler = getHandler(server, 'create_test_suite');
      const result = await handler({
        collectionPath: '/col', suiteName: 'S',
        requests: [
          { name: 'A', method: 'GET', url: 'https://a.com' },
          { name: 'B', method: 'GET', url: 'https://b.com' },
        ],
      });
      expect(result.content[0].text).toContain('1 failed');
    });

    it('should catch thrown errors', async () => {
      getManagerMock(server, 'requestBuilder', 'createRequest')
        .mockRejectedValue(new Error('boom'));
      const handler = getHandler(server, 'create_test_suite');
      const result = await handler({
        collectionPath: '/col', suiteName: 'S',
        requests: [{ name: 'A', method: 'GET', url: 'https://a.com' }],
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('create_crud_requests', () => {
    it('should return success with count', async () => {
      getManagerMock(server, 'requestBuilder', 'createCrudRequests')
        .mockResolvedValue([
          { success: true }, { success: true }, { success: true },
          { success: true }, { success: true },
        ]);
      const handler = getHandler(server, 'create_crud_requests');
      const result = await handler({
        collectionPath: '/col', entityName: 'User', baseUrl: 'https://api.com',
      });
      expect(result.content[0].text).toContain('User');
      expect(result.content[0].text).toContain('5 requests');
    });

    it('should report failures', async () => {
      getManagerMock(server, 'requestBuilder', 'createCrudRequests')
        .mockResolvedValue([{ success: true }, { success: false }]);
      const handler = getHandler(server, 'create_crud_requests');
      const result = await handler({
        collectionPath: '/col', entityName: 'Post', baseUrl: 'https://api.com',
      });
      expect(result.content[0].text).toContain('1 failed');
    });

    it('should catch thrown errors', async () => {
      getManagerMock(server, 'requestBuilder', 'createCrudRequests')
        .mockRejectedValue(new Error('boom'));
      const handler = getHandler(server, 'create_crud_requests');
      const result = await handler({
        collectionPath: '/col', entityName: 'X', baseUrl: 'https://api.com',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('list_collections', () => {
    it('should return collections list', async () => {
      (listCollectionsHandler as jest.Mock).mockResolvedValue([
        { name: 'API', path: '/col/api', exists: true },
      ]);
      const handler = getHandler(server, 'list_collections');
      const result = await handler({});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.collections).toHaveLength(1);
    });

    it('should return empty message when no collections', async () => {
      (listCollectionsHandler as jest.Mock).mockResolvedValue([]);
      const handler = getHandler(server, 'list_collections');
      const result = await handler({});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.collections).toHaveLength(0);
      expect(parsed.message).toBeTruthy();
    });

    it('should validate workspacePath', async () => {
      const handler = getHandler(server, 'list_collections');
      const result = await handler({ workspacePath: '/path/../evil' });
      expect(result.isError).toBe(true);
    });

    it('should catch thrown errors', async () => {
      (listCollectionsHandler as jest.Mock).mockRejectedValue(new Error('fail'));
      const handler = getHandler(server, 'list_collections');
      const result = await handler({});
      expect(result.isError).toBe(true);
    });
  });

  describe('get_collection_stats', () => {
    it('should return stats JSON', async () => {
      (getCollectionStats as jest.Mock).mockResolvedValue({
        totalRequests: 5, requestsByMethod: { GET: 3 }, folders: [], environments: [], requests: [],
      });
      const handler = getHandler(server, 'get_collection_stats');
      const result = await handler({ collectionPath: '/col' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.totalRequests).toBe(5);
    });

    it('should catch thrown errors', async () => {
      (getCollectionStats as jest.Mock).mockRejectedValue(new Error('fail'));
      const handler = getHandler(server, 'get_collection_stats');
      const result = await handler({ collectionPath: '/col' });
      expect(result.isError).toBe(true);
    });
  });

  describe('run_collection', () => {
    it('should return execution results', async () => {
      (RequestExecutor.executeCollection as jest.Mock).mockResolvedValue({
        summary: { total: 2, passed: 2, failed: 0, duration_ms: 100 }, results: [],
      });
      const handler = getHandler(server, 'run_collection');
      const result = await handler({ collectionPath: '/col' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.summary.total).toBe(2);
    });

    it('should pass environment and requestPath', async () => {
      (RequestExecutor.executeCollection as jest.Mock).mockResolvedValue({
        summary: { total: 1, passed: 1, failed: 0, duration_ms: 50 }, results: [],
      });
      const handler = getHandler(server, 'run_collection');
      await handler({
        collectionPath: '/col', environment: 'dev',
        collectionRoot: '/col', requestPath: '/col/test.yml',
      });
      expect(RequestExecutor.executeCollection).toHaveBeenCalledWith(
        '/col', expect.objectContaining({ environment: 'dev', requestPath: '/col/test.yml' }),
      );
    });

    it('should reject requestPath outside collectionPath', async () => {
      const handler = getHandler(server, 'run_collection');
      const result = await handler({ collectionPath: '/col', requestPath: '/other/evil.yml' });
      expect(result.isError).toBe(true);
    });

    it('should reject collectionRoot with traversal', async () => {
      const handler = getHandler(server, 'run_collection');
      const result = await handler({ collectionPath: '/col', collectionRoot: '/col/../etc' });
      expect(result.isError).toBe(true);
    });

    it('should catch thrown errors', async () => {
      (RequestExecutor.executeCollection as jest.Mock).mockRejectedValue(new Error('timeout'));
      const handler = getHandler(server, 'run_collection');
      const result = await handler({ collectionPath: '/col' });
      expect(result.isError).toBe(true);
    });
  });

  describe('start()', () => {
    it('should connect transport', async () => {
      const spy = jest.spyOn(console, 'error').mockImplementation();
      await server.start();
      expect((server as any).server.connect).toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
