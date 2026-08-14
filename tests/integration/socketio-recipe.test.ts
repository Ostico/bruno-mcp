/**
 * The published socket.io recipe, driven end to end against a real socket.io server.
 *
 * The recipe in the README is six steps, and five of them are frames a request file
 * already stores, so nothing in the runner had to be written for them — which is
 * exactly why nothing proved they work together either. The keepalive was covered
 * only against a purpose-built engine.io peer: a server that sends the frames we
 * expect, in the order we expect, because we wrote it. That proves our reply and its
 * gates; it cannot prove the recipe.
 *
 * So this suite uses the `socket.io` server package itself, at the 4.8.3 the recipe
 * was measured against, and asserts each step off the transcript. The keepalive's
 * oracle is the server's own liveness machinery rather than our bookkeeping: with the
 * reply enabled the session outlives `pingInterval + pingTimeout` and the server
 * never times it out, and with the reply disabled the same server hangs up on us and
 * says why. That second test is what makes the first one mean something — without it,
 * a session that survived because the server had stopped caring would read as a pass.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server as SocketIoServer } from 'socket.io';
import { RequestExecutor } from '../../src/bruno/request-executor.js';
import { TestRunner } from '../../src/bruno/test-runner.js';
import { resetAllowlistCache } from '../../src/bruno/url-validator.js';
import type { ExecutionOptions } from '../../src/bruno/execution-options.js';
import type { RequestResult } from '../../src/bruno/types.js';

/** Short enough that a whole ping cycle fits inside a test, real machinery otherwise. */
const PING_INTERVAL_MS = 150;
const PING_TIMEOUT_MS = 250;

interface Harness {
  http: HttpServer;
  io: SocketIoServer;
  port: number;
  /** Why the server let each client go — its own words, not our inference. */
  disconnects: string[];
  /** Event payloads the server received, so step 5 is asserted from its side too. */
  events: unknown[];
}

