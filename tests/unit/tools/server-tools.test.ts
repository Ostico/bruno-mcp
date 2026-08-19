import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrunoMcpServer, createBrunoMcpServer } from '../../../src/server';

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
    updateRequest: jest.fn(),
  }),
}));
// The registry the tools resolve is named in what they report, so this one has to
// return a path rather than the `undefined` a bare jest.fn() gives: a stub that
// resolves to nothing lets a message reading "not registered in undefined" satisfy
// an assertion about the registry. The real resolver always returns a string —
// the explicit path, then BRUNO_WORKSPACE_PATH, then the platform default.
const mockWorkspaceFile = join(tmpdir(), 'bruno-mcp-no-such-workspace', 'workspace.yml');
jest.mock('../../../src/bruno/workspace', () => ({
  createWorkspaceResolver: () => ({
    resolve: jest.fn(),
    resolveWorkspacePath: jest.fn(() => mockWorkspaceFile),
    getDefaultPath: jest.fn(),
    parseWorkspaceYaml: jest.fn(),
  }),
}));
jest.mock('../../../src/bruno/list-collections-handler', () => ({
  listCollectionsHandler: jest.fn(),
}));
jest.mock('../../../src/bruno/collection-stats', () => ({
  getCollectionStats: jest.fn(),
  // Kept real: it is a pure function over the result, and a mocked one returns
  // undefined, which turns every stats response into an error about a document
  // that could not be serialised.
  filterCollectionStats: jest.requireActual('../../../src/bruno/collection-stats')
    .filterCollectionStats,
}));
jest.mock('../../../src/bruno/request-executor', () => ({
  RequestExecutor: { executeCollection: jest.fn() },
}));
jest.mock('../../../src/bruno/format-detector', () => ({
  findCollectionRoot: jest.fn(),
  detectFormat: jest.fn(),
  // The listing tools ask which dialect a collection declares, so they can warn
  // about a request Bruno will not read. Resolving to null is "nothing declared
  // one", which is the honest answer for the fabricated `/col` these tests use
  // and suppresses the warning rather than inventing a dialect for it.
  findCollectionRootFromDirectory: jest.fn().mockResolvedValue(null),
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
const { forkingScriptRunner } = require('../../../src/bruno/sandbox-host');

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

    it('says the new collection is not in the registry list_collections reads', async () => {
      // list_collections reads Bruno's workspace registry, not the disk, so a caller
      // told only "created" cannot tell whether the next call will find it. Here the
      // resolved registry does not exist, which is the case that has to name the file
      // it tried and say the collection is reachable by path anyway — saying so in the
      // success message is the only place that lands before the caller acts. The
      // registered case is covered against a real workspace file elsewhere.
      getManagerMock(server, 'collectionManager', 'createCollection')
        .mockResolvedValue({ success: true, path: '/ws/my-api' });
      const handler = getHandler(server, 'create_collection');
      const result = await handler({ name: 'my-api', outputPath: '/ws' });
      expect(result.content[0].text).toContain(mockWorkspaceFile);
      expect(result.content[0].text).toContain('no workspace file there to add it to');
      expect(result.content[0].text).toContain('usable by path');
      expect(result.content[0].text).toContain('list_collections');
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

  describe('write_request', () => {
    it('should return success message', async () => {
      getManagerMock(server, 'requestBuilder', 'createRequest')
        .mockResolvedValue({ success: true, path: '/col/get-users.yml' });
      const handler = getHandler(server, 'write_request');
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
      const handler = getHandler(server, 'write_request');
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

    it('should pass the settings block to builder', async () => {
      const mock = getManagerMock(server, 'requestBuilder', 'createRequest');
      mock.mockResolvedValue({ success: true, path: '/col/test.yml' });
      const handler = getHandler(server, 'write_request');
      await handler({
        collectionPath: '/col', name: 'Test', method: 'POST',
        url: 'https://example.com',
        settings: { followRedirects: false, timeout: 20000 },
      });
      expect(mock).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: { followRedirects: false, timeout: 20000 },
        }),
      );
    });

    it('should leave settings undefined when none was given', async () => {
      // A request created without settings must carry no block: Bruno omits it
      // too, and for encodeUrl the presence of the block is itself the signal.
      const mock = getManagerMock(server, 'requestBuilder', 'createRequest');
      mock.mockResolvedValue({ success: true, path: '/col/test.yml' });
      const handler = getHandler(server, 'write_request');
      await handler({
        collectionPath: '/col', name: 'Test', method: 'GET', url: 'https://example.com',
      });
      expect(mock.mock.calls[0][0].settings).toBeUndefined();
    });

    it('should return error on failure', async () => {
      getManagerMock(server, 'requestBuilder', 'createRequest')
        .mockResolvedValue({ success: false, error: 'invalid' });
      const handler = getHandler(server, 'write_request');
      const result = await handler({
        collectionPath: '/col', name: 'T', method: 'GET', url: 'https://example.com',
      });
      expect(result.isError).toBe(true);
    });

    it('should catch thrown errors', async () => {
      getManagerMock(server, 'requestBuilder', 'createRequest')
        .mockRejectedValue(new Error('boom'));
      const handler = getHandler(server, 'write_request');
      const result = await handler({
        collectionPath: '/col', name: 'T', method: 'GET', url: 'https://example.com',
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

    it('should reject an invalid collectionPath before calling getCollectionStats', async () => {
      const handler = getHandler(server, 'get_collection_stats');
      const result = await handler({ collectionPath: '/col/../etc' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/collectionPath/i);
      expect(getCollectionStats).not.toHaveBeenCalled();
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

    it('should pass environment and the request selection', async () => {
      (RequestExecutor.executeCollection as jest.Mock).mockResolvedValue({
        summary: { total: 1, passed: 1, failed: 0, duration_ms: 50 }, groups: [],
      });
      const col = await mkdtemp(join(tmpdir(), 'server-tools-run-'));
      const request = join(col, 'test.yml');
      await writeFile(request, 'info:\n  name: T\n');
      const handler = getHandler(server, 'run_collection');
      await handler({
        collectionPath: col, environment: 'dev',
        collectionRoot: col, requests: [request],
      });
      expect(RequestExecutor.executeCollection).toHaveBeenCalledWith(
        col, expect.objectContaining({ environment: 'dev', requests: [request] }),
      );
      await rm(col, { recursive: true, force: true });
    });

    it('injects the forking script runner so production runs scripts behind a process boundary', async () => {
      (RequestExecutor.executeCollection as jest.Mock).mockResolvedValue({
        summary: { total: 0, passed: 0, failed: 0, duration_ms: 1 }, results: [],
      });
      const handler = getHandler(server, 'run_collection');
      await handler({ collectionPath: '/col' });
      expect(RequestExecutor.executeCollection).toHaveBeenCalledWith(
        '/col',
        expect.objectContaining({ scriptRunner: forkingScriptRunner }),
      );
    });

    it('should reject a request entry outside collectionPath', async () => {
      const handler = getHandler(server, 'run_collection');
      const result = await handler({ collectionPath: '/col', requests: ['/other/evil.yml'] });
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

  describe('createBrunoMcpServer()', () => {
    it('returns a BrunoMcpServer instance', () => {
      const instance = createBrunoMcpServer();
      expect(instance).toBeInstanceOf(BrunoMcpServer);
    });
  });

  // Non-Error rejections exercise the `error instanceof Error ? ... : 'Unknown error'`
  // fallback branch of each handler's catch block.
  describe('non-Error rejections fall back to "Unknown error"', () => {
    it('create_collection', async () => {
      getManagerMock(server, 'collectionManager', 'createCollection').mockRejectedValue('str');
      const result = await getHandler(server, 'create_collection')({ name: 't', outputPath: '/ws' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown error');
    });

    it('create_environment', async () => {
      getManagerMock(server, 'environmentManager', 'createEnvironment').mockRejectedValue('str');
      const result = await getHandler(server, 'create_environment')({ collectionPath: '/col', name: 'dev', variables: {} });
      expect(result.content[0].text).toContain('Unknown error');
    });

    it('write_request', async () => {
      getManagerMock(server, 'requestBuilder', 'createRequest').mockRejectedValue('str');
      const result = await getHandler(server, 'write_request')({ collectionPath: '/col', name: 'T', method: 'GET', url: 'https://x.com' });
      expect(result.content[0].text).toContain('Unknown error');
    });

    it('list_collections', async () => {
      (listCollectionsHandler as jest.Mock).mockRejectedValue('str');
      const result = await getHandler(server, 'list_collections')({});
      expect(result.content[0].text).toContain('Unknown error');
    });

    it('get_collection_stats', async () => {
      (getCollectionStats as jest.Mock).mockRejectedValue('str');
      const result = await getHandler(server, 'get_collection_stats')({ collectionPath: '/col' });
      expect(result.content[0].text).toContain('Unknown error');
    });

    it('run_collection', async () => {
      (RequestExecutor.executeCollection as jest.Mock).mockRejectedValue('str');
      const result = await getHandler(server, 'run_collection')({ collectionPath: '/col' });
      expect(result.content[0].text).toContain('Unknown error');
    });
  });

});
