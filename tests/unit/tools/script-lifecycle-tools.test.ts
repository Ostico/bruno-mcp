/**
 * Tests for the remove_script and delete_request tool handlers.
 *
 * Together with add_test_script these close the script lifecycle: an agent
 * limited to MCP can now undo a script block or a whole request instead of
 * being stuck with whatever it wrote first.
 *
 * Mocks mirror add-test-script.test.ts: format-detector, format-factory,
 * node:fs/promises, unrelated Bruno modules, and the MCP SDK.
 */

import { BrunoMcpServer } from '../../../src/server';
import { withPathLock } from '../../../src/bruno/path-mutex';

// ── Module mocks ───────────────────────────────────────────────────────────────

const mockReadFile = jest.fn();
const mockWriteFile = jest.fn();
// Server.ts writes through writeFileAtomic now; route it to the same mock so
// these tests keep asserting on the content and path written.
jest.mock('../../../src/bruno/atomic-write', () => ({
  writeFileAtomic: (...args: unknown[]) => mockWriteFile(...args),
}));
const mockUnlink = jest.fn();
jest.mock('node:fs/promises', () => ({
  access: jest.fn(),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
}));

const mockFindCollectionRoot = jest.fn();
const mockDetectFormat = jest.fn();
jest.mock('../../../src/bruno/format-detector', () => ({
  findCollectionRoot: (...args: unknown[]) => mockFindCollectionRoot(...args),
  detectFormat: (...args: unknown[]) => mockDetectFormat(...args),
}));

const mockRemoveScript = jest.fn();
const mockCreateWriter = jest.fn(() => ({
  generateRequest: jest.fn(),
  generateEnvironment: jest.fn(),
  injectScript: jest.fn(),
  removeScript: mockRemoveScript,
  getRequestExtension: jest.fn(() => '.yml'),
}));
jest.mock('../../../src/bruno/format-factory', () => ({
  createWriter: (...args: unknown[]) => mockCreateWriter(...args),
  createReader: jest.fn(),
  mapScriptType: jest.fn(),
  // Real normalizer so alias handling is exercised end-to-end
  normalizeScriptType: jest.requireActual('../../../src/bruno/format-factory').normalizeScriptType,
}));

