/**
 * The script budget when `settings.timeout` is zero.
 *
 * Upstream spells "no limit" as `0`, and `@usebruno/lang` injects `timeout: 0`
 * into **every** `.bru` settings block — so a request whose block says only
 * `encodeUrl: true` reaches the executor carrying a zero nobody wrote. The
 * script budget was `settings?.timeout ?? 5000`, and `0` is not nullish, so the
 * zero went to the worker, which refuses it:
 *
 *   RangeError [ERR_OUT_OF_RANGE]: The value of "options.timeout" is out of
 *   range. It must be >= 1 && <= 4294967295. Received 0
 *
 * The script never ran, and the failure was reported as `Script error` — which
 * reads as the user's code being wrong rather than a settings block they may not
 * have written by hand. Any `.bru` request with both a settings block and a
 * script hit this, which is most of the ones worth writing.
 */
import { scriptTimeoutMs, DEFAULT_SCRIPT_TIMEOUT_MS } from '../../../src/bruno/script-timeout';
import { RequestExecutor } from '../../../src/bruno/request-executor';
import { TestRunner } from '../../../src/bruno/test-runner';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const mockFetch = jest.fn();
(global as unknown as { fetch: unknown }).fetch = mockFetch;

jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockResolvedValue({ valid: true }),
  ssrfRemediation: jest.fn().mockReturnValue(''),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Map(),
    text: async () => '{}',
    json: async () => ({}),
  });
});

const bru = (settings: string): string => `meta {
  name: R
  type: http
  seq: 1
}

get {
  url: https://e.com/x
  auth: none
}
${settings}
tests {
  test("runs", function() { expect(1).to.equal(1); });
}
`;

async function runBru(content: string): Promise<Array<Record<string, unknown>>> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'script-timeout-'));
  await fs.writeFile(join(dir, 'R.bru'), content);
  const result = await RequestExecutor.executeCollection(dir, { scriptRunner: TestRunner });
  return (result.results?.[0]?.tests ?? []) as Array<Record<string, unknown>>;
}

describe('choosing the script budget', () => {
  it('falls back to the default for a zero, which upstream means as "no limit"', () => {
    expect(scriptTimeoutMs({ timeout: 0 })).toBe(DEFAULT_SCRIPT_TIMEOUT_MS);
  });

  it('falls back to the default when no timeout was declared', () => {
    expect(scriptTimeoutMs(undefined)).toBe(DEFAULT_SCRIPT_TIMEOUT_MS);
    expect(scriptTimeoutMs({})).toBe(DEFAULT_SCRIPT_TIMEOUT_MS);
  });

  it('honours a real budget', () => {
    expect(scriptTimeoutMs({ timeout: 20000 })).toBe(20000);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'falls back for %p, which the worker cannot take either',
    (timeout) => {
      expect(scriptTimeoutMs({ timeout })).toBe(DEFAULT_SCRIPT_TIMEOUT_MS);
    },
  );

  it('ignores a non-numeric timeout rather than passing it through', () => {
    expect(scriptTimeoutMs({ timeout: 'inherit' })).toBe(DEFAULT_SCRIPT_TIMEOUT_MS);
  });
});

describe('a .bru request whose settings block does not mention a timeout', () => {
  it('runs its tests instead of failing with a RangeError', async () => {
    // The block says only encodeUrl. The parser adds timeout: 0 on its own.
    const tests = await runBru(bru('\nsettings {\n  encodeUrl: true\n}\n'));

    expect(tests).toEqual([expect.objectContaining({ description: 'runs', status: 'pass' })]);
  });

  it('reports no Script error', async () => {
    const tests = await runBru(bru('\nsettings {\n  encodeUrl: true\n}\n'));

    expect(tests.map((t) => t.description)).not.toContain('Script error');
  });

  it('still runs its tests with no settings block at all', async () => {
    const tests = await runBru(bru(''));

    expect(tests).toEqual([expect.objectContaining({ description: 'runs', status: 'pass' })]);
  });

  it('still runs its tests when the block sets a real timeout', async () => {
    const tests = await runBru(bru('\nsettings {\n  timeout: 20000\n}\n'));

    expect(tests).toEqual([expect.objectContaining({ description: 'runs', status: 'pass' })]);
  });
});
