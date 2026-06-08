/**
 * Tests for create_test_suite dependency ordering.
 *
 * The create_test_suite tool now supports a `dependencies` field:
 *  - Schema: [{from: string, to: string}] — enforces execution ordering
 *  - Requests get seq numbers based on topological sort
 *  - Circular dependencies result in an error
 *  - No dependencies = positional ordering (backward compat)
 *
 * Follows the mock pattern from tests/unit/tools/server-tools.test.ts.
 */

import { BrunoMcpServer } from '../../../src/server';

// ── Module mocks ────────────────────────────────────────────────────────────

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
    updateRequest: jest.fn(),
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

// ── Helpers ─────────────────────────────────────────────────────────────────

function getHandler(server: BrunoMcpServer, toolName: string): Function {
  const mcpServer = (server as any).server;
  const tool = mcpServer._tools.get(toolName);
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);
  return tool.handler;
}

function getManagerMock(server: BrunoMcpServer, field: string, method: string): jest.Mock {
  return (server as any)[field][method];
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('create_test_suite — dependency ordering', () => {
  let server: BrunoMcpServer;
  let handler: Function;
  let createRequestMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    server = new BrunoMcpServer();
    handler = getHandler(server, 'create_test_suite');
    createRequestMock = getManagerMock(server, 'requestBuilder', 'createRequest');
    createRequestMock.mockResolvedValue({ success: true, path: '/col/test.yml' });
  });

  describe('linear dependency chain', () => {
    it('assigns sequence numbers based on topological sort (A before B before C)', async () => {
      const result = await handler({
        collectionPath: '/col',
        suiteName: 'Chain Tests',
        requests: [
          { name: 'A', method: 'GET', url: 'https://api.com/a' },
          { name: 'B', method: 'GET', url: 'https://api.com/b' },
          { name: 'C', method: 'GET', url: 'https://api.com/c' },
        ],
        dependencies: [
          { from: 'A', to: 'B' },
          { from: 'B', to: 'C' },
        ],
      });

      // Should succeed
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Chain Tests');

      // Verify sequence numbers passed to createRequest
      expect(createRequestMock).toHaveBeenCalledTimes(3);

      // Extract sequence numbers from calls
      const seqs = createRequestMock.mock.calls.map(
        (call: any[]) => ({ name: call[0].name, seq: call[0].sequence }),
      );

      // Find each request's seq
      const seqA = seqs.find((s: any) => s.name === 'A')?.seq;
      const seqB = seqs.find((s: any) => s.name === 'B')?.seq;
      const seqC = seqs.find((s: any) => s.name === 'C')?.seq;

      // A must come before B, B before C
      expect(seqA).toBeDefined();
      expect(seqB).toBeDefined();
      expect(seqC).toBeDefined();
      expect(seqA).toBeLessThan(seqB!);
      expect(seqB).toBeLessThan(seqC!);
    });
  });

  describe('circular dependency detection', () => {
    it('returns error for circular dependencies A -> B -> A', async () => {
      const result = await handler({
        collectionPath: '/col',
        suiteName: 'Circular Tests',
        requests: [
          { name: 'A', method: 'GET', url: 'https://api.com/a' },
          { name: 'B', method: 'GET', url: 'https://api.com/b' },
        ],
        dependencies: [
          { from: 'A', to: 'B' },
          { from: 'B', to: 'A' },
        ],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text.toLowerCase()).toContain('circular');
    });

    it('returns error for longer circular chain A -> B -> C -> A', async () => {
      const result = await handler({
        collectionPath: '/col',
        suiteName: 'Long Circular',
        requests: [
          { name: 'A', method: 'GET', url: 'https://api.com/a' },
          { name: 'B', method: 'GET', url: 'https://api.com/b' },
          { name: 'C', method: 'GET', url: 'https://api.com/c' },
        ],
        dependencies: [
          { from: 'A', to: 'B' },
          { from: 'B', to: 'C' },
          { from: 'C', to: 'A' },
        ],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text.toLowerCase()).toContain('circular');
    });
  });

  describe('no dependencies (backward compatibility)', () => {
    it('uses positional ordering when no dependencies are provided', async () => {
      const result = await handler({
        collectionPath: '/col',
        suiteName: 'No Deps',
        requests: [
          { name: 'First', method: 'GET', url: 'https://api.com/first' },
          { name: 'Second', method: 'POST', url: 'https://api.com/second' },
          { name: 'Third', method: 'DELETE', url: 'https://api.com/third' },
        ],
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('No Deps');
      expect(result.content[0].text).toContain('3 requests');
      expect(createRequestMock).toHaveBeenCalledTimes(3);

      // Positional ordering: first call gets seq 1, second gets seq 2, etc.
      const seqs = createRequestMock.mock.calls.map(
        (call: any[]) => call[0].sequence,
      );
      expect(seqs[0]).toBeLessThanOrEqual(seqs[1]);
      expect(seqs[1]).toBeLessThanOrEqual(seqs[2]);
    });
  });

  describe('parallel-safe dependency ordering', () => {
    it('places independent nodes before their shared dependent (A and B before C)', async () => {
      const result = await handler({
        collectionPath: '/col',
        suiteName: 'Diamond',
        requests: [
          { name: 'A', method: 'GET', url: 'https://api.com/a' },
          { name: 'B', method: 'GET', url: 'https://api.com/b' },
          { name: 'C', method: 'GET', url: 'https://api.com/c' },
        ],
        dependencies: [
          { from: 'A', to: 'C' },
          { from: 'B', to: 'C' },
        ],
      });

      expect(result.isError).toBeUndefined();

      const seqs = createRequestMock.mock.calls.map(
        (call: any[]) => ({ name: call[0].name, seq: call[0].sequence }),
      );

      const seqA = seqs.find((s: any) => s.name === 'A')?.seq;
      const seqB = seqs.find((s: any) => s.name === 'B')?.seq;
      const seqC = seqs.find((s: any) => s.name === 'C')?.seq;

      expect(seqA).toBeDefined();
      expect(seqB).toBeDefined();
      expect(seqC).toBeDefined();

      // Both A and B must come before C
      expect(seqA).toBeLessThan(seqC!);
      expect(seqB).toBeLessThan(seqC!);
    });
  });
});
