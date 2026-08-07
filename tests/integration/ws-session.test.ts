/**
 * A bounded WebSocket session, end to end, against a real `ws` server.
 *
 * The bounds are the point, so each is proven by a server built to hit it: one
 * that floods, one that stays silent, one that sends a single enormous frame. And
 * because "no socket is left open" is a claim about a resource rather than about a
 * return value, the server records every close it sees and the tests read that
 * rather than our own bookkeeping.
 *
 * Both pinning branches are exercised: an IP allowlist entry produces an address
 * to pin, and a hostname allowlist entry produces none. Written unconditionally,
 * the pinned lookup fails closed with ENOTFOUND — so the hostname case would fail
 * as if DNS were broken, and the tempting "fix" would be deleting pinning
 * altogether.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { RequestExecutor } from '../../src/bruno/request-executor.js';
import { TestRunner } from '../../src/bruno/test-runner.js';
import { resetAllowlistCache } from '../../src/bruno/url-validator.js';
import type { ExecutionOptions } from '../../src/bruno/execution-options.js';

interface Harness {
  server: WebSocketServer;
  port: number;
  /** Frames the server received, so "what we sent" is asserted from its side. */
  received: string[];
  /** How many sockets the server saw close. */
  closes: number;
}

/** A server whose behaviour on connect is supplied per test. */
async function startServer(onConnect: (socket: WebSocket, harness: Harness) => void): Promise<Harness> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const harness: Harness = { server, port: 0, received: [], closes: 0 };
  server.on('connection', (socket) => {
    socket.on('message', (data) => harness.received.push(data.toString()));
    socket.on('close', () => { harness.closes += 1; });
    onConnect(socket, harness);
  });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  harness.port = typeof address === 'object' && address ? address.port : 0;
  return harness;
}

const stop = (harness: Harness) =>
  new Promise<void>((resolve) => harness.server.close(() => resolve()));

async function collection(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ws-run-'));
  await writeFile(join(root, 'bruno.json'), JSON.stringify({ version: '1', name: 'c', type: 'collection' }));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, name), content);
  }
  return root;
}

const bruWs = (host: string, port: number, body = 'hello') => `meta {
  name: BruSocket
  type: ws
  seq: 1
}

ws {
  url: ws://${host}:${port}
  body: ws
  auth: none
}

body:ws {
  name: first
  type: text
  content: ${body}
}
`;

const ymlWs = (host: string, port: number) => `info:
  name: YmlSocket
  type: websocket
  seq: 2
websocket:
  url: ws://${host}:${port}
  message:
    - title: first
      selected: true
      message:
        type: text
        data: hello
    - title: skipped
      selected: false
      message:
        type: text
        data: never-sent
`;

const run = async (root: string, websocket?: ExecutionOptions['websocket']) => {
  const result = await RequestExecutor.executeCollection(root, {
    scriptRunner: TestRunner,
    ...(websocket ? { websocket } : {}),
  });
  return result.groups.flatMap((g) => g.results);
};

/** A run with variables supplied, and the whole result kept for inspection. */
const runWithVariables = (
  root: string,
  variables: Record<string, string>,
  websocket?: ExecutionOptions['websocket'],
) =>
  RequestExecutor.executeCollection(root, {
    scriptRunner: TestRunner,
    variables,
    ...(websocket ? { websocket } : {}),
  });

let savedAllowlist: string | undefined;

beforeAll(() => {
  savedAllowlist = process.env.BRUNO_SSRF_ALLOWLIST;
  // `localhost` is the hostname branch — an allowlisted NAME is never resolved by
  // validation, so nothing comes back to pin. `127.0.0.1` is the address branch.
  process.env.BRUNO_SSRF_ALLOWLIST = '127.0.0.1,localhost';
  resetAllowlistCache();
});

afterAll(() => {
  if (savedAllowlist === undefined) delete process.env.BRUNO_SSRF_ALLOWLIST;
  else process.env.BRUNO_SSRF_ALLOWLIST = savedAllowlist;
  resetAllowlistCache();
});

describe('a connect-send-receive-close cycle, in both dialects', () => {
  it('records the outbound frame and the reply, in order', async () => {
    const harness = await startServer((socket) => {
      socket.on('message', (data) => socket.send(`echo:${data.toString()}`));
    });
    try {
      const results = await run(
        await collection({
          'bru.bru': bruWs('127.0.0.1', harness.port),
          'yml.yml': ymlWs('127.0.0.1', harness.port),
        }),
        { maxMessages: 1, includePayloads: true },
      );
      expect(results).toHaveLength(2);
      for (const result of results) {
        const transcript = result.websocket?.transcript ?? [];
        expect(transcript[0]?.direction).toBe('sent');
        expect(transcript[0]?.payload).toBe('hello');
        expect(transcript[1]?.direction).toBe('received');
        expect(transcript[1]?.payload).toBe('echo:hello');
      }
    } finally {
      await stop(harness);
    }
  });

  it('does not send a message whose selected flag is false', async () => {
    const harness = await startServer(() => {});
    try {
      await run(await collection({ 'yml.yml': ymlWs('127.0.0.1', harness.port) }), {
        maxDurationMs: 400,
      });
      expect(harness.received).toEqual(['hello']);
    } finally {
      await stop(harness);
    }
  });

  it('records no payloads unless asked, but still counts their bytes', async () => {
    const harness = await startServer((socket) => {
      socket.on('message', () => socket.send('secret-value'));
    });
    try {
      const [result] = await run(
        await collection({ 'bru.bru': bruWs('127.0.0.1', harness.port) }),
        { maxMessages: 1 },
      );
      const received = result.websocket?.transcript.find((e) => e.direction === 'received');
      expect(received?.payload).toBeUndefined();
      expect(received?.bytes).toBe('secret-value'.length);
    } finally {
      await stop(harness);
    }
  });
});

