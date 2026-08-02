/**
 * How a run accounts for the tests it actually evaluated.
 *
 * The defect these tests pin down: the summary reported only REQUEST-level
 * counts, and derived `passed` by subtracting `failed` from the request total.
 * A run whose scripts never executed therefore produced exactly the same
 * summary as a run in which every assertion passed — which makes every
 * dropped-script and inert-feature bug invisible, because the suite goes green
 * either way.
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** No script, no assertions, no vars — nothing for the sandbox to evaluate. */
const NO_TESTS_YAML = `
info:
  name: Plain Call
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/ping"
`;

const SECOND_NO_TESTS_YAML = `
info:
  name: Another Plain Call
  type: http
  seq: 2
http:
  method: GET
  url: "https://api.example.com/pong"
`;

const WITH_TESTS_YAML = `
info:
  name: Checked Call
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/status"
runtime:
  scripts:
    - type: after-response
      code: |
        test("is ok", function() { expect(res.status).to.equal(200); });
`;

/** Declares assertions but no script: the sandbox must still evaluate them. */
const WITH_ASSERTIONS_YAML = `
info:
  name: Asserted Call
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/status"
assert:
  - name: res.status
    value: "200"
`;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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

/** A runner that reports exactly the test results it is handed. */
function runnerReturning(results: Array<{ description: string; status: 'pass' | 'fail' }>): ScriptRunner {
  return {
    runPreRequestScript: jest.fn().mockResolvedValue({ variables: {}, mutations: {} }),
    runScript: jest.fn().mockResolvedValue({ results, variables: {} }),
  };
}

describe('run-level test accounting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('a run that evaluated nothing', () => {
    it('reports zero evaluated tests instead of reading as an unqualified pass', async () => {
      setupFs({ 'Plain Call.yml': NO_TESTS_YAML, 'Another Plain Call.yml': SECOND_NO_TESTS_YAML });
      mockFetch.mockResolvedValue(createMockResponse());

      const result = await RequestExecutor.executeCollection('/test-collection');

      // The pre-existing request-level counts are unchanged: both requests
      // completed, so both "passed" in the only sense this summary ever meant.
      expect(result.summary.total).toBe(2);
      expect(result.summary.passed).toBe(2);
      expect(result.summary.failed).toBe(0);

      // The signal that was missing: nothing was actually verified.
      expect(result.summary.tests).toEqual({ total: 0, passed: 0, failed: 0 });
      expect(result.summary.requestsWithoutTests).toBe(2);
    });
  });

  describe('a run that did evaluate tests', () => {
    it('counts results at test level, not request level', async () => {
      setupFs({ 'Checked Call.yml': WITH_TESTS_YAML });
      mockFetch.mockResolvedValue(createMockResponse());

      const result = await RequestExecutor.executeCollection('/test-collection', {
        scriptRunner: runnerReturning([
          { description: 'a', status: 'pass' },
          { description: 'b', status: 'pass' },
          { description: 'c', status: 'fail' },
        ]),
      });

      // One request, three tests. The request-level and test-level counts are
      // different numbers, which is the whole point of reporting both.
      expect(result.summary.total).toBe(1);
      expect(result.summary.failed).toBe(1);
      expect(result.summary.passed).toBe(0);
      expect(result.summary.tests).toEqual({ total: 3, passed: 2, failed: 1 });
      expect(result.summary.requestsWithoutTests).toBe(0);
    });

    it('does not count a request that registered results as one without tests', async () => {
      setupFs({ 'Checked Call.yml': WITH_TESTS_YAML });
      mockFetch.mockResolvedValue(createMockResponse());

      const result = await RequestExecutor.executeCollection('/test-collection', {
        scriptRunner: runnerReturning([{ description: 'a', status: 'pass' }]),
      });

      expect(result.summary.passed).toBe(1);
      expect(result.summary.tests).toEqual({ total: 1, passed: 1, failed: 0 });
      expect(result.summary.requestsWithoutTests).toBe(0);
    });
  });

  describe('declared assertions that produced no result', () => {
    it('fails the request rather than reporting it green', async () => {
      setupFs({ 'Asserted Call.yml': WITH_ASSERTIONS_YAML });
      mockFetch.mockResolvedValue(createMockResponse());

      // The runner is handed two enabled assertions and reports nothing back.
      // Before, that was indistinguishable from "both passed".
      const result = await RequestExecutor.executeCollection('/test-collection', {
        scriptRunner: runnerReturning([]),
      });

      expect(result.summary.failed).toBe(1);
      expect(result.summary.passed).toBe(0);
      expect(result.groups[0]!.results[0].error).toMatch(/1 declared assertion/i);
      expect(result.groups[0]!.results[0].error).toMatch(/no result/i);
    });

    it('leaves a request with no declared assertions alone', async () => {
      setupFs({ 'Plain Call.yml': NO_TESTS_YAML });
      mockFetch.mockResolvedValue(createMockResponse());

      const result = await RequestExecutor.executeCollection('/test-collection', {
        scriptRunner: runnerReturning([]),
      });

      expect(result.groups[0]!.results[0].error).toBeUndefined();
      expect(result.summary.failed).toBe(0);
    });

    it('does not mask a pre-request script error with the dropped-assertion error', async () => {
      setupFs({
        'Asserted Call.yml': `${WITH_ASSERTIONS_YAML}
runtime:
  scripts:
    - type: before-request
      code: "throw new Error('boom')"
`,
      });
      mockFetch.mockResolvedValue(createMockResponse());

      const result = await RequestExecutor.executeCollection('/test-collection', {
        scriptRunner: {
          runPreRequestScript: jest.fn().mockResolvedValue({
            variables: {},
            mutations: {},
            error: 'pre-request script failed: boom',
          }),
          runScript: jest.fn().mockResolvedValue({ results: [], variables: {} }),
        },
      });

      expect(result.groups[0]!.results[0].error).toBe('pre-request script failed: boom');
      expect(result.summary.failed).toBe(1);
    });
  });
});
