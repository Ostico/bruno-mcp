/**
 * A WebSocket session that can fail.
 *
 * It could not, before: the executor returned from the WebSocket branch before the
 * path that runs scripts and assertions, so a session's declared checks were
 * parsed, written back faithfully and never evaluated. The request reported
 * `passed` with `requestsWithoutTests: 1`, which reads as an author's omission
 * rather than as a capability that did not exist.
 *
 * The first test below must go RED when the assertion is wrong. A suite whose
 * negative case cannot fail is the exact condition being fixed, so it is asserted
 * first and deliberately.
 *
 * The payload split is the other thing proven here. The transcript a caller is
 * shown omits payloads unless `includePayloads` is set, because outbound frames
 * are recorded after interpolation and would otherwise write supplied secrets into
 * a result returned by default. A script is the author's own code and sees them
 * regardless — the same line the HTTP path already draws between `res.body` and
 * `response_body`. One test holds both halves at once, because the guarantee is
 * that they differ in the same run.
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
}

async function startEcho(): Promise<Harness> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket: WebSocket) => {
    socket.on('message', (data) => socket.send(`echo:${data.toString()}`));
  });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  return { server, port: typeof address === 'object' && address ? address.port : 0 };
}

const stop = (harness: Harness) =>
  new Promise<void>((resolve) => harness.server.close(() => resolve()));

async function collection(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ws-verify-'));
  await writeFile(
    join(root, 'bruno.json'),
    JSON.stringify({ version: '1', name: 'c', type: 'collection' }),
  );
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, name), content);
  }
  return root;
}

/** A session that sends one frame, with the given tests script attached. */
const checked = (port: number, body: string) => `info:
  name: Checked
  type: websocket
  seq: 1
websocket:
  url: ws://127.0.0.1:${port}
  message:
    - title: first
      selected: true
      message:
        type: text
        data: hello
runtime:
  scripts:
    - type: tests
      code: |
${body.split('\n').map((line) => `        ${line}`).join('\n')}
`;

const run = async (root: string, websocket?: ExecutionOptions['websocket']) =>
  RequestExecutor.executeCollection(root, {
    scriptRunner: TestRunner,
    ...(websocket ? { websocket } : {}),
  });

const results = async (root: string, websocket?: ExecutionOptions['websocket']) =>
  (await run(root, websocket)).groups.flatMap((group) => group.results);

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

describe('a websocket session is verified, not assumed', () => {
  it('fails the run when its test fails', async () => {
    const harness = await startEcho();
    try {
      const [result] = await results(
        await collection({
          'red.yml': checked(
            harness.port,
            "test('the peer said something else', function () {\n"
            + "  expect(res.getBody()[1].payload).to.equal('nothing like it');\n"
            + '});',
          ),
        }),
        { maxMessages: 1, maxDurationMs: 2000 },
      );

      expect(result.tests).toHaveLength(1);
      expect(result.tests[0].status).toBe('fail');
    } finally {
      await stop(harness);
    }
  }, 15000);

  it('passes a test that reads what the peer actually sent', async () => {
    const harness = await startEcho();
    try {
      const [result] = await results(
        await collection({
          'green.yml': checked(
            harness.port,
            "test('the peer echoed', function () {\n"
            + '  const received = res.getBody().filter(function (f) {\n'
            + "    return f.direction === 'received';\n"
            + '  });\n'
            + "  expect(received[0].payload).to.equal('echo:hello');\n"
            + '});',
          ),
        }),
        { maxMessages: 1, maxDurationMs: 2000 },
      );

      expect(result.tests[0]?.status).toBe('pass');
    } finally {
      await stop(harness);
    }
  }, 15000);

  it('gives a script the payloads while the surfaced transcript still withholds them', async () => {
    // Both halves in one run, because the guarantee is precisely that they differ.
    // `includePayloads` is left at its default here — off.
    const harness = await startEcho();
    try {
      const [result] = await results(
        await collection({
          'split.yml': checked(
            harness.port,
            "test('the script can see a payload', function () {\n"
            + '  expect(res.getBody()[0].payload).to.be.a(\'string\');\n'
            + '});',
          ),
        }),
        { maxMessages: 1, maxDurationMs: 2000 },
      );

      // The script saw them...
      expect(result.tests[0]?.status).toBe('pass');
      // ...and the caller was shown none. If this ever inverts, every supplied
      // secret in an outbound frame starts appearing in a result that is returned
      // by default.
      expect(result.websocket?.transcript.length).toBeGreaterThan(0);
      for (const entry of result.websocket?.transcript ?? []) {
        expect(entry.payload).toBeUndefined();
      }
    } finally {
      await stop(harness);
    }
  }, 15000);

  it('hands the stop reason to the script as the status text', async () => {
    const harness = await startEcho();
    try {
      const [result] = await results(
        await collection({
          'reason.yml': checked(
            harness.port,
            "test('the bound that ended it is legible', function () {\n"
            + "  expect(res.getStatusText()).to.equal('count');\n"
            + '});',
          ),
        }),
        { maxMessages: 1, maxDurationMs: 2000 },
      );

      expect(result.tests[0]?.status).toBe('pass');
      // And the result's own status stays the refusal sentinel it always was.
      expect(result.status).toBe(0);
    } finally {
      await stop(harness);
    }
  }, 15000);

  it('counts a verified session in the summary rather than as untested', async () => {
    const harness = await startEcho();
    try {
      const summary = (await run(
        await collection({
          'counted.yml': checked(
            harness.port,
            "test('something was recorded', function () {\n"
            + '  expect(res.getBody().length).to.be.above(0);\n'
            + '});',
          ),
        }),
        { maxMessages: 1, maxDurationMs: 2000 },
      )).summary;

      expect(summary.tests.total).toBe(1);
      expect(summary.tests.passed).toBe(1);
      // The field that used to be the only hint that nothing had been checked.
      expect(summary.requestsWithoutTests).toBe(0);
    } finally {
      await stop(harness);
    }
  }, 15000);

  it('does not evaluate assertions against a session that never happened', async () => {
    // A refusal already carries its own error. Running the author's checks against
    // a request that was never sent would report that single failure a second
    // time, in the vocabulary of assertions rather than of the refusal — and the
    // second report would be about a `res` describing nothing.
    const [result] = await results(
      await collection({
        'blocked.yml': checked(9, "test('never runs', function () {\n"
          + '  expect(true).to.equal(false);\n'
          + '});').replace('ws://127.0.0.1:9', 'ws://169.254.169.254'),
      }),
      { maxDurationMs: 500 },
    );

    expect(result.error).toBeDefined();
    expect(result.tests).toHaveLength(0);
  }, 15000);
});
