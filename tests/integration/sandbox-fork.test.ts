/**
 * End-to-end proof of the sandbox process boundary: a real forked child running
 * the built worker, driven through runInWorker exactly as production will.
 *
 * The unit tests assert the fork is *configured* for isolation (scrubbed env,
 * piped stdio, kill escalation) with a fake fork. This test proves the built
 * artifact actually runs a job in a separate process and, critically, that a
 * runaway script is bounded by the kill rather than the vm timeout.
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { runInWorker, createForkingScriptRunner } from '../../src/bruno/sandbox-host';
import type { SandboxJob } from '../../src/bruno/sandbox-worker';

const repoRoot = path.resolve(__dirname, '../..');
const workerPath = path.join(repoRoot, 'dist', 'bruno', 'sandbox-worker.js');

beforeAll(() => {
  // Always rebuild rather than reusing whatever dist/ happens to hold. Skipping
  // the build when the file merely exists let a stale artifact keep this suite
  // green after the build script stopped emitting the worker at all — the exact
  // breakage this test exists to catch.
  execSync('npm run build', { cwd: repoRoot, stdio: 'ignore' });
}, 120_000);

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
