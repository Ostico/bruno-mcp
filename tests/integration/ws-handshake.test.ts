/**
 * What a WebSocket handshake actually puts on the wire.
 *
 * Everything here was previously inference from reading `ws-transport.ts`. No
 * public WebSocket endpoint reflects request headers back, so a live probe could
 * establish only one thing about header content, and it was negative: `Connection:
 * close` and `Upgrade: h2c` were authored and the connection upgraded anyway, which
 * means those headers are overridden rather than honoured or rejected. Which of two
 * duplicate names wins, whether a disabled header is really withheld, and whether
 * an auth credential reaches the handshake at all were all unverified.
 *
 * So the server records the handshake instead of the client claiming it: every
 * assertion below reads `req.rawHeaders` from the listener, which is the request
 * line as received. `rawHeaders` rather than `req.headers`, because Node joins
 * duplicates in the parsed map and the question here is what was sent.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { RequestExecutor } from '../../src/bruno/request-executor.js';
import { TestRunner } from '../../src/bruno/test-runner.js';
import { resetAllowlistCache } from '../../src/bruno/url-validator.js';

interface Harness {
  server: WebSocketServer;
  port: number;
  /** One entry per handshake, in the order the server accepted them. */
  handshakes: string[][];
}

async function startServer(): Promise<Harness> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const harness: Harness = { server, port: 0, handshakes: [] };
  server.on('connection', (socket, request) => {
    harness.handshakes.push([...request.rawHeaders]);
    socket.on('message', (data) => socket.send(`echo:${data.toString()}`));
  });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  harness.port = typeof address === 'object' && address ? address.port : 0;
  return harness;
}

const stop = (harness: Harness) =>
  new Promise<void>((resolve) => harness.server.close(() => resolve()));

/** Every value sent for one header name, in wire order, matched case-insensitively. */
function sent(handshake: string[], name: string): string[] {
  const wanted = name.toLowerCase();
  const values: string[] = [];
  for (let i = 0; i < handshake.length; i += 2) {
    if (handshake[i]!.toLowerCase() === wanted) values.push(handshake[i + 1]!);
  }
  return values;
}

/** Every header name sent, in wire order and in the case it was written in. */
const namesSent = (handshake: string[]): string[] =>
  handshake.filter((_, index) => index % 2 === 0);

async function collection(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ws-handshake-'));
  await writeFile(
    join(root, 'bruno.json'),
    JSON.stringify({ version: '1', name: 'c', type: 'collection' }),
  );
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, name), content);
  }
  return root;
}

/** A `.bru` WebSocket request with an arbitrary headers block and auth mode. */
const bruWs = (port: number, headers: string, auth = 'none', authBlock = ''): string => `meta {
  name: BruSocket
  type: ws
  seq: 1
}

ws {
  url: ws://127.0.0.1:${port}
  body: ws
  auth: ${auth}
}

headers {
${headers}
}
${authBlock}
body:ws {
  name: first
  type: text
  selected: true
  content: hello
}
`;

const runOne = async (root: string, variables: Record<string, string> = {}) => {
  const result = await RequestExecutor.executeCollection(root, {
    scriptRunner: TestRunner,
    variables,
    websocket: { maxMessages: 1 },
  });
  return result.groups.flatMap((group) => group.results)[0]!;
};

/** Run one request against a fresh listener and hand back its handshake. */
async function handshakeFor(
  headers: string,
  options: { auth?: string; authBlock?: string; variables?: Record<string, string> } = {},
): Promise<{ handshake: string[]; error?: string; warnings?: string[] }> {
  const harness = await startServer();
  try {
    const root = await collection({
      'sock.bru': bruWs(harness.port, headers, options.auth ?? 'none', options.authBlock ?? ''),
    });
    const result = await runOne(root, options.variables ?? {});
    return {
      handshake: harness.handshakes[0] ?? [],
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(result.warnings === undefined ? {} : { warnings: result.warnings }),
    };
  } finally {
    await stop(harness);
  }
}

let savedAllowlist: string | undefined;

beforeAll(() => {
  savedAllowlist = process.env.BRUNO_SSRF_ALLOWLIST;
  process.env.BRUNO_SSRF_ALLOWLIST = '127.0.0.1';
  resetAllowlistCache();
});

