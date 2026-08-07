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
 * DNS rebinding (TOCTOU): a successful validation returns the exact addresses
 * it approved in `addresses`. The caller must pin those at connect time (see
 * buildDispatcher in fetch-dispatcher.ts) so the connection cannot land on a
 * different address than the one that passed the denylist. Without pinning,
 * fetch() re-resolves independently and an attacker-controlled short-TTL record
 * can answer with a public IP for the check and an internal one for the request.
 */

import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';

/**
 * Default ceiling on the SSRF pre-flight DNS lookup.
 *
 * `lookup()` from node:dns/promises accepts neither a timeout nor an
 * AbortSignal, and this resolution runs BEFORE the request's own
 * AbortSignal.timeout is armed. Left unbounded, a hostname whose resolver never
 * answers hangs the whole request for as long as the OS resolver waits — time
 * that is invisible to settings.timeout and to the reported duration_ms.
 */
export const DEFAULT_DNS_TIMEOUT_MS = 5000;

/** Thrown by lookupWithTimeout when the DNS lookup outruns its budget. */
class DnsTimeoutError extends Error {
  constructor(
    public readonly hostname: string,
    public readonly timeoutMs: number,
  ) {
    super(`DNS lookup for ${hostname} exceeded ${timeoutMs}ms`);
    this.name = 'DnsTimeoutError';
  }
}

/**
 * Resolve the DNS lookup budget, letting the operator raise it for slow
 * resolvers via BRUNO_DNS_TIMEOUT_MS. Read per call (a single env read is
 * cheap and keeps tests free of cache-reset bookkeeping). Any non-positive or
 * non-finite value falls back to the default rather than disabling the bound.
 */
function resolveDnsTimeoutMs(): number {
  const raw = process.env.BRUNO_DNS_TIMEOUT_MS;
  if (raw === undefined || raw === '') {
    return DEFAULT_DNS_TIMEOUT_MS;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_DNS_TIMEOUT_MS;
  }
  return n;
}

/**
 * lookup() bounded by a timeout. Since lookup() cannot itself be cancelled, the
 * bound is a race against an unref'd timer; the losing lookup is left to settle
 * on its own, and its eventual result/rejection is swallowed so it cannot
 * surface as an unhandled rejection after the race has moved on.
 */
