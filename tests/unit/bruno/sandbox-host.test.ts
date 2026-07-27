/**
 * Tests for the parent side of the sandbox boundary. A fake fork stands in for
 * a real child so the security-relevant fork options, the kill escalation, the
 * failure paths, and the concurrency cap are all asserted without spawning a
 * process. The real fork is covered end-to-end by the integration test.
 */

import { EventEmitter } from 'node:events';
import type { fork as forkType } from 'node:child_process';
import {
  runInWorker,
  setMaxConcurrency,
  type RunInWorkerOptions,
} from '../../../src/bruno/sandbox-host';
import { WORKER_ARGV_SENTINEL, type SandboxJob, type SandboxJobResult } from '../../../src/bruno/sandbox-worker';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  signals: string[] = [];
  sentJobs: unknown[] = [];
  sendImpl: (msg: unknown, cb?: (e: Error | null) => void) => void = (_m, cb) => cb?.(null);

  send(msg: unknown, cb?: (e: Error | null) => void): boolean {
    this.sentJobs.push(msg);
    this.sendImpl(msg, cb);
    return true;
  }
  kill(signal: string): boolean {
    this.signals.push(signal);
    return true;
  }
}

let children: FakeChild[] = [];
let forkCalls: Array<{ path: string; args: string[]; opts: Record<string, unknown> }> = [];

function fakeFork(configure?: (c: FakeChild) => void): typeof forkType {
  return ((path: string, args: string[], opts: Record<string, unknown>) => {
    const child = new FakeChild();
    forkCalls.push({ path, args, opts });
    children.push(child);
    configure?.(child);
    return child;
  }) as unknown as typeof forkType;
}

const testJob: SandboxJob = {
  kind: 'test',
  script: 'test("t", function () {});',
  response: { status: 200, statusText: 'OK', headers: {}, body: {}, responseTime: 1 },
  timeout: 1000,
};

const passReply: SandboxJobResult = {
  kind: 'test',
  result: { results: [{ description: 't', status: 'pass' }], variables: {} },
};

/** Let runInWorker's awaited slot acquisition and executor run. */
const tick = () => new Promise(r => setImmediate(r));

function baseOpts(over: Partial<RunInWorkerOptions> = {}): RunInWorkerOptions {
  return {
    workerPath: '/built/sandbox-worker.js',
    handshakeOverheadMs: 20,
    killGraceMs: 10,
    fork: fakeFork(),
    ...over,
  };
}

beforeEach(() => {
  children = [];
  forkCalls = [];
  setMaxConcurrency(8);
});

describe('runInWorker fork configuration', () => {
  it('forks the worker path with the sentinel, isolated stdio, and a scrubbed env by default', async () => {
    const p = runInWorker(testJob, baseOpts());
    await tick();

    expect(forkCalls).toHaveLength(1);
    const call = forkCalls[0];
    expect(call.path).toBe('/built/sandbox-worker.js');
    expect(call.args).toEqual([WORKER_ARGV_SENTINEL]);
    expect(call.opts.stdio).toEqual(['ignore', 'pipe', 'pipe', 'ipc']);
    expect(call.opts.env).toEqual({}); // no process.env leaked to the child

    children[0].emit('message', passReply);
    await expect(p).resolves.toEqual(passReply);
  });

  it('passes a caller-supplied env allowlist through unchanged', async () => {
    const p = runInWorker(testJob, baseOpts({ env: { TZ: 'UTC' } }));
    await tick();
    expect(forkCalls[0].opts.env).toEqual({ TZ: 'UTC' });
    children[0].emit('message', passReply);
    await p;
  });

  it('sends the job over IPC to the child', async () => {
    const p = runInWorker(testJob, baseOpts());
    await tick();
    expect(children[0].sentJobs[0]).toEqual(testJob);
    children[0].emit('message', passReply);
    await p;
  });
});

