/**
 * The two transport packages must not load until a request needs them.
 *
 * This is the gate the whole dependency decision rests on. `@grpc/grpc-js` and `ws`
 * were added for two request kinds that most collections do not contain, and the
 * argument for adding them at all was that an HTTP-only run pays nothing. That
 * argument is only worth as much as the check behind it.
 *
 * The check is a resolve hook registered into the real server child (see
 * tests/helpers/resolve-recorder.mjs for why neither `process.moduleLoadList` nor
 * `require.cache` can answer this question here). Three runs, three logs:
 *
 *   - an HTTP-only run must name neither package;
 *   - a gRPC run must name `@grpc/grpc-js`;
 *   - a WebSocket run must name `ws`.
 *
 * The last two are the positive control, and they are not decoration. A recorder
 * that silently wrote nothing — wrong path, hook never registered, log truncated —
 * would satisfy the negative assertion perfectly. Each run additionally asserts its
 * own log is alive by finding a package the server cannot start without.
 *
 * Boot timing is deliberately NOT asserted. Measured on this machine, server boot
 * varies between roughly 170 and 280 ms run to run, and the import this gate is
 * about costs on the order of 18 ms: a threshold there would be a noise floor six
 * times the size of the signal, and would fail for reasons having nothing to do
 * with laziness. The module-load fact is asserted instead, because it is exact.
 */

import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = path.resolve(__dirname, '../..');
const serverEntry = path.join(repoRoot, 'dist', 'index.js');
const recorder = path.join(repoRoot, 'tests', 'helpers', 'resolve-recorder.mjs');

/**
 * A port nothing is listening on: the transport must still be loaded to find out
 * that nobody answers. Claimed from the OS and released rather than hardcoded — a
 * fixed number is a number some other process on a CI runner may already hold, and
 * a gRPC dial that unexpectedly succeeds would fail these assertions for a reason
 * that has nothing to do with module loading.
 */
let deadPort: number;

const PROTO = `syntax = "proto3";
package echo;

service Echo {
  rpc Say (SayRequest) returns (SayReply);
}

message SayRequest {
  string text = 1;
}

message SayReply {
  string text = 1;
}
`;

const httpRequest = (port: number) => `meta {
  name: Plain
  type: http
  seq: 1
}

get {
  url: http://127.0.0.1:${port}/ping
}
`;

const grpcRequest = () => `meta {
  name: Streamer
  type: grpc
  seq: 1
}

grpc {
  url: grpc://127.0.0.1:${deadPort}
  method: /echo.Echo/Say
  body: grpc
  protoPath: ./echo.proto
  methodType: unary
}

body:grpc {
  name: m1
  content: {"text":"hi"}
}
`;

const wsRequest = () => `meta {
  name: Socket
  type: ws
  seq: 1
}

ws {
  url: ws://127.0.0.1:${deadPort}
  body: ws
}

body:ws {
  name: first
  type: text
  selected: true
  content: {"hello":1}
}
`;

interface Recorded {
  /** Every bare specifier the child's loader resolved, in order. */
  specifiers: string[];
  /** What the run itself reported, so a run that never happened is visible. */
  output: string;
}

let tmpRoot: string;
let httpServer: Server;
let httpPort: number;
const children: Array<{ client: Client; transport: StdioClientTransport }> = [];

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'bruno-lazy-'));
  httpServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  httpPort = (httpServer.address() as AddressInfo).port;

  const claimed = createServer();
  await new Promise<void>((resolve) => claimed.listen(0, '127.0.0.1', resolve));
  deadPort = (claimed.address() as AddressInfo).port;
  await new Promise<void>((resolve) => claimed.close(() => resolve()));
});

afterAll(async () => {
  for (const child of children.splice(0)) {
    const { pid } = child.transport;
    try {
      await child.client.close();
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
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
}, 30_000);

/**
 * The child's environment: the parent's, minus any BRUNO_* the developer running
 * the suite happens to have exported, plus an allowlist that lets 127.0.0.1 through.
 * Without the allowlist every request would be refused by SSRF validation before its
 * transport was ever reached, and the positive control would fail for the wrong
 * reason.
 */
function childEnv(): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith('BRUNO_')) continue;
    base[key] = value;
  }
  return { ...base, BRUNO_SSRF_ALLOWLIST: '127.0.0.1' };
}

