/**
 * Tests for the write_request tool handler (Task 4).
 *
 * Mocks:
 *  - format-detector  (findCollectionRoot, detectFormat)
 *  - request builder  (updateRequest)
 *  - All other Bruno modules (not under test)
 *  - MCP SDK (capture registered handlers)
 */

import { BrunoMcpServer } from '../../../src/server';

// ── Module mocks ────────────────────────────────────────────────────────────

// format-detector
const mockFindCollectionRoot = jest.fn();
const mockDetectFormat = jest.fn();
jest.mock('../../../src/bruno/format-detector', () => ({
  findCollectionRoot: (...args: unknown[]) => mockFindCollectionRoot(...args),
  detectFormat: (...args: unknown[]) => mockDetectFormat(...args),
}));

// format-factory (required by add_test_script tool registration)
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

// request builder — capture the mock for updateRequest
const mockUpdateRequest = jest.fn();
jest.mock('../../../src/bruno/request', () => ({
  createRequestBuilder: jest.fn(() => ({
    createRequest: jest.fn(),
    createCrudRequests: jest.fn(),
    updateRequest: (...args: unknown[]) => mockUpdateRequest(...args),
  })),
}));

// Modules not under test — simple stubs so BrunoMcpServer constructs
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

// MCP SDK mock — captures tool registrations
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe('write_request tool handler', () => {
  let server: BrunoMcpServer;
  let handler: Function;

  beforeEach(() => {
    jest.clearAllMocks();
    server = new BrunoMcpServer();
    handler = getHandler(server, 'write_request');

    // Default happy-path mocks
    mockFindCollectionRoot.mockResolvedValue('/workspace/collection');
    mockDetectFormat.mockResolvedValue({
      format: 'yaml',
      configPath: '/workspace/collection/opencollection.yml',
      collectionName: 'TestCollection',
    });
    mockUpdateRequest.mockResolvedValue({
      success: true,
      path: '/workspace/collection/get-users.yml',
    });
  });

  // ── Tool registration ──────────────────────────────────────────────────

  it('registers the write_request tool', () => {
    const mcpServer = (server as any).server;
    expect(mcpServer._tools.has('write_request')).toBe(true);
  });

  // ── Success path ───────────────────────────────────────────────────────

  describe('success path', () => {
    it('returns success message on valid update', async () => {
      const res = await handler({
        filePath: '/workspace/collection/get-users.yml',
        url: 'https://api.example.com/v2/users',
      });
      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).toMatch(/successfully modified/i);
      expect(res.content[0].text).toContain('get-users.yml');
    });

    it('passes all provided fields to updateRequest', async () => {
      await handler({
        filePath: '/workspace/collection/get-users.yml',
        name: 'Updated Name',
        method: 'POST',
        url: 'https://new.api.com',
        headers: { 'X-Custom': 'value' },
        body: { type: 'json', content: '{"key":"val"}' },
        auth: { type: 'bearer', config: { token: 'tok123' } },
        query: { page: '1', limit: 10 },
      });

      expect(mockUpdateRequest).toHaveBeenCalledWith(
        '/workspace/collection/get-users.yml',
        expect.objectContaining({
          name: 'Updated Name',
          method: 'POST',
          url: 'https://new.api.com',
          headers: { 'X-Custom': 'value' },
          body: { type: 'json', content: '{"key":"val"}', formData: undefined },
          auth: { type: 'bearer', config: { token: 'tok123' } },
          query: { page: '1', limit: 10 },
        }),
      );
    });

    it('passes the settings block through to updateRequest', async () => {
      // Its own test rather than a field on the one above: the settings block is
      // the only argument whose whole purpose is to reach the file, and a handler
      // that quietly dropped it would leave the schema advertising a field that
      // does nothing.
      await handler({
        filePath: '/workspace/collection/get-users.yml',
        settings: { followRedirects: false, timeout: 20000 },
      });

      const [, updates] = mockUpdateRequest.mock.calls[0];
      expect(updates.settings).toEqual({ followRedirects: false, timeout: 20000 });
    });

    it('passes only provided fields (partial merge)', async () => {
      await handler({
        filePath: '/workspace/collection/get-users.yml',
        url: 'https://updated.example.com',
      });

      const [, updates] = mockUpdateRequest.mock.calls[0];
      expect(updates).toEqual({ url: 'https://updated.example.com' });
      expect(updates).not.toHaveProperty('name');
      expect(updates).not.toHaveProperty('method');
      expect(updates).not.toHaveProperty('headers');
    });

    it('passes filename through, and leaves name out when only the file moves', async () => {
      await handler({
        filePath: '/workspace/collection/get-users.yml',
        filename: 'list-users',
      });

      const [, updates] = mockUpdateRequest.mock.calls[0];
      expect(updates).toEqual({ filename: 'list-users' });
    });

    it('reports the path a renamed file moved to, since the old one is gone', async () => {
      mockUpdateRequest.mockResolvedValue({
        success: true,
        path: '/workspace/collection/list-users.yml',
      });

      const res = await handler({
        filePath: '/workspace/collection/get-users.yml',
        filename: 'list-users',
      });

      expect(res.content[0].text).toContain('/workspace/collection/list-users.yml');
      expect(res.content[0].text).toContain('filePath');
    });

    it('defaults inline scripts to replace so repeated calls are idempotent', async () => {
      await handler({
        filePath: '/workspace/collection/get-users.yml',
        scripts: { tests: 'test("ok", function() {});' },
      });

      const [, updates] = mockUpdateRequest.mock.calls[0];
      expect(updates.scripts).toEqual({ tests: 'test("ok", function() {});' });
      expect(updates.scriptMode).toBe('replace');
    });

    it('honours an explicit append scriptMode', async () => {
      await handler({
        filePath: '/workspace/collection/get-users.yml',
        scripts: { tests: 'test("ok", function() {});' },
        scriptMode: 'append',
      });

      const [, updates] = mockUpdateRequest.mock.calls[0];
      expect(updates.scriptMode).toBe('append');
    });

    it('omits scriptMode when no scripts are provided', async () => {
      await handler({
        filePath: '/workspace/collection/get-users.yml',
        url: 'https://updated.example.com',
        scriptMode: 'append',
      });

      const [, updates] = mockUpdateRequest.mock.calls[0];
      expect(updates).not.toHaveProperty('scriptMode');
    });

    it('works with .bru files in BRU collections', async () => {
      mockDetectFormat.mockResolvedValue({
        format: 'bru',
        configPath: '/workspace/collection/bruno.json',
        collectionName: 'TestCollection',
      });

      const res = await handler({
        filePath: '/workspace/collection/get-users.bru',
        method: 'PUT',
      });
      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).toMatch(/successfully modified/i);
    });
  });

  // ── Security: path traversal ───────────────────────────────────────────

  describe('path traversal protection', () => {
    it('rejects filePath with .. segments', async () => {
      const res = await handler({
        filePath: '/workspace/../etc/passwd',
        url: 'https://evil.com',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/filePath/i);
      expect(res.content[0].text).toMatch(/traversal/i);
    });
  });

  // ── Security: null bytes ───────────────────────────────────────────────

  describe('null byte protection', () => {
    it('rejects filePath with null bytes', async () => {
      const res = await handler({
        filePath: '/workspace/collection/request\0.yml',
        url: 'https://evil.com',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/filePath/i);
      expect(res.content[0].text).toMatch(/null/i);
    });
  });

  // ── File extension validation ──────────────────────────────────────────

  describe('file extension validation', () => {
    it('rejects files with invalid extension', async () => {
      const res = await handler({
        filePath: '/workspace/collection/request.json',
        url: 'https://example.com',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/extension|\.bru|\.yml/i);
    });

    it('rejects files with .txt extension', async () => {
      const res = await handler({
        filePath: '/workspace/collection/request.txt',
        url: 'https://example.com',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/extension/i);
    });
  });

  // ── Collection root detection ──────────────────────────────────────────

  describe('collection root detection', () => {
    it('returns error when no collection root found', async () => {
      mockFindCollectionRoot.mockResolvedValue(null);
      const res = await handler({
        filePath: '/workspace/orphan/request.yml',
        url: 'https://example.com',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/collection/i);
    });
  });

  // ── Extension vs format mismatch ───────────────────────────────────────

  describe('extension-format mismatch', () => {
    it('modifies a .bru file in a YAML collection, warning that Bruno skips it', async () => {
      mockDetectFormat.mockResolvedValue({
        format: 'yaml',
        configPath: '/workspace/collection/opencollection.yml',
        collectionName: 'Test',
      });
      const res = await handler({
        filePath: '/workspace/collection/request.bru',
        url: 'https://example.com',
      });
      // Refusing here left the caller unable to repair the very file being
      // warned about — the run path reads it either way.
      expect(res.isError).toBeUndefined();
      expect(mockUpdateRequest).toHaveBeenCalled();
      expect(res.content[0].text).toContain('rename them to ".yml"');
    });

    it('modifies a .yml file in a BRU collection, warning that Bruno skips it', async () => {
      mockDetectFormat.mockResolvedValue({
        format: 'bru',
        configPath: '/workspace/collection/bruno.json',
        collectionName: 'Test',
      });
      const res = await handler({
        filePath: '/workspace/collection/request.yml',
        url: 'https://example.com',
      });
      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).toContain('rename them to ".bru"');
    });

    it('says nothing when the extension matches the collection', async () => {
      mockDetectFormat.mockResolvedValue({
        format: 'bru',
        configPath: '/workspace/collection/bruno.json',
        collectionName: 'Test',
      });
      const res = await handler({
        filePath: '/workspace/collection/request.bru',
        url: 'https://example.com',
      });
      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).not.toContain('rename');
    });
  });

  // ── updateRequest failure ──────────────────────────────────────────────

  describe('updateRequest failure', () => {
    it('returns error when updateRequest reports failure', async () => {
      mockUpdateRequest.mockResolvedValue({
        success: false,
        error: 'ENOENT: no such file or directory',
      });
      const res = await handler({
        filePath: '/workspace/collection/missing.yml',
        url: 'https://example.com',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/ENOENT|failed/i);
    });
  });

  // ── Thrown errors caught ───────────────────────────────────────────────

  describe('error handling', () => {
    it('catches thrown errors from updateRequest', async () => {
      mockUpdateRequest.mockRejectedValue(new Error('unexpected disk error'));
      const res = await handler({
        filePath: '/workspace/collection/get-users.yml',
        url: 'https://example.com',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/unexpected disk error/i);
    });

    it('catches non-Error thrown values', async () => {
      mockUpdateRequest.mockRejectedValue('string error');
      const res = await handler({
        filePath: '/workspace/collection/get-users.yml',
        url: 'https://example.com',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/unknown error/i);
    });

    it('catches errors from findCollectionRoot', async () => {
      mockFindCollectionRoot.mockRejectedValue(new Error('fs access denied'));
      const res = await handler({
        filePath: '/workspace/collection/get-users.yml',
        url: 'https://example.com',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/fs access denied/i);
    });

    it('catches errors from detectFormat', async () => {
      mockDetectFormat.mockRejectedValue(new Error('corrupt config'));
      const res = await handler({
        filePath: '/workspace/collection/get-users.yml',
        url: 'https://example.com',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/corrupt config/i);
    });
  });
});
