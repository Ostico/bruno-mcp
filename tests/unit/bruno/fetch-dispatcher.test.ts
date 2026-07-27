import { buildDispatcher, resetDispatcherTrustCache } from '../../../src/bruno/fetch-dispatcher';
import { parseYamlRequest } from '../../../src/bruno/yaml-parser';

// The host these tests pass to buildDispatcher; the operator allowlists it so
// the collection's TLS/proxy overrides are honoured (the opt-in path).
const ALLOWED_HOST = 'trusted.test';

// Mock undici
jest.mock('undici', () => {
  const Agent = jest.fn().mockImplementation((opts: any) => ({
    _type: 'Agent',
    _opts: opts,
  }));
  const ProxyAgent = jest.fn().mockImplementation((opts: any) => ({
    _type: 'ProxyAgent',
    _opts: opts,
  }));
  const fetch = jest.fn();
  return { Agent, ProxyAgent, fetch };
});

describe('buildDispatcher (host allowlisted — the operator opt-in path)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.BRUNO_INSECURE_TLS_HOSTS = ALLOWED_HOST;
    process.env.BRUNO_PROXY_HOSTS = ALLOWED_HOST;
    resetDispatcherTrustCache();
  });

  afterEach(() => {
    delete process.env.BRUNO_INSECURE_TLS_HOSTS;
    delete process.env.BRUNO_PROXY_HOSTS;
    resetDispatcherTrustCache();
  });

  it('should return undefined when no TLS or proxy settings', async () => {
    const result = await buildDispatcher({}, ALLOWED_HOST);
    expect(result).toBeUndefined();
  });

  it('should return undefined when settings have unrelated fields only', async () => {
    const result = await buildDispatcher({ timeout: 5000, encodeUrl: true }, ALLOWED_HOST);
    expect(result).toBeUndefined();
  });

  it('should return Agent with rejectUnauthorized: false for self-signed certs', async () => {
    const result = await buildDispatcher({ tls: { rejectUnauthorized: false } }, ALLOWED_HOST);
    expect(result).toBeDefined();
    expect(result!.dispatcher).toBeDefined();
    expect((result!.dispatcher as any)._type).toBe('Agent');

    const undici = await import('undici');
    expect(undici.Agent).toHaveBeenCalledWith({
      connect: { rejectUnauthorized: false },
    });
  });

  it('should return Agent with ca/cert/key for client certs', async () => {
    const result = await buildDispatcher({
      tls: { ca: 'ca-data', cert: 'cert-data', key: 'key-data' },
    }, ALLOWED_HOST);
    expect(result).toBeDefined();
    expect((result!.dispatcher as any)._type).toBe('Agent');

    const undici = await import('undici');
    expect(undici.Agent).toHaveBeenCalledWith({
      connect: { ca: 'ca-data', cert: 'cert-data', key: 'key-data' },
    });
  });

  it('should return ProxyAgent when proxy is set', async () => {
    const result = await buildDispatcher({ proxy: 'http://proxy.example.com:8080' }, ALLOWED_HOST);
    expect(result).toBeDefined();
    expect((result!.dispatcher as any)._type).toBe('ProxyAgent');

    const undici = await import('undici');
    expect(undici.ProxyAgent).toHaveBeenCalledWith({
      uri: 'http://proxy.example.com:8080',
    });
  });

  it('should return ProxyAgent with TLS options when both proxy and tls are set', async () => {
    const result = await buildDispatcher({
      proxy: 'http://proxy.example.com:8080',
      tls: { rejectUnauthorized: false },
    }, ALLOWED_HOST);
    expect(result).toBeDefined();
    expect((result!.dispatcher as any)._type).toBe('ProxyAgent');

    const undici = await import('undici');
    expect(undici.ProxyAgent).toHaveBeenCalledWith({
      uri: 'http://proxy.example.com:8080',
      requestTls: { rejectUnauthorized: false },
    });
  });

  it('should build an Agent when only tls.cert is set (no rejectUnauthorized or ca)', async () => {
    const result = await buildDispatcher({ tls: { cert: 'cert-only-data' } }, ALLOWED_HOST);
    expect(result).toBeDefined();
    expect((result!.dispatcher as any)._type).toBe('Agent');

    const undici = await import('undici');
    expect(undici.Agent).toHaveBeenCalledWith({
      connect: { cert: 'cert-only-data' },
    });
  });

  it('should build an Agent when only tls.key is set (no rejectUnauthorized, ca, or cert)', async () => {
    const result = await buildDispatcher({ tls: { key: 'key-only-data' } }, ALLOWED_HOST);
    expect(result).toBeDefined();
    expect((result!.dispatcher as any)._type).toBe('Agent');

    const undici = await import('undici');
    expect(undici.Agent).toHaveBeenCalledWith({
      connect: { key: 'key-only-data' },
    });
  });

  it('should return undefined when tls is an empty object (no fields set)', async () => {
    const result = await buildDispatcher({ tls: {} }, ALLOWED_HOST);
    expect(result).toBeUndefined();
  });

  it('should return undici fetch function', async () => {
    const result = await buildDispatcher({ tls: { rejectUnauthorized: false } }, ALLOWED_HOST);
    expect(result).toBeDefined();
    expect(result!.fetch).toBeDefined();
    expect(typeof result!.fetch).toBe('function');
  });

  it('produces a dispatcher from settings parsed out of a .yml request (tls + proxy round-trip)', async () => {
    const yaml = parseYamlRequest(`
info:
  name: TLS Proxy
  type: http
  seq: 1
http:
  method: GET
  url: "https://example.com/api"
settings:
  tls:
    rejectUnauthorized: false
    ca: ca-pem-data
    cert: cert-pem-data
    key: key-pem-data
  proxy: "http://proxy.example.com:8080"
`);

    const result = await buildDispatcher(yaml.settings!, ALLOWED_HOST);
    expect(result).toBeDefined();
    expect((result!.dispatcher as any)._type).toBe('ProxyAgent');

    const undici = await import('undici');
    expect(undici.ProxyAgent).toHaveBeenCalledWith({
      uri: 'http://proxy.example.com:8080',
      requestTls: {
        rejectUnauthorized: false,
        ca: 'ca-pem-data',
        cert: 'cert-pem-data',
        key: 'key-pem-data',
      },
    });
  });
});