describe('runInWorker failure and timeout paths', () => {
  it('resolves as a failure when the child errors', async () => {
    const p = runInWorker(testJob, baseOpts());
    await tick();
    children[0].emit('error', new Error('spawn ENOENT'));
    const out = await p;
    expect(out.kind).toBe('test');
    if (out.kind !== 'test') throw new Error('unreachable');
    expect(out.result.results[0].error).toMatch(/failed to run: spawn ENOENT/);
  });

  it('resolves as a failure when the child exits without replying', async () => {
    const p = runInWorker(testJob, baseOpts());
    await tick();
    children[0].emit('exit', 1, null);
    const out = await p;
    if (out.kind !== 'test') throw new Error('unreachable');
    expect(out.result.results[0].error).toMatch(/exited without a result \(code=1, signal=null\)/);
  });

  it('names the signal when the child is killed rather than exiting cleanly', async () => {
    const p = runInWorker(testJob, baseOpts());
    await tick();
    children[0].emit('exit', null, 'SIGKILL');
    const out = await p;
    if (out.kind !== 'test') throw new Error('unreachable');
    expect(out.result.results[0].error).toMatch(/code=null, signal=SIGKILL/);
  });

  it('resolves as a failure when the job cannot be delivered', async () => {
    const p = runInWorker(
      testJob,
      baseOpts({ fork: fakeFork(c => (c.sendImpl = (_m, cb) => cb?.(new Error('EPIPE')))) }),
    );
    const out = await p;
    if (out.kind !== 'test') throw new Error('unreachable');
    expect(out.result.results[0].error).toMatch(/could not receive the job: EPIPE/);
  });

  it('escalates SIGTERM then SIGKILL and fails with a budget message when the child hangs', async () => {
    const p = runInWorker(
      { ...testJob, timeout: 10 },
      baseOpts({ handshakeOverheadMs: 0, killGraceMs: 15 }),
    );
    const out = await p; // never emits a message; the deadline resolves it
    if (out.kind !== 'test') throw new Error('unreachable');
    expect(out.result.results[0].error).toMatch(/exceeded its 10ms budget/);

    expect(children[0].signals[0]).toBe('SIGTERM');
    // SIGKILL follows after the grace period.
    await new Promise(r => setTimeout(r, 30));
    expect(children[0].signals).toContain('SIGKILL');
  });

  it('caps captured child output instead of growing without bound', async () => {
    const p = runInWorker(testJob, baseOpts({ maxOutputBytes: 16 }));
    await tick();
    children[0].stdout.emit('data', Buffer.from('x'.repeat(1000)));
    children[0].stderr.emit('data', Buffer.from('y'.repeat(1000)));
    children[0].emit('message', passReply);
    // The point is that a flood neither throws nor blocks the reply.
    await expect(p).resolves.toEqual(passReply);
  });
});

describe('runInWorker robustness', () => {
  it('tolerates a child with no stdout/stderr streams', async () => {
    const p = runInWorker(
      testJob,
      baseOpts({
        fork: fakeFork(c => {
          (c as unknown as { stdout: null }).stdout = null;
          (c as unknown as { stderr: null }).stderr = null;
        }),
      }),
    );
    await tick();
    children[0].emit('message', passReply);
    await expect(p).resolves.toEqual(passReply);
  });

  it('resolves once and ignores a later settle attempt', async () => {
    // Stash the send callback so it can fire AFTER a message already resolved —
    // the send callback is not an emitter listener, so cleanup does not remove
    // it, which is the one path that can re-enter finish and exercise its guard.
    let deferredSendCb: ((e: Error | null) => void) | undefined;
    const p = runInWorker(
      testJob,
      baseOpts({ fork: fakeFork(c => (c.sendImpl = (_m, cb) => (deferredSendCb = cb))) }),
    );
    await tick();

    children[0].emit('message', passReply);
    await expect(p).resolves.toEqual(passReply);

    // Late failure callback must be a no-op: no throw, no change to the result.
    expect(() => deferredSendCb?.(new Error('too late'))).not.toThrow();
  });
});

describe('runInWorker concurrency cap', () => {
  it('queues jobs beyond the cap and runs them as slots free', async () => {
    setMaxConcurrency(1);
    const opts = baseOpts();

    const p1 = runInWorker(testJob, opts);
    const p2 = runInWorker(testJob, opts);
    await tick();

    // Only one child forked; the second job is queued.
    expect(forkCalls).toHaveLength(1);

    children[0].emit('message', passReply);
    await p1;
    await tick();

    // Slot freed → the second job forks now.
    expect(forkCalls).toHaveLength(2);
    children[1].emit('message', passReply);
    await p2;
  });
});
