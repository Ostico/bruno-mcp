/**
 * The server starts when it is invoked the way people actually invoke it.
 *
 * `tests/integration/mcp-stdio.test.ts` spawns `dist/index.js` by its real
 * absolute path, which is the one case that always worked. The entry point's
 * "am I the main module?" check was `import.meta.url === \`file://${argv[1]}\``,
 * and that comparison is wrong in two ways that both end the same: the process
 * exits 0, prints nothing, answers no JSON-RPC, and looks to a client exactly
 * like a server that started and then ignored it.
 *
 *   - Through a symlink, `argv[1]` is the link and `import.meta.url` is the
 *     target. That is precisely what `npm install` creates in
 *     `node_modules/.bin`, so `npx @ostico/bruno-mcp` started nothing at all.
 *   - Through a path containing a space, a file URL percent-encodes and string
 *     concatenation does not. `~/Library/Application Support/...` has a space in
 *     it, and so does many a checkout directory.
 *
 * Both are driven here through the real transport, because the failure is only
 * visible from outside the process.
 */

import { existsSync, mkdtempSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = path.resolve(__dirname, '../..');
const serverEntry = path.join(repoRoot, 'dist', 'index.js');

let workDir: string;

beforeAll(() => {
  if (!existsSync(serverEntry)) {
    throw new Error(`dist/index.js is missing at ${serverEntry}; tests/global-setup.ts builds it`);
  }
  workDir = mkdtempSync(path.join(tmpdir(), 'bruno-mcp-bin-'));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Connect a real SDK client to the server at `entry` and return what it reports
 * about itself. A server that never started fails here on connect rather than
 * returning something wrong, which is the point.
 */
async function serverInfoVia(entry: string): Promise<{ name: string; version: string }> {
  const client = new Client({ name: 'bin-entrypoint-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
  await client.connect(transport);
  try {
    const info = client.getServerVersion();
    if (info === undefined) throw new Error('server reported no version');
    return { name: info.name, version: info.version };
  } finally {
    await client.close();
  }
}

describe('the entry point starts the server', () => {
  it('when spawned through a symlink, the way npm links a bin', async () => {
    // `node_modules/.bin/bruno-mcp -> ../@ostico/bruno-mcp/dist/index.js`, which
    // is what `npx` runs and what every MCP client config using the package name
    // ends up executing.
    const binDir = path.join(workDir, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    const link = path.join(binDir, 'bruno-mcp');
    symlinkSync(serverEntry, link);

    const info = await serverInfoVia(link);

    expect(info.name).toBe('bruno-mcp');
  }, 30000);

  it('when the path to it contains a space', async () => {
    const spaced = path.join(workDir, 'My Collections');
    mkdirSync(spaced, { recursive: true });
    const link = path.join(spaced, 'server.js');
    symlinkSync(serverEntry, link);

    const info = await serverInfoVia(link);

    expect(info.name).toBe('bruno-mcp');
  }, 30000);

  it('and still starts when spawned by its own real path', async () => {
    // The case that always worked, kept so a fix for the two above cannot break
    // the one everybody documents.
    const info = await serverInfoVia(serverEntry);

    expect(info.name).toBe('bruno-mcp');
  }, 30000);
});
