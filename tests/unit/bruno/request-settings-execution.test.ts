/**
 * What an authored `settings` block actually changes at run time.
 *
 * The file-level tests next door prove the bytes land on disk. These prove the
 * two behaviours that made the block worth authoring in the first place, by
 * writing a request with the real builder and then running it — so a break
 * anywhere along schema, input type, writer, parser or executor fails here.
 *
 * A purely file-level test would not have caught the original defect: the block
 * was already parsed and already honoured by the executor. Only the authoring
 * end was missing, and only an end-to-end run covers the join.
 */

import { createRequestBuilder, RequestBuilder } from '../../../src/bruno/request';
import { createCollectionManager } from '../../../src/bruno/collection';
import { RequestExecutor } from '../../../src/bruno/request-executor';
import { TestRunner } from '../../../src/bruno/test-runner';
import type { RequestSettingsInput } from '../../../src/bruno/types';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mocked rather than served over a loopback socket: a real server passes locally
// and fails CI on undici state another test file owns.
const mockFetch = jest.fn();
(global as unknown as { fetch: unknown }).fetch = mockFetch;

jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
  ssrfRemediation: jest.fn().mockReturnValue('REMEDIATION_SENTINEL'),
}));

jest.mock('../../../src/bruno/fetch-dispatcher', () => ({
  buildDispatcher: jest.fn().mockResolvedValue(undefined),
}));

let builder: RequestBuilder;

beforeEach(() => {
  builder = createRequestBuilder();
  mockFetch.mockReset();
});

function response(init: { status: number; headers?: Record<string, string>; body?: string }): Response {
  return {
    status: init.status,
    statusText: init.status === 302 ? 'Found' : 'OK',
    headers: new Headers(init.headers ?? {}),
    text: async () => init.body ?? '{}',
    ok: init.status < 400,
  } as unknown as Response;
}

/**
 * Author a request into a fresh single-request collection and run it.
 *
 * The collection holds exactly this request, so `results[0]` is unambiguous.
 */
async function authorAndRun(
  format: 'bru' | 'yaml',
  settings: RequestSettingsInput | undefined,
  scripts?: Record<string, string>,
) {
  const tmpDir = await fs.mkdtemp(join(tmpdir(), `bruno-settings-run-${format}-`));
  const created = await createCollectionManager().createCollection({
    name: 'RunAPI',
    outputPath: tmpDir,
    format,
  });
  if (!created.success) throw new Error(`collection setup failed: ${created.error}`);
  const collectionPath = join(tmpDir, 'RunAPI');

  const request = await builder.createRequest({
    collectionPath,
    name: 'Reset Password',
    method: 'POST',
    url: 'https://api.example.com/reset',
    ...(settings ? { settings } : {}),
    ...(scripts ? { scripts } : {}),
  });
  if (!request.success) throw new Error(`create failed: ${request.error}`);

  // TestRunner opts out of the process boundary on purpose: forking needs the
  // built worker at dist/, which this lane does not produce.
  const run = await RequestExecutor.executeCollection(collectionPath, {
    scriptRunner: TestRunner,
  });
  return run.results[0];
}

describe('an authored followRedirects: false stops the redirect being followed', () => {
  /** A 302 carrying the session cookie, then the 200 it points at. */
  function stubRedirectChain(): void {
    mockFetch
      .mockResolvedValueOnce(
        response({
          status: 302,
          headers: {
            location: 'https://api.example.com/reset/done',
            'set-cookie': 'session=abc123; Path=/',
          },
        }),
      )
      .mockResolvedValueOnce(response({ status: 200 }));
  }

  it.each(['bru', 'yaml'] as const)(
    'returns the 302 itself and makes only one request (%s)',
    async (format) => {
      stubRedirectChain();
      const result = await authorAndRun(format, { followRedirects: false });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(302);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    },
  );

  it('leaves the Set-Cookie from the 302 visible to a test script', async () => {
    // The field failure this guards. Following the redirect consumes the 3xx and
    // the caller only ever sees the final response, so a reset endpoint that does
    // hand back its session cookie alongside the 302 looks like one that issued
    // no cookie at all, and the next call 500s as unauthenticated.
    stubRedirectChain();
    const result = await authorAndRun('yaml', { followRedirects: false }, {
      tests: 'test("the session cookie is visible", function () {\n' +
        '  expect(res.getHeader("set-cookie")).to.equal("session=abc123; Path=/");\n' +
        '});',
    });

    expect(result.error).toBeUndefined();
    expect(result.tests).toEqual([
      expect.objectContaining({ description: 'the session cookie is visible', status: 'pass' }),
    ]);
  });

  it('follows the redirect when no settings block was authored', async () => {
    // The control, and the reason the block has to be authorable at all: absent
    // settings mean `followRedirects !== false`, so the hop is taken and the
    // cookie on the 302 is gone by the time the caller sees a response.
    stubRedirectChain();
    const result = await authorAndRun('yaml', undefined);

    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('still follows the redirect when followRedirects is authored true', async () => {
    stubRedirectChain();
    const result = await authorAndRun('yaml', { followRedirects: true });

    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('an authored settings.timeout raises the script budget past 5000ms', () => {
  /**
   * Sleeps longer than the 5000ms default budget. The sandbox clamps a sleep to
   * the remaining budget and reports the timeout itself, so this either
   * completes (budget raised) or errors (budget still 5000ms) — the two outcomes
   * are distinguishable without measuring elapsed time.
   */
  const SLEEP_MS = 6000;
  const sleepingTest =
    `test("outlasts the default budget", async function () {\n` +
    `  await bru.sleep(${SLEEP_MS});\n` +
    `  expect(1).to.equal(1);\n` +
    `});`;

  beforeEach(() => {
    mockFetch.mockResolvedValue(response({ status: 200 }));
  });

  it.each(['bru', 'yaml'] as const)(
    'lets a script outlast 5000ms when timeout is authored (%s)',
    async (format) => {
      const result = await authorAndRun(format, { timeout: 30000 }, { tests: sleepingTest });

      expect(result.tests).toEqual([
        expect.objectContaining({ description: 'outlasts the default budget', status: 'pass' }),
      ]);
    },
    30_000,
  );

  it('aborts the same script at 5000ms when no timeout is authored', async () => {
    // The control. Without an authorable settings block this was the only
    // reachable behaviour, and the 5000ms cap could not be lifted from the
    // server at all.
    const result = await authorAndRun('yaml', undefined, { tests: sleepingTest });

    const passed = (result.tests ?? []).filter((t) => t.status === 'pass');
    expect(passed).toEqual([]);
  }, 30_000);

  it('lowers the budget too, when a smaller timeout is authored', async () => {
    // Proves the authored number is what governs, rather than the raised case
    // merely coinciding with some larger built-in ceiling.
    const result = await authorAndRun('yaml', { timeout: 500 }, {
      tests:
        'test("finishes inside a 500ms budget", async function () {\n' +
        '  await bru.sleep(2000);\n' +
        '  expect(1).to.equal(1);\n' +
        '});',
    });

    const passed = (result.tests ?? []).filter((t) => t.status === 'pass');
    expect(passed).toEqual([]);
  }, 30_000);
});
