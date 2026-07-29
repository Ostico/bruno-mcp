import type { TlsSettings, YamlSettings } from './types.js';

/**
 * Operator trust boundary for collection-supplied TLS/proxy overrides.
 *
 * A collection file is untrusted input. Honouring its `settings.tls` /
 * `settings.proxy` unconditionally lets any collection disable certificate
 * verification, install its own CA/client certificate, or route every request
 * — with all its credentials — through a proxy it names: a silent MITM with no
 * preconditions. So these overrides are DENIED by
 * default and re-enabled only per target host by the operator, mirroring the
 * host-scoped SSRF allowlist:
 *
 *   BRUNO_INSECURE_TLS_HOSTS  hosts that may use a collection's
 *                             rejectUnauthorized:false / ca / cert / key
 *   BRUNO_PROXY_HOSTS         hosts that may use a collection's proxy
 *
 * Both are comma-separated, exact-match, case-insensitive host lists. A `*`
 * wildcard entry is silently ignored — the boundary must be explicit. A plain
 * `rejectUnauthorized: true` is not a downgrade and is always honoured.
 */

let tlsHostsCache: Set<string> | null = null;
let proxyHostsCache: Set<string> | null = null;

function parseHostAllowlist(raw: string | undefined): Set<string> {
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

function proxyHosts(): Set<string> {
  if (proxyHostsCache === null) {
    proxyHostsCache = parseHostAllowlist(process.env.BRUNO_PROXY_HOSTS);
  }
  return proxyHostsCache;
}

/** Reset the cached env allowlists. Exported for testing. */
export function resetDispatcherTrustCache(): void {
  tlsHostsCache = null;
  proxyHostsCache = null;
}

function hostAllowed(host: string | undefined, set: Set<string>): boolean {
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
 */
function gateTls(tls: TlsSettings | undefined, host: string | undefined): TlsSettings | undefined {
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

export interface DispatcherResult {
  dispatcher: unknown;
  fetch: typeof globalThis.fetch;
  /**
   * Release the sockets this dispatcher owns. Callers must invoke it once the
   * response body has been read. Never rejects — cleanup must not mask the
   * request result.
   */
  close: () => Promise<void>;
}

/**
 * Build a custom undici Dispatcher from a collection's TLS/proxy settings,
 * gated by the operator trust boundary above. `host` is the target host of the
 * request the dispatcher will serve; it is what the allowlists are checked
 * against.
 *
 * `pinnedAddresses` are the addresses validateUrl() already checked against the
 * SSRF denylist. When present, the dispatcher connects to exactly those and
 * performs no lookup of its own, which closes the DNS-rebinding window between
 * validation and connection. The Host header and TLS SNI
 * still carry the hostname, so virtual hosting and certificate validation are
 * unaffected.
 *
 * Returns undefined when there is nothing to apply — no permitted TLS or proxy
 * settings and nothing to pin — so the caller falls back to global fetch().
 */
export async function buildDispatcher(
  settings: YamlSettings,
  host?: string,
  pinnedAddresses?: string[],
): Promise<DispatcherResult | undefined> {
  const tls = gateTls(settings.tls, host);

  let proxy: string | undefined;
  if (settings.proxy) {
    if (hostAllowed(host, proxyHosts())) {
      proxy = settings.proxy;
    } else {
      // Name the host only — never the proxy URI, which may carry credentials.
      console.warn(
        `[bruno-mcp TLS/proxy] Ignoring collection proxy for host "${host ?? '(unknown)'}": ` +
          `not in BRUNO_PROXY_HOSTS`,
      );
    }
  }

  const hasTls =
    !!tls &&
    (tls.rejectUnauthorized !== undefined || !!tls.ca || !!tls.cert || !!tls.key);
  const hasProxy = !!proxy;

  // A proxy terminates the connection at the proxy host and resolves the target
  // itself, so there is no local lookup left to pin. Routing through it is
  // already an explicit operator decision (BRUNO_PROXY_HOSTS), and that is the
  // trust boundary covering the target the proxy reaches.
  const pinned =
    !hasProxy && pinnedAddresses && pinnedAddresses.length > 0 ? pinnedAddresses : undefined;

  if (!hasTls && !hasProxy && !pinned) {
    return undefined;
  }

  // Dynamic import — undici is only loaded once a custom dispatcher is needed
  const undici = await import('undici');

  if (hasProxy) {
    const proxyConnectOpts = hasTls ? buildConnectOptions(tls!) : undefined;
    const proxyAgent = new undici.ProxyAgent({
      uri: proxy!,
      ...(proxyConnectOpts ? { requestTls: proxyConnectOpts } : {}),
    });
    return {
      dispatcher: proxyAgent,
      fetch: undici.fetch as unknown as typeof globalThis.fetch,
      close: () => closeQuietly(proxyAgent),
    };
  }

  const connectOpts: Record<string, unknown> = hasTls ? buildConnectOptions(tls!) : {};
  if (pinned) {
    connectOpts.lookup = pinnedLookup(pinned);
  }
  const agent = new undici.Agent({ connect: connectOpts });
  return {
    dispatcher: agent,
    fetch: undici.fetch as unknown as typeof globalThis.fetch,
    close: () => closeQuietly(agent),
  };
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
 */
function pinnedLookup(addresses: string[]) {
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

async function closeQuietly(agent: { destroy: () => Promise<void> }): Promise<void> {
  try {
    await agent.destroy();
  } catch {
    // Best-effort socket cleanup; a failure here must not mask the request result.
  }
}

function buildConnectOptions(tls: TlsSettings): Record<string, unknown> {
  const opts: Record<string, unknown> = {};
  if (tls.rejectUnauthorized !== undefined) {
    opts.rejectUnauthorized = tls.rejectUnauthorized;
  }
  if (tls.ca) opts.ca = tls.ca;
  if (tls.cert) opts.cert = tls.cert;
  if (tls.key) opts.key = tls.key;
  return opts;
}
