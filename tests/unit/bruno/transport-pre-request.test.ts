/**
 * The pre-request phase of a gRPC or WebSocket request.
 *
 * Both transports are executed by a branch that used to return before the
 * pre-request block was reached, so a script on either of them ran not at all:
 * `bru.setVar` wrote nothing, `req.setUrl` changed nothing, and a script that
 * threw did not stop the request. Post-response and test scripts always ran,
 * which is what hid it.
 *
 * The transports themselves are mocked, so what is asserted is the input the
 * executor hands them — the variables, the target and the header surface a
 * script's writes actually reach. Nothing is dialled.
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RequestExecutor } from '../../../src/bruno/request-executor';
import { TestRunner } from '../../../src/bruno/test-runner';
import { executeGrpcRequest } from '../../../src/bruno/grpc-transport';
import { executeWebsocketRequest } from '../../../src/bruno/ws-transport';

// Spread the real modules: only the entry point is replaced, so `buildMetadata`
// and `handshakeHeaders` — which the executor calls to seed what the script
// reads — stay the implementations that also produce what is sent.
jest.mock('../../../src/bruno/grpc-transport', () => ({
  ...jest.requireActual('../../../src/bruno/grpc-transport'),
  executeGrpcRequest: jest.fn(),
}));
jest.mock('../../../src/bruno/ws-transport', () => ({
  ...jest.requireActual('../../../src/bruno/ws-transport'),
  executeWebsocketRequest: jest.fn(),
}));

const mockedGrpc = executeGrpcRequest as jest.Mock;
const mockedWs = executeWebsocketRequest as jest.Mock;

/** A session that connected and said nothing, so verification has a response. */
const wsOutcome = (name: string, url: string) => ({
  result: {
    name,
    method: 'WS',
    url,
    status: 0,
    statusText: 'closed',
    duration_ms: 1,
    tests: [],
  },
  response: { status: 0, statusText: 'closed', headers: {}, body: [], rawBody: '[]' },
});

const grpcOutcome = (name: string, url: string) => ({
  result: {
    name,
    method: 'GRPC',
    url,
    status: 0,
    statusText: 'OK',
    duration_ms: 1,
    tests: [],
  },
  response: { status: 0, statusText: 'OK', headers: {}, body: {}, rawBody: '{}' },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedWs.mockImplementation(async () => wsOutcome('Socket', 'ws://feed.test/room'));
  mockedGrpc.mockImplementation(async () => grpcOutcome('Streamer', 'grpc://svc.test:50051'));
});

async function collection(name: string, content: string): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'transport-pre-'));
  await fs.writeFile(join(root, name), content);
  return root;
}

const run = (root: string, variables?: Record<string, string>) =>
  RequestExecutor.executeCollection(root, { scriptRunner: TestRunner, variables });

/** A WebSocket request whose script is whatever the caller passes. */
const wsRequest = (script: string, url = 'ws://feed.test/{{room}}'): string => `info:
  name: Socket
  type: websocket
  seq: 1
websocket:
  url: "${url}"
  headers:
    - name: X-Room
      value: "{{room}}"
  message:
    - title: hello
      message:
        type: text
        data: '{"op":"subscribe"}'
runtime:
  scripts:
    - type: before-request
      code: |
${script.split('\n').map((line) => `        ${line}`).join('\n')}
`;

const grpcRequest = (script: string): string => `info:
  name: Streamer
  type: grpc
  seq: 1
grpc:
  url: "grpc://svc.test:50051"
  method: /pkg.Svc/Method
  methodType: unary
  metadata:
    - name: x-room
      value: "{{room}}"
runtime:
  scripts:
    - type: before-request
      code: |
${script.split('\n').map((line) => `        ${line}`).join('\n')}
`;

/** The single argument the executor handed the mocked transport. */
const wsInput = (): Record<string, unknown> => mockedWs.mock.calls[0][0];
const grpcInput = (): Record<string, unknown> => mockedGrpc.mock.calls[0][0];

const varsOf = (input: Record<string, unknown>): Map<string, string> =>
  input.vars as Map<string, string>;

