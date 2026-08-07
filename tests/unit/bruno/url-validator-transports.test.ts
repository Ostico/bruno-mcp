import { validateUrl, resetAllowlistCache } from '../../../src/bruno/url-validator.js';

const GRPC = { allowedSchemes: ['grpc', 'grpcs'], defaultScheme: 'grpc' } as const;
const WS = { allowedSchemes: ['ws', 'wss'], defaultScheme: 'ws' } as const;

describe('the HTTP gate is unchanged', () => {
  const original = process.env.BRUNO_SSRF_ALLOWLIST;

  beforeEach(() => {
    process.env.BRUNO_SSRF_ALLOWLIST = '127.0.0.1';
    resetAllowlistCache();
  });
  afterEach(() => {
    if (original === undefined) delete process.env.BRUNO_SSRF_ALLOWLIST;
    else process.env.BRUNO_SSRF_ALLOWLIST = original;
    resetAllowlistCache();
  });

  // The whole point of the scheme parameter: widening it for a transport must not
  // widen it for the three existing HTTP call sites, including the redirect
  // re-check.
  it('still refuses grpc:// when no scheme set is supplied', async () => {
    const result = await validateUrl('grpc://127.0.0.1:50051');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Blocked scheme: grpc');
  });

  it('still refuses ws:// when no scheme set is supplied', async () => {
    expect((await validateUrl('ws://127.0.0.1:8080')).valid).toBe(false);
  });

  it('still accepts http and reports the addresses it pinned', async () => {
    const result = await validateUrl('http://127.0.0.1:8080/x');
    expect(result.valid).toBe(true);
    expect(result.addresses).toEqual(['127.0.0.1']);
  });
});

describe('the two new scheme classes do not behave alike', () => {
  const original = process.env.BRUNO_SSRF_ALLOWLIST;

  beforeEach(() => {
    process.env.BRUNO_SSRF_ALLOWLIST = '127.0.0.1';
    resetAllowlistCache();
  });
  afterEach(() => {
    if (original === undefined) delete process.env.BRUNO_SSRF_ALLOWLIST;
    else process.env.BRUNO_SSRF_ALLOWLIST = original;
    resetAllowlistCache();
  });

  // grpc: is not a special scheme, so the URL parser reads a backslash in the
  // authority as data. Measured: hostname comes back as evil.com.
  it('refuses backslash host confusion under grpc', async () => {
    const result = await validateUrl('grpc://127.0.0.1\\@evil.example:50051', GRPC);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('backslash in authority');
  });

  // ws: IS special, so the parser already resolved this to 127.0.0.1. Asserting a
  // refusal here would mean refusing a safe URL, so assert the safe outcome
  // instead — that is what the difference between the two classes means.
  //
  // The decoy survives, but as PATH data: the parser treats the backslash as a
  // path delimiter, so the result is `ws://127.0.0.1/@evil.example:8080`. Assert
  // on the host, not on the whole string — `evil.example` appearing in the path is
  // harmless, and a substring check would call a safe URL dangerous.
  it('accepts the same authority under ws, because the parser already made it safe', async () => {
    const result = await validateUrl('ws://127.0.0.1\\@evil.example:8080', WS);
    expect(result.valid).toBe(true);
    expect(new URL(result.normalisedUrl!).hostname).toBe('127.0.0.1');
    expect(result.addresses).toEqual(['127.0.0.1']);
  });

  it('lower-cases the host for a non-special scheme, which the parser does not', async () => {
    const result = await validateUrl('grpc://127.0.0.1:50051', GRPC);
    expect(result.valid).toBe(true);
    expect(result.normalisedUrl).toContain('127.0.0.1');
  });

  // grpcs:// parses with an empty hostname where wss:// throws. Both must be
  // refused, by different branches.
  it('refuses an empty authority under grpcs', async () => {
    const result = await validateUrl('grpcs://', { allowedSchemes: ['grpc', 'grpcs'] });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('empty hostname');
  });

  it('refuses an unparseable wss authority', async () => {
    const result = await validateUrl('wss://', { allowedSchemes: ['ws', 'wss'] });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('unable to parse');
  });
});

describe('a bare host:port target', () => {
  const original = process.env.BRUNO_SSRF_ALLOWLIST;

  beforeEach(() => {
    process.env.BRUNO_SSRF_ALLOWLIST = '127.0.0.1';
    resetAllowlistCache();
  });
  afterEach(() => {
    if (original === undefined) delete process.env.BRUNO_SSRF_ALLOWLIST;
    else process.env.BRUNO_SSRF_ALLOWLIST = original;
    resetAllowlistCache();
  });

  // `new URL('example.com:50051')` SUCCEEDS, yielding protocol 'example.com:'.
  // Only a digit-leading authority throws. So normalisation has to happen by
  // shape, before any parse attempt.
  it('accepts an IP:port target and pins the address', async () => {
    const result = await validateUrl('127.0.0.1:50051', GRPC);
    expect(result.valid).toBe(true);
    expect(result.addresses).toEqual(['127.0.0.1']);
    expect(result.normalisedUrl).toBe('grpc://127.0.0.1:50051');
  });

  it('does not mistake a hostname target for a scheme', async () => {
    const result = await validateUrl('localhost:50051', GRPC);
    // Refused for being loopback, NOT for "Blocked scheme: localhost".
    expect(result.valid).toBe(false);
    expect(result.reason).not.toContain('Blocked scheme');
  });

  it('leaves a target that already has a scheme alone', async () => {
    const result = await validateUrl('grpcs://127.0.0.1:50051', GRPC);
    expect(result.valid).toBe(true);
    expect(result.normalisedUrl).toContain('grpcs:');
  });
});

describe('the normalised URL is what a transport must dial', () => {
  const original = process.env.BRUNO_SSRF_ALLOWLIST;

  beforeEach(() => {
    process.env.BRUNO_SSRF_ALLOWLIST = 'allowed.example';
    resetAllowlistCache();
  });
  afterEach(() => {
    if (original === undefined) delete process.env.BRUNO_SSRF_ALLOWLIST;
    else process.env.BRUNO_SSRF_ALLOWLIST = original;
    resetAllowlistCache();
  });

  // An allowlisted hostname is deliberately NOT resolved, so there is nothing to
  // pin. A transport must notice and omit its pinned lookup rather than pass an
  // empty address list, which fails closed with ENOTFOUND.
  it('returns a normalised URL but no addresses on the allowlisted-hostname path', async () => {
    const result = await validateUrl('grpc://allowed.example:50051', GRPC);
    expect(result.valid).toBe(true);
    expect(result.addresses).toBeUndefined();
    expect(result.normalisedUrl).toBe('grpc://allowed.example:50051');
  });
});
