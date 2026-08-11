/**
 * A WebSocket request authored through this server, run with no hand-editing.
 *
 * The unit tests prove the bytes match what Bruno writes. That is a claim about a
 * file, not about a session: a file can be byte-perfect and still go nowhere if
 * the runner reads a field the writer never set, or reads it from the block the
 * other dialect uses. So this authors the request the way a caller would, points
 * it at a real `ws` server, and reads the transcript back.
 *
 * Both dialects run, because the two writers put a WebSocket request's headers in
 * different places — a top-level `headers` block in `.bru`, inside the
 * `websocket:` block in `.yml` — and only a live handshake proves either arrived.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestBuilder } from '../../src/bruno/request.js';
import { createCollectionManager } from '../../src/bruno/collection.js';
import { RequestExecutor } from '../../src/bruno/request-executor.js';
import { TestRunner } from '../../src/bruno/test-runner.js';
import { resetAllowlistCache } from '../../src/bruno/url-validator.js';

let savedAllowlist: string | undefined;

beforeAll(() => {
  savedAllowlist = process.env.BRUNO_SSRF_ALLOWLIST;
  // Loopback is refused without this, so a run here would fail on the address
  // rather than on anything the authoring wrote.
  process.env.BRUNO_SSRF_ALLOWLIST = '127.0.0.1';
  resetAllowlistCache();
});

afterAll(() => {
  if (savedAllowlist === undefined) delete process.env.BRUNO_SSRF_ALLOWLIST;
  else process.env.BRUNO_SSRF_ALLOWLIST = savedAllowlist;
  resetAllowlistCache();
});

interface Harness {
  server: WebSocketServer;
  port: number;
  received: string[];
  /** The handshake as it arrived, so an authored header is read off the wire. */
  handshakes: string[][];
}

async function startServer(): Promise<Harness> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const harness: Harness = { server, port: 0, received: [], handshakes: [] };
  server.on('connection', (socket: WebSocket, request) => {
    harness.handshakes.push([...request.rawHeaders]);
    socket.on('message', (data) => {
      harness.received.push(data.toString());
      socket.send(`echo:${data.toString()}`);
    });
  });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  harness.port = typeof address === 'object' && address ? address.port : 0;
  return harness;
}

const stop = (harness: Harness) =>
  new Promise<void>((resolve) => harness.server.close(() => resolve()));

/** The value the handshake carried for a header name, matched case-insensitively. */
function sent(handshake: string[], name: string): string | undefined {
  for (let i = 0; i < handshake.length; i += 2) {
    if (handshake[i].toLowerCase() === name.toLowerCase()) return handshake[i + 1];
  }
  return undefined;
}

async function collectionRoot(format: 'bru' | 'yaml'): Promise<string> {
  const tmpDir = await mkdtemp(join(tmpdir(), `ws-authored-${format}-`));
  const made = await createCollectionManager().createCollection({
    name: 'Authored',
    outputPath: tmpDir,
    format,
  });
  if (!made.success) throw new Error(`collection setup failed: ${made.error}`);
  return join(tmpDir, 'Authored');
}

describe.each([['bru'], ['yaml']] as const)(
  'a WebSocket request authored into a %s collection',
  (format) => {
    let harness: Harness;

    beforeEach(async () => {
      harness = await startServer();
    });

    afterEach(async () => {
      await stop(harness);
    });

    it('runs against a live endpoint and produces a transcript', async () => {
      const root = await collectionRoot(format);
      const created = await createRequestBuilder().createRequest({
        collectionPath: root,
        name: 'Echo',
        kind: 'ws',
        url: `ws://127.0.0.1:${harness.port}`,
        headers: { 'X-Authored': 'yes' },
        websocket: {
          messages: [
            { title: 'first', type: 'text', content: 'ping' },
            { title: 'second', type: 'text', content: 'pong' },
          ],
        },
      });
      expect(created.success).toBe(true);

      const result = await RequestExecutor.executeCollection(root, {
        scriptRunner: TestRunner,
        // The transcript names directions but withholds payloads by default, and
        // the payloads are what prove the authored messages arrived.
        websocket: { maxMessages: 2, maxDurationMs: 4000, idleMs: 500, includePayloads: true },
      });

      // Both counts, because `failed: 0` is also what a run that discovered
      // nothing reports.
      expect({ total: result.summary.total, failed: result.summary.failed }).toEqual({
        total: 1,
        failed: 0,
      });
      expect(harness.received).toEqual(['ping', 'pong']);
      expect(sent(harness.handshakes[0], 'x-authored')).toBe('yes');

      // Each direction's own order is fixed — the messages go in the order they
      // were authored, and the echoes come back in the order they were sent — but
      // whether the first echo lands before the second send is the network's
      // decision, so the two directions are asserted separately rather than as
      // one interleaved sequence.
      const transcript = result.groups[0].results[0].websocket?.transcript ?? [];
      const payloads = (direction: string) =>
        transcript.filter((e) => e.direction === direction).map((e) => e.payload);
      expect(payloads('sent')).toEqual(['ping', 'pong']);
      expect(payloads('received')).toEqual(['echo:ping', 'echo:pong']);
    });
  },
);