describe('a pre-request script on a WebSocket request', () => {
  it('runs at all, and its variable reaches the target the session dials', async () => {
    const root = await collection('w.yml', wsRequest('bru.setVar("room", "prices");'));

    const result = await run(root, { room: 'lobby' });

    // The transport substitutes `{{room}}` itself, so what proves the script ran
    // before substitution is the value it is handed.
    expect(mockedWs).toHaveBeenCalledTimes(1);
    expect(varsOf(wsInput()).get('room')).toBe('prices');
    expect(result.summary.failed).toBe(0);
  });

  it('reads the substituted target and the request\'s own headers', async () => {
    const root = await collection(
      'w.yml',
      wsRequest('bru.setVar("sawUrl", req.getUrl());\nbru.setVar("sawRoom", req.getHeaders()["X-Room"]);'),
    );

    await run(root, { room: 'lobby' });

    const vars = varsOf(wsInput());
    expect(vars.get('sawUrl')).toBe('ws://feed.test/lobby');
    expect(vars.get('sawRoom')).toBe('lobby');
  });

  it('honours req.setUrl as the target, without expanding it again', async () => {
    // `{{room}}` in what the script set stays literal: the script was handed a
    // substituted URL, so its answer is a finished target, not a template.
    const root = await collection('w.yml', wsRequest('req.setUrl("ws://other.test/{{room}}");'));

    await run(root, { room: 'lobby' });

    expect(wsInput().urlOverride).toBe('ws://other.test/{{room}}');
  });

  it('honours req.setHeader as a handshake header', async () => {
    const root = await collection(
      'w.yml',
      wsRequest('req.setHeader("Authorization", "Bearer from-script");'),
    );

    await run(root, { room: 'lobby' });

    expect(wsInput().headerOverrides).toEqual({ Authorization: 'Bearer from-script' });
  });

  it('warns that req.setBody is not applied, rather than guessing a message', async () => {
    const root = await collection('w.yml', wsRequest('req.setBody({ op: "guessed" });'));

    const result = await run(root, { room: 'lobby' });

    // Still sent: the script's other work stands, and only the body is refused.
    expect(mockedWs).toHaveBeenCalledTimes(1);
    const warnings = (result.groups[0]!.results?.[0] as { warnings?: string[] }).warnings ?? [];
    expect(warnings.join(' ')).toContain('req.setBody()');
    expect(warnings.join(' ')).toContain('list of messages');
  });

  it('halts the request when the script throws, opening no socket', async () => {
    const root = await collection('w.yml', wsRequest('throw new Error("no credential today");'));

    const result = await run(root, { room: 'lobby' });

    expect(mockedWs).not.toHaveBeenCalled();
    const failed = result.groups[0]!.results![0]!;
    expect(failed.status).toBe(0);
    expect(failed.method).toBe('WS');
    expect(failed.url).toBe('ws://feed.test/lobby');
    expect(failed.error).toContain('no credential today');
    expect(failed.error).toContain('was not sent');
    expect(result.summary.failed).toBe(1);
  });
});

describe('a pre-request script on a gRPC request', () => {
  it('runs at all, and its variable reaches the call', async () => {
    const root = await collection('g.yml', grpcRequest('bru.setVar("room", "prices");'));

    const result = await run(root, { room: 'lobby' });

    expect(mockedGrpc).toHaveBeenCalledTimes(1);
    expect(varsOf(grpcInput()).get('room')).toBe('prices');
    expect(result.summary.failed).toBe(0);
  });

  it('reads the substituted metadata as its headers', async () => {
    // Metadata is this transport's header surface: grpc-js sends it as HTTP/2
    // headers, and the transport already merges auth's headers into it.
    const root = await collection(
      'g.yml',
      grpcRequest('bru.setVar("sawRoom", req.getHeaders()["x-room"]);'),
    );

    await run(root, { room: 'lobby' });

    expect(varsOf(grpcInput()).get('sawRoom')).toBe('lobby');
  });

  it('honours req.setHeader as metadata', async () => {
    const root = await collection('g.yml', grpcRequest('req.setHeader("x-trace", "abc");'));

    await run(root, { room: 'lobby' });

    expect(grpcInput().metadataOverrides).toEqual({ 'x-trace': 'abc' });
  });

  it('honours req.setUrl as the target', async () => {
    const root = await collection('g.yml', grpcRequest('req.setUrl("grpc://other.test:50052");'));

    await run(root, { room: 'lobby' });

    expect(grpcInput().urlOverride).toBe('grpc://other.test:50052');
  });

  it('halts the request when the script throws, opening no channel', async () => {
    const root = await collection('g.yml', grpcRequest('throw new Error("proto missing");'));

    const result = await run(root, { room: 'lobby' });

    expect(mockedGrpc).not.toHaveBeenCalled();
    const failed = result.groups[0]!.results![0]!;
    expect(failed.status).toBe(0);
    expect(failed.method).toBe('GRPC');
    expect(failed.error).toContain('proto missing');
    expect(result.summary.failed).toBe(1);
  });
});
