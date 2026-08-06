import type { TlsSettings, YamlSettings } from './types.js';
import {
  gateTls,
  hostAllowed,
  parseHostAllowlist,
  pinnedLookup,
  resetTransportTrustCache,
} from './transport-trust.js';

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
 *
 * The TLS half of that boundary lives in `transport-trust.ts`, because gRPC and
 * WebSocket negotiate TLS too and a gate reachable from only this module would
 * leave `grpcs://` and `wss://` ungated. Only the proxy half is still local:
 * neither of those transports supports a proxy here.
 */

let proxyHostsCache: Set<string> | null = null;

function proxyHosts(): Set<string> {
  if (proxyHostsCache === null) {
    proxyHostsCache = parseHostAllowlist(process.env.BRUNO_PROXY_HOSTS);
  }
  return proxyHostsCache;
}

/**
 * Reset the cached env allowlists. Exported for testing.
 *
 * The TLS half of that state now lives in `transport-trust.ts`, shared with the
 * gRPC and WebSocket transports, so both have to be cleared together — resetting
 * only the local one would leave a test looking at a stale TLS allowlist.
 */
export function resetDispatcherTrustCache(): void {
  proxyHostsCache = null;
  resetTransportTrustCache();
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
