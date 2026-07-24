/**
 * URL Validator — SSRF Protection
 *
 * Validates fetch target URLs to prevent Server-Side Request Forgery (SSRF).
 * Blocks:
 *  - Non-HTTP(S) schemes (file://, ftp://, data:, javascript:, etc.)
 *  - Private/internal IPv4 ranges (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 0.0.0.0)
 *  - Private/reserved IPv6 addresses (::1, fc00::/7, fe80::/10)
 *  - Dangerous hostnames (localhost, *.local, metadata.google.internal)
 *
 * DNS resolution: hostnames are resolved to IP address(es) BEFORE the SSRF
 * check, so a public-looking domain that resolves to an internal address
 * (e.g. filters.example.com -> 10.x.x.x) is blocked. This closes the
 * hostname-indirection bypass.
 *
 * Explicit allowlist: operators may permit specific otherwise-blocked targets
 * via the BRUNO_SSRF_ALLOWLIST environment variable — a comma-separated list
 * of exact hostnames, IP literals, and/or CIDR ranges (IPv4 and IPv6). The
 * variable is read once (captured at first use / process startup) and can NOT
 * be influenced by tool-call arguments, preserving the trust boundary: only
 * the human who launched the server decides what internal targets are allowed.
 * Wildcard entries (anything containing '*') are rejected with a warning —
 * an allowlist must name specific hosts, IPs, or CIDRs.
 *
 * Residual risk: DNS rebinding (TOCTOU). Validation resolves the hostname,
 * but the subsequent fetch() re-resolves independently and could connect to a
 * different address. Full mitigation requires pinning the validated IP at
 * connect time; tracked as a follow-up.
 */

import { lookup } from 'node:dns/promises';

export interface UrlValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validate a URL for SSRF safety.
 *
 * Asynchronous because unresolved hostnames are looked up via DNS before the
 * private-range check is applied.
 *
 * @param url - The URL string to validate
 * @returns Validation result with optional reason for rejection
 */
