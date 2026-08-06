/**
 * The defect this work exists to close, verified end to end.
 *
 * Four files — gRPC and WebSocket, in both dialects — each edited through
 * `modify_request` on a field that has nothing to do with the transport. Before
 * this work, every one of them came back with its target block, its credentials
 * and every stored message deleted, because the model the writer rebuilt the file
 * from had never held them. A rename was enough to do it.
 *
 * Message CONTENT is asserted, not the count: the `.bru` grammar substitutes `{}`
 * for a falsy message body, so two content-destroyed messages still round-trip as
 * two blocks and a count assertion would pass on total loss.
 *
 * The second half of the file is the no-throw sweep. Every read and write entry
 * point is exercised against all four files, because a tool that throws is one an
 * agent cannot use even to find out what went wrong.
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequestBuilder, RequestBuilder } from '../../../src/bruno/request.js';
import { createReader } from '../../../src/bruno/format-factory.js';
import { toRequestView } from '../../../src/bruno/request-view.js';
import { discoverRequests } from '../../../src/bruno/request-discovery.js';
import { getCollectionStats } from '../../../src/bruno/collection-stats.js';
import { RequestExecutor } from '../../../src/bruno/request-executor.js';
import { TestRunner } from '../../../src/bruno/test-runner.js';
import { parseBruRequest } from '../../../src/bruno/bru-parser.js';
import { parseYamlRequest } from '../../../src/bruno/yaml-parser.js';

jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
  ssrfRemediation: jest.fn().mockReturnValue(''),
}));

const BRU_GRPC = `meta {
  name: BruStreamer
  type: grpc
  seq: 1
}

grpc {
  url: grpc://localhost:50051
  method: /pkg.Svc/Method
  body: grpc
  protoPath: ./svc.proto
  auth: bearer
  methodType: unary
}

auth:bearer {
  token: live-token
}

metadata {
  authorization: Bearer live
  ~x-disabled: nope
}

body:grpc {
  name: m1
  content: {"a":1}
}

body:grpc {
  name: m2
  content: {"b":2}
}
`;

const BRU_WS = `meta {
  name: BruSocket
  type: ws
  seq: 2
}

ws {
  url: ws://localhost:8080
  body: ws
  auth: none
}

headers {
  authorization: Bearer live
  ~x-off: nope
}

body:ws {
  name: first
  type: text
  content: {"hello":1}
}

body:ws {
  name: second
  type: binary
  content: cGF5
}
`;

const YML_GRPC = `info:
  name: YmlStreamer
  type: grpc
  seq: 3
grpc:
  url: grpc://localhost:50052
  method: /pkg.Svc/Other
  protoFilePath: ./other.proto
  methodType: unary
  auth:
    type: bearer
    token: live-token
  metadata:
    - name: authorization
      value: Bearer live
    - name: x-disabled
      value: nope
      disabled: true
  message:
    - title: m1
      message: '{"a":1}'
    - title: m2
      message: '{"b":2}'
  reflection: true
`;

const YML_WS = `info:
  name: YmlSocket
  type: websocket
  seq: 4
websocket:
  url: ws://localhost:8081
  headers:
    - name: authorization
      value: Bearer live
    - name: x-off
      value: nope
      disabled: true
  message:
    - title: first
      selected: true
      message:
        type: text
        data: '{"hello":1}'
    - title: second
      selected: false
      message:
        type: binary
        data: cGF5
  subprotocols:
    - graphql-ws
`;

const FILES = [
  ['.bru gRPC', 'brustreamer.bru', BRU_GRPC],
  ['.bru WebSocket', 'brusocket.bru', BRU_WS],
  ['.yml gRPC', 'ymlstreamer.yml', YML_GRPC],
  ['.yml WebSocket', 'ymlsocket.yml', YML_WS],
] as const;

let builder: RequestBuilder;

beforeEach(() => {
  builder = createRequestBuilder();
  global.fetch = jest.fn().mockResolvedValue(
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
  ) as never;
});

/** A collection holding all four files, plus the manifest the tools look for. */
async function collection(label: string): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), `bruno-dataloss-${label}-`));
  await fs.writeFile(
    join(dir, 'bruno.json'),
    JSON.stringify({ version: '1', name: 'c', type: 'collection' }),
  );
  for (const [, fileName, source] of FILES) {
    await fs.writeFile(join(dir, fileName), source);
  }
  return dir;
}

/** Read a file back the way `read_request` does, through the format reader. */
function viewOf(filePath: string, content: string) {
  const format = filePath.endsWith('.bru') ? 'bru' as const : 'yaml' as const;
  return toRequestView(createReader(format).parseRequest(content), format, filePath);
}

