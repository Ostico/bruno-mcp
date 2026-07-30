/**
 * IPv6 transitional-address SSRF regression tests.
 *
 * Every IPv6 transition mechanism can carry an IPv4 address inside an IPv6 one.
 * Un-embedding only the canonical `::ffff:` form left the rest as live bypasses:
 * each vector below reaches a private or reserved IPv4 address — several of them
 * 169.254.169.254, the cloud instance-metadata endpoint — while presenting an
 * IPv6 literal that no IPv4 rule ever inspected.
 *
 * These are IP literals, so no DNS lookup is involved; the mock below only
 * guarantees the suite cannot touch the network if a case is ever added that
 * uses a hostname.
 */
import { validateUrl, resetAllowlistCache } from '../../../src/bruno/url-validator.js';

jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(async () => {
    throw new Error('DNS must not be consulted by an IP-literal test');
  }),
}));

beforeEach(() => {
  delete process.env.BRUNO_SSRF_ALLOWLIST;
  resetAllowlistCache();
});

afterEach(() => {
  delete process.env.BRUNO_SSRF_ALLOWLIST;
  resetAllowlistCache();
});

describe('IPv6 transitional encodings that embed a blocked IPv4 address', () => {
  // Each row: URL, the IPv4 address it actually reaches, matcher for the reason.
  const blocked: Array<[string, string, RegExp]> = [
    // NAT64 well-known prefix (RFC 6052). RFC 6052 permits this prefix only at
    // /96, so the IPv4 address is always the low 32 bits.
    ['http://[64:ff9b::a9fe:a9fe]/', '169.254.169.254', /nat64/i],
    ['http://[64:ff9b::7f00:1]/', '127.0.0.1', /nat64/i],
    ['http://[64:ff9b::a00:1]/', '10.0.0.1', /nat64/i],

    // 6to4 (RFC 3056) — the IPv4 tunnel endpoint follows the 2002::/16 prefix.
    ['http://[2002:a9fe:a9fe::]/', '169.254.169.254', /6to4/i],
    ['http://[2002:a00:1::]/', '10.0.0.1', /6to4/i],
    ['http://[2002:7f00:1::]/', '127.0.0.1', /6to4/i],

    // IPv4-translated (RFC 2765) — one group left of the IPv4-mapped form.
    ['http://[::ffff:0:a9fe:a9fe]/', '169.254.169.254', /translated/i],
    ['http://[::ffff:0:7f00:1]/', '127.0.0.1', /translated/i],

    // ISATAP (RFC 5214), under a public routing prefix in the documentation
    // range. The tunnel still terminates at the embedded IPv4 address.
    ['http://[2001:db8::5efe:a9fe:a9fe]/', '169.254.169.254', /isatap/i],
    ['http://[2001:db8::200:5efe:a00:1]/', '10.0.0.1', /isatap/i],

    // Teredo (RFC 4380) embeds two IPv4 addresses: the relay server plainly,
    // and the client as a bitwise complement.
    // Server 169.254.169.254, client 93.184.216.34 (public).
    ['http://[2001:0:a9fe:a9fe:0:0:a247:27dd]/', '169.254.169.254', /teredo server/i],
    // Server 93.184.216.34 (public), client 10.0.0.1 as ~0a00:~0001.
    ['http://[2001:0:5db8:d822:0:0:f5ff:fffe]/', '10.0.0.1', /teredo client/i],

    // Still covered: the canonical forms that were already handled.
    ['http://[::ffff:a9fe:a9fe]/', '169.254.169.254', /ipv4-mapped/i],
    ['http://[::a9fe:a9fe]/', '169.254.169.254', /ipv4-compatible/i],
  ];

  it.each(blocked)('blocks %s, which reaches %s', async (url, reached, reasonPattern) => {
    const result = await validateUrl(url);

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(reasonPattern);
    // The reason names the address actually reached, so an operator reading the
    // error can tell which internal target was refused.
    expect(result.reason).toContain(reached);
    expect(result.allowlistOverridable).toBe(true);
    expect(result.addresses).toBeUndefined();
  });

  it('blocks the whole local-use NAT64 range, whatever it carries', async () => {
    // 64:ff9b:1::/48 (RFC 8215) is reserved for local use, and each deployment
    // picks its own /96 inside it, so the embedding offset is a site convention
    // rather than a property of the address.
    const result = await validateUrl('http://[64:ff9b:1:0:0:0:a9fe:a9fe]/');

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/64:ff9b:1::\/48/);
    expect(result.allowlistOverridable).toBe(true);
  });
});