describe('buildDispatcher — collection TLS/proxy denied by default (S10/S11/S12)', () => {
  // These run with BRUNO_INSECURE_TLS_HOSTS / BRUNO_PROXY_HOSTS unset, so a
  // collection's dangerous overrides must be ignored rather than honored.
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BRUNO_INSECURE_TLS_HOSTS;
    delete process.env.BRUNO_PROXY_HOSTS;
    resetDispatcherTrustCache();
  });

  afterEach(() => {
    delete process.env.BRUNO_INSECURE_TLS_HOSTS;
    delete process.env.BRUNO_PROXY_HOSTS;
    resetDispatcherTrustCache();
  });

  it('ignores rejectUnauthorized:false for a non-allowlisted host', async () => {
    const result = await buildDispatcher({ tls: { rejectUnauthorized: false } }, 'evil.test');
    // No safe TLS setting remains and no proxy, so no custom dispatcher: the
    // request falls back to verifying global fetch.
    expect(result).toBeUndefined();
  });

  it('ignores custom ca/cert/key for a non-allowlisted host', async () => {
    const result = await buildDispatcher(
      { tls: { ca: 'ca-data', cert: 'cert-data', key: 'key-data' } },
      'evil.test',
    );
    expect(result).toBeUndefined();
  });

  it('ignores a collection-supplied proxy for a non-allowlisted host', async () => {
    const result = await buildDispatcher({ proxy: 'http://attacker.test:8080' }, 'evil.test');
    expect(result).toBeUndefined();
  });

  it('does not echo secret TLS material or the proxy value in the warning', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await buildDispatcher(
      { tls: { rejectUnauthorized: false, ca: 'SECRET-CA', key: 'SECRET-KEY' }, proxy: 'http://user:pw@p.test' },
      'evil.test',
    );
    const emitted = warn.mock.calls.map(c => c.join(' ')).join('\n');
    expect(emitted).not.toContain('SECRET-CA');
    expect(emitted).not.toContain('SECRET-KEY');
    expect(emitted).not.toContain('user:pw');
    warn.mockRestore();
  });

  it('denies when the host is not the one the operator allowlisted', async () => {
    process.env.BRUNO_INSECURE_TLS_HOSTS = 'good.test';
    resetDispatcherTrustCache();
    const result = await buildDispatcher({ tls: { rejectUnauthorized: false } }, 'evil.test');
    expect(result).toBeUndefined();
  });

  it('denies when no target host is known (host-less call)', async () => {
    process.env.BRUNO_INSECURE_TLS_HOSTS = 'good.test';
    resetDispatcherTrustCache();
    const result = await buildDispatcher({ tls: { rejectUnauthorized: false } });
    expect(result).toBeUndefined();
  });

  it('silently ignores a wildcard allowlist entry', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.BRUNO_INSECURE_TLS_HOSTS = '*';
    resetDispatcherTrustCache();
    const result = await buildDispatcher({ tls: { rejectUnauthorized: false } }, 'evil.test');
    expect(result).toBeUndefined(); // wildcard did NOT grant access
    expect(warn.mock.calls.map(c => c.join(' ')).join('\n')).toMatch(/wildcard/i);
    warn.mockRestore();
  });

  it('keeps an explicit rejectUnauthorized:true floor while stripping a denied custom CA', async () => {
    // Privileged (has ca) so it hits the deny path, but the secure floor survives.
    const result = await buildDispatcher(
      { tls: { rejectUnauthorized: true, ca: 'ca-data' } },
      'evil.test',
    );
    expect(result).toBeDefined();
    const undici = await import('undici');
    expect(undici.Agent).toHaveBeenCalledWith({ connect: { rejectUnauthorized: true } });
  });

  it('honors a plain rejectUnauthorized:true without any opt-in (not a downgrade)', async () => {
    const result = await buildDispatcher({ tls: { rejectUnauthorized: true } }, 'evil.test');
    expect(result).toBeDefined();
    const undici = await import('undici');
    expect(undici.Agent).toHaveBeenCalledWith({ connect: { rejectUnauthorized: true } });
  });

  it('drops empty and whitespace allowlist entries without granting access', async () => {
    process.env.BRUNO_PROXY_HOSTS = ' , ,';
    resetDispatcherTrustCache();
    const result = await buildDispatcher({ proxy: 'http://p.test' }, 'evil.test');
    expect(result).toBeUndefined();
  });

  it('denies a collection proxy when no target host is known', async () => {
    const result = await buildDispatcher({ proxy: 'http://p.test' });
    expect(result).toBeUndefined();
  });
});
