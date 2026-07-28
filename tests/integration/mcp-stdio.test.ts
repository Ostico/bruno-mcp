/**
 * End-to-end proof of the MCP protocol surface: the built server is spawned as
 * a real child process and driven by the official SDK client over stdio.
 *
 * Every other test in this repo calls a tool handler as a plain function. That
 * leaves the whole protocol layer unproven: a tool that is never registered, an
 * input schema the SDK cannot serialise, a transport that dies on start, or a
 * stray `console.log` writing into the stdout channel that carries JSON-RPC
 * would all ship with a fully green suite. This file is the only place where a
 * failure of the actual wire protocol is visible.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const repoRoot = path.resolve(__dirname, '../..');

// Spawned straight out of dist/, which tests/global-setup.ts builds once before
// any worker starts. This file used to build in its own `beforeAll` and then
// snapshot dist/ into a private directory, with a retry loop, because the
// sibling sandbox-fork suite rebuilt concurrently and `npm run build` is
// --clean: its `rm -rf dist` could land between this file's build and its
// spawns (finding Q18). With a single hoisted build nothing deletes dist/ while
// a suite is running, so the copy and the retries are gone.
const serverEntry = path.join(repoRoot, 'dist', 'index.js');

/**
 * Every tool the server is expected to register, by wire name.
 *
 * Spelled out rather than derived so a rename or a dropped
 * `setup*Tool()` call fails here instead of silently shrinking the API that
 * clients see. Handler-level unit tests cannot notice either.
 */
const EXPECTED_TOOLS = [
  'create_collection',
  'create_environment',
  'update_environment',
  'set_environment_variable',
  'remove_environment_variable',
  'create_request',
  'modify_request',
  'add_test_script',
  'remove_script',
  'delete_request',
  'create_test_suite',
  'create_crud_requests',
  'list_collections',
  'list_requests',
  'get_collection_stats',
  'run_collection',
];

interface Session {
  client: Client;
  transport: StdioClientTransport;
  /** Everything the child has written to stderr so far. */
  stderr: () => string;
  /** Protocol-level errors surfaced by the transport (must stay empty). */
  protocolErrors: Error[];
}

const sessions: Session[] = [];
let tmpRoot: string;

/**
 * Child environment: the parent's, minus any BRUNO_* the developer running the
 * suite happens to have exported, plus the caller's explicit overrides. Without
 * the filter a local BRUNO_SSRF_ALLOWLIST would change what these tests prove.
 */
function childEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith('BRUNO_')) continue;
    base[key] = value;
  }
  return { ...base, ...overrides };
}

async function startServer(env: Record<string, string> = {}): Promise<Session> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: repoRoot,
    env: childEnv(env),
    // Required: without a pipe the child's diagnostics go to the test runner's
    // own stderr and the stdout-integrity assertions below have nothing to read.
    stderr: 'pipe',
  });

  let stderrText = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderrText += chunk.toString('utf8');
  });

  const client = new Client({ name: 'mcp-stdio-harness', version: '1.0.0' });
  const protocolErrors: Error[] = [];
  // Anything unparseable on stdout arrives here rather than as a rejected
  // request, so a corrupted stream would otherwise be invisible.
  client.onerror = (error) => {
    protocolErrors.push(error);
  };

  const session: Session = { client, transport, stderr: () => stderrText, protocolErrors };
  // Registered before connect: a handshake that fails partway still leaves a
  // live child that teardown has to reap.
  sessions.push(session);

  await client.connect(transport);
  return session;
}

/** Tear every child down, including after a failure, so the suite cannot hang. */
async function stopAllServers(): Promise<void> {
  for (const session of sessions.splice(0)) {
    const { pid } = session.transport;
    try {
      await session.client.close();
    } catch {
      /* already gone */
    }
    try {
      await session.transport.close();
    } catch {
      /* already gone */
    }
    if (typeof pid === 'number') {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already exited */
      }
    }
  }
}

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function textOf(result: unknown): string {
  const content = (result as ToolResult).content ?? [];
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
}