describe('transitional encodings of public IPv4 addresses stay reachable', () => {
  // 93.184.216.34 is a public address, so its translated forms must pass. These
  // guard against the un-embedding turning into a blanket block on the prefix.
  const allowed = [
    'http://[64:ff9b::5db8:d822]/', // NAT64 of 93.184.216.34
    'http://[2002:5db8:d822::]/', // 6to4 of 93.184.216.34
    'http://[::ffff:0:5db8:d822]/', // IPv4-translated 93.184.216.34
    'http://[2001:db8::5efe:5db8:d822]/', // ISATAP of 93.184.216.34
  ];

  it.each(allowed)('allows %s', async (url) => {
    const result = await validateUrl(url);

    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('does not mistake an ordinary documentation address for Teredo', async () => {
    // Teredo is 2001:0::/32; 2001:db8::/32 is the documentation range (RFC 3849)
    // and shares only the first group.
    const result = await validateUrl('http://[2001:db8::1]/');

    expect(result.valid).toBe(true);
  });

  it('does not treat an arbitrary interface identifier as ISATAP', async () => {
    // ISATAP requires 0:5efe or 200:5efe in the two groups before the IPv4 part.
    const result = await validateUrl('http://[2001:db8::5eff:a9fe:a9fe]/');

    expect(result.valid).toBe(true);
  });
});

describe('IPv4 ranges reachable through the transitional forms', () => {
  it('blocks the whole 0.0.0.0/8 this-host range, not just 0.0.0.0', async () => {
    // Linux routes any 0.x.y.z to the local host.
    const result = await validateUrl('http://0.0.0.1/');

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/0\.0\.0\.0\/8/);
  });

  it('still reports 0.0.0.0 itself as the unspecified address', async () => {
    const result = await validateUrl('http://0.0.0.0/');

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/unspecified/i);
  });

  it('allows 1.0.0.1, immediately above 0.0.0.0/8', async () => {
    const result = await validateUrl('http://1.0.0.1/');

    expect(result.valid).toBe(true);
  });

  it('blocks 240.0.0.1 (reserved, formerly class E)', async () => {
    const result = await validateUrl('http://240.0.0.1/');

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/240\.0\.0\.0\/4/);
  });

  it('blocks 255.0.0.1, also inside 240.0.0.0/4', async () => {
    const result = await validateUrl('http://255.0.0.1/');

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/240\.0\.0\.0\/4/);
  });

  it('keeps the specific broadcast reason for 255.255.255.255', async () => {
    const result = await validateUrl('http://255.255.255.255/');

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/broadcast/i);
  });

  it('keeps the multicast reason for 239.255.255.255, just below 240/4', async () => {
    const result = await validateUrl('http://239.255.255.255/');

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/multicast/i);
  });

  it('blocks 192.88.99.1 (6to4 relay anycast)', async () => {
    const result = await validateUrl('http://192.88.99.1/');

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/anycast|192\.88\.99\.0\/24/i);
  });

  it('allows 192.88.98.1 and 192.88.100.1, either side of the anycast /24', async () => {
    expect((await validateUrl('http://192.88.98.1/')).valid).toBe(true);
    expect((await validateUrl('http://192.88.100.1/')).valid).toBe(true);
  });
});

describe('the operator allowlist still governs transitional forms', () => {
  it('permits a transitional literal named exactly in the allowlist', async () => {
    process.env.BRUNO_SSRF_ALLOWLIST = '64:ff9b::a9fe:a9fe';
    resetAllowlistCache();

    const result = await validateUrl('http://[64:ff9b::a9fe:a9fe]/');

    expect(result.valid).toBe(true);
  });

  it('does not leak an allowlist entry into the block reason', async () => {
    process.env.BRUNO_SSRF_ALLOWLIST = 'vault.internal.example,198.51.100.7';
    resetAllowlistCache();

    const result = await validateUrl('http://[2002:a9fe:a9fe::]/');

    expect(result.valid).toBe(false);
    expect(result.reason).not.toContain('vault.internal.example');
    expect(result.reason).not.toContain('198.51.100.7');
  });
});
