import { validateUrl, parseAllowlist, resetAllowlistCache } from '../../../src/bruno/url-validator.js';

// DNS resolution is mocked so hostname-based tests are deterministic and never
// touch the network. Public test domains resolve to a public IP; unknown hosts
// reject (ENOTFOUND). Individual tests can override the map.
jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(),
}));
import { lookup } from 'node:dns/promises';
const mockLookup = lookup as unknown as jest.Mock;

// Hostname -> resolved addresses. Mutated by tests that need custom resolution.
let dnsMap: Record<string, string[]>;

beforeEach(() => {
  dnsMap = {
    'api.example.com': ['93.184.216.34'],
    'example.com': ['93.184.216.34'],
  };
  mockLookup.mockReset();
  mockLookup.mockImplementation(async (hostname: string) => {
    const addrs = dnsMap[hostname];
    if (!addrs) {
      throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    }
    return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  });

  // Ensure a clean allowlist for every test unless it opts in.
  delete process.env.BRUNO_SSRF_ALLOWLIST;
  resetAllowlistCache();
});

afterEach(() => {
  delete process.env.BRUNO_SSRF_ALLOWLIST;
  resetAllowlistCache();
});

describe('validateUrl', () => {
  // -----------------------------------------------------------------------
  // Valid URLs — public HTTP(S) should be allowed
  // -----------------------------------------------------------------------
  describe('allows public HTTP(S) URLs', () => {
    it('allows https://api.example.com/v1/users', async () => {
      const result = await validateUrl('https://api.example.com/v1/users');
      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('allows http://api.example.com/v1/users', async () => {
      const result = await validateUrl('http://api.example.com/v1/users');
      expect(result.valid).toBe(true);
    });

    it('allows https://example.com with port', async () => {
      const result = await validateUrl('https://example.com:8443/path');
      expect(result.valid).toBe(true);
    });

    it('allows a URL with query string and fragment', async () => {
      const result = await validateUrl('https://example.com/path?q=1&b=2#frag');
      expect(result.valid).toBe(true);
    });

    it('allows public IP addresses', async () => {
      const result = await validateUrl('http://93.184.216.34/index.html');
      expect(result.valid).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Invalid / malformed URLs
  // -----------------------------------------------------------------------
  describe('rejects invalid URLs', () => {
    it('rejects empty string', async () => {
      const result = await validateUrl('');
      expect(result.valid).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it('rejects non-URL string', async () => {
      const result = await validateUrl('not a url');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/invalid/i);
    });
  });

  // -----------------------------------------------------------------------
  // Blocked schemes
  // -----------------------------------------------------------------------
  describe('blocks non-HTTP(S) schemes', () => {
    const blockedSchemes = [
      ['file:///etc/passwd', 'file'],
      ['ftp://files.example.com/pub', 'ftp'],
      ['data:text/html,<h1>hi</h1>', 'data'],
      ['javascript:alert(1)', 'javascript'],
      ['gopher://example.com/', 'gopher'],
    ];

    it.each(blockedSchemes)('blocks %s (scheme: %s)', async (url) => {
      const result = await validateUrl(url as string);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/scheme/i);
    });
  });

  // -----------------------------------------------------------------------
  // Blocked hostnames
  // -----------------------------------------------------------------------
  describe('blocks dangerous hostnames', () => {
    it('blocks localhost', async () => {
      const result = await validateUrl('http://localhost:8080/api');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/localhost/i);
    });

    it('blocks localhost without port', async () => {
      const result = await validateUrl('http://localhost/api');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/localhost/i);
    });

    it('blocks *.local hostnames', async () => {
      const result = await validateUrl('http://myservice.local/api');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/local/i);
    });

    it('blocks metadata.google.internal', async () => {
      const result = await validateUrl('http://metadata.google.internal/computeMetadata/v1/');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/internal|metadata/i);
    });

    it('blocks 169.254.169.254 (cloud metadata IP)', async () => {
      const result = await validateUrl('http://169.254.169.254/latest/meta-data/');
      expect(result.valid).toBe(false);
      expect(result.reason).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Blocked private IPv4 ranges
  // -----------------------------------------------------------------------
  describe('blocks private IPv4 ranges', () => {
    it('blocks 127.0.0.1 (loopback)', async () => {
      const result = await validateUrl('http://127.0.0.1/api');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/loopback|private/i);
    });

    it('blocks 127.0.0.2 (loopback /8)', async () => {
      const result = await validateUrl('http://127.0.0.2:3000/api');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/loopback|private/i);
    });

    it('blocks 10.0.0.1 (10/8 private)', async () => {
      const result = await validateUrl('http://10.0.0.1/internal');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/private/i);
    });

    it('blocks 10.255.255.255 (10/8 upper bound)', async () => {
      const result = await validateUrl('http://10.255.255.255/');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/private/i);
    });

    it('blocks 172.16.0.1 (172.16/12 lower bound)', async () => {
      const result = await validateUrl('http://172.16.0.1/admin');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/private/i);
    });

    it('blocks 172.31.255.255 (172.16/12 upper bound)', async () => {
      const result = await validateUrl('http://172.31.255.255/');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/private/i);
    });

    it('allows 172.15.255.255 (just below 172.16/12)', async () => {
      const result = await validateUrl('http://172.15.255.255/');
      expect(result.valid).toBe(true);
    });

    it('allows 172.32.0.0 (just above 172.16/12)', async () => {
      const result = await validateUrl('http://172.32.0.0/');
      expect(result.valid).toBe(true);
    });

    it('blocks 192.168.1.1 (192.168/16 private)', async () => {
      const result = await validateUrl('http://192.168.1.1/admin');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/private/i);
    });

    it('blocks 192.168.0.0 (192.168/16 lower bound)', async () => {
      const result = await validateUrl('http://192.168.0.0/');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/private/i);
    });

    it('blocks 169.254.1.1 (link-local)', async () => {
      const result = await validateUrl('http://169.254.1.1/');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/link-local|private/i);
    });

    it('blocks 0.0.0.0', async () => {
      const result = await validateUrl('http://0.0.0.0/');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/private|unspecified/i);
    });
  });

  // -----------------------------------------------------------------------
  // Blocked IPv6 addresses
  // -----------------------------------------------------------------------
  describe('blocks private/reserved IPv6 addresses', () => {
    it('blocks ::1 (loopback)', async () => {
      const result = await validateUrl('http://[::1]/api');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/loopback|ipv6/i);
    });

    it('blocks fc00:: (unique local)', async () => {
      const result = await validateUrl('http://[fc00::1]/api');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/private|ipv6/i);
    });

    it('blocks fd00:: (unique local)', async () => {
      const result = await validateUrl('http://[fd00::1]/api');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/private|ipv6/i);
    });

    it('blocks fe80:: (link-local)', async () => {
      const result = await validateUrl('http://[fe80::1]/api');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/link-local|ipv6/i);
    });
  });

  // -----------------------------------------------------------------------
  // IPv4-mapped IPv6 SSRF bypass prevention
  // -----------------------------------------------------------------------
  describe('blocks IPv4-mapped IPv6 addresses (::ffff:X.X.X.X)', () => {
    it('blocks ::ffff:127.0.0.1 (loopback via dotted-decimal)', async () => {
      const result = await validateUrl('http://[::ffff:127.0.0.1]/');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/ipv4-mapped|private|loopback/i);
    });

    it('blocks ::ffff:10.0.0.1 (private via dotted-decimal)', async () => {
      const result = await validateUrl('http://[::ffff:10.0.0.1]/');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/ipv4-mapped|private/i);
    });

    it('blocks ::ffff:169.254.169.254 (link-local metadata via dotted-decimal)', async () => {
      const result = await validateUrl('http://[::ffff:169.254.169.254]/');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/ipv4-mapped|private|link-local/i);
    });

    it('blocks ::ffff:192.168.1.1 (private via dotted-decimal)', async () => {
      const result = await validateUrl('http://[::ffff:192.168.1.1]/');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/ipv4-mapped|private/i);
    });

    it('allows ::ffff:8.8.8.8 (public IP via dotted-decimal)', async () => {
      const result = await validateUrl('http://[::ffff:8.8.8.8]/');
      expect(result.valid).toBe(true);
    });

    it('blocks ::ffff:7f00:1 (hex form of 127.0.0.1)', async () => {
      const result = await validateUrl('http://[::ffff:7f00:1]/');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/ipv4-mapped|private|loopback/i);
    });

    it('blocks 0:0:0:0:0:ffff:127.0.0.1 (expanded form with dotted-decimal)', async () => {
      const result = await validateUrl('http://[0:0:0:0:0:ffff:127.0.0.1]/');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/ipv4-mapped|private|loopback/i);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases / bypass attempts
  // -----------------------------------------------------------------------
  describe('handles bypass attempts', () => {
    it('blocks 0x7f000001 (hex-encoded 127.0.0.1)', async () => {
      // Node's WHATWG URL parser normalizes 0x7f000001 to 127.0.0.1, which is loopback.
      const result = await validateUrl('http://0x7f000001/');
      expect(result.valid).toBe(false);
    });

    it('blocks :: (IPv6 unspecified address)', async () => {
      const result = await validateUrl('http://[::]/');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/unspecified|ipv6/i);
    });

    it('blocks ::127.0.0.1 (IPv4-compatible loopback embedding)', async () => {
      const result = await validateUrl('http://[::127.0.0.1]/');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/private|loopback|embed/i);
    });

    it('blocks localhost with a trailing dot (FQDN form)', async () => {
      const result = await validateUrl('http://localhost./api');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/localhost/i);
    });

    it('blocks a private IPv4 with a trailing dot', async () => {
      const result = await validateUrl('http://10.0.0.1./');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/private/i);
    });

    it('blocks URL with credentials', async () => {
      // user:pass@ before hostname — should still detect the private IP
      const result = await validateUrl('http://user:pass@127.0.0.1/');
      expect(result.valid).toBe(false);
    });

    it('blocks URL with mixed-case scheme', async () => {
      // new URL normalizes the scheme to lowercase
      const result = await validateUrl('FILE:///etc/passwd');
      expect(result.valid).toBe(false);
    });

    it('handles URL with empty hostname gracefully', async () => {
      const result = await validateUrl('http:///path');
      // Should not throw, should return invalid
      expect(result.valid).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // DNS resolution — hostname-indirection SSRF bypass prevention
  // -----------------------------------------------------------------------
  describe('resolves hostnames before the SSRF check', () => {
    it('blocks a public-looking hostname that resolves to a private IP', async () => {
      dnsMap['10.20.30.40.sslip.io'] = ['10.20.30.40'];
      const result = await validateUrl('https://10.20.30.40.sslip.io/health');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/private/i);
    });

    it('blocks a hostname that resolves to a loopback address', async () => {
      dnsMap['sneaky.example.com'] = ['127.0.0.1'];
      const result = await validateUrl('https://sneaky.example.com/');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/loopback|private/i);
    });

    it('blocks when ANY resolved address is private (multi-record)', async () => {
      dnsMap['mixed.example.com'] = ['93.184.216.34', '10.0.0.5'];
      const result = await validateUrl('https://mixed.example.com/');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/private/i);
    });

    it('rejects a hostname that fails DNS resolution', async () => {
      const result = await validateUrl('https://nonexistent.invalid/');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/dns resolution failed/i);
    });

    it('allows a hostname that resolves to a public IP', async () => {
      dnsMap['good.example.com'] = ['8.8.8.8'];
      const result = await validateUrl('https://good.example.com/');
      expect(result.valid).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // BRUNO_SSRF_ALLOWLIST — operator-controlled exceptions
  // -----------------------------------------------------------------------
  describe('BRUNO_SSRF_ALLOWLIST', () => {
    it('allows a private IP literal that is explicitly allowlisted', async () => {
      process.env.BRUNO_SSRF_ALLOWLIST = '10.20.30.40';
      resetAllowlistCache();
      const result = await validateUrl('http://10.20.30.40/health');
      expect(result.valid).toBe(true);
    });

    it('still blocks a private IP NOT in the allowlist', async () => {
      process.env.BRUNO_SSRF_ALLOWLIST = '10.20.30.40';
      resetAllowlistCache();
      const result = await validateUrl('http://10.20.30.41/health');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/private/i);
    });

    it('allows a hostname resolving to an allowlisted private IP', async () => {
      process.env.BRUNO_SSRF_ALLOWLIST = '10.20.30.40';
      resetAllowlistCache();
      dnsMap['10.20.30.40.sslip.io'] = ['10.20.30.40'];
      const result = await validateUrl('https://10.20.30.40.sslip.io/health');
      expect(result.valid).toBe(true);
    });

    it('allows an exact hostname entry regardless of resolved IP', async () => {
      process.env.BRUNO_SSRF_ALLOWLIST = '10.20.30.40.sslip.io';
      resetAllowlistCache();
      dnsMap['10.20.30.40.sslip.io'] = ['10.20.30.40'];
      const result = await validateUrl('https://10.20.30.40.sslip.io/health');
      expect(result.valid).toBe(true);
    });

    it('allows a private IP within an allowlisted CIDR range', async () => {
      process.env.BRUNO_SSRF_ALLOWLIST = '10.20.0.0/16';
      resetAllowlistCache();
      const result = await validateUrl('http://10.20.30.40/health');
      expect(result.valid).toBe(true);
    });

    it('blocks a private IP outside an allowlisted CIDR range', async () => {
      process.env.BRUNO_SSRF_ALLOWLIST = '10.20.0.0/16';
      resetAllowlistCache();
      const result = await validateUrl('http://10.21.0.1/health');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/private/i);
    });

    it('allows an allowlisted IPv6 CIDR range', async () => {
      process.env.BRUNO_SSRF_ALLOWLIST = 'fd00::/8';
      resetAllowlistCache();
      const result = await validateUrl('http://[fd00::1]/health');
      expect(result.valid).toBe(true);
    });

    it('does not allow a private IP when only a wildcard entry is provided', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.BRUNO_SSRF_ALLOWLIST = '10.*';
      resetAllowlistCache();
      const result = await validateUrl('http://10.0.0.1/');
      expect(result.valid).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('does not allow a private IP via a /0 match-all CIDR', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.BRUNO_SSRF_ALLOWLIST = '0.0.0.0/0';
      resetAllowlistCache();
      const result = await validateUrl('http://10.0.0.1/');
      expect(result.valid).toBe(false);
      warnSpy.mockRestore();
    });

    it('does not allow a private IP via an empty-prefix CIDR (10.0.0.0/)', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.BRUNO_SSRF_ALLOWLIST = '10.0.0.0/';
      resetAllowlistCache();
      const result = await validateUrl('http://10.0.0.1/');
      expect(result.valid).toBe(false);
      warnSpy.mockRestore();
    });
  });
});