describe('each bound stops the session and names itself', () => {
  it('stops on the message count', async () => {
    const harness = await startServer((socket) => {
      for (let i = 0; i < 200; i += 1) socket.send(`frame-${i}`);
    });
    try {
      const [result] = await run(await collection({ 'bru.bru': bruWs('127.0.0.1', harness.port) }));
      const received = result.websocket?.transcript.filter((e) => e.direction === 'received') ?? [];
      expect(received).toHaveLength(50);
      expect(result.websocket?.stop_reason).toBe('count');
      expect(result.websocket?.truncated).toBe(true);
    } finally {
      await stop(harness);
    }
  });

  it('stops on the clock when the peer says nothing', async () => {
    const harness = await startServer(() => {});
    try {
      const startedAt = Date.now();
      const [result] = await run(
        await collection({ 'bru.bru': bruWs('127.0.0.1', harness.port) }),
        { maxDurationMs: 600 },
      );
      expect(result.websocket?.stop_reason).toBe('timeout');
      expect(result.websocket?.truncated).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(4000);
    } finally {
      await stop(harness);
    }
  }, 10000);

  it('stops on the cumulative byte ceiling, distinctly from the count', async () => {
    const harness = await startServer((socket) => {
      socket.send('x'.repeat(4096));
    });
    try {
      const [result] = await run(
        await collection({ 'bru.bru': bruWs('127.0.0.1', harness.port) }),
        { maxTranscriptBytes: 1024, maxDurationMs: 2000 },
      );
      expect(result.websocket?.stop_reason).toBe('bytes');
      expect(result.websocket?.truncated).toBe(true);
    } finally {
      await stop(harness);
    }
  }, 10000);

  it('reports a peer-initiated close as closed, not as truncation', async () => {
    const harness = await startServer((socket) => socket.close());
    try {
      const [result] = await run(
        await collection({ 'bru.bru': bruWs('127.0.0.1', harness.port) }),
        { maxDurationMs: 2000 },
      );
      expect(result.websocket?.stop_reason).toBe('closed');
      expect(result.websocket?.truncated).toBe(false);
    } finally {
      await stop(harness);
    }
  }, 10000);
});

describe('both SSRF pinning branches connect', () => {
  it('dials the validated address when an IP was allowlisted', async () => {
    const harness = await startServer((socket) => socket.send('pinned'));
    try {
      const [result] = await run(
        await collection({ 'bru.bru': bruWs('127.0.0.1', harness.port) }),
        { maxMessages: 1 },
      );
      expect(result.error).toBeUndefined();
      expect(result.websocket?.transcript.some((e) => e.direction === 'received')).toBe(true);
    } finally {
      await stop(harness);
    }
  });

  // The regression this guards: `pinnedLookup([])` fails closed with ENOTFOUND, so
  // passing it on a path that pinned nothing would break every allowlisted
  // hostname while looking like a DNS problem.
  it('connects on the hostname path rather than failing with ENOTFOUND', async () => {
    const harness = await startServer((socket) => socket.send('unpinned'));
    try {
      const [result] = await run(
        await collection({ 'bru.bru': bruWs('localhost', harness.port) }),
        { maxMessages: 1 },
      );
      expect(result.error).toBeUndefined();
      expect(result.websocket?.transcript.some((e) => e.direction === 'received')).toBe(true);
    } finally {
      await stop(harness);
    }
  });
});

describe('no socket survives the call', () => {
  it('the server observes a close after a bounded recording', async () => {
    const harness = await startServer((socket) => socket.send('one'));
    try {
      await run(await collection({ 'bru.bru': bruWs('127.0.0.1', harness.port) }), { maxMessages: 1 });
      // Polled rather than asserted immediately: the close is a network event, and
      // asserting it synchronously would pass for the wrong reason on a fast run.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(harness.closes).toBeGreaterThan(0);
    } finally {
      await stop(harness);
    }
  }, 10000);

  it('the server observes a close after the peer errors mid-session', async () => {
    const harness = await startServer((socket) => {
      socket.send('one');
      // A frame the client cannot decode as a close handshake: the socket is torn
      // down under the recording rather than closed politely.
      setTimeout(() => socket.terminate(), 50);
    });
    try {
      const [result] = await run(
        await collection({ 'bru.bru': bruWs('127.0.0.1', harness.port) }),
        { maxDurationMs: 2000 },
      );
      expect(result.websocket).toBeDefined();
      expect(['closed', 'error']).toContain(result.websocket?.stop_reason);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(harness.closes).toBeGreaterThan(0);
    } finally {
      await stop(harness);
    }
  }, 10000);
});

