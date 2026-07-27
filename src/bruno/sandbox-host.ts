/**
 * Parent side of the sandbox process boundary.
 *
 * runInWorker forks the built worker (src/bruno/sandbox-worker.ts, emitted as
 * dist/bruno/sandbox-worker.js), sends it exactly one job, and returns the one
 * reply — turning the in-process runJob into a call that runs in a separate,
 * disposable process. The guarantees this adds over running runJob in-process,
 * and why each matters, are frozen in docs/sandbox-ipc-contract.md:
 *
 *   - scrubbed env: the child does not inherit the operator's environment, so a
 *     script that escapes the vm inside the child still cannot read the server's
 *     secrets — they are not in its address space.
 *   - isolated stdio: the child's stdout is piped, never inherited, so a script
 *     cannot write onto the parent's fd 1, which carries the MCP JSON-RPC stream.
 *   - a hard kill: a runaway script is bounded by SIGKILL on the child, an
 *     absolute wall-clock bound that the vm timeout — a V8 interrupt covering
 *     only work inside runInContext — cannot provide.
 *
 * This is defence-in-depth via an OS process, not a jail: it does not stop code
 * execution inside the child, it makes such execution worthless.
 */

import { fork as realFork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import {
  DEFAULT_TIMEOUT,
  WORKER_ARGV_SENTINEL,
  failingResultFor,
  type SandboxJob,
  type SandboxJobResult,
} from './sandbox-worker.js';
import type {
  MockRequestData,
  MockResponseData,
  PreRequestScriptResult,
  ScriptResult,
  TestRunnerOptions,
} from './types.js';

/** Milliseconds allowed for spawn + prelude on top of the script's own budget. */
const DEFAULT_HANDSHAKE_OVERHEAD_MS = 1000;

/** How long to wait after SIGTERM before escalating to SIGKILL. */
const DEFAULT_KILL_GRACE_MS = 200;

/** Cap on captured child stdout/stderr so a chatty script cannot exhaust memory. */
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Concurrent children allowed at once. A 100-request collection must not fork
 * 100 cold starts simultaneously; excess jobs queue and run as slots free.
 */
const DEFAULT_MAX_CONCURRENCY = 8;

export interface RunInWorkerOptions {
  /** Absolute path to the built worker (dist/bruno/sandbox-worker.js). */
  workerPath: string;
  /**
   * Environment for the child. Defaults to {} — a pure-compute worker needs
   * none of the operator's variables, and withholding them is the point.
   */
  env?: NodeJS.ProcessEnv;
  handshakeOverheadMs?: number;
  killGraceMs?: number;
  maxOutputBytes?: number;
  /** Injectable for tests; defaults to node:child_process fork. */
  fork?: typeof realFork;
}

/** Semaphore state, module-scoped so it bounds all callers together. */
let activeChildren = 0;
const waiters: Array<() => void> = [];
let maxConcurrency = DEFAULT_MAX_CONCURRENCY;

/** Override the concurrency cap (tests, or a future config surface). */
export function setMaxConcurrency(n: number): void {
  maxConcurrency = Math.max(1, Math.floor(n));
}

function acquireSlot(): Promise<void> {
  if (activeChildren < maxConcurrency) {
    activeChildren++;
    return Promise.resolve();
  }
  return new Promise(resolve => {
    waiters.push(() => {
      activeChildren++;
      resolve();
    });
  });
}

function releaseSlot(): void {
  activeChildren--;
  const next = waiters.shift();
  if (next) {
    next();
  }
}

/**
 * Run one job in a forked worker and resolve with its reply. Never rejects: a
 * child that crashes, times out, or never replies resolves as a failing result
 * of the job's kind, so a misbehaving script can never take down the caller.
 */
export async function runInWorker(
  job: SandboxJob,
  options: RunInWorkerOptions,
): Promise<SandboxJobResult> {
  const {
    workerPath,
    env = {},
    handshakeOverheadMs = DEFAULT_HANDSHAKE_OVERHEAD_MS,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    fork = realFork,
  } = options;

  await acquireSlot();

  return new Promise<SandboxJobResult>(resolve => {
    let settled = false;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const child: ChildProcess = fork(workerPath, [WORKER_ARGV_SENTINEL], {
      // fd 1 (stdout) and fd 2 (stderr) are PIPED, never inherited: inheriting
      // fd 1 would let the child write onto the parent's MCP JSON-RPC stream.
      // fd 3 is the IPC channel the job and reply travel over.
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      // Scrubbed: the child gets only what the caller passed (default nothing),
      // never process.env.
      env,
    });

    // Captured, capped, and never written to the parent's stdout. Kept so a
    // failure can be explained without ever letting child output reach fd 1.
    let captured = '';
    const capture = (chunk: Buffer): void => {
      if (captured.length < maxOutputBytes) {
        captured += chunk.toString('utf8').slice(0, maxOutputBytes - captured.length);
      }
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    const cleanup = (): void => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      // killTimer is deliberately NOT cleared: it is only ever scheduled on the
      // deadline path, and the caller is resolved before SIGKILL fires. Clearing
      // it here would cancel the escalation and leave the runaway child alive.
      child.removeAllListeners();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
    };

    const finish = (result: SandboxJobResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      releaseSlot();
      resolve(result);
    };

    // Escalating kill: ask politely, then force. The forced kill is the bound
    // the vm timeout cannot give — it holds no matter what the script left
    // spinning on the child's stack.
    const killChild = (): void => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, killGraceMs);
    };

    deadlineTimer = setTimeout(() => {
      killChild();
      finish(
        failingResultFor(
          job.kind,
          `sandbox worker exceeded its ${job.timeout}ms budget and was terminated`,
        ),
      );
    }, job.timeout + handshakeOverheadMs);

    child.on('message', (reply: SandboxJobResult) => {
      finish(reply);
    });

    // Spawn failure, or the child died before replying. Either way it is a
    // failing result, not a thrown error the caller must catch.
    child.on('error', (error: Error) => {
      finish(
        failingResultFor(job.kind, `sandbox worker failed to run: ${error.message}`),
      );
    });
    child.on('exit', (code, signal) => {
      finish(
        failingResultFor(
          job.kind,
          `sandbox worker exited without a result (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
        ),
      );
    });

    child.send(job, (error: Error | null) => {
      if (error) {
        finish(
          failingResultFor(
            job.kind,
            `sandbox worker could not receive the job: ${error.message}`,
          ),
        );
      }
    });
  });
}

/**
 * The seam request-executor runs scripts through. Its shape is exactly the two
 * static methods TestRunner already exposes, so the in-process runner and the
 * forked runner below are interchangeable and either can be injected.
 */
export interface ScriptRunner {
  runPreRequestScript(
    script: string,
    request: MockRequestData,
    options?: TestRunnerOptions,
  ): Promise<PreRequestScriptResult>;
  runScript(
    script: string,
    response: MockResponseData,
    options?: TestRunnerOptions,
  ): Promise<ScriptResult>;
}

/**
 * Absolute path to the built worker, resolved from this module's own location
 * at runtime. In the bundled ESM output tsup emits it at dist/, with the worker
 * entry at dist/bruno/sandbox-worker.js — __dirname (shimmed by tsup --shims in
 * ESM, native in the CJS test compile) points at dist/. Deliberately not an env
 * var: a worker path taken from the environment in the file meant to remove
 * code execution would reintroduce it (finding S13).
 */
export function resolveWorkerPath(): string {
  return path.join(__dirname, 'bruno', 'sandbox-worker.js');
}

/**
 * Build a script runner that runs every non-empty script in a forked,
 * env-scrubbed, killable worker. Empty scripts short-circuit to the same shape
 * the in-process path returns, so a request without scripts never pays for a
 * fork.
 *
 * The worker path and the transport are parameters purely so this is testable
 * without depending on __dirname resolving to a real built worker: production
 * takes the defaults.
 */
export function createForkingScriptRunner(
  workerPath: string = resolveWorkerPath(),
  runner: typeof runInWorker = runInWorker,
): ScriptRunner {
  return {
    async runPreRequestScript(script, request, options) {
      if (!script || script.trim().length === 0) {
        return { variables: {}, mutations: {} };
      }
      const out = await runner(
        {
          kind: 'pre-request',
          script,
          request,
          timeout: options?.timeout ?? DEFAULT_TIMEOUT,
        },
        { workerPath },
      );
      return out.result as PreRequestScriptResult;
    },

    async runScript(script, response, options) {
      if (!script || script.trim().length === 0) {
        return { results: [], variables: {} };
      }
      const out = await runner(
        {
          kind: 'test',
          script,
          response,
          timeout: options?.timeout ?? DEFAULT_TIMEOUT,
        },
        { workerPath },
      );
      return out.result as ScriptResult;
    },
  };
}

/**
 * The production script runner. server.ts injects this; the in-process
 * TestRunner remains the executor's default so the test suite runs without
 * forking.
 */
export const forkingScriptRunner: ScriptRunner = createForkingScriptRunner();