async function waitForStderr(session: Session, needle: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (session.stderr().includes(needle)) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `child stderr never contained ${JSON.stringify(needle)}. Captured:\n${session.stderr()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'bruno-mcp-stdio-'));
});

afterAll(async () => {
  await stopAllServers();
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
}, 30_000);

describe('MCP stdio transport (real child process)', () => {
  it('completes the initialize handshake and reports its identity', async () => {
    const { client } = await startServer();

    // connect() resolves only after initialize/initialized has round-tripped,
    // so reaching here at all proves the handshake completed.
    expect(client.getServerVersion()).toMatchObject({ name: 'bruno-mcp' });
    expect(client.getServerCapabilities()).toHaveProperty('tools');
    // Instructions are declared at construction and only ever reach a client
    // through the initialize result.
    expect(client.getInstructions()).toContain('list_collections');
  }, 60_000);

  it('advertises every tool over tools/list with a usable input schema', async () => {
    const { client } = await startServer();

    const { tools } = await client.listTools();

    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOLS].sort());

    for (const tool of tools) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
      // A schema the SDK cannot render is the failure mode this catches: the
      // tool is listed but no client can construct a valid call for it.
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.inputSchema.properties).toBe('object');
    }
  }, 60_000);

  it('round-trips create_collection and list_collections against a real directory', async () => {
    const { client } = await startServer();
    const workDir = path.join(tmpRoot, 'roundtrip');
    const collectionPath = path.join(workDir, 'harness-collection');

    const created = await client.callTool({
      name: 'create_collection',
      arguments: { name: 'harness-collection', outputPath: workDir, format: 'yaml' },
    });

    expect(created.isError).toBeFalsy();
    expect(textOf(created)).toContain(collectionPath);
    // The tool reported success; the filesystem has to agree.
    expect(existsSync(collectionPath)).toBe(true);

    // list_collections reads a workspace registry, not the filesystem, so give
    // it one that points at what was just created.
    const workspacePath = path.join(workDir, 'workspace.yml');
    writeFileSync(
      workspacePath,
      `collections:\n  - name: harness-collection\n    path: ${collectionPath}\n`,
      'utf8',
    );

    const listed = await client.callTool({
      name: 'list_collections',
      arguments: { workspacePath },
    });

    expect(listed.isError).toBeFalsy();
    const payload = JSON.parse(textOf(listed)) as {
      collections: Array<{ name: string; path: string; exists: boolean }>;
    };
    expect(payload.collections).toEqual([
      { name: 'harness-collection', path: collectionPath, exists: true },
    ]);
  }, 60_000);

  it('round-trips create_request and list_requests through the protocol', async () => {
    const { client } = await startServer();
    const workDir = path.join(tmpRoot, 'requests');
    const collectionPath = path.join(workDir, 'req-collection');

    const created = await client.callTool({
      name: 'create_collection',
      arguments: { name: 'req-collection', outputPath: workDir, format: 'yaml' },
    });
    expect(created.isError).toBeFalsy();

    const request = await client.callTool({
      name: 'create_request',
      arguments: {
        collectionPath,
        name: 'ping',
        method: 'GET',
        url: 'https://example.test/ping',
      },
    });
    expect(request.isError).toBeFalsy();

    const listed = await client.callTool({
      name: 'list_requests',
      arguments: { collectionPath },
    });

    expect(listed.isError).toBeFalsy();
    const payload = JSON.parse(textOf(listed)) as { requests: unknown[] };
    expect(JSON.stringify(payload.requests)).toContain('ping');
  }, 60_000);

  it('answers invalid tool calls with a protocol error and stays alive', async () => {
    const session = await startServer();
    const { client } = session;

    const before = await client.listTools();

    // Wrong argument type plus a missing required argument. The SDK validates
    // against the registered zod schema before the handler ever runs.
    const wrongTypes = await client.callTool({
      name: 'create_collection',
      arguments: { name: 42 },
    });
    expect(wrongTypes.isError).toBe(true);
    expect(textOf(wrongTypes)).toContain('-32602');
    expect(textOf(wrongTypes)).toMatch(/validation error/i);

    // A tool nobody registered.
    const unknownTool = await client.callTool({
      name: 'definitely_not_a_tool',
      arguments: {},
    });
    expect(unknownTool.isError).toBe(true);
    expect(textOf(unknownTool)).toContain('not found');

    // A JSON-RPC method nobody implements must come back as a real -32601
    // rejection, not a hang and not a dead child.
    await expect(
      client.request({ method: 'definitely/not/a/method', params: {} }, z.unknown()),
    ).rejects.toMatchObject({ code: -32601 });
    await expect(
      client.request({ method: 'definitely/not/a/method', params: {} }, z.unknown()),
    ).rejects.toBeInstanceOf(McpError);

    // The point of the test: three bad calls later, the server is still serving.
    const after = await client.listTools();
    expect(after.tools.map((tool) => tool.name)).toEqual(before.tools.map((tool) => tool.name));
    expect(session.protocolErrors).toEqual([]);
  }, 60_000);

  it('keeps the JSON-RPC stream intact while emitting diagnostics and warnings', async () => {
    // stdout carries the protocol. Anything the server prints has to go to
    // stderr or the next message the client reads is garbage. Two writers are
    // exercised here: the unconditional startup banner, and the SSRF allowlist
    // parser, which is made to complain by handing it a wildcard entry it must
    // reject. Both are asserted to have actually fired, so the test cannot pass
    // vacuously by simply never producing output.
    const session = await startServer({
      BRUNO_SSRF_ALLOWLIST: '*.internal.example, 10.20.30.40',
    });
    const { client } = session;

    // Written by start() immediately after the transport is connected, i.e.
    // while the protocol stream is already live.
    await waitForStderr(session, 'Bruno MCP Server started successfully!');

    const workDir = path.join(tmpRoot, 'stdout-integrity');
    const collectionPath = path.join(workDir, 'noisy-collection');

    expect(
      (
        await client.callTool({
          name: 'create_collection',
          arguments: { name: 'noisy-collection', outputPath: workDir, format: 'yaml' },
        })
      ).isError,
    ).toBeFalsy();

    // A loopback literal: refused by the SSRF check without any DNS or network
    // traffic, and the refusal is what drives the allowlist parse.
    expect(
      (
        await client.callTool({
          name: 'create_request',
          arguments: {
            collectionPath,
            name: 'blocked',
            method: 'GET',
            url: 'http://127.0.0.1:9/',
          },
        })
      ).isError,
    ).toBeFalsy();

    const run = await client.callTool({
      name: 'run_collection',
      arguments: { collectionPath },
    });

    expect(run.isError).toBeFalsy();
    const report = JSON.parse(textOf(run)) as {
      summary: { total: number; failed: number };
      results: Array<{ error?: string }>;
    };
    expect(report.summary.total).toBe(1);
    expect(report.results[0].error).toContain('SSRF blocked');

    // The warning fired...
    await waitForStderr(session, '[bruno-mcp SSRF allowlist]');
    expect(session.stderr()).toContain('*.internal.example');
    // ...and it went to stderr, so the protocol stream is still clean and the
    // next call still round-trips.
    const afterWarning = await client.listTools();
    expect(afterWarning.tools).toHaveLength(EXPECTED_TOOLS.length);
    expect(session.protocolErrors).toEqual([]);
  }, 90_000);
});
