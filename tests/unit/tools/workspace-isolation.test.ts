/**
 * That a test run cannot register anything in the developer's own workspace.
 *
 * `create_collection` registers what it creates, and with no explicit path it
 * resolves the Bruno app's workspace for this platform — the real one, on a
 * machine with Bruno installed. That is how forty-five entries naming temp
 * directories, every one of them reporting `exists: false`, got into a
 * maintainer's registry.
 *
 * tests/setup-workspace-isolation.ts redirects the variable the resolver reads,
 * for every test file in both lanes, which makes the leak impossible rather than
 * unlikely. This proves the redirect holds at the seam that was leaking: a
 * default-path registration lands in the throwaway file and the app's own
 * workspace is byte-identical afterwards, including still being absent if it was
 * absent.
 */
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  const tools: Map<string, { config: unknown; handler: unknown }> = new Map();
  return {
    McpServer: jest.fn().mockImplementation(() => ({
      registerTool: jest.fn((name: string, config: unknown, handler: unknown) => {
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

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrunoMcpServer } from '../../../src/server';
import { createWorkspaceResolver } from '../../../src/bruno/workspace';

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

/** The file's bytes, or null when there is no file — both are states to preserve. */
async function snapshot(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

function same(before: Buffer | null, after: Buffer | null): boolean {
  if (before === null || after === null) return before === after;
  return before.equals(after);
}

describe('the workspace a test run resolves by default', () => {
  it('is not the one the Bruno app on this machine reads', () => {
    const resolver = createWorkspaceResolver();

    expect(resolver.resolveWorkspacePath()).not.toBe(resolver.getDefaultPath());
    expect(resolver.resolveWorkspacePath().startsWith(tmpdir())).toBe(true);
  });

  it("takes the registration, leaving the app's own workspace byte-identical", async () => {
    const resolver = createWorkspaceResolver();
    const ambient = resolver.getDefaultPath();
    const redirected = resolver.resolveWorkspacePath();
    const before = await snapshot(ambient);

    const server = new BrunoMcpServer();
    const dir = await mkdtemp(join(tmpdir(), 'workspace-isolation-'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (server as any).server._tools.get('create_collection').handler;
    const result = await handler({
      name: 'Isolated',
      outputPath: dir,
      format: 'yaml',
    }) as ToolResult;

    // Asserted, not assumed: if registration had been skipped — because the
    // redirect pointed at a file that was never written, say — the claim below
    // would hold for the wrong reason and this test would pass with the leak
    // still open.
    expect(result.content[0]!.text).toContain(`Registered in ${redirected}`);
    expect(await readFile(redirected, 'utf-8')).toContain(`path: "${join(dir, 'Isolated')}"`);

    expect(same(before, await snapshot(ambient))).toBe(true);
  });
});
