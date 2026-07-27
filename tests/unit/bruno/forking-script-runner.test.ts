/**
 * Tests for the forking script runner and the worker-path resolution behind it.
 * The transport is injected so the delegate/short-circuit logic is covered
 * without a real fork; the real fork is exercised in the integration test.
 */

import {
  createForkingScriptRunner,
  resolveWorkerPath,
} from '../../../src/bruno/sandbox-host';
import { DEFAULT_TIMEOUT, type SandboxJob, type SandboxJobResult } from '../../../src/bruno/sandbox-worker';
import { MockRequestData, MockResponseData } from '../../../src/bruno/types';

const request: MockRequestData = { url: 'https://x.test', method: 'GET', headers: {}, body: null };
const response: MockResponseData = { status: 200, statusText: 'OK', headers: {}, body: {}, responseTime: 1 };

describe('resolveWorkerPath', () => {
  it('points at the worker entry beside the built module', () => {
    expect(resolveWorkerPath().replace(/\\/g, '/')).toMatch(/\/bruno\/sandbox-worker\.js$/);
  });
});

describe('createForkingScriptRunner', () => {
  it('short-circuits an empty pre-request script without forking', async () => {
    const runner = jest.fn();
    const r = createForkingScriptRunner('/unused', runner as never);

    await expect(r.runPreRequestScript('   ', request)).resolves.toEqual({
      variables: {},
      mutations: {},
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it('short-circuits an empty test script without forking', async () => {
    const runner = jest.fn();
    const r = createForkingScriptRunner('/unused', runner as never);

    await expect(r.runScript('', response)).resolves.toEqual({ results: [], variables: {} });
    expect(runner).not.toHaveBeenCalled();
  });

  it('delegates a non-empty pre-request script to the worker transport', async () => {
    const reply: SandboxJobResult = {
      kind: 'pre-request',
      result: { variables: { a: 1 }, mutations: { headers: { h: 'v' } } },
    };
    let seenJob: SandboxJob | undefined;
    let seenPath: string | undefined;
    const runner = jest.fn(async (job: SandboxJob, opts: { workerPath: string }) => {
      seenJob = job;
      seenPath = opts.workerPath;
      return reply;
    });
    const r = createForkingScriptRunner('/built/worker.js', runner as never);

    const out = await r.runPreRequestScript('bru.setVar("a", 1);', request, { timeout: 250 });

    expect(out).toEqual(reply.result);
    expect(seenPath).toBe('/built/worker.js');
    expect(seenJob).toMatchObject({ kind: 'pre-request', script: 'bru.setVar("a", 1);', timeout: 250, request });
  });

  it('applies the default timeout when the caller omits one', async () => {
    let seenJob: SandboxJob | undefined;
    const runner = jest.fn(async (job: SandboxJob) => {
      seenJob = job;
      return { kind: 'pre-request', result: { variables: {}, mutations: {} } } as SandboxJobResult;
    });
    const r = createForkingScriptRunner('/built/worker.js', runner as never);

    await r.runPreRequestScript('bru.setVar("a", 1);', request);

    expect(seenJob?.timeout).toBe(DEFAULT_TIMEOUT);
  });

  it('delegates a non-empty test script to the worker transport', async () => {
    const reply: SandboxJobResult = {
      kind: 'test',
      result: { results: [{ description: 't', status: 'pass' }], variables: {} },
    };
    const runner = jest.fn(async () => reply);
    const r = createForkingScriptRunner('/built/worker.js', runner as never);

    const out = await r.runScript('test("t", function () {});', response);

    expect(out).toEqual(reply.result);
    expect(runner).toHaveBeenCalledTimes(1);
    const [job] = runner.mock.calls[0];
    expect(job).toMatchObject({ kind: 'test', response });
  });
});
