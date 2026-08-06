/**
 * Trust decisions shared by every transport, not just undici.
 *
 * These two primitives used to be private to `fetch-dispatcher.ts`, which is
 * HTTP-only. That was safe while HTTP was the only thing that opened a socket:
 * once gRPC and WebSocket can dial out, a trust gate reachable from just one
 * transport is a gate with a hole in it — `grpcs://` and `wss://` would have
 * bypassed the collection-TLS check entirely, and silently.
 *
 * A collection file is untrusted input. It may ask for a weaker TLS posture, and
 * the answer is no unless the operator named the host in an environment
 * variable. `rejectUnauthorized: true` is not a downgrade and is always honoured.
 */

import type { TlsSettings } from './types.js';

let tlsHostsCache: Set<string> | null = null;

/**
 * Parse a comma-separated host allowlist from an environment variable.
 *
 * Shared with the proxy allowlist in `fetch-dispatcher.ts`, which is why it is
 * exported rather than kept local to the TLS gate.
 */
export function parseHostAllowlist(raw: string | undefined): Set<string> {
  const set = new Set<string>();
  if (!raw) return set;
  for (const part of raw.split(',')) {
    const entry = part.trim().toLowerCase();
    if (!entry) continue;
    if (entry.includes('*')) {
      // A wildcard would defeat the point of an explicit allowlist.
      console.warn(`[bruno-mcp TLS/proxy] Ignoring wildcard host entry "${entry}"`);
      continue;
    }
    set.add(entry);
  }
  return set;
}

function tlsHosts(): Set<string> {
  if (tlsHostsCache === null) {
    tlsHostsCache = parseHostAllowlist(process.env.BRUNO_INSECURE_TLS_HOSTS);
  }
  return tlsHostsCache;
}

/** Reset the cached TLS allowlist. Exported for testing. */
export function resetTransportTrustCache(): void {
  tlsHostsCache = null;
}

export function hostAllowed(host: string | undefined, set: Set<string>): boolean {
  return host !== undefined && set.has(host.toLowerCase());
}

/** A TLS block is privileged if it downgrades verification or supplies its own trust material. */
function tlsIsPrivileged(tls: TlsSettings): boolean {
  return tls.rejectUnauthorized === false || !!tls.ca || !!tls.cert || !!tls.key;
}

/**
 * Return the TLS settings actually applied for `host`. If the block is
 * privileged and the host is not operator-allowlisted, the dangerous fields are
 * dropped (a warning naming the host and the field NAMES — never their values —
 * is emitted) and only an explicit `rejectUnauthorized: true` floor is kept.
 * Returns undefined when nothing safe remains.
 *
 * Every transport that can negotiate TLS routes through this, keyed on the same
 * host, so one allowlist entry means the same thing whichever protocol asks.
 */
export function gateTls(
  tls: TlsSettings | undefined,
  host: string | undefined,
): TlsSettings | undefined {
  if (!tls) return undefined;
  if (!tlsIsPrivileged(tls) || hostAllowed(host, tlsHosts())) return tls;

  const dropped: string[] = [];
  if (tls.rejectUnauthorized === false) dropped.push('rejectUnauthorized');
  if (tls.ca) dropped.push('ca');
  if (tls.cert) dropped.push('cert');
  if (tls.key) dropped.push('key');
  console.warn(
    `[bruno-mcp TLS/proxy] Ignoring collection TLS override (${dropped.join(', ')}) for host ` +
      `"${host ?? '(unknown)'}": not in BRUNO_INSECURE_TLS_HOSTS`,
  );

  if (tls.rejectUnauthorized === true) return { rejectUnauthorized: true };
  return undefined;
}

interface LookupAddress {
  address: string;
  family: number;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A `net.connect` lookup that ignores DNS and answers with the already-validated
 * addresses. Node calls it either in "all" mode (an array, used by
 * autoSelectFamily/Happy Eyeballs) or single mode (address + family), and may
 * constrain the family; all three shapes are honoured so multi-record failover
 * still works.
 *
 * Callers must not hand this an empty list: it fails closed with ENOTFOUND
 * rather than falling back to a real lookup, which is correct but looks like a
 * DNS failure. When no address was pinned — an allowlisted hostname produces
 * none — omit the lookup instead of passing `[]`.
 */
export function pinnedLookup(addresses: string[]) {
  const entries: LookupAddress[] = addresses.map((address) => ({
    address,
    family: address.includes(':') ? 6 : 4,
  }));

  return (
    hostname: string,
    options: { family?: number; all?: boolean } | undefined,
    callback: LookupCallback,
  ): void => {
    const wanted = options?.family;
    const matching =
      wanted === 4 || wanted === 6 ? entries.filter((e) => e.family === wanted) : entries;

    if (matching.length === 0) {
      // Fail closed: never let a family mismatch fall back to a real lookup.
      const err: NodeJS.ErrnoException = new Error(
        `No validated address for ${hostname} in the requested address family`,
      );
      err.code = 'ENOTFOUND';
      callback(err);
      return;
    }

    if (options?.all) {
      callback(null, matching);
      return;
    }
    callback(null, matching[0].address, matching[0].family);
  };
}
