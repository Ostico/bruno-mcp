/**
 * Tests for the sandbox worker's job dispatch.
 *
 * runJob is the single entry the forked child will invoke in the child-process
 * migration (PR-b), and the seam TestRunner delegates to today. It must route a
 * job to the right sandbox by kind, hand back a result discriminated by that
 * same kind, and pass the caller's timeout through untouched (no default of its
 * own — the default is the caller's responsibility).
 *
 * The per-script behaviour (matchers, bru vars, mutations, warnings) is covered
 * exhaustively by the test-runner-*.test.ts suites, which drive the same
 * functions through TestRunner. These tests cover only the dispatch layer.
 */

import {
  runJob,
  runPreRequestJob,
  runTestJob,
  DEFAULT_TIMEOUT,
} from '../../../src/bruno/sandbox-worker';
import { MockRequestData, MockResponseData } from '../../../src/bruno/types';

const mockRequest: MockRequestData = {
  url: 'https://example.test/api',
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: { hello: 'world' },
};

const mockResponse: MockResponseData = {
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json' },
  body: { success: true },
  responseTime: 42,
};

describe('sandbox-worker runJob dispatch', () => {
  it('routes a pre-request job to runPreRequestJob and tags the reply', () => {
    const out = runJob({
      kind: 'pre-request',
      script: 'bru.setVar("token", "abc"); req.setHeader("x-token", bru.getVar("token"));',
      request: mockRequest,
      timeout: DEFAULT_TIMEOUT,
    });

    expect(out.kind).toBe('pre-request');
    if (out.kind !== 'pre-request') throw new Error('unreachable');
    expect(out.result.variables.token).toBe('abc');
    expect(out.result.mutations.headers).toMatchObject({ 'x-token': 'abc' });
    expect(out.result.error).toBeUndefined();
  });

  it('routes a test job to runTestJob and tags the reply', () => {
    const out = runJob({
      kind: 'test',
      script: 'test("ok", function () { expect(res.getStatus()).to.equal(200); });',
      response: mockResponse,
      timeout: DEFAULT_TIMEOUT,
    });

    expect(out.kind).toBe('test');
    if (out.kind !== 'test') throw new Error('unreachable');
    expect(out.result.results).toHaveLength(1);
    expect(out.result.results[0]).toMatchObject({ description: 'ok', status: 'pass' });
  });

  it('produces the same result as calling the underlying function directly', () => {
    const viaJob = runJob({
      kind: 'test',
      script: 'test("t", function () { expect(1).to.equal(1); });',
      response: mockResponse,
      timeout: DEFAULT_TIMEOUT,
    });
    const direct = runTestJob(
      'test("t", function () { expect(1).to.equal(1); });',
      mockResponse,
      DEFAULT_TIMEOUT,
    );

    expect(viaJob.kind === 'test' && viaJob.result).toEqual(direct);
  });

  it('passes the caller-supplied timeout through — a spinning script is bounded by it', () => {
    const out = runJob({
      kind: 'test',
      script: 'while (true) {}',
      response: mockResponse,
      timeout: 50,
    });

    expect(out.kind).toBe('test');
    if (out.kind !== 'test') throw new Error('unreachable');
    expect(out.result.results[0].status).toBe('fail');
    expect(out.result.results[0].error).toMatch(/timed out after 50ms/);
  });

  it('exposes a sane default timeout for callers that do not set one', () => {
    expect(DEFAULT_TIMEOUT).toBeGreaterThan(0);
    // runPreRequestJob is pure and takes an already-resolved timeout; an empty
    // script returns the empty shape without consuming the budget.
    expect(runPreRequestJob('', mockRequest, DEFAULT_TIMEOUT)).toEqual({
      variables: {},
      mutations: {},
    });
  });
});