jest.mock('../../../src/bruno/request-executor');
jest.mock('../../../src/bruno/collection', () => ({
  createCollectionManager: jest.fn(() => ({
    createCollection: jest.fn(),
    getCollectionStats: jest.fn(),
  })),
}));
jest.mock('../../../src/bruno/environment', () => ({
  createEnvironmentManager: jest.fn(() => ({ createEnvironment: jest.fn() })),
}));
jest.mock('../../../src/bruno/request', () => ({
  createRequestBuilder: jest.fn(() => ({
    createRequest: jest.fn(),
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function getHandler(server: BrunoMcpServer, toolName: string): Function {
  const mcpServer = (server as any).server;
  const tool = mcpServer._tools.get(toolName);
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);
  return tool.handler;
}

const ORIGINAL = 'info:\n  name: Test\nruntime:\n  scripts:\n    - type: after-response\n      code: test("ok", function() {});\n';
const STRIPPED = 'info:\n  name: Test\n';

// ── remove_script ─────────────────────────────────────────────────────────────

describe('remove_script tool handler', () => {
  let handler: Function;

  beforeEach(() => {
    jest.clearAllMocks();
    handler = getHandler(new BrunoMcpServer(), 'remove_script');

    mockReadFile.mockResolvedValue(ORIGINAL);
    mockWriteFile.mockResolvedValue(undefined);
    mockFindCollectionRoot.mockResolvedValue('/workspace/collection');
    mockDetectFormat.mockResolvedValue({
      format: 'yaml',
      configPath: '/workspace/collection/opencollection.yml',
      collectionName: 'TestCollection',
    });
    mockRemoveScript.mockReturnValue(STRIPPED);
  });

  it('removes the script and writes the file back', async () => {
    const res = await handler({
      bruFilePath: '/workspace/collection/request.yml',
      scriptType: 'tests',
    });

    expect(res.isError).toBeUndefined();
    expect(mockRemoveScript).toHaveBeenCalledWith(ORIGINAL, 'tests');
    expect(mockWriteFile).toHaveBeenCalledWith('/workspace/collection/request.yml', STRIPPED);
    expect(res.content[0].text).toMatch(/Removed tests script from request\.yml/);
  });

  // A .yml request keeps its test script in a slot of its own, so removing one
  // script type says nothing about the others and the message must not claim it
  // cleared a shared block.
  it('does not claim a shared after-response slot on .yml collections', async () => {
    const res = await handler({
      bruFilePath: '/workspace/collection/request.yml',
      scriptType: 'tests',
    });
    expect(res.content[0].text).not.toMatch(/shared/i);
  });

  it('reports a pre-request removal without a shared-slot caveat', async () => {
    const res = await handler({
      bruFilePath: '/workspace/collection/request.yml',
      scriptType: 'pre-request',
    });
    expect(mockRemoveScript).toHaveBeenCalledWith(ORIGINAL, 'pre-request');
    expect(res.content[0].text).not.toMatch(/shared/i);
  });

  it('normalizes the after-response alias to post-response', async () => {
    const res = await handler({
      bruFilePath: '/workspace/collection/request.yml',
      scriptType: 'after-response',
    });
    expect(mockRemoveScript).toHaveBeenCalledWith(ORIGINAL, 'post-response');
    expect(res.content[0].text).toMatch(/Removed post-response script/);
  });

  it('does not add the shared-slot note for .bru collections', async () => {
    mockDetectFormat.mockResolvedValue({
      format: 'bru',
      configPath: '/workspace/collection/bruno.json',
      collectionName: 'TestCollection',
    });
    const res = await handler({
      bruFilePath: '/workspace/collection/request.bru',
      scriptType: 'tests',
    });
    expect(res.content[0].text).toMatch(/\(bru format\)/);
    expect(res.content[0].text).not.toMatch(/shared after-response block/);
  });

  it('reports a no-op without writing when nothing changed', async () => {
    mockRemoveScript.mockReturnValue(ORIGINAL);
    const res = await handler({
      bruFilePath: '/workspace/collection/request.yml',
      scriptType: 'tests',
    });
    expect(res.isError).toBeUndefined();
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(res.content[0].text).toMatch(/nothing to remove/);
  });

  it('rejects a traversal path', async () => {
    const res = await handler({
      bruFilePath: '/workspace/../etc/passwd',
      scriptType: 'tests',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Invalid bruFilePath/);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('rejects an unsupported extension', async () => {
    const res = await handler({
      bruFilePath: '/workspace/collection/request.txt',
      scriptType: 'tests',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Invalid file extension/);
  });

  it('rejects a file outside any collection', async () => {
    mockFindCollectionRoot.mockResolvedValue(null);
    const res = await handler({
      bruFilePath: '/workspace/collection/request.yml',
      scriptType: 'tests',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Could not determine collection format/);
  });

  it('warns, rather than refusing, when the extension contradicts the collection', async () => {
    mockDetectFormat.mockResolvedValue({
      format: 'bru',
      configPath: '/workspace/collection/bruno.json',
      collectionName: 'TestCollection',
    });
    const res = await handler({
      bruFilePath: '/workspace/collection/request.yml',
      scriptType: 'tests',
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toMatch(/rename them to "\.bru"/);
  });

  it('surfaces a read failure as an error', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));
    const res = await handler({
      bruFilePath: '/workspace/collection/request.yml',
      scriptType: 'tests',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Error removing script: ENOENT/);
  });

  it('reports a non-Error throw as unknown', async () => {
    mockReadFile.mockRejectedValue('boom');
    const res = await handler({
      bruFilePath: '/workspace/collection/request.yml',
      scriptType: 'tests',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Unknown error/);
  });
});

// ── delete_request ────────────────────────────────────────────────────────────

describe('delete_request tool handler', () => {
  let handler: Function;

  beforeEach(() => {
    jest.clearAllMocks();
    handler = getHandler(new BrunoMcpServer(), 'delete_request');

    mockUnlink.mockResolvedValue(undefined);
    mockFindCollectionRoot.mockResolvedValue('/workspace/collection');
    mockDetectFormat.mockResolvedValue({
      format: 'yaml',
      configPath: '/workspace/collection/opencollection.yml',
      collectionName: 'TestCollection',
    });
  });

  it('deletes the request file', async () => {
    const res = await handler({
      filePath: '/workspace/collection/request.yml',
      confirm: true,
    });
    expect(res.isError).toBeUndefined();
    expect(mockUnlink).toHaveBeenCalledWith('/workspace/collection/request.yml');
    expect(res.content[0].text).toMatch(/Deleted request request\.yml \(yaml format\)/);
  });

  it('waits for the per-file lock before unlinking', async () => {
    // add_test_script and remove_script hold this lock while they read, inject and
    // write back. Unlocked, a deletion could unlink between their read and their
    // write, and the write would then restore a file this tool had just reported
    // as permanently deleted.
    let releaseGate!: () => void;
    const gate = new Promise<void>((res) => {
      releaseGate = res;
    });
    const held = withPathLock('/workspace/collection/request.yml', () => gate);

    const deleting = handler({
      filePath: '/workspace/collection/request.yml',
      confirm: true,
    });

    // Everything the handler awaits before the unlink is a resolved mock, so an
    // unserialised delete would already have unlinked by now.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(mockUnlink).not.toHaveBeenCalled();

    releaseGate();
    await held;
    const res = await deleting;
    expect(res.isError).toBeUndefined();
    expect(mockUnlink).toHaveBeenCalledWith('/workspace/collection/request.yml');
  });

  it('refuses to delete without confirm', async () => {
    const res = await handler({ filePath: '/workspace/collection/request.yml' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/confirm must be true/);
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it('refuses when confirm is false', async () => {
    const res = await handler({
      filePath: '/workspace/collection/request.yml',
      confirm: false,
    });
    expect(res.isError).toBe(true);
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it('rejects a traversal path before touching the filesystem', async () => {
    const res = await handler({ filePath: '/workspace/../etc/passwd', confirm: true });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Invalid filePath/);
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it('rejects an unsupported extension', async () => {
    const res = await handler({ filePath: '/workspace/collection/notes.txt', confirm: true });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Invalid file extension/);
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it('rejects a file outside any collection', async () => {
    mockFindCollectionRoot.mockResolvedValue(null);
    const res = await handler({ filePath: '/workspace/collection/request.yml', confirm: true });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Could not determine collection format/);
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it('surfaces an unlink failure as an error', async () => {
    mockUnlink.mockRejectedValue(new Error('EACCES: permission denied'));
    const res = await handler({ filePath: '/workspace/collection/request.yml', confirm: true });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Error deleting request: EACCES/);
  });

  it('reports a non-Error throw as unknown', async () => {
    mockUnlink.mockRejectedValue('boom');
    const res = await handler({ filePath: '/workspace/collection/request.yml', confirm: true });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Unknown error/);
  });
});