async function startSocketIo(): Promise<Harness> {
  const http = createServer();
  const io = new SocketIoServer(http, {
    // `websocket` only: the recipe's `transport=websocket` skips the long-polling
    // handshake, and leaving polling enabled would let a failure to say so pass.
    transports: ['websocket'],
    pingInterval: PING_INTERVAL_MS,
    pingTimeout: PING_TIMEOUT_MS,
  });
  const harness: Harness = { http, io, port: 0, disconnects: [], events: [] };

  io.on('connection', (socket) => {
    socket.on('probe', (payload: unknown) => {
      harness.events.push(payload);
      socket.emit('probe-reply', { seen: payload });
    });
    socket.on('disconnect', (reason: string) => harness.disconnects.push(reason));
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
  const address = http.address();
  harness.port = typeof address === 'object' && address ? address.port : 0;
  return harness;
}

const stop = async (harness: Harness) => {
  await harness.io.close();
  await new Promise<void>((resolve) => harness.http.close(() => resolve()));
};

/**
 * Wait until the server reports a disconnect, then hand back what it said.
 *
 * A disconnect is the far end's event, and reading the array the instant a run
 * resolves measures machine load rather than behaviour: it passes on an idle machine
 * and fails under one that is busy. Waiting for the entry and returning it keeps the
 * assertion about the reason, so a server that hung up for some other reason fails on
 * the reason rather than on a timeout.
 */
async function disconnectSeen(harness: Harness, timeoutMs = 3000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (harness.disconnects.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return harness.disconnects;
}

/** The recipe's steps 3 and 5, as the two frames a request file stores. */
const socketIoRequest = (port: number) => `meta {
  name: SocketIo
  type: ws
  seq: 1
}

ws {
  url: ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket
  body: ws
  auth: none
}

body:ws {
  name: join-default-namespace
  type: text
  selected: true
  content: 40
}

body:ws {
  name: emit-probe
  type: text
  selected: true
  content: 42["probe",{"n":1}]
}
`;

async function collection(port: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'socketio-recipe-'));
  await writeFile(
    join(root, 'bruno.json'),
    JSON.stringify({ version: '1', name: 'c', type: 'collection' }),
  );
  await writeFile(join(root, 'socketio.bru'), socketIoRequest(port));
  return root;
}

const run = async (root: string, websocket: ExecutionOptions['websocket']): Promise<RequestResult> => {
  const result = await RequestExecutor.executeCollection(root, {
    scriptRunner: TestRunner,
    websocket,
  });
  return result.groups.flatMap((g) => g.results)[0]!;
};

const payloads = (result: RequestResult, direction: 'sent' | 'received') =>
  (result.websocket?.transcript ?? [])
    .filter((entry) => entry.direction === direction)
    .map((entry) => entry.payload ?? '');

/**
 * Options shared by both tests, so the only difference between them is the reply.
 *
 * `sendIntervalMs` is what orders the two authored frames: the recipe says nothing
 * works before the `40` is answered, and sending both in one tick would leave the
 * event racing the namespace it belongs to. `idleTimeoutMs: 0` hands the bound to the
 * wall clock, since the gaps here are the ping interval and stopping on silence would
 * end the session before the thing under test happened.
 */
const baseOptions = {
  includePayloads: true,
  sendIntervalMs: PING_INTERVAL_MS,
  idleTimeoutMs: 0,
} satisfies ExecutionOptions['websocket'];

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

describe('the socket.io recipe, against socket.io itself', () => {
  it('completes all six steps and is not timed out by the server', async () => {
    const harness = await startSocketIo();
    try {
      const result = await run(await collection(harness.port), {
        ...baseOptions,
        engineIoKeepalive: true,
        // Longer than one full ping cycle, so surviving it requires the reply.
        maxDurationMs: PING_INTERVAL_MS + PING_TIMEOUT_MS + 600,
      });

      const received = payloads(result, 'received');
      const sent = payloads(result, 'sent');

      // Steps 1 and 2: the URL reached engine.io, which opened with its parameters.
      const open = received.find((frame) => frame.startsWith('0{'));
      expect(open).toBeDefined();
      const handshake = JSON.parse(open!.slice(1)) as Record<string, unknown>;
      expect(typeof handshake.sid).toBe('string');
      expect(handshake.pingInterval).toBe(PING_INTERVAL_MS);
      expect(handshake.pingTimeout).toBe(PING_TIMEOUT_MS);

      // Steps 3 and 4: we joined the default namespace and it acknowledged with a sid.
      expect(sent).toContain('40');
      const namespace = received.find((frame) => frame.startsWith('40{'));
      expect(namespace).toBeDefined();
      expect(typeof (JSON.parse(namespace!.slice(2)) as { sid?: unknown }).sid).toBe('string');

      // Step 5: the event arrived as an event, and the reply came back framed the same way.
      expect(sent).toContain('42["probe",{"n":1}]');
      expect(harness.events).toEqual([{ n: 1 }]);
      const reply = received.find((frame) => frame.startsWith('42['));
      expect(reply).toBeDefined();
      expect(JSON.parse(reply!.slice(2))).toEqual(['probe-reply', { seen: { n: 1 } }]);

      // Step 6: a real PING, our PONG, and the server still holding the socket open.
      // The last two assertions are the load-bearing ones, and the transcript is not:
      // deleting the `socket.send` while leaving the transcript entry beside it keeps
      // a "sent 3" in the record and still gets us hung up on, which is how the pair
      // was checked.
      expect(received).toContain('2');
      expect(sent).toContain('3');
      expect(result.websocket?.stop_reason).toBe('timeout');
      expect(harness.disconnects).not.toContain('ping timeout');
    } finally {
      await stop(harness);
    }
  }, 15000);

  // The control for the test above. Without it, "the session survived" would also be
  // satisfied by a server that had stopped enforcing its own timeout, and the reply
  // could be deleted with nothing going red.
  it('is hung up on by the same server when the reply is left off', async () => {
    const harness = await startSocketIo();
    try {
      const result = await run(await collection(harness.port), {
        ...baseOptions,
        // Room for the server to ping, wait out its timeout, and disconnect us.
        maxDurationMs: PING_INTERVAL_MS * 2 + PING_TIMEOUT_MS + 900,
      });

      expect(payloads(result, 'sent')).not.toContain('3');
      expect(await disconnectSeen(harness)).toContain('ping timeout');
      // The session ended because the peer closed it, not because our clock ran out.
      expect(result.websocket?.stop_reason).toBe('closed');
    } finally {
      await stop(harness);
    }
  }, 15000);
});