async function lookupWithTimeout(hostname: string): Promise<LookupAddress[]> {
  const timeoutMs = resolveDnsTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DnsTimeoutError(hostname, timeoutMs)), timeoutMs);
    // Do not keep the process alive solely to wait out this timer.
    timer.unref?.();
  });
  const lookupPromise = lookup(hostname, { all: true });
  // If the lookup settles after the timeout already won the race, its result is
  // ignored — guard against an unhandled rejection from that orphaned promise.
  lookupPromise.catch(() => {});
  try {
    return await Promise.race([lookupPromise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export interface UrlValidationResult {
  valid: boolean;
  reason?: string;
  /**
   * True when an allowlist entry could legitimately permit this target, i.e.
   * the block is a policy decision about a well-formed address rather than a
   * malformed URL or a DNS failure. Only these blocks get remediation text —
   * telling a caller to allowlist a typo'd hostname would be worse than
   * saying nothing.
   */
  allowlistOverridable?: boolean;
  /**
   * The concrete addresses this validation approved, present only on success.
   * Pin these at connect time to close the DNS-rebinding window between the
   * check and the request.
   *
   * Absent when there is nothing to pin: a host matched by the operator's
   * BRUNO_SSRF_ALLOWLIST is never resolved here (the operator has vouched for
   * the name, not for a particular address), so the connection resolves it
   * normally.
   */
  addresses?: string[];
  /**
   * The URL that was actually checked, present only on success.
   *
   * A transport must dial THIS and never re-parse the author's raw target. The
   * two differ whenever normalisation did something — a bare `host:port` gained
   * a scheme, or a non-special scheme's host was lower-cased — and re-parsing
   * the original would mean the string that was checked and the string that is
   * dialled are not the same string.
   */
  normalisedUrl?: string;
}

/** Schemes the HTTP callers permit. Anything else must opt in explicitly. */
const DEFAULT_ALLOWED_SCHEMES: readonly string[] = ['http', 'https'];

/**
 * Schemes the WHATWG URL parser treats as "special" and therefore normalises for
 * us: it lower-cases the host, applies IDNA, resolves IPv4 shorthand, and reads a
 * backslash in the authority as a delimiter rather than as data.
 *
 * `ws` and `wss` are on that list; `grpc` and `grpcs` are not, and the difference
 * is not cosmetic. Measured:
 *
 *   ws://10.0.0.1\@evil.com:8080    -> hostname "10.0.0.1"   (safe)
 *   grpc://10.0.0.1\@evil.com:50051 -> hostname "evil.com"   (host confusion)
 *   ws://EXAMPLE.com                -> "example.com"
 *   grpc://EXAMPLE.com              -> "EXAMPLE.com"
 *
 * So a single normaliser written on the assumption that all four behave alike
 * would be wrong for two of them. The non-special schemes get the checks the
 * parser declines to perform.
 */
const SPECIAL_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'ws', 'wss', 'ftp', 'file']);

export interface UrlValidationOptions {
  /**
   * Schemes this call permits. Defaults to http/https, so the existing HTTP call
   * sites keep exactly today's narrow gate and only a transport that needs a
   * wider one has to say so.
   */
  allowedSchemes?: readonly string[];
  /**
   * Scheme to assume when the target carries none, e.g. a bare `host:port` gRPC
   * target. Omitted by the HTTP callers, so their behaviour is unchanged.
   */
  defaultScheme?: string;
}

/**
 * Give a scheme-less target its scheme before anything tries to parse it.
 *
 * Shape first, deliberately. The tempting order — try `new URL`, prepend on
 * failure — does not work, because `new URL('example.com:50051')` SUCCEEDS,
 * yielding `{protocol:'example.com:', hostname:'', pathname:'50051'}`. Only a
 * digit-leading authority such as `127.0.0.1:50051` throws. So a hostname target
 * would sail past the try/catch and be rejected later as a blocked scheme named
 * after the host itself.
 */
function withDefaultScheme(url: string, defaultScheme: string | undefined): string {
  if (defaultScheme === undefined) return url;
  const trimmed = url.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `${defaultScheme}://${trimmed}`;
}

/**
 * Reject a backslash in the authority of a non-special-scheme URL.
 *
 * The parser reads it as data rather than as a delimiter for these schemes, so
 * `grpc://10.0.0.1\@evil.com:50051` resolves to `evil.com` while looking, to a
 * human reviewing the collection file, like it targets `10.0.0.1`.
 */
function authorityHasBackslash(url: string): boolean {
  const start = url.indexOf('://');
  if (start === -1) return false;
  const rest = url.slice(start + 3);
  const end = rest.search(/[/?#]/);
  return (end === -1 ? rest : rest.slice(0, end)).includes('\\');
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
export async function validateUrl(
  url: string,
  options?: UrlValidationOptions,
): Promise<UrlValidationResult> {
  const allowedSchemes = options?.allowedSchemes ?? DEFAULT_ALLOWED_SCHEMES;

  // Normalise by shape before parsing, so a scheme-less target is not later
  // rejected as a scheme named after its own host. A no-op unless the caller
  // supplied a default scheme.
  const candidate = withDefaultScheme(url, options?.defaultScheme);

  // Parse the URL
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { valid: false, reason: 'Invalid URL: unable to parse' };
  }

  // 1. Check scheme against the set this caller permits
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (!allowedSchemes.includes(scheme)) {
    return {
      valid: false,
      reason: `Blocked scheme: ${scheme}. Only ${allowedSchemes.join(' and ')} are allowed`,
    };
  }

  // 1b. For a scheme the parser does not treat as special, perform the authority
  // checks it declines to perform. Skipped for http/https/ws/wss, where the
  // parser has already read a backslash as a delimiter.
  if (!SPECIAL_SCHEMES.has(scheme) && authorityHasBackslash(candidate)) {
    return {
      valid: false,
      reason: 'Invalid URL: backslash in authority. '
        + `The "${scheme}" scheme is not normalised by the URL parser, so this would resolve to a `
        + 'different host than it appears to name',
    };
  }

  const rawHostname = parsed.hostname.toLowerCase();

  // 2. Reject empty hostname
  // Note: some URL parsers treat 'http:///path' as hostname='path', so also
  // check if the original URL had an authority section with empty host.
  //
  // Reachable: a non-special scheme accepts an empty authority where http would
  // throw — `new URL('grpcs://')` parses with hostname '', while `new URL('wss://')`
  // throws. Left unchecked, `checkHostname('')` returns null and the empty name
  // reaches `dns.lookup('')`, which has historically resolved to loopback on
  // Linux — a platform-dependent bypass.
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
  const schemeEnd = candidate.indexOf('://');
  if (schemeEnd !== -1 && candidate[schemeEnd + 3] === '/') {
    return { valid: false, reason: 'Invalid URL: empty hostname' };
  }

  // The string a transport must dial. Rebuilt from the parsed URL rather than
  // handed back verbatim, so a non-special scheme's host arrives lower-cased —
  // the parser does not do it for those, and the checks below all ran against the
  // lower-cased form.
  const normalisedUrl = parsed.hostname === hostname
    ? parsed.toString()
    : (() => {
      const rebuilt = new URL(parsed.toString());
      rebuilt.hostname = hostname;
      return rebuilt.toString();
    })();

  const allowlist = getAllowlist();

  // 3. Explicit host allowlist — an operator-approved exact hostname bypasses
  // all host/IP policy checks (the operator has vouched for this target).
  if (allowlist.hosts.has(hostname)) {
    return { valid: true, normalisedUrl };
  }

  // 4. Check hostname denylist (localhost, *.local, cloud metadata)
  const hostnameResult = checkHostname(hostname);
  if (hostnameResult) {
    return { ...hostnameResult, allowlistOverridable: true };
  }

  // 5. Resolve the target to concrete IP address(es).
  let ips: string[];
  if (isIPv4(hostname) || isIPv6(hostname)) {
    ips = [hostname];
  } else {
    try {
      const records = await lookupWithTimeout(hostname);
      ips = records.map((r) => r.address);
    } catch (err) {
      if (err instanceof DnsTimeoutError) {
        return {
          valid: false,
          reason: `DNS resolution timed out after ${err.timeoutMs}ms for hostname: ${hostname}`,
        };
      }
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
        return { ...ipv6Result, allowlistOverridable: true };
      }
    } else if (isIPv4(ip)) {
      // Fail closed: an address that looks like IPv4 but does not parse is blocked.
      if (!parseIPv4Octets(ip)) {
        return { valid: false, reason: `Blocked: unparseable IPv4 address (${ip})` };
      }
      const ipv4Result = checkIPv4(ip);
      if (ipv4Result) {
        return { ...ipv4Result, allowlistOverridable: true };
      }
    } else {
      // A resolved address that is neither IPv4 nor IPv6 — fail closed.
      return { valid: false, reason: `Blocked: unrecognized resolved address (${ip})` };
    }
  }

  // Hand back exactly the addresses that were checked, so the connection is
  // pinned to them instead of re-resolving the hostname (DNS rebinding).
  return { valid: true, addresses: ips, normalisedUrl };
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

  // 0.0.0.0/8 — "this host on this network" (RFC 1122). The whole /8 is
  // blocked, not just 0.0.0.0: Linux routes any 0.x.y.z to the local host, so
  // http://0.0.0.1/ reaches loopback while looking like an ordinary address.
  if (a === 0) {
    const label = b === 0 && c === 0 && d === 0 ? '0.0.0.0 (unspecified address)' : 'this-host range (0.0.0.0/8)';
    return { valid: false, reason: `Blocked IP: ${label}` };
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

  // 100.64.0.0/10 — shared address space / CGNAT (RFC 6598).
  // Also contains 100.100.100.200 (Alibaba/Oracle Cloud metadata endpoint).
  if (a === 100 && b >= 64 && b <= 127) {
    return { valid: false, reason: 'Blocked IP: shared address space / CGNAT (100.64.0.0/10)' };
  }

  // 192.0.0.0/24 — IETF protocol assignments (RFC 6890).
  if (a === 192 && b === 0 && c === 0) {
    return { valid: false, reason: 'Blocked IP: IETF protocol assignments (192.0.0.0/24)' };
  }

  // 192.0.2.0/24 — documentation range TEST-NET-1 (RFC 5737).
  if (a === 192 && b === 0 && c === 2) {
    return { valid: false, reason: 'Blocked IP: documentation range TEST-NET-1 (192.0.2.0/24)' };
  }

  // 192.88.99.0/24 — 6to4 relay anycast (RFC 3068, deprecated by RFC 7526).
  // A packet sent here is handed to whichever relay is nearest, so the operator
  // of the destination is not knowable from the address.
  if (a === 192 && b === 88 && c === 99) {
    return { valid: false, reason: 'Blocked IP: 6to4 relay anycast (192.88.99.0/24)' };
  }

  // 198.18.0.0/15 — benchmarking (RFC 2544); 198.18.0.0 - 198.19.255.255.
  if (a === 198 && (b === 18 || b === 19)) {
    return { valid: false, reason: 'Blocked IP: benchmarking range (198.18.0.0/15)' };
  }

  // 198.51.100.0/24 — documentation range TEST-NET-2 (RFC 5737).
  if (a === 198 && b === 51 && c === 100) {
    return { valid: false, reason: 'Blocked IP: documentation range TEST-NET-2 (198.51.100.0/24)' };
  }

  // 203.0.113.0/24 — documentation range TEST-NET-3 (RFC 5737).
  if (a === 203 && b === 0 && c === 113) {
    return { valid: false, reason: 'Blocked IP: documentation range TEST-NET-3 (203.0.113.0/24)' };
  }

  // 224.0.0.0/4 — multicast (RFC 5771); 224.0.0.0 - 239.255.255.255.
  // Includes 239.255.255.250 (SSDP) — internal service discovery.
  if (a >= 224 && a <= 239) {
    return { valid: false, reason: 'Blocked IP: multicast address (224.0.0.0/4)' };
  }

  // 255.255.255.255 — limited broadcast (RFC 919). Checked before 240.0.0.0/4,
  // which also contains it, so the more specific reason is the one reported.
  if (a === 255 && b === 255 && c === 255 && d === 255) {
    return { valid: false, reason: 'Blocked IP: limited broadcast address (255.255.255.255)' };
  }

  // 240.0.0.0/4 — reserved for future use, formerly class E (RFC 1112).
  // Not globally routable, and stacks disagree on how they treat it.
  if (a >= 240) {
    return { valid: false, reason: 'Blocked IP: reserved range (240.0.0.0/4)' };
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

  // 64:ff9b:1::/48 — the local-use NAT64 prefix (RFC 8215). Blocked wholesale
  // rather than decoded: deployments carve their own /96 out of this range, so
  // where the IPv4 address sits inside it is a site-local convention rather
  // than something the address itself states. Reserved for local use means any
  // address here is inside the site, which is what makes it unreachable-by-policy
  // whatever IPv4 it turns out to carry.
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 1) {
    return { valid: false, reason: 'Blocked IPv6: local-use NAT64 range (64:ff9b:1::/48)' };
  }

  // Every transitional encoding that carries an IPv4 address inside an IPv6
  // one has to be un-embedded before the address is called clean, or the IPv4
  // denylist never sees the address that is actually reached.
  for (const candidate of embeddedIPv4Candidates(groups)) {
    if (checkIPv4(candidate.ipv4)) {
      return {
        valid: false,
        reason:
          `Blocked IPv6: ${candidate.mechanism} address (${candidate.form}) ` +
          'embeds a private/reserved IPv4 address',
      };
    }
  }

  return null;
}

/** One IPv4 address recovered from an IPv6 transitional encoding. */
interface EmbeddedIPv4 {
  /** The recovered IPv4 address in dotted-quad form. */
  ipv4: string;
  /** Name of the transition mechanism that defines this encoding. */
  mechanism: string;
  /** How the address reads once the embedded IPv4 is spelled out. */
  form: string;
}

/** Join two 16-bit groups into a dotted-quad IPv4 address. */
function dottedQuad(high: number, low: number): string {
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

/**
 * Recover every IPv4 address embedded in an IPv6 address by a transition
 * mechanism. Returns one entry per encoding that applies — usually zero (an
 * ordinary IPv6 address embeds nothing) or one.
 *
 * Each recognised prefix is either IANA-reserved for translation or, in the
 * 6to4 case, defined so that the embedded IPv4 fully determines the
 * destination. So an entry here is never a guess about an ordinary global
 * address: if the encoding matches, the IPv4 it yields is genuinely where the
 * packet ends up, and it belongs in front of the IPv4 denylist.
 */
function embeddedIPv4Candidates(groups: number[]): EmbeddedIPv4[] {
  const found: EmbeddedIPv4[] = [];
  const zeroThrough = (upTo: number): boolean => groups.slice(0, upTo + 1).every((g) => g === 0);

  // ::ffff:a.b.c.d — IPv4-mapped (RFC 4291), and ::a.b.c.d — IPv4-compatible,
  // deprecated by the same RFC but still routed by most stacks.
  if (zeroThrough(4) && (groups[5] === 0xffff || groups[5] === 0)) {
    const ipv4 = dottedQuad(groups[6], groups[7]);
    found.push({
      ipv4,
      mechanism: groups[5] === 0xffff ? 'IPv4-mapped' : 'IPv4-compatible',
      form: groups[5] === 0xffff ? `::ffff:${ipv4}` : `::${ipv4}`,
    });
  }

  // ::ffff:0:a.b.c.d — IPv4-translated (RFC 2765). One group further left than
  // the mapped form above, which is exactly what let it through unnoticed.
  if (zeroThrough(3) && groups[4] === 0xffff && groups[5] === 0) {
    const ipv4 = dottedQuad(groups[6], groups[7]);
    found.push({ ipv4, mechanism: 'IPv4-translated (RFC 2765)', form: `::ffff:0:${ipv4}` });
  }

  // 64:ff9b::/96 — the NAT64 well-known prefix (RFC 6052), which that RFC
  // permits only at /96, so the IPv4 address is always the low 32 bits.
  if (
    groups[0] === 0x0064 && groups[1] === 0xff9b &&
    groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0
  ) {
    const ipv4 = dottedQuad(groups[6], groups[7]);
    found.push({ ipv4, mechanism: 'NAT64 (RFC 6052)', form: `64:ff9b::${ipv4}` });
  }

  // 2002::/16 — 6to4 (RFC 3056). The IPv4 address of the tunnel endpoint sits
  // in the 32 bits after the prefix and decides where the traffic surfaces.
  if (groups[0] === 0x2002) {
    const ipv4 = dottedQuad(groups[1], groups[2]);
    found.push({ ipv4, mechanism: '6to4 (RFC 3056)', form: `2002:${ipv4}::` });
  }

  // 2001::/32 — Teredo (RFC 4380). Two IPv4 addresses are embedded: the relay
  // server plainly, and the client obfuscated by a bitwise complement.
  if (groups[0] === 0x2001 && groups[1] === 0) {
    const server = dottedQuad(groups[2], groups[3]);
    found.push({ ipv4: server, mechanism: 'Teredo server (RFC 4380)', form: `2001:0:${server}::` });
    const client = dottedQuad(~groups[6] & 0xffff, ~groups[7] & 0xffff);
    found.push({ ipv4: client, mechanism: 'Teredo client (RFC 4380)', form: `2001:0:: -> ${client}` });
  }

  // ::0:5efe:a.b.c.d / ::200:5efe:a.b.c.d — ISATAP interface identifiers
  // (RFC 5214) under any routing prefix. The tunnel terminates at the embedded
  // IPv4 address, so a public prefix is no assurance about the destination.
  if (groups[5] === 0x5efe && (groups[4] === 0 || groups[4] === 0x0200)) {
    const ipv4 = dottedQuad(groups[6], groups[7]);
    found.push({ ipv4, mechanism: 'ISATAP (RFC 5214)', form: `::${groups[4] === 0 ? '0' : '200'}:5efe:${ipv4}` });
  }

  return found;
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
/**
 * Number of configured allowlist entries, across all entry kinds.
 *
 * Deliberately a count and not the entries themselves: the entries name
 * internal hosts, and an error message is the wrong place to hand them to a
 * caller that did not already know them.
 */
export function allowlistEntryCount(): number {
  const a = getAllowlist();
  return a.hosts.size + a.ipv4.size + a.ipv6.size + a.cidr4.length + a.cidr6.length;
}

/**
 * Remediation sentence appended to an allowlist-overridable SSRF block.
 *
 * Two cases, because the correct next action differs. With nothing configured
 * the caller cannot fix this from the tools at all and should stop and escalate;
 * with entries present, reaching the service by an already-allowlisted route is
 * the intended path, not a workaround.
 *
 * Phrased as operator configuration rather than as an instruction to the reader:
 * an imperative here reads as a to-do, and a caller acting on it would be
 * launching a process with a security control disabled.
 */
export function ssrfRemediation(): string {
  const count = allowlistEntryCount();
  const preamble =
    'Targets that resolve to private, loopback, link-local or otherwise reserved ' +
    'addresses are refused unless the server operator allowlists them via the ' +
    'BRUNO_SSRF_ALLOWLIST environment variable (comma-separated hostnames, IPs or CIDRs).';

  if (count === 0) {
    return (
      `${preamble} No entries are configured. This is an authorization decision, not a ` +
      'transport failure — it will not resolve by retrying or by using a different client. ' +
      'Report to the user that an allowlist entry is required.'
    );
  }

  return (
    `${preamble} ${count} ${count === 1 ? 'entry is' : 'entries are'} configured; none match ` +
    'this target. If the service is also reachable at an allowlisted hostname or address, use ' +
    'that. Otherwise report to the user that an entry must be added.'
  );
}

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
