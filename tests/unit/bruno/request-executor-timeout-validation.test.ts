/**
 * `settings.timeout` comes from a collection file and is not validated by the
 * parser, so the executor has to survive whatever is in it.
 *
 * Two verified Node behaviours drive these tests:
 *   - `AbortSignal.timeout(2 ** 31)` does NOT throw. It emits a
 *     TimeoutOverflowWarning and silently sets the duration to 1 ms, so every
 *     request fails as an immediate timeout.
 *   - `AbortSignal.timeout()` THROWS ERR_OUT_OF_RANGE for a fractional value,
 *     for anything above the 32-bit ceiling, and for NaN/Infinity. Constructed
 *     outside the try/catch, that escaped executeSingleRequest unwrapped
 *     instead of being reported as a failed request.
 */

import { RequestExecutor } from '../../../src/bruno/request-executor';
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

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function requestYaml(timeout: string): string {
  return `
info:
  name: Timed Call
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/ping"
settings:
  timeout: ${timeout}
`;
}

function createMockResponse(): Response {
  return {
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    text: jest.fn().mockResolvedValue('{}'),
    ok: true,
  } as unknown as Response;
}

function setupFs(content: string): void {
  mockedFs.readdir.mockImplementation(async () =>
    [{ name: 'Timed Call.yml', isFile: () => true, isDirectory: () => false }] as any,
  );
  mockedFs.readFile.mockImplementation(async () => content);
}

/** The AbortSignal the executor handed to fetch, if any. */
function signalOf(call: number): AbortSignal | undefined {
  return (mockFetch.mock.calls[call][1] as RequestInit).signal as AbortSignal | undefined;
}

async function run(timeout: string) {
  setupFs(requestYaml(timeout));
  mockFetch.mockResolvedValue(createMockResponse());
  return RequestExecutor.executeCollection('/test-collection');
}

describe('settings.timeout validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('values Node accepts as-is', () => {
    it('passes an ordinary integer timeout through', async () => {
      const result = await run('5000');
      expect(result.results[0].error).toBeUndefined();
      expect(signalOf(0)).toBeInstanceOf(AbortSignal);
    });

    it('sends no signal at all when the timeout is 0', async () => {
      const result = await run('0');
      expect(result.results[0].error).toBeUndefined();
      expect(signalOf(0)).toBeUndefined();
    });
  });

  describe('values that would throw out of the try', () => {
    it.each([
      ['a fractional timeout', '1.5'],
      ['a timeout past the 32-bit ceiling', '5e9'],
      ['an infinite timeout', '.inf'],
      ['a negative timeout', '-1'],
    ])('completes the run for %s rather than throwing out of it', async (_label, value) => {
      // What matters is that executeCollection RESOLVES. Before the fix the
      // ERR_OUT_OF_RANGE was constructed outside the try, so it propagated out
      // of executeCollection and failed the whole run instead of one request.
      const result = await run(value);
      expect(result.summary.total).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('truncates a fractional timeout to whole milliseconds', async () => {
      const result = await run('1500.7');
      expect(result.results[0].error).toBeUndefined();
      expect(signalOf(0)).toBeInstanceOf(AbortSignal);
    });
  });

  describe('the silent-1ms trap', () => {
    it('does not let a timeout above the ceiling collapse to a 1ms deadline', async () => {
      // 2 ** 31 does not throw: Node warns and sets the duration to 1 ms, which
      // turns every request into an instant timeout. Refusing to build a signal
      // is the only reading that is not actively wrong.
      const result = await run(String(2 ** 31));

      expect(signalOf(0)).toBeUndefined();
      expect(result.results[0].warnings).toEqual(
        expect.arrayContaining([expect.stringContaining(String(MAX_TIMEOUT_MS))]),
      );
    });

    it('treats an infinite timeout as no timeout', async () => {
      const result = await run('.inf');
      expect(signalOf(0)).toBeUndefined();
      expect(result.results[0].warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('no timeout')]),
      );
    });
  });

  describe('values that are not numbers', () => {
    it('falls back to the default and warns when the timeout is not a number', async () => {
      const result = await run('.nan');

      expect(signalOf(0)).toBeInstanceOf(AbortSignal);
      expect(result.results[0].warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('not a number')]),
      );
    });
  });
});