/**
 * Write a collection, then run it in a fresh child whose loader is recording, and
 * hand back everything that child resolved.
 */
async function runRecorded(label: string, files: Record<string, string>): Promise<Recorded> {
  const collection = await mkdtemp(path.join(tmpRoot, `${label}-`));
  await writeFile(
    path.join(collection, 'bruno.json'),
    JSON.stringify({ version: '1', name: label, type: 'collection' }),
  );
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(collection, name), content);
  }

  const logPath = path.join(collection, 'resolved.log');
  // A bootstrap module rather than a `data:` URL: `--import` accepts either, and a
  // real file keeps the registration readable in a stack trace if it ever throws.
  const bootstrap = path.join(collection, 'register-recorder.mjs');
  await writeFile(
    bootstrap,
    `import { register } from 'node:module';\n`
      + `register(${JSON.stringify(pathToFileURL(recorder).href)}, `
      + `{ data: { logPath: ${JSON.stringify(logPath)} } });\n`,
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', pathToFileURL(bootstrap).href, serverEntry],
    cwd: repoRoot,
    env: childEnv(),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'lazy-transport-gate', version: '1.0.0' });
  children.push({ client, transport });
  await client.connect(transport);

  const result = await client.callTool({
    name: 'run_collection',
    arguments: { collectionPath: collection },
  });
  // Closed before the log is read: the loader thread appends synchronously, but a
  // child still running could add a line between the read and the assertion.
  await client.close();

  const specifiers = (await readFile(logPath, 'utf-8'))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return { specifiers, output: content.map((part) => part.text ?? '').join('\n') };
}

const namesGrpc = (specifiers: string[]) => specifiers.filter((s) => s.startsWith('@grpc/'));
const namesWs = (specifiers: string[]) => specifiers.filter((s) => s === 'ws');

describe('an HTTP-only run loads neither transport', () => {
  let recorded: Recorded;

  beforeAll(async () => {
    recorded = await runRecorded('http', { 'plain.bru': httpRequest(httpPort) });
  }, 60_000);

  // Asserted first: every claim below it is worthless if the recorder wrote nothing.
  it('recorded something at all', () => {
    expect(recorded.specifiers.length).toBeGreaterThan(0);
    // A package the server cannot boot without, so its absence means the hook,
    // not the server, is what failed.
    expect(recorded.specifiers.some((s) => s.startsWith('@modelcontextprotocol/'))).toBe(true);
  });

  it('actually ran the request, rather than refusing it', () => {
    expect(recorded.output).toContain('200');
  });

  it('never resolves @grpc/grpc-js or @grpc/proto-loader', () => {
    expect(namesGrpc(recorded.specifiers)).toEqual([]);
  });

  it('never resolves ws', () => {
    expect(namesWs(recorded.specifiers)).toEqual([]);
  });
});

describe('the positive control: a run that needs a transport loads it', () => {
  it('a gRPC run resolves @grpc/grpc-js', async () => {
    const recorded = await runRecorded('grpc', {
      'echo.proto': PROTO,
      'streamer.bru': grpcRequest(),
    });
    expect(recorded.specifiers).toContain('@grpc/grpc-js');
    // Loaded because the request reached the transport, not because something
    // unrelated pulled it in: the call itself got as far as a dial and failed.
    expect(recorded.output).toMatch(/UNAVAILABLE|ECONNREFUSED|refused|Failed to connect/i);
  }, 60_000);

  it('a WebSocket run resolves ws', async () => {
    const recorded = await runRecorded('ws', { 'socket.bru': wsRequest() });
    expect(recorded.specifiers).toContain('ws');
    expect(recorded.output).toMatch(/ECONNREFUSED|refused|closed/i);
  }, 60_000);
});
