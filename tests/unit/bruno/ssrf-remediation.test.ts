/**
 * Tests for the actionable half of an SSRF refusal.
 *
 * The block itself was already correct; what it lacked was any indication of
 * what to do next, so a caller could only guess whether it had used the wrong
 * host or hit a wall it cannot pass. These tests pin three things: which blocks
 * are eligible for remediation, that the two allowlist states give different
 * advice, and that the entries themselves are never disclosed.
 */

import {
  validateUrl,
  ssrfRemediation,
  allowlistEntryCount,
  resetAllowlistCache,
} from '../../../src/bruno/url-validator';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));
import { lookup } from 'node:dns/promises';
const mockLookup = lookup as unknown as jest.Mock;

let dnsMap: Record<string, string[]>;

beforeEach(() => {
  dnsMap = {
    'internal.example.com': ['10.0.0.5'],
    'public.example.com': ['93.184.216.34'],
  };
  mockLookup.mockImplementation(async (host: string) => {
    const addrs = dnsMap[host];
    if (!addrs) {
      const err: NodeJS.ErrnoException = new Error(`ENOTFOUND ${host}`);
      err.code = 'ENOTFOUND';
      throw err;
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

describe('allowlistEntryCount', () => {
  it('is zero when the variable is unset', () => {
    expect(allowlistEntryCount()).toBe(0);
  });

  it('counts entries across hostnames, IPs and CIDRs', () => {
    process.env.BRUNO_SSRF_ALLOWLIST = 'svc.internal.test, 10.20.30.40, 10.60.0.0/16';
    resetAllowlistCache();
    expect(allowlistEntryCount()).toBe(3);
  });

  it('does not count rejected wildcard entries', () => {
    process.env.BRUNO_SSRF_ALLOWLIST = '*, 10.20.30.40';
    resetAllowlistCache();
    expect(allowlistEntryCount()).toBe(1);
  });
});

describe('ssrfRemediation', () => {
  it('names the mechanism and its entry syntax', () => {
    expect(ssrfRemediation()).toContain('BRUNO_SSRF_ALLOWLIST');
    expect(ssrfRemediation()).toContain('hostnames, IPs or CIDRs');
  });

  it('tells the caller to stop and escalate when nothing is configured', () => {
    const msg = ssrfRemediation();
    expect(msg).toContain('No entries are configured');
    expect(msg).toContain('will not resolve by retrying');
    expect(msg).toContain('Report to the user');
  });

  it('points at the allowlisted route when entries exist but none match', () => {
    process.env.BRUNO_SSRF_ALLOWLIST = 'svc.internal.test, 10.20.30.40';
    resetAllowlistCache();
    const msg = ssrfRemediation();
    expect(msg).toContain('2 entries are configured; none match this target');
    expect(msg).toContain('reachable at an allowlisted hostname or address');
    // The stop-and-escalate wording belongs to the other branch only.
    expect(msg).not.toContain('will not resolve by retrying');
  });

  it('agrees in number for a single entry', () => {
    process.env.BRUNO_SSRF_ALLOWLIST = '10.20.30.40';
    resetAllowlistCache();
    expect(ssrfRemediation()).toContain('1 entry is configured');
  });

  it('never discloses the entries themselves', () => {
    process.env.BRUNO_SSRF_ALLOWLIST = 'secret-host.internal.test, 10.20.30.40, 10.60.0.0/16';
    resetAllowlistCache();
    const msg = ssrfRemediation();
    expect(msg).not.toContain('secret-host.internal.test');
    expect(msg).not.toContain('10.20.30.40');
    expect(msg).not.toContain('10.60.0.0/16');
  });

  it('does not instruct the reader to set the variable themselves', () => {
    // Phrasing is deliberately operator-directed: an imperative here reads as a
    // to-do, and acting on it means launching a process with the guard off.
    const msg = ssrfRemediation();
    expect(msg).toContain('the server operator allowlists them via');
    expect(msg).not.toMatch(/\bset BRUNO_SSRF_ALLOWLIST\b/);
    expect(msg).not.toMatch(/\bexport BRUNO_SSRF_ALLOWLIST\b/);
  });
});

describe('validateUrl allowlistOverridable', () => {
  it('marks a private-IP block as overridable', async () => {
    const result = await validateUrl('http://10.0.0.5/health');
    expect(result.valid).toBe(false);
    expect(result.allowlistOverridable).toBe(true);
  });

  it('marks a block on a hostname resolving to a private IP as overridable', async () => {
    const result = await validateUrl('http://internal.example.com/health');
    expect(result.valid).toBe(false);
    expect(result.allowlistOverridable).toBe(true);
  });

  it('marks a hostname-denylist block (localhost) as overridable', async () => {
    const result = await validateUrl('http://localhost:8080/health');
    expect(result.valid).toBe(false);
    expect(result.allowlistOverridable).toBe(true);
  });

  it('marks a cloud-metadata block as overridable', async () => {
    const result = await validateUrl('http://169.254.169.254/latest/meta-data/');
    expect(result.valid).toBe(false);
    expect(result.allowlistOverridable).toBe(true);
  });

  it('does NOT mark a DNS failure as overridable', async () => {
    const result = await validateUrl('http://nonexistent.example.com/health');
    expect(result.valid).toBe(false);
    expect(result.allowlistOverridable).toBeUndefined();
  });

  it('does NOT mark a malformed URL as overridable', async () => {
    const result = await validateUrl('http:///health');
    expect(result.valid).toBe(false);
    expect(result.allowlistOverridable).toBeUndefined();
  });

  it('leaves the flag off entirely for a permitted URL', async () => {
    const result = await validateUrl('http://public.example.com/health');
    expect(result.valid).toBe(true);
    expect(result.allowlistOverridable).toBeUndefined();
  });
});
