import type { TlsSettings, YamlSettings } from './types.js';

/**
 * Build a custom undici Dispatcher from TLS/proxy settings.
 * Returns undefined when no TLS or proxy settings are configured,
 * so the caller can fall back to global fetch().
 */
export async function buildDispatcher(
  settings: YamlSettings,
): Promise<{ dispatcher: unknown; fetch: typeof globalThis.fetch } | undefined> {
  const hasTls =
    settings.tls &&
    (settings.tls.rejectUnauthorized !== undefined ||
      settings.tls.ca ||
      settings.tls.cert ||
      settings.tls.key);
  const hasProxy = !!settings.proxy;

  if (!hasTls && !hasProxy) {
    return undefined;
  }

  // Dynamic import — undici is only loaded when TLS/proxy settings are present
  const undici = await import('undici');

  if (hasProxy) {
    const connectOpts = hasTls ? buildConnectOptions(settings.tls!) : undefined;
    const proxyAgent = new undici.ProxyAgent({
      uri: settings.proxy!,
      ...(connectOpts ? { requestTls: connectOpts } : {}),
    });
    return { dispatcher: proxyAgent, fetch: undici.fetch as unknown as typeof globalThis.fetch };
  }

  // TLS only (no proxy)
  const connectOpts = buildConnectOptions(settings.tls!);
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
