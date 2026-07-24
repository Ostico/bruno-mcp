/**
 * Tests for the environment merge tools:
 *   - update_environment           (partial merge, anti-clobber)
 *   - set_environment_variable     (add / update a single var)
 *   - remove_environment_variable  (remove a single var)
 *
 * These tools delegate to EnvironmentManager. update_environment performs the
 * anti-clobber merge in the tool handler (load existing → overlay → update).
 */

import { BrunoMcpServer } from '../../../src/server';

// EnvironmentManager mock — capture the methods the tools use.
const mockMergeEnvironment = jest.fn();
const mockSetEnvironmentVariable = jest.fn();
const mockRemoveEnvironmentVariable = jest.fn();
jest.mock('../../../src/bruno/environment', () => ({
  createEnvironmentManager: jest.fn(() => ({
    createEnvironment: jest.fn(),
    mergeEnvironment: (...args: unknown[]) => mockMergeEnvironment(...args),
    setEnvironmentVariable: (...args: unknown[]) => mockSetEnvironmentVariable(...args),
    removeEnvironmentVariable: (...args: unknown[]) => mockRemoveEnvironmentVariable(...args),
  })),
}));

// Other modules — stubs so BrunoMcpServer constructs.
jest.mock('../../../src/bruno/request-executor');
jest.mock('../../../src/bruno/collection', () => ({
  createCollectionManager: jest.fn(() => ({
    createCollection: jest.fn(),
    getCollectionStats: jest.fn(),
  })),
}));
jest.mock('../../../src/bruno/request', () => ({
  createRequestBuilder: jest.fn(() => ({
    createRequest: jest.fn(),
    createCrudRequests: jest.fn(),
    updateRequest: jest.fn(),
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
jest.mock('../../../src/bruno/format-detector', () => ({
  findCollectionRoot: jest.fn(),
  detectFormat: jest.fn(),
}));
jest.mock('../../../src/bruno/format-factory', () => ({
  createWriter: jest.fn(),
  normalizeScriptType: jest.fn(),
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

function getTool(server: BrunoMcpServer, toolName: string): { config: any; handler: Function } {
  const mcpServer = (server as any).server;
  return mcpServer._tools.get(toolName);
}

describe('environment merge tools', () => {
  let server: BrunoMcpServer;

  beforeEach(() => {
    jest.clearAllMocks();
    server = new BrunoMcpServer();
  });

  it('registers update_environment, set_environment_variable, remove_environment_variable', () => {
    expect(getTool(server, 'update_environment')).toBeDefined();
    expect(getTool(server, 'set_environment_variable')).toBeDefined();
    expect(getTool(server, 'remove_environment_variable')).toBeDefined();
    // Descriptions must signal MERGE semantics (vs create_environment which replaces).
    expect(getTool(server, 'update_environment').config.description).toMatch(/merg/i);
    expect(getTool(server, 'set_environment_variable').config.description).toMatch(/merg|preserv/i);
    expect(getTool(server, 'remove_environment_variable').config.description).toMatch(/merg|preserv/i);
  });

  describe('update_environment', () => {
    it('delegates to mergeEnvironment (which preserves unlisted vars incl. disabled)', async () => {
      mockMergeEnvironment.mockResolvedValue({ success: true, path: '/col/environments/dev.yml' });

      const handler = getHandler(server, 'update_environment');
      const res = await handler({
        collectionPath: '/col',
        name: 'dev',
        variables: { newC: 'c', keepB: 'override' },
      });

      expect(res.isError).toBeFalsy();
      expect(mockMergeEnvironment).toHaveBeenCalledWith('/col', 'dev', {
        newC: 'c',
        keepB: 'override',
      });
    });

    it('reports failure when the underlying merge fails', async () => {
      mockMergeEnvironment.mockResolvedValue({ success: false, error: 'nope' });

      const handler = getHandler(server, 'update_environment');
      const res = await handler({ collectionPath: '/col', name: 'dev', variables: { x: '1' } });
      expect(res.isError).toBe(true);
    });
  });

  describe('set_environment_variable', () => {
    it('adds/updates a single variable via setEnvironmentVariable', async () => {
      mockSetEnvironmentVariable.mockResolvedValue({ success: true, path: '/col/environments/dev.yml' });

      const handler = getHandler(server, 'set_environment_variable');
      const res = await handler({
        collectionPath: '/col',
        environment: 'dev',
        name: 'token',
        value: 'abc123',
      });

      expect(res.isError).toBeFalsy();
      expect(mockSetEnvironmentVariable).toHaveBeenCalledWith('/col', 'dev', 'token', 'abc123', undefined);
    });

    it('forwards the enabled flag so it can be persisted', async () => {
      mockSetEnvironmentVariable.mockResolvedValue({ success: true, path: '/col/environments/dev.yml' });

      const handler = getHandler(server, 'set_environment_variable');
      const res = await handler({
        collectionPath: '/col',
        environment: 'dev',
        name: 'FEATURE',
        value: 'off',
        enabled: false,
      });

      expect(res.isError).toBeFalsy();
      expect(mockSetEnvironmentVariable).toHaveBeenCalledWith('/col', 'dev', 'FEATURE', 'off', false);
    });
  });

  describe('remove_environment_variable', () => {
    it('removes a single variable via removeEnvironmentVariable', async () => {
      mockRemoveEnvironmentVariable.mockResolvedValue({ success: true, path: '/col/environments/dev.yml' });

      const handler = getHandler(server, 'remove_environment_variable');
      const res = await handler({
        collectionPath: '/col',
        environment: 'dev',
        name: 'token',
      });

      expect(res.isError).toBeFalsy();
      expect(mockRemoveEnvironmentVariable).toHaveBeenCalledWith('/col', 'dev', 'token');
    });
  });
});