describe('the engine.io keepalive is gated twice', () => {
  /** A server that speaks the engine.io handshake, then pings. */
  const engineIo = (socket: WebSocket) => {
    socket.send('0{"sid":"abc","pingInterval":25,"pingTimeout":100}');
    setTimeout(() => socket.send('2'), 40);
  };

  it('answers a ping with a pong once an OPEN frame has been seen', async () => {
    const harness = await startServer(engineIo);
    try {
      const [result] = await run(
        await collection({ 'bru.bru': bruWs('127.0.0.1', harness.port) }),
        { maxDurationMs: 600, engineIoKeepalive: true, includePayloads: true },
      );
      expect(harness.received).toContain('3');
      // Recorded, not just sent: a transcript that hides the frames we injected
      // would misrepresent the session.
      expect(result.websocket?.transcript.filter((e) => e.payload === '3')).toHaveLength(1);
    } finally {
      await stop(harness);
    }
  }, 10000);

  it('sends nothing when the keepalive is not enabled', async () => {
    const harness = await startServer(engineIo);
    try {
      await run(await collection({ 'bru.bru': bruWs('127.0.0.1', harness.port) }), {
        maxDurationMs: 600,
      });
      expect(harness.received).not.toContain('3');
    } finally {
      await stop(harness);
    }
  }, 10000);

  // Without this gate, any server that happened to send the single character "2"
  // would be answered with a "3" it never asked for.
  it('sends nothing when no OPEN frame was seen, even with the keepalive enabled', async () => {
    const harness = await startServer((socket) => socket.send('2'));
    try {
      await run(await collection({ 'bru.bru': bruWs('127.0.0.1', harness.port) }), {
        maxDurationMs: 600,
        engineIoKeepalive: true,
      });
      expect(harness.received).not.toContain('3');
    } finally {
      await stop(harness);
    }
  }, 10000);
});

describe('the allowlist is what lets any of this reach loopback', () => {
  // A canary, not a feature test. Every assertion in this file runs with
  // BRUNO_SSRF_ALLOWLIST set, and the variable is process-global and cached
  // inside url-validator. If a sibling suite in the same worker leaked an
  // assignment, or the reset here quietly stopped working, every SSRF-dependent
  // assertion in this file would keep passing for the wrong reason and nothing
  // would notice. This one fails if the allowlist has stopped being load-bearing.
  it('refuses ws://127.0.0.1 with the allowlist cleared', async () => {
    const harness = await startServer((socket) => socket.send('hi'));
    try {
      const root = await collection({ 'a.bru': bruWs('127.0.0.1', harness.port) });
      delete process.env.BRUNO_SSRF_ALLOWLIST;
      resetAllowlistCache();

      const [result] = await run(root);

      expect(result?.status).toBe(0);
      expect(result?.error).toMatch(/^Blocked:/);
      // Nothing was dialled: the server saw no frame at all.
      expect(harness.received).toEqual([]);
    } finally {
      // Restored on BOTH sides, in a finally, because a failure here would
      // otherwise leave the rest of the worker running without an allowlist.
      process.env.BRUNO_SSRF_ALLOWLIST = '127.0.0.1,localhost';
      resetAllowlistCache();
      await stop(harness);
    }
  }, 10000);
});

describe('a secret substituted into a frame stays out of the default result', () => {
  const SECRET = 'sup3r-s3cret-token';

  // Outbound frames are recorded AFTER {{var}} substitution, so the transcript is
  // the one place a value supplied in memory could reach a returned result.
  // `variables` is documented as the only correct way to pass a secret, which
  // makes this the claim standing behind that advice.
  it('never appears anywhere in the result under the default bounds', async () => {
    const harness = await startServer((socket) => socket.send('ack'));
    try {
      const root = await collection({ 'a.bru': bruWs('127.0.0.1', harness.port, '{{token}}') });

      const result = await runWithVariables(root, { token: SECRET }, { maxMessages: 1 });

      // The secret really was on the wire — otherwise its absence from the
      // result would prove nothing except that substitution had failed.
      expect(harness.received).toEqual([SECRET]);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    } finally {
      await stop(harness);
    }
  }, 10000);

  it('appears once payloads are asked for, which is the opt-in working', async () => {
    const harness = await startServer((socket) => socket.send('ack'));
    try {
      const root = await collection({ 'a.bru': bruWs('127.0.0.1', harness.port, '{{token}}') });

      const result = await runWithVariables(
        root,
        { token: SECRET },
        { maxMessages: 1, includePayloads: true },
      );

      expect(JSON.stringify(result)).toContain(SECRET);
    } finally {
      await stop(harness);
    }
  }, 10000);
});
