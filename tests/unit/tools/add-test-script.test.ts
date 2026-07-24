/**
 * Tests for the add_test_script tool handler (Task 5).
 *
 * Mocks:
 *  - format-detector  (findCollectionRoot, detectFormat)
 *  - format-factory   (createWriter)
 *  - node:fs/promises (access, readFile, writeFile)
 *  - All other Bruno modules (not under test)
 *  - MCP SDK (capture registered handlers)
 */

import { BrunoMcpServer } from '../../../src/server';

// ── Module mocks ────────────────────────────────────────────────────────────

// fs/promises — we need access, readFile, writeFile
const mockAccess = jest.fn();
const mockReadFile = jest.fn();
const mockWriteFile = jest.fn();
jest.mock('node:fs/promises', () => ({
  access: (...args: unknown[]) => mockAccess(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
}));

// format-detector
const mockFindCollectionRoot = jest.fn();
const mockDetectFormat = jest.fn();
jest.mock('../../../src/bruno/format-detector', () => ({
  findCollectionRoot: (...args: unknown[]) => mockFindCollectionRoot(...args),
  detectFormat: (...args: unknown[]) => mockDetectFormat(...args),
}));

// format-factory
const mockInjectScript = jest.fn();
const mockCreateWriter = jest.fn(() => ({
  generateRequest: jest.fn(),
  generateEnvironment: jest.fn(),
  injectScript: mockInjectScript,
  getRequestExtension: jest.fn(() => '.yml'),
}));
jest.mock('../../../src/bruno/format-factory', () => ({
  createWriter: (...args: unknown[]) => mockCreateWriter(...args),
  createReader: jest.fn(),
  mapScriptType: jest.fn(),
  // Use the real normalizer so alias handling is exercised end-to-end.
  normalizeScriptType: jest.requireActual('../../../src/bruno/format-factory').normalizeScriptType,
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

describe('add_test_script tool handler', () => {
  let server: BrunoMcpServer;
  let handler: Function;

  beforeEach(() => {
    jest.clearAllMocks();
    server = new BrunoMcpServer();
    handler = getHandler(server, 'add_test_script');

    // Default happy-path mocks
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue('info:\n  name: Test\nhttp:\n  method: GET\n  url: https://example.com\n');
    mockWriteFile.mockResolvedValue(undefined);
    mockFindCollectionRoot.mockResolvedValue('/workspace/collection');
    mockDetectFormat.mockResolvedValue({
      format: 'yaml',
      configPath: '/workspace/collection/opencollection.yml',
      collectionName: 'TestCollection',
    });
    mockInjectScript.mockReturnValue('info:\n  name: Test\nhttp:\n  method: GET\n  url: https://example.com\nruntime:\n  scripts:\n    - type: after-response\n      code: |\n        test("ok", () => {});\n');
  });

  // ── Security: path traversal (existing validateToolPath) ────────────────

  describe('path traversal protection (validateToolPath)', () => {
    it('rejects bruFilePath with .. segments', async () => {
      const res = await handler({
        bruFilePath: '/workspace/../etc/passwd',
        scriptType: 'tests',
        script: 'test("ok", () => {});',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/bruFilePath/i);
    });

    it('rejects bruFilePath with null bytes', async () => {
      const res = await handler({
        bruFilePath: '/workspace/request\0.yml',
        scriptType: 'tests',
        script: 'test("ok", () => {});',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/bruFilePath/i);
    });
  });

  // ── Security: script content validation ─────────────────────────────────

  describe('script content validation', () => {
    it('rejects scripts exceeding 50KB', async () => {
      const bigScript = 'x'.repeat(50_001);
      const res = await handler({
        bruFilePath: '/workspace/collection/request.yml',
        scriptType: 'tests',
        script: bigScript,
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/size|limit|50/i);
    });

    it('accepts scripts exactly 50KB', async () => {
      const exactScript = 'x'.repeat(50_000);
      const res = await handler({
        bruFilePath: '/workspace/collection/request.yml',
        scriptType: 'tests',
        script: exactScript,
      });
      // Should not fail on size — may fail for other reasons depending on mock setup,
      // but specifically the size check should pass
      if (res.isError) {
        expect(res.content[0].text).not.toMatch(/size|limit|50/i);
      }
    });

    it('rejects scripts containing null bytes', async () => {
      const res = await handler({
        bruFilePath: '/workspace/collection/request.yml',
        scriptType: 'tests',
        script: 'test("ok", () => {});\x00malicious',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/null/i);
    });
  });

  // ── File existence check ────────────────────────────────────────────────

  describe('file existence', () => {
    it('returns error when file does not exist', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT: no such file or directory'));
      const res = await handler({
        bruFilePath: '/workspace/collection/nonexistent.yml',
        scriptType: 'tests',
        script: 'test("ok", () => {});',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/ENOENT|error/i);
    });
  });

  // ── File extension validation ───────────────────────────────────────────

  describe('file extension validation', () => {
    it('rejects files with .json extension', async () => {
      const res = await handler({
        bruFilePath: '/workspace/collection/request.json',
        scriptType: 'tests',
        script: 'test("ok", () => {});',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/extension|\.bru|\.yml/i);
    });

    it('rejects files with .txt extension', async () => {
      const res = await handler({
        bruFilePath: '/workspace/collection/request.txt',
        scriptType: 'tests',
        script: 'test("ok", () => {});',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/extension|\.bru|\.yml/i);
    });

    it('accepts .yml files', async () => {
      const res = await handler({
        bruFilePath: '/workspace/collection/request.yml',
        scriptType: 'tests',
        script: 'test("ok", () => {});',
      });
      expect(res.isError).toBeUndefined();
    });

    it('accepts .bru files in BRU collections', async () => {
      mockFindCollectionRoot.mockResolvedValue('/workspace/collection');
      mockDetectFormat.mockResolvedValue({
        format: 'bru',
        configPath: '/workspace/collection/bruno.json',
        collectionName: 'TestCollection',
      });
      mockCreateWriter.mockReturnValue({
        generateRequest: jest.fn(),
        generateEnvironment: jest.fn(),
        injectScript: mockInjectScript,
        getRequestExtension: jest.fn(() => '.bru'),
      });

      const res = await handler({
        bruFilePath: '/workspace/collection/request.bru',
        scriptType: 'pre-request',
        script: 'console.log("before");',
      });
      expect(res.isError).toBeUndefined();
    });
  });

  // ── Collection root detection ───────────────────────────────────────────

  describe('collection root detection', () => {
    it('returns error when no collection root found', async () => {
      mockFindCollectionRoot.mockResolvedValue(null);
      const res = await handler({
        bruFilePath: '/workspace/orphan/request.yml',
        scriptType: 'tests',
        script: 'test("ok", () => {});',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/collection/i);
    });
  });

  // ── Extension vs format mismatch ────────────────────────────────────────

  describe('extension-format mismatch', () => {
    it('rejects .bru file in YAML collection', async () => {
      mockDetectFormat.mockResolvedValue({
        format: 'yaml',
        configPath: '/workspace/collection/opencollection.yml',
        collectionName: 'Test',
      });
      const res = await handler({
        bruFilePath: '/workspace/collection/request.bru',
        scriptType: 'tests',
        script: 'test("ok", () => {});',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/extension.*format|format.*extension|mismatch/i);
    });

    it('rejects .yml file in BRU collection', async () => {
      mockDetectFormat.mockResolvedValue({
        format: 'bru',
        configPath: '/workspace/collection/bruno.json',
        collectionName: 'Test',
      });
      const res = await handler({
        bruFilePath: '/workspace/collection/request.yml',
        scriptType: 'tests',
        script: 'test("ok", () => {});',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/extension.*format|format.*extension|mismatch/i);
    });
  });

  // ── Happy path: YAML injection ──────────────────────────────────────────

  describe('YAML injection (happy path)', () => {
    it('injects post-response script into .yml file', async () => {
      const res = await handler({
        bruFilePath: '/workspace/collection/request.yml',
        scriptType: 'post-response',
        script: 'test("status 200", () => expect(res.status).to.equal(200));',
      });

      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).toMatch(/success/i);

      // Verify the pipeline was called correctly
      expect(mockFindCollectionRoot).toHaveBeenCalledWith('/workspace/collection/request.yml');
      expect(mockDetectFormat).toHaveBeenCalledWith('/workspace/collection');
      expect(mockCreateWriter).toHaveBeenCalledWith('yaml');
      expect(mockInjectScript).toHaveBeenCalledWith(
        expect.any(String),
        'post-response',
        'test("status 200", () => expect(res.status).to.equal(200));',
        'append',
      );
      expect(mockReadFile).toHaveBeenCalledWith('/workspace/collection/request.yml', 'utf-8');
      expect(mockWriteFile).toHaveBeenCalledWith(
        '/workspace/collection/request.yml',
        expect.any(String),
      );
    });

    it('injects pre-request script into .yml file', async () => {
      const res = await handler({
        bruFilePath: '/workspace/collection/request.yml',
        scriptType: 'pre-request',
        script: 'console.log("before");',
      });

      expect(res.isError).toBeUndefined();
      expect(mockInjectScript).toHaveBeenCalledWith(
        expect.any(String),
        'pre-request',
        'console.log("before");',
        'append',
      );
    });

    it('injects tests script into .yml file', async () => {
      const res = await handler({
        bruFilePath: '/workspace/collection/request.yml',
        scriptType: 'tests',
        script: 'test("ok", () => {});',
      });

      expect(res.isError).toBeUndefined();
      expect(mockInjectScript).toHaveBeenCalledWith(
        expect.any(String),
        'tests',
        'test("ok", () => {});',
        'append',
      );
    });
  });

  // ── Happy path: BRU injection ───────────────────────────────────────────

  describe('BRU injection (happy path)', () => {
    beforeEach(() => {
      mockFindCollectionRoot.mockResolvedValue('/workspace/collection');
      mockDetectFormat.mockResolvedValue({
        format: 'bru',
        configPath: '/workspace/collection/bruno.json',
        collectionName: 'TestCollection',
      });
      mockReadFile.mockResolvedValue('meta {\n  name: Test\n  type: http\n}\n\nget {\n  url: https://example.com\n}\n');
      mockInjectScript.mockReturnValue('meta {\n  name: Test\n  type: http\n}\n\nget {\n  url: https://example.com\n}\n\nscript:post-response {\n  test("ok", () => {});\n}\n');
      mockCreateWriter.mockReturnValue({
        generateRequest: jest.fn(),
        generateEnvironment: jest.fn(),
        injectScript: mockInjectScript,
        getRequestExtension: jest.fn(() => '.bru'),
      });
    });

    it('injects post-response script into .bru file', async () => {
      const res = await handler({
        bruFilePath: '/workspace/collection/request.bru',
        scriptType: 'post-response',
        script: 'test("ok", () => {});',
      });

      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).toMatch(/success/i);
      expect(mockCreateWriter).toHaveBeenCalledWith('bru');
      expect(mockInjectScript).toHaveBeenCalledWith(
        expect.any(String),
        'post-response',
        'test("ok", () => {});',
        'append',
      );
      expect(mockWriteFile).toHaveBeenCalled();
    });

    it('injects pre-request script into .bru file', async () => {
      const res = await handler({
        bruFilePath: '/workspace/collection/request.bru',
        scriptType: 'pre-request',
        script: 'console.log("before");',
      });

      expect(res.isError).toBeUndefined();
      expect(mockInjectScript).toHaveBeenCalledWith(
        expect.any(String),
        'pre-request',
        'console.log("before");',
        'append',
      );
    });
  });

  // ── Script-type alias normalization ─────────────────────────────────────

  describe('script type alias normalization', () => {
    it('accepts the after-response alias and injects it as post-response', async () => {
      const res = await handler({
        bruFilePath: '/workspace/collection/request.yml',
        scriptType: 'after-response',
        script: 'test("ok", () => {});',
      });

      expect(res.isError).toBeUndefined();
      // Alias is normalized to the canonical generic type before injection.
      expect(mockInjectScript).toHaveBeenCalledWith(
        expect.any(String),
        'post-response',
        'test("ok", () => {});',
        'append',
      );
      // Success message reports the canonical type, not the alias.
      expect(res.content[0].text).toMatch(/post-response/);
      expect(res.content[0].text).not.toMatch(/after-response/);
    });

    it('accepts the before-request alias and injects it as pre-request', async () => {
      const res = await handler({
        bruFilePath: '/workspace/collection/request.yml',
        scriptType: 'before-request',
        script: 'console.log("before");',
      });

      expect(res.isError).toBeUndefined();
      expect(mockInjectScript).toHaveBeenCalledWith(
        expect.any(String),
        'pre-request',
        'console.log("before");',
        'append',
      );
    });
  });

  // ── Error propagation ───────────────────────────────────────────────────

  describe('error handling', () => {
    it('catches and returns errors from injectScript', async () => {
      mockInjectScript.mockImplementation(() => {
        throw new Error('injection failed');
      });
      const res = await handler({
        bruFilePath: '/workspace/collection/request.yml',
        scriptType: 'tests',
        script: 'test("ok", () => {});',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/injection failed/i);
    });

    it('catches and returns errors from writeFile', async () => {
      mockWriteFile.mockRejectedValue(new Error('EACCES: permission denied'));
      const res = await handler({
        bruFilePath: '/workspace/collection/request.yml',
        scriptType: 'tests',
        script: 'test("ok", () => {});',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/EACCES|permission/i);
    });

    it('catches and returns errors from readFile', async () => {
      mockReadFile.mockRejectedValue(new Error('EACCES: permission denied'));
      const res = await handler({
        bruFilePath: '/workspace/collection/request.yml',
        scriptType: 'tests',
        script: 'test("ok", () => {});',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/EACCES|permission/i);
    });
  });

  // ── Success message content ─────────────────────────────────────────────

  describe('success message', () => {
    it('includes format in success message', async () => {
      const res = await handler({
        bruFilePath: '/workspace/collection/request.yml',
        scriptType: 'post-response',
        script: 'test("ok", () => {});',
      });
      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).toMatch(/yaml|yml/i);
    });

    it('includes script type in success message', async () => {
      const res = await handler({
        bruFilePath: '/workspace/collection/request.yml',
        scriptType: 'post-response',
        script: 'test("ok", () => {});',
      });
      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).toMatch(/post-response/i);
    });
  });
});
