import { BrunoMcpServer } from '../../../src/server';
import { RequestExecutor } from '../../../src/bruno/request-executor';
import type { CollectionRunResult } from '../../../src/bruno/types';

jest.mock('../../../src/bruno/request-executor');
const mockedExecutor = jest.mocked(RequestExecutor);

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

function getRegisteredTool(server: BrunoMcpServer): { config: any; handler: Function } | undefined {
  const mcpServer = (server as any).server;
  return mcpServer._tools.get('run_collection');
}

function createSuccessResult(total = 3, passed = 3, failed = 0): CollectionRunResult {
  const results = [];
  for (let i = 0; i < total; i++) {
    const isFailed = i >= (total - failed);
    results.push({
      name: `Request ${i + 1}`,
      method: 'GET',
      url: `https://api.example.com/r${i + 1}`,
      status: isFailed ? 500 : 200,
      duration_ms: 50 + i * 10,
      tests: isFailed
        ? [{ description: 'should pass', status: 'fail' as const, error: 'expected 500 to equal 200' }]
        : [{ description: 'should pass', status: 'pass' as const }],
    });
  }

  return {
    summary: {
      total,
      passed,
      failed,
      duration_ms: results.reduce((sum, r) => sum + r.duration_ms, 0),
    },
    results,
  };
}

