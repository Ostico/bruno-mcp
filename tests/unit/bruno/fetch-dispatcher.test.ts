import { buildDispatcher } from '../../../src/bruno/fetch-dispatcher';
import { parseYamlRequest } from '../../../src/bruno/yaml-parser';

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

describe('buildDispatcher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return undefined when no TLS or proxy settings', async () => {
    const result = await buildDispatcher({});
    expect(result).toBeUndefined();
  });

  it('should return undefined when settings have unrelated fields only', async () => {
    const result = await buildDispatcher({ timeout: 5000, encodeUrl: true });
    expect(result).toBeUndefined();
  });

  it('should return Agent with rejectUnauthorized: false for self-signed certs', async () => {
    const result = await buildDispatcher({ tls: { rejectUnauthorized: false } });
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
    });
    expect(result).toBeDefined();
    expect((result!.dispatcher as any)._type).toBe('Agent');

    const undici = await import('undici');
    expect(undici.Agent).toHaveBeenCalledWith({
      connect: { ca: 'ca-data', cert: 'cert-data', key: 'key-data' },
    });
  });

  it('should return ProxyAgent when proxy is set', async () => {
    const result = await buildDispatcher({ proxy: 'http://proxy.example.com:8080' });
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
    });
    expect(result).toBeDefined();
    expect((result!.dispatcher as any)._type).toBe('ProxyAgent');

    const undici = await import('undici');
    expect(undici.ProxyAgent).toHaveBeenCalledWith({
      uri: 'http://proxy.example.com:8080',
      requestTls: { rejectUnauthorized: false },
    });
  });

  it('should return undici fetch function', async () => {
    const result = await buildDispatcher({ tls: { rejectUnauthorized: false } });
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

    const result = await buildDispatcher(yaml.settings!);
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
