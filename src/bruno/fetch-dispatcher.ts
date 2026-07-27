import type { TlsSettings, YamlSettings } from './types.js';

/**
 * Operator trust boundary for collection-supplied TLS/proxy overrides.
 *
 * A collection file is untrusted input. Honouring its `settings.tls` /
 * `settings.proxy` unconditionally lets any collection disable certificate
 * verification, install its own CA/client certificate, or route every request
 * — with all its credentials — through a proxy it names: a silent MITM with no
 * preconditions (findings S10/S11/S12). So these overrides are DENIED by
 * default and re-enabled only per target host by the operator, mirroring the
 * host-scoped SSRF allowlist (finding S13):
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

/**
 * Build a custom undici Dispatcher from a collection's TLS/proxy settings,
 * gated by the operator trust boundary above. `host` is the target host of the
 * request the dispatcher will serve; it is what the allowlists are checked
 * against. Returns undefined when no (permitted) TLS or proxy settings remain,
 * so the caller falls back to the verifying global fetch().
 */
export async function buildDispatcher(
  settings: YamlSettings,
  host?: string,
): Promise<{ dispatcher: unknown; fetch: typeof globalThis.fetch } | undefined> {
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

  if (!hasTls && !hasProxy) {
    return undefined;
  }

  // Dynamic import — undici is only loaded when TLS/proxy settings are present
  const undici = await import('undici');

  if (hasProxy) {
    const connectOpts = hasTls ? buildConnectOptions(tls!) : undefined;
    const proxyAgent = new undici.ProxyAgent({
      uri: proxy!,
      ...(connectOpts ? { requestTls: connectOpts } : {}),
    });
    return { dispatcher: proxyAgent, fetch: undici.fetch as unknown as typeof globalThis.fetch };
  }

  // TLS only (no proxy)
  const connectOpts = buildConnectOptions(tls!);
  const agent = new undici.Agent({ connect: connectOpts });
  return { dispatcher: agent, fetch: undici.fetch as unknown as typeof globalThis.fetch };
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
