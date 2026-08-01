/**
 * End-to-end proof of the sandbox process boundary: a real forked child running
 * the built worker, driven through runInWorker exactly as production will.
 *
 * The unit tests assert the fork is *configured* for isolation (scrubbed env,
 * piped stdio, kill escalation) with a fake fork. This test proves the built
 * artifact actually runs a job in a separate process and, critically, that a
 * runaway script is bounded by the kill rather than the vm timeout.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { runInWorker, createForkingScriptRunner } from '../../src/bruno/sandbox-host';
import type { SandboxJob } from '../../src/bruno/sandbox-worker';

const repoRoot = path.resolve(__dirname, '../..');
const workerPath = path.join(repoRoot, 'dist', 'bruno', 'sandbox-worker.js');

// dist/ is built by tests/global-setup.ts, once, before any worker starts. This
// suite used to rebuild in its own `beforeAll`, which raced the sibling
// mcp-stdio suite's build: `npm run build` is `--clean`, so one suite's
// `rm -rf dist` could delete the artifact the other was about to spawn
//. The guarantee that mattered here is preserved — globalSetup
// always rebuilds and never skips on an artifact that merely exists, which is
// what stops a stale dist/ from keeping the assertion below green after the
// build script has stopped emitting the worker.

it('the build emits the worker where the production resolver looks for it', () => {
  // resolveWorkerPath() points at dist/bruno/sandbox-worker.js. If the build
  // stops emitting that entry, forking is broken for every installed copy while
  // every unit test still passes, because they fork a fake.
  expect(existsSync(workerPath)).toBe(true);
});

describe('sandbox fork (real child)', () => {
  it('runs a test job in a forked worker and returns its results', async () => {
    const job: SandboxJob = {
      kind: 'test',
      script: 'test("status is 200", function () { expect(res.getStatus()).to.equal(200); });',
      response: { status: 200, statusText: 'OK', headers: {}, body: { ok: true }, responseTime: 5 },
      timeout: 3000,
    };

    const out = await runInWorker(job, { workerPath });

    expect(out.kind).toBe('test');
    if (out.kind !== 'test') throw new Error('unreachable');
    expect(out.result.results).toEqual([{ description: 'status is 200', status: 'pass' }]);
  });

  it('runs a pre-request job in a forked worker and returns its writes', async () => {
    const job: SandboxJob = {
      kind: 'pre-request',
      script: 'bru.setVar("token", "abc"); req.setHeader("x-token", bru.getVar("token"));',
      request: { url: 'https://example.test', method: 'GET', headers: {}, body: null },
      timeout: 3000,
    };

    const out = await runInWorker(job, { workerPath });

    expect(out.kind).toBe('pre-request');
    if (out.kind !== 'pre-request') throw new Error('unreachable');
    expect(out.result.variables.token).toBe('abc');
    expect(out.result.mutations.headers).toMatchObject({ 'x-token': 'abc' });
  });

  it('resolves a runaway script as a bounded failure instead of hanging', async () => {
    // A synchronous infinite loop. Whichever bound fires first — the vm timeout
    // inside the child or the parent's deadline-then-kill — the job must resolve
    // as a failure and the run must complete well within a generous ceiling. The
    // SIGTERM->SIGKILL escalation itself is force-tested in sandbox-host.test.ts,
    // where a child that never replies is the only way to guarantee that path.
    const job: SandboxJob = {
      kind: 'test',
      script: 'while (true) {}',
      response: { status: 200, statusText: 'OK', headers: {}, body: {}, responseTime: 1 },
      timeout: 200,
    };

    const started = Date.now();
    const out = await runInWorker(job, { workerPath, handshakeOverheadMs: 300, killGraceMs: 50 });
    const elapsed = Date.now() - started;

    expect(out.kind).toBe('test');
    if (out.kind !== 'test') throw new Error('unreachable');
    expect(out.result.results[0].status).toBe('fail');
    // Resolved by the deadline, not left hanging on the spinning child.
    expect(elapsed).toBeLessThan(3000);
  }, 10_000);

  it('sleeps and awaits inside the built worker, not just in the source tree', async () => {
    // The clock lives in its own module, so the unit tests would stay green even
    // if the bundler dropped it from the chunk the worker imports — the same
    // shape of failure as a dependency that is declared but not installed. This
    // is the only test that runs bru.sleep through the artifact production
    // forks.
    const job: SandboxJob = {
      kind: 'pre-request',
      script:
        'const before = await Promise.resolve("go");\n' +
        'await bru.sleep(150);\n' +
        'bru.setVar("state", before + "-slept");',
      request: { url: 'https://example.test', method: 'GET', headers: {}, body: null },
      timeout: 3000,
    };

    const started = Date.now();
    const out = await runInWorker(job, { workerPath });
    const elapsed = Date.now() - started;

    expect(out.kind).toBe('pre-request');
    if (out.kind !== 'pre-request') throw new Error('unreachable');
    expect(out.result.error).toBeUndefined();
    expect(out.result.variables.state).toBe('go-slept');
    expect(elapsed).toBeGreaterThanOrEqual(140);
  }, 10_000);

  it('bounds a sleep that outruns its budget instead of waiting it out', async () => {
    // The clamp is inside the child, so it reports a timeout itself rather than
    // being killed by the parent — the difference between a diagnosable failure
    // and "sandbox worker exceeded its budget and was terminated".
    const job: SandboxJob = {
      kind: 'pre-request',
      script: 'await bru.sleep(9000);',
      request: { url: 'https://example.test', method: 'GET', headers: {}, body: null },
      timeout: 300,
    };

    const started = Date.now();
    const out = await runInWorker(job, { workerPath });
    const elapsed = Date.now() - started;

    expect(out.kind).toBe('pre-request');
    if (out.kind !== 'pre-request') throw new Error('unreachable');
    expect(out.result.error).toContain('timed out');
    expect(elapsed).toBeLessThan(5000);
  }, 15_000);

  it('runs a script through the production forking runner against the real worker', async () => {
    // The same runner server.ts injects, pointed at the built worker — proves
    // the production path executes scripts in a forked child end to end.
    const runner = createForkingScriptRunner(workerPath);

    const out = await runner.runScript(
      'test("passes", function () { expect(res.getStatus()).to.equal(201); });',
      { status: 201, statusText: 'Created', headers: {}, body: {}, responseTime: 3 },
      { timeout: 3000 },
    );

    expect(out.results).toEqual([{ description: 'passes', status: 'pass' }]);
  });
});