// ---------------------------------------------------------------------------
// parseAllowlist — unit tests
// ---------------------------------------------------------------------------
describe('parseAllowlist', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns an empty allowlist for undefined input', () => {
    const a = parseAllowlist(undefined);
    expect(a.hosts.size).toBe(0);
    expect(a.ipv4.size).toBe(0);
    expect(a.ipv6.size).toBe(0);
    expect(a.cidr4).toHaveLength(0);
    expect(a.cidr6).toHaveLength(0);
  });

  it('parses mixed hosts, IPs, and CIDRs', () => {
    const a = parseAllowlist('filters.dev.example.com, 10.20.30.40, 10.0.0.0/8, fd00::1, fd00::/8');
    expect(a.hosts.has('filters.dev.example.com')).toBe(true);
    expect(a.ipv4.size).toBe(1);
    expect(a.ipv6.size).toBe(1);
    expect(a.cidr4).toHaveLength(1);
    expect(a.cidr6).toHaveLength(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('lowercases hostnames', () => {
    const a = parseAllowlist('Filters.Example.COM');
    expect(a.hosts.has('filters.example.com')).toBe(true);
  });

  it('ignores blank entries', () => {
    const a = parseAllowlist('  , 10.0.0.1 ,, ');
    expect(a.ipv4.size).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('rejects wildcard entries with a warning', () => {
    const a = parseAllowlist('*, *.example.com, 10.*, 10.0.0.0/*');
    expect(a.hosts.size).toBe(0);
    expect(a.ipv4.size).toBe(0);
    expect(a.cidr4).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(4);
  });

  it('warns and skips malformed CIDR prefix lengths', () => {
    const a = parseAllowlist('10.0.0.0/33, fd00::/129');
    expect(a.cidr4).toHaveLength(0);
    expect(a.cidr6).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('warns and skips /0 match-all and empty-prefix CIDRs', () => {
    const a = parseAllowlist('0.0.0.0/0, ::/0, 10.0.0.0/');
    expect(a.cidr4).toHaveLength(0);
    expect(a.cidr6).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  it('warns and skips a CIDR with a non-IP base', () => {
    const a = parseAllowlist('example.com/24');
    expect(a.cidr4).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
