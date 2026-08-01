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
const mockCreateEnvironment = jest.fn();
jest.mock('../../../src/bruno/environment', () => ({
  createEnvironmentManager: jest.fn(() => ({
    createEnvironment: (...args: unknown[]) => mockCreateEnvironment(...args),
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

    it('rejects an invalid collectionPath before merging', async () => {
      const handler = getHandler(server, 'update_environment');
      const res = await handler({ collectionPath: '/col/../etc', name: 'dev', variables: {} });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/collectionPath/i);
      expect(mockMergeEnvironment).not.toHaveBeenCalled();
    });

    it('catches errors thrown by mergeEnvironment', async () => {
      mockMergeEnvironment.mockRejectedValue(new Error('boom'));

      const handler = getHandler(server, 'update_environment');
      const res = await handler({ collectionPath: '/col', name: 'dev', variables: { x: '1' } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/updating environment/i);
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
      expect(mockSetEnvironmentVariable).toHaveBeenCalledWith('/col', 'dev', 'token', 'abc123', undefined, undefined);
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
      expect(mockSetEnvironmentVariable).toHaveBeenCalledWith('/col', 'dev', 'FEATURE', 'off', false, undefined);
    });

    it('forwards the secret flag so it can be persisted', async () => {
      mockSetEnvironmentVariable.mockResolvedValue({ success: true, path: '/col/environments/dev.yml' });

      const handler = getHandler(server, 'set_environment_variable');
      const res = await handler({
        collectionPath: '/col',
        environment: 'dev',
        name: 'API_KEY',
        value: 'discarded',
        secret: true,
      });

      expect(res.isError).toBeFalsy();
      expect(mockSetEnvironmentVariable).toHaveBeenCalledWith(
        '/col', 'dev', 'API_KEY', 'discarded', undefined, true,
      );
    });

    it('tells the caller a secret variable stores the name but not the value', async () => {
      mockSetEnvironmentVariable.mockResolvedValue({ success: true, path: '/col/environments/dev.yml' });

      const handler = getHandler(server, 'set_environment_variable');
      const res = await handler({
        collectionPath: '/col',
        environment: 'dev',
        name: 'API_KEY',
        value: 'discarded',
        secret: true,
      });

      expect(res.content[0].text).toContain('the value is not stored in the file');
      // The value must never be echoed back, secret or not.
      expect(res.content[0].text).not.toContain('discarded');
    });

    it('does not claim a non-secret variable withheld its value', async () => {
      mockSetEnvironmentVariable.mockResolvedValue({ success: true, path: '/col/environments/dev.yml' });

      const handler = getHandler(server, 'set_environment_variable');
      const res = await handler({
        collectionPath: '/col', environment: 'dev', name: 'plain', value: 'v',
      });

      expect(res.content[0].text).not.toContain('not stored');
    });

    it('advertises the secret flag as persisted, not as ignored', () => {
      // An agent picks `secret` on the strength of this description, so a
      // description that says the flag is dropped is a security decision made
      // on a false premise.
      const { config } = getTool(server, 'set_environment_variable');
      const description = config.inputSchema.secret.description as string;

      expect(description).not.toMatch(/ignored/i);
      expect(description).not.toMatch(/not representable/i);
      expect(description).toMatch(/Persisted/);
      expect(description).toMatch(/VALUE IS NOT SAVED/);
    });

    it('rejects an invalid collectionPath before setting', async () => {
      const handler = getHandler(server, 'set_environment_variable');
      const res = await handler({
        collectionPath: '/col/../etc',
        environment: 'dev',
        name: 'k',
        value: 'v',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/collectionPath/i);
      expect(mockSetEnvironmentVariable).not.toHaveBeenCalled();
    });

    it('reports failure when setEnvironmentVariable fails', async () => {
      mockSetEnvironmentVariable.mockResolvedValue({ success: false, error: 'nope' });

      const handler = getHandler(server, 'set_environment_variable');
      const res = await handler({ collectionPath: '/col', environment: 'dev', name: 'k', value: 'v' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/failed to set/i);
    });

    it('catches errors thrown by setEnvironmentVariable', async () => {
      mockSetEnvironmentVariable.mockRejectedValue(new Error('boom'));

      const handler = getHandler(server, 'set_environment_variable');
      const res = await handler({ collectionPath: '/col', environment: 'dev', name: 'k', value: 'v' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/setting variable/i);
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

    it('rejects an invalid collectionPath before removing', async () => {
      const handler = getHandler(server, 'remove_environment_variable');
      const res = await handler({ collectionPath: '/col/../etc', environment: 'dev', name: 'token' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/collectionPath/i);
      expect(mockRemoveEnvironmentVariable).not.toHaveBeenCalled();
    });

    it('reports failure when removeEnvironmentVariable fails', async () => {
      mockRemoveEnvironmentVariable.mockResolvedValue({ success: false, error: 'nope' });

      const handler = getHandler(server, 'remove_environment_variable');
      const res = await handler({ collectionPath: '/col', environment: 'dev', name: 'token' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/failed to remove/i);
    });

    it('catches errors thrown by removeEnvironmentVariable', async () => {
      mockRemoveEnvironmentVariable.mockRejectedValue(new Error('boom'));

      const handler = getHandler(server, 'remove_environment_variable');
      const res = await handler({ collectionPath: '/col', environment: 'dev', name: 'token' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/removing variable/i);
    });
  });

  // Non-Error rejections exercise the "Unknown error" fallback branch.
  describe('non-Error rejections fall back to "Unknown error"', () => {
    it('update_environment', async () => {
      mockMergeEnvironment.mockRejectedValue('str');
      const res = await getHandler(server, 'update_environment')({ collectionPath: '/col', name: 'dev', variables: {} });
      expect(res.content[0].text).toContain('Unknown error');
    });

    it('set_environment_variable', async () => {
      mockSetEnvironmentVariable.mockRejectedValue('str');
      const res = await getHandler(server, 'set_environment_variable')({ collectionPath: '/col', environment: 'dev', name: 'k', value: 'v' });
      expect(res.content[0].text).toContain('Unknown error');
    });

    it('remove_environment_variable', async () => {
      mockRemoveEnvironmentVariable.mockRejectedValue('str');
      const res = await getHandler(server, 'remove_environment_variable')({ collectionPath: '/col', environment: 'dev', name: 'k' });
      expect(res.content[0].text).toContain('Unknown error');
    });
  });
});

describe('create_environment reports a refusal so the caller can decide', () => {
  let server: BrunoMcpServer;

  beforeEach(() => {
    jest.clearAllMocks();
    server = new BrunoMcpServer();
  });

  it('renders the three name lists and the next steps', async () => {
    // The point of the conflict report is that the CALLER sees it. Asserting only
    // on the manager leaves the rendering untested, and dropping it there is
    // invisible: the call still fails, just uninformatively.
    mockCreateEnvironment.mockResolvedValue({
      success: false,
      path: '/col/environments/dev.yml',
      error: 'Environment already exists at /col/environments/dev.yml',
      conflict: {
        path: '/col/environments/dev.yml',
        existing: [{ name: 'token', secret: true }, { name: 'onlyOnDisk' }],
        alreadyPresent: ['shared'],
        added: ['brandNew'],
        wouldBeLost: ['onlyOnDisk'],
      },
    });

    const res = await getHandler(server, 'create_environment')({
      collectionPath: '/col', name: 'dev', variables: { shared: 'x', brandNew: 'y' },
    });

    expect(res.isError).toBe(true);
    const text = res.content[0].text as string;
    expect(text).toContain('Already present: shared');
    expect(text).toContain('Would be added: brandNew');
    expect(text).toContain('Would be DELETED by a replace: onlyOnDisk');
    expect(text).toContain('update_environment');
    expect(text).toContain('overwrite: true');
  });

  it('spells out an empty list rather than trailing a bare colon', async () => {
    mockCreateEnvironment.mockResolvedValue({
      success: false,
      error: 'Environment already exists',
      conflict: { path: '/p', existing: [], alreadyPresent: [], added: ['a'], wouldBeLost: [] },
    });

    const res = await getHandler(server, 'create_environment')({
      collectionPath: '/col', name: 'dev', variables: { a: '1' },
    });
    expect(res.content[0].text).toContain('Would be DELETED by a replace: (none)');
  });

  it('forwards overwrite to the manager', async () => {
    // Dropping the flag here would silently restore the refusal for a caller who
    // explicitly asked to replace, and the failure would look like the feature
    // working as designed.
    mockCreateEnvironment.mockResolvedValue({ success: true, path: '/p' });
    await getHandler(server, 'create_environment')({
      collectionPath: '/col', name: 'dev', variables: { a: '1' }, overwrite: true,
    });
    expect(mockCreateEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ overwrite: true }),
    );
  });

  it('omits overwrite entirely when the caller did not pass it', async () => {
    mockCreateEnvironment.mockResolvedValue({ success: true, path: '/p' });
    await getHandler(server, 'create_environment')({
      collectionPath: '/col', name: 'dev', variables: { a: '1' },
    });
    expect(mockCreateEnvironment.mock.calls[0][0]).not.toHaveProperty('overwrite');
  });

  it('leaves an ordinary failure unadorned', async () => {
    mockCreateEnvironment.mockResolvedValue({ success: false, error: 'disk on fire' });
    const res = await getHandler(server, 'create_environment')({
      collectionPath: '/col', name: 'dev', variables: { a: '1' },
    });
    expect(res.content[0].text).toContain('disk on fire');
    expect(res.content[0].text).not.toContain('Would be added');
  });
});
