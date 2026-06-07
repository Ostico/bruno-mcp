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
 * Does NOT perform DNS resolution (planned for v2).
 */

export interface UrlValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validate a URL for SSRF safety.
 *
 * @param url - The URL string to validate
 * @returns Validation result with optional reason for rejection
 */
export function validateUrl(url: string): UrlValidationResult {
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
  if (!rawHostname) {
    return { valid: false, reason: 'Invalid URL: empty hostname' };
  }

  // Strip IPv6 brackets if present (some Node.js versions keep them)
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname;

  // Detect empty-authority URLs like 'http:///path' where the parser
  // mistakenly treats the path component as the hostname.
  // A triple-slash after scheme means no host was provided.
  const schemeEnd = url.indexOf('://');
  if (schemeEnd !== -1 && url[schemeEnd + 3] === '/') {
    return { valid: false, reason: 'Invalid URL: empty hostname' };
  }

  // 3. Check hostname denylist
  const hostnameResult = checkHostname(hostname);
  if (hostnameResult) {
    return hostnameResult;
  }

  // 4. Check IPv6
  if (isIPv6(hostname)) {
    const ipv6Result = checkIPv6(hostname);
    if (ipv6Result) {
      return ipv6Result;
    }
  }

  // 5. Check IPv4
  if (isIPv4(hostname)) {
    const ipv4Result = checkIPv4(hostname);
    if (ipv4Result) {
      return ipv4Result;
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

  // ::ffff:0:0/96 — IPv4-mapped IPv6 addresses
  // Form: 0:0:0:0:0:ffff:a.b.c.d  (groups[0-4]=0, groups[5]=0xffff)
  // These bypass IPv4 checks if not handled explicitly.
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    // Reconstruct the embedded IPv4 address from groups[6] and groups[7]
    const a = (groups[6] >> 8) & 0xff;
    const b =  groups[6]       & 0xff;
    const c = (groups[7] >> 8) & 0xff;
    const d =  groups[7]       & 0xff;
    const embeddedIPv4 = `${a}.${b}.${c}.${d}`;
    const ipv4Result = checkIPv4(embeddedIPv4);
    if (ipv4Result) {
      return {
        valid: false,
        reason: `Blocked IPv6: IPv4-mapped address (::ffff:${embeddedIPv4}) embeds a private/reserved IPv4 address`,
      };
    }
  }

  return null;
}
