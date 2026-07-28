/**
 * Tests for the actionable half of a network failure.
 *
 * The failures themselves were reported correctly; what they lacked was any
 * indication of what the caller should do about them. These pin the two things
 * round 4 showed to matter: a timeout must not read as "the address is wrong",
 * and `fetch failed` must surface the socket-level cause that actually does
 * justify changing the URL.
 */

import { describeNetworkError } from '../../../src/bruno/network-error';

const CTX = { url: 'http://svc.internal.test/api', timeoutMs: 30000, elapsedMs: 30012 };

function timeoutError(): Error {
  const err = new Error('The operation was aborted due to timeout');
  err.name = 'TimeoutError';
  return err;
}

function fetchFailed(code: string, message = 'fetch failed'): Error {
  const err = new Error(message);
  (err as Error & { cause?: unknown }).cause = Object.assign(new Error(`socket: ${code}`), { code });
  return err;
}

describe('describeNetworkError — timeouts', () => {
  it('names the target and the elapsed time', () => {
    const msg = describeNetworkError(timeoutError(), CTX);
    expect(msg).toContain('http://svc.internal.test/api');
    expect(msg).toContain('30012ms');
  });

  it('names the setting that controls the limit and how to disable it', () => {
    const msg = describeNetworkError(timeoutError(), CTX);
    expect(msg).toContain('settings.timeout = 30000ms');
    expect(msg).toContain('set it to 0');
  });

  it('states that a timeout is not evidence the address is wrong', () => {
    // This is the whole point: round 4's agent switched scheme on a timeout,
    // wasted a run, then passed with the original URL unchanged.
    const msg = describeNetworkError(timeoutError(), CTX);
    expect(msg).toContain('not evidence that the URL, scheme or host is wrong');
    expect(msg).toContain('retrying the same request may succeed');
  });

  it('recognises a timeout by name even with an unfamiliar message', () => {
    const err = new Error('aborted');
    err.name = 'TimeoutError';
    expect(describeNetworkError(err, CTX)).toContain('timed out after');
  });

  it('recognises a timeout by message even with an unfamiliar name', () => {
    const err = new Error('This operation was aborted due to timeout');
    err.name = 'AbortError';
    expect(describeNetworkError(err, CTX)).toContain('timed out after');
  });

  it('flags an elapsed time well past the configured limit', () => {
    const msg = describeNetworkError(timeoutError(), { ...CTX, elapsedMs: 95867 });
    expect(msg).toContain('well past that limit');
    expect(msg).toContain('95867ms');
  });

  it('attributes the overrun to pre-request setup work, not an upload stall', () => {
    const msg = describeNetworkError(timeoutError(), { ...CTX, elapsedMs: 95867 });
    // The overrun is caused by work done before the abort signal is armed —
    // DNS resolution and connection setup — which settings.timeout cannot bound.
    // It is NOT an upload/request-body stall, which is what the old text claimed.
    expect(msg).not.toContain('request body');
    expect(msg).toMatch(/before .*timeout|DNS|resolution|connection/i);
    expect(msg).toContain('settings.timeout');
  });

  it('does not flag an overrun when elapsed is close to the limit', () => {
    const msg = describeNetworkError(timeoutError(), { ...CTX, elapsedMs: 31000 });
    expect(msg).not.toContain('well past that limit');
  });

  it('reports honestly when no limit was configured', () => {
    const msg = describeNetworkError(timeoutError(), { ...CTX, timeoutMs: 0 });
    expect(msg).toContain('No limit was configured');
    expect(msg).not.toContain('well past that limit');
  });
});

describe('describeNetworkError — socket causes', () => {
  it('explains a refused connection in terms of scheme and port', () => {
    const msg = describeNetworkError(fetchFailed('ECONNREFUSED'), CTX);
    expect(msg).toContain('ECONNREFUSED');
    expect(msg).toContain('Check the scheme and port');
    expect(msg).toContain('https:// URL against a plain-HTTP listener');
  });

  it.each(['ENOTFOUND', 'EAI_AGAIN'])('explains %s as a resolution failure', (code) => {
    expect(describeNetworkError(fetchFailed(code), CTX)).toContain('did not resolve');
  });

  it.each(['ECONNRESET', 'EPIPE'])('marks %s as probably transient', (code) => {
    expect(describeNetworkError(fetchFailed(code), CTX)).toContain('retrying the same request may succeed');
  });

  it.each([
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_HAS_EXPIRED',
  ])('separates a TLS rejection (%s) from unreachability', (code) => {
    const msg = describeNetworkError(fetchFailed(code), CTX);
    expect(msg).toContain('The address is reachable');
  });

  it.each(['EHOSTUNREACH', 'ENETUNREACH'])('reports %s as a routing failure', (code) => {
    expect(describeNetworkError(fetchFailed(code), CTX)).toContain('No route to that address');
  });

  it('still surfaces an unrecognised code, without inventing a hint', () => {
    const msg = describeNetworkError(fetchFailed('EWEIRD'), CTX);
    expect(msg).toContain('(EWEIRD)');
    expect(msg).toMatch(/failed after 30012ms: fetch failed \(EWEIRD\)\.?$/);
  });

  it('digs a code out of a nested cause chain', () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const middle = Object.assign(new Error('socket hang up'), { cause: inner });
    const outer = Object.assign(new Error('fetch failed'), { cause: middle });
    expect(describeNetworkError(outer, CTX)).toContain('ECONNREFUSED');
  });

  it('does not loop forever on a self-referencing cause chain', () => {
    const err: Error & { cause?: unknown } = new Error('fetch failed');
    err.cause = err;
    expect(() => describeNetworkError(err, CTX)).not.toThrow();
  });
});

describe('describeNetworkError — fallbacks', () => {
  it('appends a cause message when there is no code', () => {
    const err = Object.assign(new Error('fetch failed'), { cause: new Error('write EPROTO') });
    const msg = describeNetworkError(err, CTX);
    expect(msg).toContain('fetch failed (write EPROTO)');
  });

  it('does not repeat the cause when it duplicates the outer message', () => {
    const err = Object.assign(new Error('fetch failed'), { cause: new Error('fetch failed') });
    expect(describeNetworkError(err, CTX)).toBe(
      'Request to http://svc.internal.test/api failed after 30012ms: fetch failed',
    );
  });

  it('handles an error with no cause at all', () => {
    expect(describeNetworkError(new Error('boom'), CTX)).toBe(
      'Request to http://svc.internal.test/api failed after 30012ms: boom',
    );
  });

  it('handles a thrown non-Error', () => {
    expect(describeNetworkError('kaboom', CTX)).toContain('failed after 30012ms: kaboom');
  });

  it('handles null', () => {
    expect(describeNetworkError(null, CTX)).toContain('failed after 30012ms: null');
  });
});
