import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      tests: { total, passed: total - failed, failed },
      requestsWithoutTests: 0,
    },
    results,
  };
}

describe('run_collection tool', () => {
  let server: BrunoMcpServer;

  // A real tree, not a plausible-looking string: the tool confirms that a named
  // request or folder exists before it runs anything, so a fictional path is no
  // longer a usable stand-in for a valid one.
  let collectionDir: string;
  let requestFile: string;
  let subfolder: string;

  beforeAll(async () => {
    collectionDir = await mkdtemp(join(tmpdir(), 'run-collection-'));
    subfolder = join(collectionDir, 'subfolder');
    await mkdir(subfolder);
    requestFile = join(collectionDir, 'Get Users.yml');
    await writeFile(requestFile, 'info:\n  name: Get Users\n');
    await writeFile(join(subfolder, 'ping.yml'), 'info:\n  name: Ping\n');
  });

  afterAll(async () => {
    await rm(collectionDir, { recursive: true, force: true });
  });

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
      expect(parsed.groups[0].results).toHaveLength(3);
    });

    it('should pass requestPath for single-request mode', async () => {
      const mockResult = createSuccessResult(1, 1, 0);
      mockedExecutor.executeCollection.mockResolvedValue(mockResult);

      const tool = getRegisteredTool(server)!;
      await tool.handler({
        collectionPath: collectionDir,
        requestPath: requestFile,
      });

      expect(mockedExecutor.executeCollection).toHaveBeenCalledWith(
        collectionDir,
        expect.objectContaining({ requestPath: requestFile }),
      );
    });

    it('should pass directory requestPath to executor', async () => {
      const mockResult = createSuccessResult(2, 2, 0);
      mockedExecutor.executeCollection.mockResolvedValue(mockResult);

      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: collectionDir,
        requestPath: subfolder,
      });

      expect(mockedExecutor.executeCollection).toHaveBeenCalledWith(
        collectionDir,
        expect.objectContaining({ requestPath: subfolder }),
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
        collectionPath: collectionDir,
        requestPath: requestFile,
      });

      expect(response.isError).toBeUndefined();
      expect(mockedExecutor.executeCollection).toHaveBeenCalledWith(
        collectionDir,
        expect.objectContaining({ requestPath: requestFile }),
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

  describe('variables', () => {
    it('passes variables through, coercing non-string values', async () => {
      mockedExecutor.executeCollection.mockResolvedValue(createSuccessResult(1, 1, 0));

      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: '/workspace/collection',
        variables: { token: 'secret-abc', port: 8080 },
      });

      expect(response.isError).toBeUndefined();
      expect(mockedExecutor.executeCollection).toHaveBeenCalledWith(
        '/workspace/collection',
        expect.objectContaining({ variables: { token: 'secret-abc', port: '8080' } }),
      );
    });

    it('omits nothing when no variables are given', async () => {
      mockedExecutor.executeCollection.mockResolvedValue(createSuccessResult(1, 1, 0));

      const tool = getRegisteredTool(server)!;
      await tool.handler({ collectionPath: '/workspace/collection' });

      expect(mockedExecutor.executeCollection).toHaveBeenCalledWith(
        '/workspace/collection',
        expect.objectContaining({ variables: {} }),
      );
    });

    it('passes captureVariables through to the run', async () => {
      mockedExecutor.executeCollection.mockResolvedValue(createSuccessResult(1, 1, 0));

      const tool = getRegisteredTool(server)!;
      await tool.handler({
        collectionPath: '/workspace/collection',
        captureVariables: ['token', 'orderId'],
      });

      expect(mockedExecutor.executeCollection).toHaveBeenCalledWith(
        '/workspace/collection',
        expect.objectContaining({ captureVariables: ['token', 'orderId'] }),
      );
    });

    it('asks for no captured values when the caller names none', async () => {
      // Values are opt-in: an undefined here is what keeps a token a script
      // captured out of the result of a run that never asked about it.
      mockedExecutor.executeCollection.mockResolvedValue(createSuccessResult(1, 1, 0));

      const tool = getRegisteredTool(server)!;
      await tool.handler({ collectionPath: '/workspace/collection' });

      expect(mockedExecutor.executeCollection).toHaveBeenCalledWith(
        '/workspace/collection',
        expect.objectContaining({ captureVariables: undefined }),
      );
    });

    it('defaults the cookie jar to on, matching Bruno\'s --disable-cookies', () => {
      // The default lives in the schema: the SDK parses args before the handler
      // sees them, so it is asserted where it actually applies. (Calling the
      // handler directly, as the tests below do, bypasses that parse — the
      // executor's own `cookieJar !== false` covers that case.)
      const tool = getRegisteredTool(server)!;

      expect(tool.config.inputSchema.cookieJar.parse(undefined)).toBe(true);
      expect(tool.config.inputSchema.cookieJar.parse(false)).toBe(false);
    });

    it('passes the cookie jar opt-out through', async () => {
      mockedExecutor.executeCollection.mockResolvedValue(createSuccessResult(1, 1, 0));

      const tool = getRegisteredTool(server)!;
      await tool.handler({ collectionPath: '/workspace/collection', cookieJar: false });

      expect(mockedExecutor.executeCollection).toHaveBeenCalledWith(
        '/workspace/collection',
        expect.objectContaining({ cookieJar: false }),
      );
    });

    it('rejects a name no placeholder could reference, and runs nothing', async () => {
      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: '/workspace/collection',
        variables: { 'bad}name': 'x' },
      });

      // Accepting it would mean running the whole collection with an override
      // that silently never applied.
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('Invalid variables');
      expect(response.content[0].text).toContain('bad}name');
      expect(mockedExecutor.executeCollection).not.toHaveBeenCalled();
    });
  });

  describe('running a subset', () => {
    it('resolves folder to the directory it names under the collection', async () => {
      mockedExecutor.executeCollection.mockResolvedValue(createSuccessResult(2, 2, 0));

      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: collectionDir,
        folder: 'subfolder',
      });

      expect(response.isError).toBeUndefined();
      expect(mockedExecutor.executeCollection).toHaveBeenCalledWith(
        collectionDir,
        expect.objectContaining({ requestPath: subfolder }),
      );
    });

    it('accepts an absolute folder unchanged', async () => {
      mockedExecutor.executeCollection.mockResolvedValue(createSuccessResult(2, 2, 0));

      const tool = getRegisteredTool(server)!;
      await tool.handler({ collectionPath: collectionDir, folder: subfolder });

      expect(mockedExecutor.executeCollection).toHaveBeenCalledWith(
        collectionDir,
        expect.objectContaining({ requestPath: subfolder }),
      );
    });

    it('resolves a relative requestPath against collectionPath, not the cwd', async () => {
      mockedExecutor.executeCollection.mockResolvedValue(createSuccessResult(1, 1, 0));

      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: collectionDir,
        requestPath: 'Get Users.yml',
      });

      expect(response.isError).toBeUndefined();
      expect(mockedExecutor.executeCollection).toHaveBeenCalledWith(
        collectionDir,
        expect.objectContaining({ requestPath: requestFile }),
      );
    });

    it('rejects folder and requestPath together rather than picking one', async () => {
      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: collectionDir,
        folder: 'subfolder',
        requestPath: 'Get Users.yml',
      });

      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('not both');
      expect(mockedExecutor.executeCollection).not.toHaveBeenCalled();
    });

    it('rejects a folder that does not exist instead of running everything', async () => {
      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: collectionDir,
        folder: 'Nope',
      });

      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('folder does not exist');
      expect(response.content[0].text).toContain(join(collectionDir, 'Nope'));
      expect(mockedExecutor.executeCollection).not.toHaveBeenCalled();
    });

    it('rejects a requestPath that does not exist instead of running everything', async () => {
      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: collectionDir,
        requestPath: 'Nope.yml',
      });

      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('requestPath does not exist');
      expect(mockedExecutor.executeCollection).not.toHaveBeenCalled();
    });

    it('rejects a folder that names a file', async () => {
      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: collectionDir,
        folder: 'Get Users.yml',
      });

      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('must name a directory');
      expect(mockedExecutor.executeCollection).not.toHaveBeenCalled();
    });

    it('rejects a folder that escapes the collection', async () => {
      const tool = getRegisteredTool(server)!;
      const response = await tool.handler({
        collectionPath: collectionDir,
        folder: '../..',
      });

      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('Invalid folder');
      expect(mockedExecutor.executeCollection).not.toHaveBeenCalled();
    });

    it('names both subset arguments, and only those, in its description', () => {
      const tool = getRegisteredTool(server)!;
      const description: string = tool.config.description;

      expect(description).toContain('folder');
      expect(description).toContain('requestPath');
      // A caller must be able to learn from the schema alone that the key they
      // guessed is not read, rather than discovering it from a whole-collection
      // run that looked like a subset.
      expect(description).toMatch(/silently discarded/i);
      expect(Object.keys(tool.config.inputSchema)).toContain('folder');
    });
  });
});
