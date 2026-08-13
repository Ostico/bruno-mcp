/**
 * The allowlist and the spelling of a target.
 *
 * A hostname entry is matched against the spelling in the URL; an address entry
 * is matched against the address the URL resolves to. That left one asymmetry
 * with real consequences: an operator who allowlisted `127.0.0.1` still had
 * `http://localhost:8888` refused, because the name is denied before anything
 * resolves — the same listener reachable or not depending on how it was written.
 * A denylisted name is now permitted when every address it resolves to is
 * allowlisted, which is exactly what an address entry vouches for, and refused
 * otherwise.
 */
import {
  validateUrl,
  resetAllowlistCache,
  ssrfRemediation,
} from '../../../src/bruno/url-validator.js';

jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(),
}));
import { lookup } from 'node:dns/promises';
const mockLookup = lookup as unknown as jest.Mock;

let dnsMap: Record<string, string[]>;

beforeEach(() => {
  dnsMap = {
    localhost: ['127.0.0.1'],
    'db.local': ['10.20.30.40'],
    'mixed.local': ['127.0.0.1', '8.8.8.8'],
    'metadata.google.internal': ['169.254.169.254'],
    'v6.local': ['::1'],
    'v6net.local': ['fd00::1'],
  };
  mockLookup.mockReset();
  mockLookup.mockImplementation(async (hostname: string) => {
    const addrs = dnsMap[hostname];
    if (!addrs) {
      throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    }
    return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  });
  delete process.env.BRUNO_SSRF_ALLOWLIST;
  resetAllowlistCache();
});

afterEach(() => {
  delete process.env.BRUNO_SSRF_ALLOWLIST;
  resetAllowlistCache();
});

function withAllowlist(raw: string): void {
  process.env.BRUNO_SSRF_ALLOWLIST = raw;
  resetAllowlistCache();
}

describe('a denylisted name whose addresses are allowlisted', () => {
  it('is permitted, and still pins the connection to what it resolved to', async () => {
    withAllowlist('127.0.0.1');

    const result = await validateUrl('http://localhost:8888/api');

    expect(result.valid).toBe(true);
    // Without this the name would be permitted while the connection went
    // wherever a second lookup pointed.
    expect(result.addresses).toEqual(['127.0.0.1']);
  });

  it('is permitted by a CIDR entry as well as a literal one', async () => {
    withAllowlist('10.20.0.0/16');

    const result = await validateUrl('http://db.local/health');

    expect(result.valid).toBe(true);
    expect(result.addresses).toEqual(['10.20.30.40']);
  });

  it('is permitted by an IPv6 literal entry', async () => {
    withAllowlist('::1');

    const result = await validateUrl('http://v6.local/health');

    expect(result.valid).toBe(true);
    expect(result.addresses).toEqual(['::1']);
  });

  it('is permitted by an IPv6 CIDR entry', async () => {
    withAllowlist('fd00::/8');

    const result = await validateUrl('http://v6net.local/health');

    expect(result.valid).toBe(true);
    expect(result.addresses).toEqual(['fd00::1']);
  });

  it('extends to a cloud metadata name, which is the operator vouching for it', async () => {
    // Deliberate and worth stating: allowlisting `169.254.169.254` is a
    // decision about that endpoint, and refusing the name that resolves to
    // nothing else would only mean the caller writes the address instead.
    withAllowlist('169.254.169.254');

    const result = await validateUrl('http://metadata.google.internal/computeMetadata/v1/');

    expect(result.valid).toBe(true);
    expect(result.addresses).toEqual(['169.254.169.254']);
  });

  it('agrees with the address spelling of the same target', async () => {
    withAllowlist('127.0.0.1');

    const byName = await validateUrl('http://localhost:8888/api');
    const byAddress = await validateUrl('http://127.0.0.1:8888/api');

    expect(byName.valid).toBe(byAddress.valid);
    expect(byName.valid).toBe(true);
  });
});

describe('a denylisted name that the allowlist does not cover', () => {
  it('is refused when only some of its addresses are allowlisted', async () => {
    withAllowlist('127.0.0.1');

    const result = await validateUrl('http://mixed.local/health');

    expect(result.valid).toBe(false);
    // The name is what was denied, so the name is what the message is about: an
    // IP reason would send the caller after 8.8.8.8 rather than after the entry
    // they actually need.
    expect(result.reason).toContain('.local');
    expect(result.allowlistOverridable).toBe(true);
  });

  it('keeps the hostname refusal when resolution fails, rather than reporting DNS', async () => {
    withAllowlist('127.0.0.1');

    const result = await validateUrl('http://nothing.local/health');

    expect(result.valid).toBe(false);
    expect(result.reason).not.toContain('DNS resolution');
    expect(result.reason).toContain('.local');
  });

  it('keeps the hostname refusal when resolution returns nothing', async () => {
    withAllowlist('127.0.0.1');
    dnsMap['empty.local'] = [];

    const result = await validateUrl('http://empty.local/health');

    expect(result.valid).toBe(false);
    expect(result.reason).not.toContain('DNS resolution');
    expect(result.reason).toContain('.local');
  });

  it('does not resolve at all when no address entry could permit the name', async () => {
    withAllowlist('example.com');

    const result = await validateUrl('http://localhost:8888/api');

    expect(result.valid).toBe(false);
    // A lookup that cannot change the answer is a lookup not worth paying for,
    // and on the common path there are no address entries at all.
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('is still refused with no allowlist configured', async () => {
    const result = await validateUrl('http://localhost:8888/api');

    expect(result.valid).toBe(false);
    expect(mockLookup).not.toHaveBeenCalled();
  });
});

describe('the remediation text', () => {
  it('states which spelling each kind of entry matches', async () => {
    withAllowlist('127.0.0.1');

    const text = ssrfRemediation();

    expect(text).toContain('hostname entry matches the spelling in the URL');
    expect(text).toContain('address the URL resolves to');
    expect(text).toContain('every address it resolves to is');
  });
});
