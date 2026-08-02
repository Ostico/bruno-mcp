/**
 * EMFILE names the limit it hit.
 *
 * There is deliberately no fd-derived concurrency cap — the open-files soft
 * limit is around a million on a normal host, so sizing a run against it would
 * be fortune-telling. The honest alternative is to make the rare failure
 * diagnosable the moment it happens: a bare `connect EMFILE` reads as a network
 * fault, and a caller who believes that goes looking at the target instead of
 * at `ulimit -n` and their own maxConcurrency.
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describeNetworkError } from '../../../src/bruno/network-error';
import { RequestExecutor } from '../../../src/bruno/request-executor';
import { TestRunner } from '../../../src/bruno/test-runner';

const mockFetch = jest.fn();
(global as unknown as { fetch: unknown }).fetch = mockFetch;

jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockResolvedValue({ valid: true }),
  ssrfRemediation: jest.fn().mockReturnValue(''),
}));

const emfile = (): Error =>
  Object.assign(new Error('connect EMFILE'), { code: 'EMFILE' });

const softLimit = (): number | undefined => {
  const report = process.report?.getReport() as
    | { userLimits?: { open_files?: { soft?: unknown } } }
    | undefined;
  const soft = report?.userLimits?.open_files?.soft;

  return typeof soft === 'number' ? soft : undefined;
};

beforeEach(() => {
  jest.restoreAllMocks();
  mockFetch.mockReset();
});

describe('describing an EMFILE failure', () => {
  it('quotes this process’s open-files soft limit', () => {
    const soft = softLimit();
    // Not a conditional assertion: a platform that reports no figure is the
    // other test below, and this one is meaningless if the figure is missing.
    expect(soft).toBeDefined();

    const message = describeNetworkError(emfile(), {
      url: 'https://api.example.com/x',
      timeoutMs: 0,
      elapsedMs: 12,
    });

    expect(message).toContain('EMFILE');
    expect(message).toContain(String(soft));
    expect(message).toContain('ulimit -n');
  });

  it('says the descriptors ran out rather than blaming the target', () => {
    const message = describeNetworkError(emfile(), {
      url: 'https://api.example.com/x',
      timeoutMs: 0,
      elapsedMs: 12,
    });

    // The whole point. Without this the message is indistinguishable from the
    // host being down, which is the wrong thing to go and check.
    expect(message).toContain('nothing is wrong with the target');
  });

  it('still explains itself on a platform that reports no limit', () => {
    // Windows reports an empty userLimits. Throwing inside an error handler
    // would replace a diagnosable failure with an undiagnosable one.
    jest.spyOn(process.report!, 'getReport').mockReturnValue({} as never);

    const message = describeNetworkError(emfile(), {
      url: 'https://api.example.com/x',
      timeoutMs: 0,
      elapsedMs: 12,
    });

    expect(message).toContain('EMFILE');
    expect(message).toContain('would not report its open-files limit');
    expect(message).toContain('ulimit -n');
  });

  it('leaves an unrelated socket error alone', () => {
    // The limit belongs to EMFILE only; quoting it on every failure would make
    // it noise, and noise is what the bare message already was.
    const message = describeNetworkError(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      { url: 'https://api.example.com/x', timeoutMs: 0, elapsedMs: 12 },
    );

    expect(message).not.toContain('open-files');
  });
});

describe('an EMFILE that surfaces through a run', () => {
  it('reaches the caller on the result of the request that hit it', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'emfile-'));
    await fs.writeFile(
      join(root, 'get.yml'),
      `info:
  name: get
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/get"
`,
    );
    mockFetch.mockRejectedValue(emfile());

    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: TestRunner,
    });

    const error = result.groups[0]!.results[0]!.error ?? '';
    expect(error).toContain('EMFILE');
    expect(error).toContain(String(softLimit()));
  });
});
