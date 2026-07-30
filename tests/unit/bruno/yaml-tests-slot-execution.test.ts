/**
 * The `.yml` `tests` script slot, read side.
 *
 * Writing a test script to the `tests` slot is only half the job: the executor
 * has to read that slot back, or an authored test is faithfully stored and then
 * never run — a request that looks green because nothing was checked. This is
 * the same fold the .bru path already performs when it turns a `tests:` block
 * into a post-response script.
 *
 * The fixtures here are the bytes the write side produces, so the two ends are
 * pinned against the same on-disk shape.
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
  ssrfRemediation: jest.fn().mockReturnValue('REMEDIATION_SENTINEL'),
}));

jest.mock('../../../src/bruno/fetch-dispatcher', () => ({
  buildDispatcher: jest.fn().mockResolvedValue(undefined),
}));

const TEST_CODE = 'test("is ok", function() { expect(res.getStatus()).to.equal(200); });';
const POST_CODE = 'bru.setVar("seen", res.getStatus());';

/** A test script in the slot Bruno actually uses for one. */
const TESTS_ONLY_YAML = `info:
  name: Checked Call
  type: http
  seq: 1
http:
  method: GET
  url: https://api.example.com/status
runtime:
  scripts:
    - type: tests
      code: ${JSON.stringify(TEST_CODE)}
`;

/** Both post-response slots populated, as Bruno writes them. */
const BOTH_SLOTS_YAML = `info:
  name: Checked Call
  type: http
  seq: 1
http:
  method: GET
  url: https://api.example.com/status
runtime:
  scripts:
    - type: after-response
      code: ${JSON.stringify(POST_CODE)}
    - type: tests
      code: ${JSON.stringify(TEST_CODE)}
`;

function createMockResponse(status = 200): Response {
  return {
    status,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    text: jest.fn().mockResolvedValue('{}'),
    ok: status >= 200 && status < 300,
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

function runnerReturning(
  results: Array<{ description: string; status: 'pass' | 'fail' }>,
): ScriptRunner {
  return {
    runPreRequestScript: jest.fn().mockResolvedValue({ variables: {}, mutations: {} }),
    runScript: jest.fn().mockResolvedValue({ results, variables: {} }),
  };
}

describe('.yml tests script slot (read side)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValue(createMockResponse());
  });

  it('runs a script stored in the tests slot', async () => {
    setupFs({ 'Checked Call.yml': TESTS_ONLY_YAML });
    const runner = runnerReturning([{ description: 'is ok', status: 'pass' }]);

    const result = await RequestExecutor.executeCollection('/test-collection', {
      scriptRunner: runner,
    });

    // The code actually handed to the sandbox — an unexecuted tests slot would
    // pass an empty string here and still report a green run.
    expect(runner.runScript).toHaveBeenCalledTimes(1);
    expect(jest.mocked(runner.runScript).mock.calls[0][0]).toContain('test("is ok"');

    expect(result.summary.tests).toEqual({ total: 1, passed: 1, failed: 0 });
    expect(result.summary.requestsWithoutTests).toBe(0);
  });

  it('does not report a request with a tests slot as having no tests', async () => {
    setupFs({ 'Checked Call.yml': TESTS_ONLY_YAML });

    const result = await RequestExecutor.executeCollection('/test-collection', {
      scriptRunner: runnerReturning([{ description: 'is ok', status: 'pass' }]),
    });

    expect(result.summary.requestsWithoutTests).toBe(0);
  });

  it('surfaces a failure from a tests-slot script', async () => {
    setupFs({ 'Checked Call.yml': TESTS_ONLY_YAML });

    const result = await RequestExecutor.executeCollection('/test-collection', {
      scriptRunner: runnerReturning([{ description: 'is ok', status: 'fail' }]),
    });

    expect(result.summary.tests).toEqual({ total: 1, passed: 0, failed: 1 });
    expect(result.summary.failed).toBe(1);
  });

  it('runs the after-response script before the tests script', async () => {
    setupFs({ 'Checked Call.yml': BOTH_SLOTS_YAML });
    const runner = runnerReturning([{ description: 'is ok', status: 'pass' }]);

    await RequestExecutor.executeCollection('/test-collection', {
      scriptRunner: runner,
    });

    const code = jest.mocked(runner.runScript).mock.calls[0][0];
    expect(code).toContain('bru.setVar("seen"');
    expect(code).toContain('test("is ok"');
    expect(code.indexOf('bru.setVar("seen"')).toBeLessThan(code.indexOf('test("is ok"'));
  });
});
