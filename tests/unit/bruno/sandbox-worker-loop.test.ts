/**
 * Tests for the worker's IPC loop and its startup guard — the child side of the
 * process boundary. Exercised through the WorkerChannel interface so no real
 * child is forked here; the real fork is covered by the integration test.
 */

import {
  runWorkerLoop,
  maybeStartWorker,
  processWorkerChannel,
  failingResultFor,
  WORKER_ARGV_SENTINEL,
  type SandboxJob,
  type SandboxJobResult,
  type WorkerChannel,
} from '../../../src/bruno/sandbox-worker';
import { MockResponseData } from '../../../src/bruno/types';

interface FakeChannel extends WorkerChannel {
  fire(job: SandboxJob): void;
  readonly sent: unknown[];
  readonly exitCode: number | undefined;
}

function makeChannel(withSend = true): FakeChannel {
  let handler: ((job: SandboxJob) => void) | undefined;
  const sent: unknown[] = [];
  let exitCode: number | undefined;

  const channel: FakeChannel = {
    on(_event, listener) {
      handler = listener;
    },
    send: withSend
      ? (message, callback) => {
          sent.push(message);
          callback?.(null);
          return true;
        }
      : undefined,
    exit(code) {
      exitCode = code;
      return undefined as never;
    },
    fire(job) {
      if (!handler) throw new Error('no message handler registered');
      handler(job);
    },
    get sent() {
      return sent;
    },
    get exitCode() {
      return exitCode;
    },
  };
  return channel;
}

const response: MockResponseData = {
  status: 200,
  statusText: 'OK',
  headers: {},
  body: { ok: true },
  responseTime: 1,
};

describe('failingResultFor', () => {
  it('shapes a pre-request failure with an error and empty writes', () => {
    expect(failingResultFor('pre-request', 'boom')).toEqual({
      kind: 'pre-request',
      result: { variables: {}, mutations: {}, error: 'boom' },
    });
  });

  it('shapes a test failure as one failing result', () => {
    expect(failingResultFor('test', 'boom')).toEqual({
      kind: 'test',
      result: {
        results: [{ description: 'sandbox', status: 'fail', error: 'boom' }],
        variables: {},
      },
    });
  });
});

describe('runWorkerLoop', () => {
  it('runs a job, sends the result, then exits', () => {
    const ch = makeChannel();
    runWorkerLoop(ch);

    ch.fire({
      kind: 'test',
      script: 'test("ok", function () { expect(res.getStatus()).to.equal(200); });',
      response,
      timeout: 1000,
    });

    expect(ch.sent).toHaveLength(1);
    const reply = ch.sent[0] as SandboxJobResult;
    expect(reply.kind).toBe('test');
    if (reply.kind !== 'test') throw new Error('unreachable');
    expect(reply.result.results[0]).toMatchObject({ description: 'ok', status: 'pass' });
    expect(ch.exitCode).toBe(0);
  });

  it('exits directly when the channel cannot send (no IPC)', () => {
    const ch = makeChannel(false);
    runWorkerLoop(ch);

    ch.fire({ kind: 'pre-request', script: 'bru.setVar("a", 1);', request: { url: 'x', method: 'GET', headers: {}, body: null }, timeout: 1000 });

    expect(ch.sent).toHaveLength(0);
    expect(ch.exitCode).toBe(0);
  });

  it('reports a catastrophic runJob failure as a failing result rather than throwing', () => {
    const ch = makeChannel();
    runWorkerLoop(ch);

    // A non-string script makes runTestJob's script.trim() throw synchronously,
    // outside its own try — the exact case the loop's catch exists to contain.
    ch.fire({
      kind: 'test',
      script: 123 as unknown as string,
      response,
      timeout: 1000,
    });

    const reply = ch.sent[0] as SandboxJobResult;
    expect(reply.kind).toBe('test');
    if (reply.kind !== 'test') throw new Error('unreachable');
    expect(reply.result.results[0].status).toBe('fail');
    expect(reply.result.results[0].error).toMatch(/sandbox worker crashed/);
    expect(ch.exitCode).toBe(0);
  });

  it('contains a catastrophic pre-request failure in the pre-request shape', () => {
    const ch = makeChannel();
    runWorkerLoop(ch);

    // Non-string script → runPreRequestJob's script.trim() throws before its try.
    ch.fire({
      kind: 'pre-request',
      script: 123 as unknown as string,
      request: { url: 'x', method: 'GET', headers: {}, body: null },
      timeout: 1000,
    });

    const reply = ch.sent[0] as SandboxJobResult;
    expect(reply.kind).toBe('pre-request');
    if (reply.kind !== 'pre-request') throw new Error('unreachable');
    expect(reply.result.error).toMatch(/sandbox worker crashed/);
    expect(ch.exitCode).toBe(0);
  });
});

describe('maybeStartWorker', () => {
  it('starts the loop when the argv sentinel is present', () => {
    const ch = makeChannel();
    const started = maybeStartWorker(['node', 'worker.js', WORKER_ARGV_SENTINEL], ch);

    expect(started).toBe(true);
    // Proven started by the loop being live: firing a job produces a reply.
    ch.fire({ kind: 'test', script: 'test("t", function () { expect(1).to.equal(1); });', response, timeout: 1000 });
    expect(ch.sent).toHaveLength(1);
  });

  it('stays dormant without the sentinel', () => {
    const ch = makeChannel();
    const started = maybeStartWorker(['node', 'worker.js'], ch);

    expect(started).toBe(false);
    expect(() => ch.fire({ kind: 'test', script: '', response, timeout: 1000 })).toThrow(
      /no message handler/,
    );
  });
});

describe('processWorkerChannel', () => {
  it('delegates on/send/exit to the underlying process', () => {
    const calls: { on?: string; sent?: unknown; exit?: number } = {};
    const listener = (): void => undefined;
    const fakeProc = {
      on: (event: string, l: unknown) => {
        calls.on = event;
        expect(l).toBe(listener);
      },
      send: (msg: unknown) => {
        calls.sent = msg;
        return true;
      },
      exit: (code: number) => {
        calls.exit = code;
        return undefined as never;
      },
    } as unknown as NodeJS.Process;

    const channel = processWorkerChannel(fakeProc);
    channel.on('message', listener);
    channel.send?.({ ping: true });
    channel.exit(0);

    expect(calls).toEqual({ on: 'message', sent: { ping: true }, exit: 0 });
  });

  it('omits send when the process has no IPC channel', () => {
    const fakeProc = { on: () => undefined, exit: () => undefined as never } as unknown as NodeJS.Process;
    expect(processWorkerChannel(fakeProc).send).toBeUndefined();
  });
});
