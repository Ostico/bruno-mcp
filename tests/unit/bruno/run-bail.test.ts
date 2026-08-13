/**
 * Stopping a run at the first failure.
 *
 * The defect: there was no way to stop. A run of twenty-three dependent requests
 * whose login failed at request twenty ran the remaining three anyway, each
 * against an empty token, and reported four failures for one cause. The three
 * that could not have succeeded are noise in exactly the place a caller looks
 * first for the reason.
 *
 * What is pinned here is not only that the rest stop, but what the rest are
 * reported AS: a skipped request is neither a pass nor a failure, and a
 * truncated run must not look like a shorter one that went green.
 */

import { RequestExecutor } from '../../../src/bruno/request-executor';
import type { ScriptRunner } from '../../../src/bruno/sandbox-host';
import * as fs from 'node:fs/promises';

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

jest.mock('node:fs/promises');
const mockedFs = jest.mocked(fs);

jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
  ssrfRemediation: jest.fn().mockReturnValue(''),
}));

jest.mock('../../../src/bruno/fetch-dispatcher', () => ({
  buildDispatcher: jest.fn().mockResolvedValue(undefined),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Every fixture declares a post-response script, because a request with nothing
 * to evaluate never reaches the script runner at all — and then the runner that
 * decides which request fails would never be asked.
 */
function request(name: string, seq: number, path: string): string {
  return `
info:
  name: ${name}
  type: http
  seq: ${seq}
http:
  method: POST
  url: "https://api.example.com/${path}"
runtime:
  scripts:
    - type: after-response
      code: |
        test("checks the answer", function() { expect(res.status).to.equal(200); });
`;
}

const LOGIN = request('Login', 1, 'login');
const SECOND = request('Second', 2, 'second');
const THIRD = request('Third', 3, 'third');

// ── Harness ──────────────────────────────────────────────────────────────────

function okResponse(): Response {
  return {
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    text: jest.fn().mockResolvedValue('{}'),
    ok: true,
  } as unknown as Response;
}

function setupFs(files: Record<string, string>): void {
  mockedFs.readdir.mockImplementation(async () =>
    Object.keys(files).map(name => ({
      name,
      isFile: () => true,
      isDirectory: () => false,
    })) as any,
  );
  mockedFs.readFile.mockImplementation(async (filePath: any) => {
    const p = String(filePath);
    for (const [name, content] of Object.entries(files)) {
      if (p.endsWith(name)) return content;
    }
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
}

/** Every request's tests come back with the given statuses, in order of call. */
function runnerFailingOn(failFor: (callIndex: number) => boolean): ScriptRunner {
  let call = -1;
  return {
    runPreRequestScript: jest.fn().mockResolvedValue({ variables: {}, mutations: {} }),
    runScript: jest.fn().mockImplementation(async () => {
      call++;
      return {
        results: [{ description: 'checks the answer', status: failFor(call) ? 'fail' : 'pass' }],
        variables: {},
      };
    }),
  };
}

const THREE_FILES = {
  'Login.yml': LOGIN,
  'Second.yml': SECOND,
  'Third.yml': THIRD,
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('a run that does not ask to stop', () => {
  it('runs everything after the failure, as it always did', async () => {
    // The control. Without this, every assertion below could pass because the
    // requests never ran for some unrelated reason.
    setupFs(THREE_FILES);
    mockFetch.mockResolvedValue(okResponse());

    const result = await RequestExecutor.executeCollection('/c', {
      scriptRunner: runnerFailingOn((i) => i === 0),
    });

    expect(result.summary.total).toBe(3);
    expect(result.summary.failed).toBe(1);
    expect(result.bail).toBeUndefined();
    expect(result.summary.skipped).toBeUndefined();
    expect(result.groups[0]?.results.map((r) => r.skipped)).toEqual([
      undefined, undefined, undefined,
    ]);
  });
});

describe('stopping at a failed test', () => {
  it('does not run the requests after it', async () => {
    setupFs(THREE_FILES);
    mockFetch.mockResolvedValue(okResponse());

    const result = await RequestExecutor.executeCollection('/c', {
      bail: true,
      scriptRunner: runnerFailingOn((i) => i === 0),
    });

    // One request reached the wire. Read off fetch rather than off the results,
    // because "reported as skipped" and "never sent" are two different claims
    // and this is the one that matters.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.groups[0]?.results.map((r) => r.name)).toEqual(['Login', 'Second', 'Third']);
  });

  it('reports the ones it did not run as skipped, not as passed', async () => {
    setupFs(THREE_FILES);
    mockFetch.mockResolvedValue(okResponse());

    const result = await RequestExecutor.executeCollection('/c', {
      bail: true,
      scriptRunner: runnerFailingOn((i) => i === 0),
    });

    const [, second, third] = result.groups[0]?.results ?? [];
    expect(second?.skipped).toBe(true);
    expect(second?.skipReason).toBe('bail');
    expect(second?.status).toBe(0);
    expect(second?.tests).toEqual([]);
    expect(second?.error).toBeUndefined();
    expect(third?.skipped).toBe(true);
  });

  it('carries the method and url the skipped request declares', async () => {
    // What would have been sent. A caller deciding whether to rerun this one has
    // nothing else to go on, and empty strings would say the request had no target.
    setupFs(THREE_FILES);
    mockFetch.mockResolvedValue(okResponse());

    const result = await RequestExecutor.executeCollection('/c', {
      bail: true,
      scriptRunner: runnerFailingOn((i) => i === 0),
    });

    const second = result.groups[0]?.results[1];
    expect(second?.method).toBe('POST');
    expect(second?.url).toBe('https://api.example.com/second');
    expect(second?.path).toContain('Second.yml');
  });

  it('counts a skipped request in neither passed nor failed', async () => {
    setupFs(THREE_FILES);
    mockFetch.mockResolvedValue(okResponse());

    const result = await RequestExecutor.executeCollection('/c', {
      bail: true,
      scriptRunner: runnerFailingOn((i) => i === 0),
    });

    expect(result.summary.total).toBe(1);
    expect(result.summary.passed).toBe(0);
    expect(result.summary.failed).toBe(1);
    expect(result.summary.skipped).toBe(2);
    // The invariant that makes `failed === 0` still a safe green check.
    expect(result.summary.passed + result.summary.failed).toBe(result.summary.total);
  });

  it('does not count a skipped request as one that verified nothing', async () => {
    // `requestsWithoutTests` exists to say "this ran and checked nothing". A
    // request that never ran is not an instance of that.
    setupFs(THREE_FILES);
    mockFetch.mockResolvedValue(okResponse());

    const result = await RequestExecutor.executeCollection('/c', {
      bail: true,
      scriptRunner: runnerFailingOn((i) => i === 0),
    });

    expect(result.summary.requestsWithoutTests).toBe(0);
  });

  it('says where it stopped, and what it cost', async () => {
    setupFs(THREE_FILES);
    mockFetch.mockResolvedValue(okResponse());

    const result = await RequestExecutor.executeCollection('/c', {
      bail: true,
      scriptRunner: runnerFailingOn((i) => i === 0),
    });

    expect(result.bail?.reason).toBe('test failure');
    expect(result.bail?.at).toBe('Login');
    expect(result.bail?.group).toBe(0);
    expect(result.bail?.skipped).toBe(2);
    expect(result.bail?.path).toContain('Login.yml');
  });
});

describe('stopping at a request that never got an answer', () => {
  it('reports a request failure rather than a test failure', async () => {
    // The two upstream reasons this can produce, and the more specific one wins:
    // a request that never reached the wire registered no test to fail.
    setupFs(THREE_FILES);
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await RequestExecutor.executeCollection('/c', {
      bail: true,
      scriptRunner: runnerFailingOn(() => false),
    });

    expect(result.bail?.reason).toBe('request failure');
    expect(result.bail?.at).toBe('Login');
    expect(result.summary.skipped).toBe(2);
  });
});

describe('stopping across groups', () => {
  it('does not start the groups after the one that failed', async () => {
    setupFs(THREE_FILES);
    mockFetch.mockResolvedValue(okResponse());

    const result = await RequestExecutor.executeCollection('/c', {
      bail: true,
      scriptRunner: runnerFailingOn((i) => i === 0),
      groups: [
        { name: 'first', requests: ['Login.yml'] },
        { name: 'second', requests: ['Second.yml', 'Third.yml'] },
      ],
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.bail?.group).toBe(0);
    expect(result.groups[1]?.name).toBe('second');
    expect(result.groups[1]?.results.map((r) => r.skipped)).toEqual([true, true]);
    // Skipped, not errored: nothing about the group itself went wrong.
    expect(result.groups[1]?.error).toBeUndefined();
    expect(result.groups[1]?.summary.skipped).toBe(2);
    expect(result.groups[1]?.summary.total).toBe(0);
  });

  it('counts what every group skipped, not just the failing one', async () => {
    setupFs(THREE_FILES);
    mockFetch.mockResolvedValue(okResponse());

    const result = await RequestExecutor.executeCollection('/c', {
      bail: true,
      scriptRunner: runnerFailingOn((i) => i === 0),
      groups: [
        { name: 'first', requests: ['Login.yml', 'Second.yml'] },
        { name: 'second', requests: ['Third.yml'] },
      ],
    });

    // One skipped behind the failure in group 0, one whole group after it.
    expect(result.bail?.skipped).toBe(2);
    expect(result.summary.skipped).toBe(2);
  });

  it('reports a group that cannot be resolved as skipped rather than broken', async () => {
    // The check order is deliberate. A group naming an unparseable file carries
    // an `error`, but the run stopped before reaching it, so blaming it for a
    // defect nothing hit would be a claim about work that never happened.
    setupFs({ ...THREE_FILES, 'Broken.yml': 'info:\n  name: [unclosed\n' });
    mockFetch.mockResolvedValue(okResponse());

    const result = await RequestExecutor.executeCollection('/c', {
      bail: true,
      scriptRunner: runnerFailingOn((i) => i === 0),
      groups: [
        { name: 'first', requests: ['Login.yml'] },
        { name: 'second', requests: ['Broken.yml'] },
      ],
    });

    expect(result.groups[1]?.error).toBeUndefined();
    expect(result.groups[1]?.summary.total).toBe(0);
    expect(result.groups[1]?.summary.failed).toBe(0);
  });
});

describe('stopping while running concurrently', () => {
  it('says that it only skipped what had not started', async () => {
    // Honesty about the limit: nothing cancels a request already in flight, so a
    // caller who reads "stopped at the first failure" and gets three completed
    // results needs the reason in the run, not in the documentation.
    setupFs(THREE_FILES);
    mockFetch.mockResolvedValue(okResponse());

    const result = await RequestExecutor.executeCollection('/c', {
      bail: true,
      parallel: true,
      scriptRunner: runnerFailingOn((i) => i === 0),
    });

    expect(result.bail).toBeDefined();
    expect((result.warnings ?? []).join('\n')).toContain('running concurrently');
    expect((result.warnings ?? []).join('\n')).toContain('needs a serial run');
  });

  it('reports the failure that stopped the run, not the last one to resolve', async () => {
    // Two requests are already in flight and both fail. Only the serial path is
    // protected by the skip guard; here the second failure arrives after the run
    // has already stopped, and reporting it would name a request that is a
    // consequence of the stop rather than its cause.
    setupFs(THREE_FILES);

    let loginSettled = (): void => {};
    const loginDone = new Promise<void>((resolve) => { loginSettled = resolve; });

    mockFetch.mockImplementation(async (target: unknown) => {
      const url = String(target);
      if (url.endsWith('/login')) {
        // A macrotask, so the run records this failure before the wait below is
        // released — the ordering the test is about, made deterministic.
        setImmediate(loginSettled);
        throw new Error('ECONNREFUSED');
      }
      if (url.endsWith('/third')) {
        await loginDone;
        throw new Error('ECONNREFUSED later');
      }
      return okResponse();
    });

    const result = await RequestExecutor.executeCollection('/c', {
      bail: true,
      parallel: true,
      groups: [{ name: 'both', requests: ['Login.yml', 'Third.yml'], parallel: true }],
    });

    expect(result.bail?.at).toBe('Login');
    // The one that lost the race still reports its own failure as a failure.
    const third = result.groups[0]?.results.find((r) => r.name === 'Third');
    expect(third?.skipped).toBeUndefined();
    expect(third?.error).toContain('ECONNREFUSED later');
  });

  it('says nothing about concurrency when the run was serial', async () => {
    setupFs(THREE_FILES);
    mockFetch.mockResolvedValue(okResponse());

    const result = await RequestExecutor.executeCollection('/c', {
      bail: true,
      scriptRunner: runnerFailingOn((i) => i === 0),
    });

    expect((result.warnings ?? []).join('\n')).not.toContain('running concurrently');
  });

  it('says nothing when a concurrent run never failed', async () => {
    setupFs(THREE_FILES);
    mockFetch.mockResolvedValue(okResponse());

    const result = await RequestExecutor.executeCollection('/c', {
      bail: true,
      parallel: true,
      scriptRunner: runnerFailingOn(() => false),
    });

    expect(result.bail).toBeUndefined();
    expect((result.warnings ?? []).join('\n')).not.toContain('running concurrently');
  });
});
