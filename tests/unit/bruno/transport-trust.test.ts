import {
  gateTls,
  hostAllowed,
  parseHostAllowlist,
  pinnedLookup,
  resetTransportTrustCache,
} from '../../../src/bruno/transport-trust.js';

// These two primitives used to be private to the undici dispatcher. They are the
// trust boundary every transport shares now, so their behaviour is pinned here
// rather than only being exercised through the HTTP path.
describe('gateTls', () => {
  const original = process.env.BRUNO_INSECURE_TLS_HOSTS;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    resetTransportTrustCache();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restored explicitly on both sides: the allowlist is process-global and
    // cached, so a leaked assignment would make every later assertion in this
    // worker pass for the wrong reason.
    if (original === undefined) delete process.env.BRUNO_INSECURE_TLS_HOSTS;
    else process.env.BRUNO_INSECURE_TLS_HOSTS = original;
    resetTransportTrustCache();
    warn.mockRestore();
  });

  it('drops a verification downgrade for a host that is not allowlisted', () => {
    delete process.env.BRUNO_INSECURE_TLS_HOSTS;
    expect(gateTls({ rejectUnauthorized: false }, 'internal.example')).toBeUndefined();
  });

  it('names the field it withheld and never its value', () => {
    delete process.env.BRUNO_INSECURE_TLS_HOSTS;
    gateTls({ rejectUnauthorized: false, ca: 'SECRET-PEM-MATERIAL' }, 'internal.example');
    const message = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toContain('rejectUnauthorized');
    expect(message).toContain('ca');
    expect(message).toContain('internal.example');
    expect(message).not.toContain('SECRET-PEM-MATERIAL');
  });

  it('honours the downgrade once the operator allowlists the host', () => {
    process.env.BRUNO_INSECURE_TLS_HOSTS = 'internal.example';
    resetTransportTrustCache();
    expect(gateTls({ rejectUnauthorized: false }, 'internal.example')).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('keeps an explicit rejectUnauthorized true floor when dropping trust material', () => {
    delete process.env.BRUNO_INSECURE_TLS_HOSTS;
    expect(gateTls({ rejectUnauthorized: true, key: 'k' }, 'internal.example')).toEqual({
      rejectUnauthorized: true,
    });
  });

  it('passes an unprivileged block through untouched', () => {
    expect(gateTls({ rejectUnauthorized: true }, 'anywhere.example')).toEqual({
      rejectUnauthorized: true,
    });
  });

  it('returns undefined when there is no tls block at all', () => {
    expect(gateTls(undefined, 'anywhere.example')).toBeUndefined();
  });
});

describe('parseHostAllowlist', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('refuses a wildcard entry, which would defeat an explicit allowlist', () => {
    const set = parseHostAllowlist('good.example,*.evil.example');
    expect(set.has('good.example')).toBe(true);
    expect(set.size).toBe(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('wildcard');
  });

  it('matches case-insensitively and ignores blank entries', () => {
    const set = parseHostAllowlist(' Good.Example , ,other.example ');
    expect(hostAllowed('GOOD.EXAMPLE', set)).toBe(true);
    expect(set.size).toBe(2);
  });

  it('treats an unset variable as an empty allowlist', () => {
    expect(parseHostAllowlist(undefined).size).toBe(0);
  });
});

describe('pinnedLookup', () => {
  it('answers single mode with the validated address', () => {
    const cb = jest.fn();
    pinnedLookup(['127.0.0.1'])('ignored.example', undefined, cb);
    expect(cb).toHaveBeenCalledWith(null, '127.0.0.1', 4);
  });

  it('answers all mode with every validated address', () => {
    const cb = jest.fn();
    pinnedLookup(['127.0.0.1', '::1'])('ignored.example', { all: true }, cb);
    expect(cb).toHaveBeenCalledWith(null, [
      { address: '127.0.0.1', family: 4 },
      { address: '::1', family: 6 },
    ]);
  });

  it('honours a requested address family', () => {
    const cb = jest.fn();
    pinnedLookup(['127.0.0.1', '::1'])('ignored.example', { family: 6 }, cb);
    expect(cb).toHaveBeenCalledWith(null, '::1', 6);
  });

  // The behaviour every caller has to know about: an empty list does NOT mean
  // "resolve normally". A caller with no pinned address must omit the lookup
  // rather than pass [], or the connection fails as if DNS had failed.
  it('fails closed on an empty address list rather than falling back to DNS', () => {
    const cb = jest.fn();
    pinnedLookup([])('ignored.example', undefined, cb);
    const err = cb.mock.calls[0][0] as NodeJS.ErrnoException;
    expect(err.code).toBe('ENOTFOUND');
    expect(cb.mock.calls[0][1]).toBeUndefined();
  });

  it('fails closed when no validated address matches the requested family', () => {
    const cb = jest.fn();
    pinnedLookup(['127.0.0.1'])('ignored.example', { family: 6 }, cb);
    expect((cb.mock.calls[0][0] as NodeJS.ErrnoException).code).toBe('ENOTFOUND');
  });
});