describe('an unrelated edit no longer destroys the transport block', () => {
  it.each(FILES)('%s keeps its target and every message', async (label, fileName) => {
    const dir = await collection(`edit-${fileName}`);
    const filePath = join(dir, fileName);

    // `sequence` is about as unrelated to a transport as an update gets.
    const result = await builder.updateRequest(filePath, { sequence: 42 });
    expect(result.success).toBe(true);

    const view = viewOf(filePath, await fs.readFile(filePath, 'utf-8'));
    expect(view.seq).toBe(42);
    const block = view.grpc ?? view.websocket;
    expect(block?.url).toMatch(/^(grpc|ws):\/\/localhost:/);
    expect(block?.messages).toBe(2);
    expect(label).toBeDefined();
  });

  it.each(FILES)('%s keeps its message content, not just its message count', async (_label, fileName) => {
    const dir = await collection(`content-${fileName}`);
    const filePath = join(dir, fileName);
    await builder.updateRequest(filePath, { sequence: 42 });

    const content = await fs.readFile(filePath, 'utf-8');
    const messages = fileName.endsWith('.bru')
      ? (() => {
        const bru = parseBruRequest(content);
        return (bru.grpc?.messages ?? bru.ws?.messages ?? []).map((m) => m.content);
      })()
      : (() => {
        const yaml = parseYamlRequest(content);
        return (yaml.grpc?.messages ?? yaml.websocket?.messages ?? []).map((m) => m.content ?? '');
      })();

    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain(fileName.includes('socket') ? '"hello":1' : '"a":1');
    expect(messages[1]).toContain(fileName.includes('socket') ? 'cGF5' : '"b":2');
  });

  it.each(FILES)('%s keeps its credentials, disabled entries included', async (_label, fileName) => {
    const dir = await collection(`creds-${fileName}`);
    const filePath = join(dir, fileName);
    await builder.updateRequest(filePath, { sequence: 42 });

    const view = viewOf(filePath, await fs.readFile(filePath, 'utf-8'));
    // gRPC keeps its credentials in `metadata`; a WebSocket request keeps them in
    // ordinary headers. Both had to survive, and each is read from its own place.
    const credentials = view.grpc?.metadata ?? view.headers ?? [];
    expect(credentials).toEqual([
      { name: 'authorization', value: 'Bearer live' },
      { name: fileName.includes('socket') ? 'x-off' : 'x-disabled', value: 'nope', disabled: true },
    ]);
  });

  it('keeps a .yml unmodelled block key across the edit', async () => {
    const dir = await collection('extra');
    const filePath = join(dir, 'ymlstreamer.yml');
    await builder.updateRequest(filePath, { sequence: 42 });
    expect(parseYamlRequest(await fs.readFile(filePath, 'utf-8')).grpc?.extra)
      .toEqual({ reflection: true });
  });

  it('keeps the .bru proto path across the edit', async () => {
    const dir = await collection('proto');
    const filePath = join(dir, 'brustreamer.bru');
    await builder.updateRequest(filePath, { sequence: 42 });
    expect(parseBruRequest(await fs.readFile(filePath, 'utf-8')).grpc?.protoPath)
      .toBe('./svc.proto');
  });
});

describe('no entry point throws on any of the four', () => {
  it.each(FILES)('reads %s back without throwing', async (_label, fileName) => {
    const dir = await collection(`read-${fileName}`);
    const filePath = join(dir, fileName);
    const content = await fs.readFile(filePath, 'utf-8');
    expect(() => viewOf(filePath, content)).not.toThrow();
  });

  it.each(FILES)('refuses an http-shaped edit to %s as a result, not a throw', async (_label, fileName) => {
    const dir = await collection(`refuse-${fileName}`);
    const result = await builder.updateRequest(join(dir, fileName), { url: 'http://evil.example' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/request: it has no http block/);
  });

  it('lists all four without a parse failure', async () => {
    const discovered = await discoverRequests(await collection('list'));
    expect(discovered.parseFailures).toEqual([]);
    expect(discovered.requests).toHaveLength(4);
  });

  it('reports stats over all four without throwing', async () => {
    await expect(getCollectionStats(await collection('stats'))).resolves.toBeDefined();
  });

  it('runs the collection, refusing each by name and rejecting nothing', async () => {
    const run = await RequestExecutor.executeCollection(await collection('run'), {
      scriptRunner: TestRunner,
    });
    const results = run.groups.flatMap((g) => g.results);
    expect(results).toHaveLength(4);
    for (const result of results) {
      expect(result.status).toBe(0);
      // Every one of the four is refused by name, but no longer all for the same
      // reason: WebSocket is still refused for its kind, while gRPC now reaches
      // its transport and is refused on its own terms — the fixtures carry two
      // messages and a target that SSRF validation blocks. What this test is
      // about is that a refusal is named and nothing throws, not which reason
      // applies.
      expect(result.error).toBeDefined();
      expect(result.error).not.toMatch(/undefined|\[object/i);
    }
    const reasons = results.map((r) => r.error ?? '');
    expect(reasons.filter((r) => /cannot execute a "ws" request/i.test(r))).toHaveLength(2);
    expect(reasons.filter((r) => /more than one message|^Blocked:/i.test(r))).toHaveLength(2);
    // Nothing was sent over HTTP: no transport here is an http one.
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(0);
  });
});