export async function validateUrl(url: string): Promise<UrlValidationResult> {
  // Parse the URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: 'Invalid URL: unable to parse' };
  }

  // 1. Check scheme — only http and https allowed
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    return { valid: false, reason: `Blocked scheme: ${scheme}. Only http and https are allowed` };
  }

  const rawHostname = parsed.hostname.toLowerCase();

  // 2. Reject empty hostname
  // Note: some URL parsers treat 'http:///path' as hostname='path', so also
  // check if the original URL had an authority section with empty host.
  /* istanbul ignore next -- defensive: the WHATWG URL parser requires a non-empty
     host for http/https (an empty authority throws), so a successfully-parsed
     http(s) URL never reaches here with an empty hostname */
  if (!rawHostname) {
    return { valid: false, reason: 'Invalid URL: empty hostname' };
  }

  // Strip IPv6 brackets if present (some Node.js versions keep them)
  const bracketStripped = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname;

  // Strip trailing dot(s) of the FQDN form so 'localhost.' / '10.0.0.1.' /
  // 'metadata.google.internal.' cannot bypass the name/IP checks.
  const hostname = bracketStripped.replace(/\.+$/, '');

  // Detect empty-authority URLs like 'http:///path' where the parser
  // mistakenly treats the path component as the hostname.
  // A triple-slash after scheme means no host was provided.
  const schemeEnd = url.indexOf('://');
  if (schemeEnd !== -1 && url[schemeEnd + 3] === '/') {
    return { valid: false, reason: 'Invalid URL: empty hostname' };
  }

  const allowlist = getAllowlist();

  // 3. Explicit host allowlist — an operator-approved exact hostname bypasses
  // all host/IP policy checks (the operator has vouched for this target).
  if (allowlist.hosts.has(hostname)) {
    return { valid: true };
  }

  // 4. Check hostname denylist (localhost, *.local, cloud metadata)
  const hostnameResult = checkHostname(hostname);
  if (hostnameResult) {
    return hostnameResult;
  }

  // 5. Resolve the target to concrete IP address(es).
  let ips: string[];
  if (isIPv4(hostname) || isIPv6(hostname)) {
    ips = [hostname];
  } else {
    try {
      const records = await lookup(hostname, { all: true });
      ips = records.map((r) => r.address);
    } catch {
      return { valid: false, reason: `DNS resolution failed for hostname: ${hostname}` };
    }
    if (ips.length === 0) {
      return { valid: false, reason: `DNS resolution returned no addresses for hostname: ${hostname}` };
    }
  }

  // 6. Check every resolved IP against the SSRF denylist. An IP explicitly
  // present in the allowlist (as a literal or within a CIDR) is permitted;
  // any other private/reserved IP blocks the whole request.
  for (const ip of ips) {
    if (ipAllowed(allowlist, ip)) {
      continue;
    }
    if (isIPv6(ip)) {
      // Fail closed: an address that looks like IPv6 but does not parse is blocked.
      if (!parseIPv6(ip)) {
        return { valid: false, reason: `Blocked: unparseable IPv6 address (${ip})` };
      }
      const ipv6Result = checkIPv6(ip);
      if (ipv6Result) {
        return ipv6Result;
      }
    } else if (isIPv4(ip)) {
      // Fail closed: an address that looks like IPv4 but does not parse is blocked.
      if (!parseIPv4Octets(ip)) {
        return { valid: false, reason: `Blocked: unparseable IPv4 address (${ip})` };
      }
      const ipv4Result = checkIPv4(ip);
      if (ipv4Result) {
        return ipv4Result;
      }
    } else {
      // A resolved address that is neither IPv4 nor IPv6 — fail closed.
      return { valid: false, reason: `Blocked: unrecognized resolved address (${ip})` };
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Hostname checks
// ---------------------------------------------------------------------------

function checkHostname(hostname: string): UrlValidationResult | null {
  // Exact match: localhost
  if (hostname === 'localhost') {
    return { valid: false, reason: 'Blocked hostname: localhost' };
  }

  // *.local suffix
  if (hostname.endsWith('.local')) {
    return { valid: false, reason: 'Blocked hostname: *.local domains are not allowed' };
  }

  // Cloud metadata endpoints
  if (hostname === 'metadata.google.internal') {
    return { valid: false, reason: 'Blocked hostname: metadata.google.internal (cloud metadata endpoint)' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// IPv4 checks
// ---------------------------------------------------------------------------

const IPV4_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIPv4(hostname: string): boolean {
  return IPV4_REGEX.test(hostname);
}

function parseIPv4Octets(hostname: string): number[] | null {
  const match = hostname.match(IPV4_REGEX);
  if (!match) return null;
  const octets = [
    parseInt(match[1], 10),
    parseInt(match[2], 10),
    parseInt(match[3], 10),
    parseInt(match[4], 10),
  ];
  if (octets.some((o) => o > 255)) return null;
  return octets;
}

function checkIPv4(hostname: string): UrlValidationResult | null {
  const octets = parseIPv4Octets(hostname);
  if (!octets) return null;

  const [a, b, c, d] = octets;

  // 0.0.0.0
  if (a === 0 && b === 0 && c === 0 && d === 0) {
    return { valid: false, reason: 'Blocked IP: 0.0.0.0 (unspecified address)' };
  }

  // 127.0.0.0/8 — loopback
  if (a === 127) {
    return { valid: false, reason: 'Blocked IP: loopback address (127.0.0.0/8)' };
  }

  // 10.0.0.0/8 — private
  if (a === 10) {
    return { valid: false, reason: 'Blocked IP: private address (10.0.0.0/8)' };
  }

  // 172.16.0.0/12 — private (172.16.0.0 - 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) {
    return { valid: false, reason: 'Blocked IP: private address (172.16.0.0/12)' };
  }

  // 192.168.0.0/16 — private
  if (a === 192 && b === 168) {
    return { valid: false, reason: 'Blocked IP: private address (192.168.0.0/16)' };
  }

  // 169.254.0.0/16 — link-local
  if (a === 169 && b === 254) {
    return { valid: false, reason: 'Blocked IP: link-local address (169.254.0.0/16)' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// IPv6 checks
// ---------------------------------------------------------------------------

function isIPv6(hostname: string): boolean {
  // URL parser strips brackets, so we just look for colons
  return hostname.includes(':');
}

/**
 * Expand a compressed IPv6 address to its full 8-group form, returning
 * an array of 8 numeric (16-bit) values, or null if unparseable.
 *
 * Handles IPv4-mapped IPv6 addresses where the last two groups are expressed
 * as dotted-decimal IPv4 notation (e.g. ::ffff:127.0.0.1).
 */
function parseIPv6(hostname: string): number[] | null {
  // Strip zone ID (e.g., %25eth0)
  const addr = hostname.split('%')[0];

  const halves = addr.split('::');
  if (halves.length > 2) return null; // multiple :: is invalid

  /**
   * Parse the right-hand side of an IPv6 address segment string.
   * If the last colon-delimited token contains dots, treat it as an
   * IPv4 dotted-decimal address and expand it into two 16-bit groups.
   */
  const parseGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const parts = s.split(':');
    const lastPart = parts[parts.length - 1];

    // Detect IPv4-mapped suffix (contains dots — dotted-decimal IPv4)
    if (lastPart.includes('.')) {
      const ipv4Match = lastPart.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (!ipv4Match) return null;
      const octets = [
        parseInt(ipv4Match[1], 10),
        parseInt(ipv4Match[2], 10),
        parseInt(ipv4Match[3], 10),
        parseInt(ipv4Match[4], 10),
      ];
      if (octets.some((o) => o > 255)) return null;
      // Convert four octets to two 16-bit groups
      const high = (octets[0] << 8) | octets[1];
      const low  = (octets[2] << 8) | octets[3];
      const hexParts = parts.slice(0, -1).map((g) => parseInt(g, 16));
      return [...hexParts, high, low];
    }

    return parts.map((g) => parseInt(g, 16));
  };

  let groups: number[];
  if (halves.length === 2) {
    const left = parseGroups(halves[0]);
    const right = parseGroups(halves[1]);
    if (left === null || right === null) return null;
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...Array(fill).fill(0), ...right];
  } else {
    const parsed = parseGroups(halves[0]);
    if (parsed === null) return null;
    groups = parsed;
  }

  if (groups.length !== 8) return null;
  if (groups.some((g) => isNaN(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

function checkIPv6(hostname: string): UrlValidationResult | null {
  const groups = parseIPv6(hostname);
  if (!groups) return null;

  // ::1 — loopback
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0 &&
    groups[6] === 0 &&
    groups[7] === 1
  ) {
    return { valid: false, reason: 'Blocked IPv6: loopback address (::1)' };
  }

  // :: — unspecified address (connects to loopback on dual-stack hosts)
  if (groups.every((g) => g === 0)) {
    return { valid: false, reason: 'Blocked IPv6: unspecified address (::)' };
  }

  // fc00::/7 — unique local (fc00:: through fdff::)
  // First group high byte: 0xfc = 252, 0xfd = 253 → top 7 bits = 1111110
  const firstHighByte = (groups[0] >> 8) & 0xff;
  if (firstHighByte === 0xfc || firstHighByte === 0xfd) {
    return { valid: false, reason: 'Blocked IPv6: private unique-local address (fc00::/7)' };
  }

  // fe80::/10 — link-local
  // First group: fe80 through febf → top 10 bits = 1111111010
  if (groups[0] >= 0xfe80 && groups[0] <= 0xfebf) {
    return { valid: false, reason: 'Blocked IPv6: link-local address (fe80::/10)' };
  }

  // ::/96 embeddings of an IPv4 address (groups[0-4]=0):
  //  - IPv4-mapped:     0:0:0:0:0:ffff:a.b.c.d  (groups[5]=0xffff)
  //  - IPv4-compatible: 0:0:0:0:0:0:a.b.c.d     (groups[5]=0, deprecated per RFC 4291)
  // Both can embed a private/reserved IPv4 address and would otherwise bypass
  // the IPv4 checks.
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    (groups[5] === 0xffff || groups[5] === 0)
  ) {
    // Reconstruct the embedded IPv4 address from groups[6] and groups[7]
    const a = (groups[6] >> 8) & 0xff;
    const b =  groups[6]       & 0xff;
    const c = (groups[7] >> 8) & 0xff;
    const d =  groups[7]       & 0xff;
    const embeddedIPv4 = `${a}.${b}.${c}.${d}`;
    const ipv4Result = checkIPv4(embeddedIPv4);
    if (ipv4Result) {
      const form = groups[5] === 0xffff ? `::ffff:${embeddedIPv4}` : `::${embeddedIPv4}`;
      return {
        valid: false,
        reason: `Blocked IPv6: IPv4-embedded address (${form}) embeds a private/reserved IPv4 address`,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// SSRF allowlist (BRUNO_SSRF_ALLOWLIST)
// ---------------------------------------------------------------------------

interface Cidr4 {
  base: number; // network address as unsigned 32-bit int
  mask: number; // unsigned 32-bit mask
}

interface Cidr6 {
  base: bigint; // network address as 128-bit value
  mask: bigint; // 128-bit mask
}

interface Allowlist {
  hosts: Set<string>; // exact hostnames, lowercased
  ipv4: Set<number>; // exact IPv4 literals as unsigned 32-bit ints
  ipv6: Set<bigint>; // exact IPv6 literals as 128-bit values
  cidr4: Cidr4[];
  cidr6: Cidr6[];
}

const IPV4_MAX = 0xffffffff;
const IPV6_MAX = (1n << 128n) - 1n;

function ipv4ToInt(octets: number[]): number {
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function ipv6ToBigInt(groups: number[]): bigint {
  let value = 0n;
  for (const g of groups) {
    value = (value << 16n) | BigInt(g);
  }
  return value;
}

let allowlistCache: Allowlist | null = null;

/**
 * Reset the cached allowlist so the next call re-reads the environment.
 * Intended for tests only; production reads the environment once.
 */
export function resetAllowlistCache(): void {
  allowlistCache = null;
}

function getAllowlist(): Allowlist {
  if (allowlistCache === null) {
    allowlistCache = parseAllowlist(process.env.BRUNO_SSRF_ALLOWLIST);
  }
  return allowlistCache;
}

function warnAllowlist(entry: string, reason: string): void {
  // Warnings must go to stderr; stdout carries the MCP JSON-RPC stream.
  console.warn(`[bruno-mcp SSRF allowlist] Ignoring entry "${entry}": ${reason}`);
}

/**
 * Parse the raw BRUNO_SSRF_ALLOWLIST value into a structured allowlist.
 * Exported for testing.
 *
 * Accepted entry forms:
 *  - exact hostname:  orders-api.internal.example
 *  - IPv4 literal:    10.20.30.40
 *  - IPv6 literal:    fd00::1
 *  - CIDR (v4/v6):    10.20.0.0/16, fd00::/8
 *
 * Any entry containing '*' is rejected — an allowlist must be explicit.
 * Malformed entries are ignored with a warning.
 */
export function parseAllowlist(raw: string | undefined): Allowlist {
  const allowlist: Allowlist = {
    hosts: new Set(),
    ipv4: new Set(),
    ipv6: new Set(),
    cidr4: [],
    cidr6: [],
  };

  if (!raw) return allowlist;

  for (const token of raw.split(',')) {
    const entry = token.trim();
    if (!entry) continue;

    // Reject wildcards outright — allowlist must name explicit targets.
    if (entry.includes('*')) {
      warnAllowlist(entry, 'wildcards are not permitted; specify an exact host, IP, or CIDR');
      continue;
    }

    if (entry.includes('/')) {
      parseCidrEntry(allowlist, entry);
      continue;
    }

    const lower = entry.toLowerCase();

    if (isIPv4(lower)) {
      const octets = parseIPv4Octets(lower);
      if (!octets) {
        warnAllowlist(entry, 'invalid IPv4 address');
        continue;
      }
      allowlist.ipv4.add(ipv4ToInt(octets));
    } else if (isIPv6(lower)) {
      const groups = parseIPv6(lower);
      if (!groups) {
        warnAllowlist(entry, 'invalid IPv6 address');
        continue;
      }
      allowlist.ipv6.add(ipv6ToBigInt(groups));
    } else {
      // Treat as an exact hostname.
      allowlist.hosts.add(lower);
    }
  }

  return allowlist;
}

function parseCidrEntry(allowlist: Allowlist, entry: string): void {
  const [base, bitsStr, ...rest] = entry.split('/');
  if (rest.length > 0) {
    warnAllowlist(entry, 'malformed CIDR');
    return;
  }
  // Prefix must be a plain decimal integer. Reject empty ('10.0.0.0/' → Number('')===0),
  // hex/exponent forms, and negatives.
  if (!/^\d+$/.test(bitsStr)) {
    warnAllowlist(entry, 'invalid CIDR prefix length');
    return;
  }
  const bits = Number(bitsStr);
  // Reject /0 — a match-all range is never a valid explicit allowlist entry.
  if (bits < 1) {
    warnAllowlist(entry, 'CIDR prefix must be >= 1 (a match-all range is not permitted)');
    return;
  }

  if (isIPv4(base)) {
    const octets = parseIPv4Octets(base);
    if (!octets || bits > 32) {
      warnAllowlist(entry, 'invalid IPv4 CIDR');
      return;
    }
    const mask = bits === 0 ? 0 : ((IPV4_MAX << (32 - bits)) >>> 0);
    const network = (ipv4ToInt(octets) & mask) >>> 0;
    allowlist.cidr4.push({ base: network, mask });
  } else if (isIPv6(base)) {
    const groups = parseIPv6(base);
    if (!groups || bits > 128) {
      warnAllowlist(entry, 'invalid IPv6 CIDR');
      return;
    }
    const mask = bits === 0 ? 0n : (IPV6_MAX ^ ((1n << BigInt(128 - bits)) - 1n));
    const network = ipv6ToBigInt(groups) & mask;
    allowlist.cidr6.push({ base: network, mask });
  } else {
    warnAllowlist(entry, 'CIDR base is not a valid IP address');
  }
}

/**
 * Returns true if the given resolved IP literal is explicitly permitted by the
 * allowlist (matching an exact IP entry or falling within a CIDR range).
 */
function ipAllowed(allowlist: Allowlist, ip: string): boolean {
  if (isIPv4(ip)) {
    const octets = parseIPv4Octets(ip);
    if (!octets) return false;
    const value = ipv4ToInt(octets);
    if (allowlist.ipv4.has(value)) return true;
    return allowlist.cidr4.some((c) => ((value & c.mask) >>> 0) === c.base);
  }

  if (isIPv6(ip)) {
    const groups = parseIPv6(ip);
    if (!groups) return false;
    const value = ipv6ToBigInt(groups);
    if (allowlist.ipv6.has(value)) return true;
    return allowlist.cidr6.some((c) => (value & c.mask) === c.base);
  }

  return false;
}