describe('run_collection tool', () => {
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

  it('should accept collectionPath as required input', () => {
    const tool = getRegisteredTool(server);
    expect(tool!.config.inputSchema.collectionPath).toBeDefined();
  });

  it('should accept optional environment and requestPath inputs', () => {
    const tool = getRegisteredTool(server);
    expect(tool!.config.inputSchema.environment).toBeDefined();
    expect(tool!.config.inputSchema.requestPath).toBeDefined();
  });

  it('should accept optional parallel input', () => {
    const tool = getRegisteredTool(server);
    expect(tool!.config.inputSchema.parallel).toBeDefined();
  });

  describe('successful execution', () => {
    it('should return structured results with summary and per-request detail', async () => {
      const mockResult = createSuccessResult(3, 3, 0);
      mockedExecutor.executeCollection.mockResolvedValue(mockResult);

      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: '/path/to/collection',
        environment: 'dev',
      });

      expect(mockedExecutor.executeCollection).toHaveBeenCalledWith(
        '/path/to/collection',
        expect.objectContaining({ environment: 'dev' }),
      );

      expect(response.content).toBeDefined();
      expect(response.content[0].type).toBe('text');

      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.summary.total).toBe(3);
      expect(parsed.summary.passed).toBe(3);
      expect(parsed.summary.failed).toBe(0);
      expect(parsed.results).toHaveLength(3);
    });

    it('should pass requestPath for single-request mode', async () => {
      const mockResult = createSuccessResult(1, 1, 0);
      mockedExecutor.executeCollection.mockResolvedValue(mockResult);

      const tool = getRegisteredTool(server)!;
      await tool.handler({
        collectionPath: '/path/to/collection',
        requestPath: '/path/to/collection/Get Users.yml',
      });

      expect(mockedExecutor.executeCollection).toHaveBeenCalledWith(
        '/path/to/collection',
        expect.objectContaining({ requestPath: '/path/to/collection/Get Users.yml' }),
      );
    });

    it('should pass directory requestPath to executor', async () => {
      const mockResult = createSuccessResult(2, 2, 0);
      mockedExecutor.executeCollection.mockResolvedValue(mockResult);

      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: '/path/to/collection',
        requestPath: '/path/to/collection/subfolder',
      });

      expect(mockedExecutor.executeCollection).toHaveBeenCalledWith(
        '/path/to/collection',
        expect.objectContaining({ requestPath: '/path/to/collection/subfolder' }),
      );

      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.summary.total).toBe(2);
    });

    it('should pass parallel flag to executor', async () => {
      const mockResult = createSuccessResult(2, 2, 0);
      mockedExecutor.executeCollection.mockResolvedValue(mockResult);

      const tool = getRegisteredTool(server)!;
      await tool.handler({
        collectionPath: '/path/to/collection',
        parallel: true,
      });

      expect(mockedExecutor.executeCollection).toHaveBeenCalledWith(
        '/path/to/collection',
        expect.objectContaining({ parallel: true }),
      );
    });

    it('should pass parallel as undefined when not specified', async () => {
      const mockResult = createSuccessResult(2, 2, 0);
      mockedExecutor.executeCollection.mockResolvedValue(mockResult);

      const tool = getRegisteredTool(server)!;
      await tool.handler({
        collectionPath: '/path/to/collection',
      });

      expect(mockedExecutor.executeCollection).toHaveBeenCalledWith(
        '/path/to/collection',
        expect.objectContaining({}),
      );
      // parallel is falsy (undefined) when not specified — executor treats it as serial
      const calledOptions = mockedExecutor.executeCollection.mock.calls[0][1];
      expect(!calledOptions?.parallel).toBe(true);
    });

    it('should work without optional parameters', async () => {
      const mockResult = createSuccessResult(2, 2, 0);
      mockedExecutor.executeCollection.mockResolvedValue(mockResult);

      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: '/path/to/collection',
      });

      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.summary.total).toBe(2);
    });
  });

  describe('partial failures', () => {
    it('should report both passed and failed results', async () => {
      const mockResult = createSuccessResult(3, 2, 1);
      mockedExecutor.executeCollection.mockResolvedValue(mockResult);

      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: '/path/to/collection',
        environment: 'dev',
      });

      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.summary.total).toBe(3);
      expect(parsed.summary.passed).toBe(2);
      expect(parsed.summary.failed).toBe(1);
    });
  });

  describe('error handling', () => {
    it('should return error response when executor throws', async () => {
      mockedExecutor.executeCollection.mockRejectedValue(
        new Error('Collection path does not exist: /bad/path'),
      );

      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: '/bad/path',
      });

      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('Collection path does not exist');
    });

    it('should handle unknown errors gracefully', async () => {
      mockedExecutor.executeCollection.mockRejectedValue('some string error');

      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: '/path/to/collection',
      });

      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('Error');
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
      expect(mockedExecutor.executeCollection).not.toHaveBeenCalled();
    });

    it('should reject collectionPath with null bytes', async () => {
      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: '/workspace/collection\0malicious',
      });

      expect(response.isError).toBe(true);
      expect(response.content[0].text).toMatch(/null/i);
      expect(mockedExecutor.executeCollection).not.toHaveBeenCalled();
    });

    it('should reject requestPath outside collectionPath', async () => {
      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: '/workspace/collection',
        requestPath: '/etc/passwd',
      });

      expect(response.isError).toBe(true);
      expect(response.content[0].text).toMatch(/path|outside|traversal/i);
      expect(mockedExecutor.executeCollection).not.toHaveBeenCalled();
    });

    it('should reject collectionRoot with traversal segments', async () => {
      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: '/workspace/collection',
        collectionRoot: '/workspace/../etc',
      });

      expect(response.isError).toBe(true);
      expect(response.content[0].text).toMatch(/path|traversal/i);
      expect(mockedExecutor.executeCollection).not.toHaveBeenCalled();
    });

    it('should allow valid paths and call executor normally', async () => {
      const mockResult = createSuccessResult(1, 1, 0);
      mockedExecutor.executeCollection.mockResolvedValue(mockResult);

      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: '/workspace/collection',
        requestPath: '/workspace/collection/Get Users.yml',
      });

      expect(response.isError).toBeUndefined();
      expect(mockedExecutor.executeCollection).toHaveBeenCalledWith(
        '/workspace/collection',
        expect.objectContaining({ requestPath: '/workspace/collection/Get Users.yml' }),
      );
    });

    it('should reject empty collectionPath', async () => {
      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: '',
      });

      // Either zod rejects it or our validator does
      expect(response.isError).toBe(true);
      expect(mockedExecutor.executeCollection).not.toHaveBeenCalled();
    });
  });
});