afterAll(() => {
  if (savedAllowlist === undefined) delete process.env.BRUNO_SSRF_ALLOWLIST;
  else process.env.BRUNO_SSRF_ALLOWLIST = savedAllowlist;
  resetAllowlistCache();
});

describe('an authored header on a WebSocket handshake', () => {
  it('reaches the server with the name and value the file gave it', async () => {
    const { handshake } = await handshakeFor('  X-Trace: abc123');

    expect(sent(handshake, 'x-trace')).toEqual(['abc123']);
    // The authored case is what goes out; nothing lowercases it on the way.
    expect(namesSent(handshake)).toContain('X-Trace');
  });

  it('is withheld entirely when the file disabled it', async () => {
    const { handshake } = await handshakeFor('  X-Trace: abc123\n  ~X-Skip: nope');

    expect(sent(handshake, 'x-trace')).toEqual(['abc123']);
    expect(sent(handshake, 'x-skip')).toEqual([]);
  });

  it('carries the substituted value, not the placeholder', async () => {
    const { handshake } = await handshakeFor('  Authorization: Bearer {{token}}', {
      variables: { token: 'from-a-variable' },
    });

    expect(sent(handshake, 'authorization')).toEqual(['Bearer from-a-variable']);
  });
});

describe('two headers writing the same name', () => {
  it('collapses an exact duplicate to the last value, sending one header', async () => {
    // Diagnosed from the code and now observed: handshake headers are collected
    // into an object keyed by name, so the second `X-Dup` overwrites the first.
    // The HTTP path joins duplicates instead, which is why this was worth
    // measuring rather than assuming the two transports agree.
    const { handshake } = await handshakeFor('  X-Dup: one\n  X-Dup: two');

    expect(sent(handshake, 'x-dup')).toEqual(['two']);
  });

  it('collapses two spellings of one name to the last value as well', async () => {
    // Two keys survive our own map here, since it is keyed by the authored name
    // and `X-Dup` is not `x-dup`. They collapse one layer lower: Node's outgoing
    // header store is keyed case-insensitively, so a second spelling replaces the
    // first and takes its own casing with it. Measured directly against a plain
    // `http.request` as well, so this is Node's behaviour and not something the
    // transport could choose differently while still handing over an object.
    const { handshake } = await handshakeFor('  X-Dup: one\n  x-dup: two');

    expect(sent(handshake, 'x-dup')).toEqual(['two']);
    expect(namesSent(handshake)).toContain('x-dup');
    expect(namesSent(handshake)).not.toContain('X-Dup');
  });
});

describe('a header the handshake itself owns', () => {
  it('is overridden rather than honoured or rejected', async () => {
    // The live probe established this negatively: a conforming server could not
    // have upgraded a connection that asked to close, so those headers never
    // reached the wire as written. Here the wire is readable, so the override is
    // observed instead of inferred.
    const { handshake, error } = await handshakeFor(
      '  Connection: close\n  Upgrade: h2c',
    );

    expect(error).toBeUndefined();
    expect(sent(handshake, 'connection')).toEqual(['Upgrade']);
    expect(sent(handshake, 'upgrade')).toEqual(['websocket']);
  });

  it('negotiates the version through the library, not through the header', async () => {
    // `ws` writes `Sec-WebSocket-Version` itself from its `protocolVersion`
    // option, so an authored 8 works only because the transport extracts it and
    // passes it on. The proof that the header alone does nothing is that a
    // version the library refuses is refused at all: see the unit tests for the
    // refusal. Here 8 is accepted, and the server sees 8 exactly once.
    const { handshake, error } = await handshakeFor('  Sec-WebSocket-Version: 8');

    expect(error).toBeUndefined();
    expect(sent(handshake, 'sec-websocket-version')).toEqual(['8']);
  });
});

describe('an auth mode on a WebSocket request', () => {
  it('places its credential on the handshake', async () => {
    const { handshake } = await handshakeFor('  X-Trace: abc123', {
      auth: 'bearer',
      authBlock: `
auth:bearer {
  token: shhh
}
`,
    });

    expect(sent(handshake, 'authorization')).toEqual(['Bearer shhh']);
  });
});
