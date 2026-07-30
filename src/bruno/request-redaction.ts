/**
 * Keeping credentials out of two places they must never reach: the values
 * reported back to the caller, and a redirect hop to a different origin.
 *
 * Both halves are about the same class of secret — a token substituted out of an
 * environment file — leaking by a route nobody looks at. A URL is echoed in
 * `result.url` and in every error message; a header survives a 302 to whatever
 * host the target names.
 *
 * Extracted from request-executor.ts, which crossed the repo-wide max-lines
 * ceiling.
 */

/** Query-parameter names whose values are masked before a URL is shown to the caller. */
const SECRET_QUERY_PARAMS = new Set([
  'key', 'api-key', 'apikey', 'api_key', 'x-api-key',
  'token', 'access_token', 'refresh_token', 'id_token', 'api_token', 'apitoken',
  'secret', 'client_secret', 'password', 'pwd', 'passwd',
  'auth', 'authorization', 'sig', 'signature', 'session', 'sessionid',
]);

/**
 * Redact secrets from a URL before it is returned to the caller or embedded in
 * an error message. A query api-key or userinfo
 * (`https://user:pass@host`) substituted from an env file must not cross back
 * over the MCP boundary. Userinfo is always stripped; the values of known
 * secret-bearing query parameters are masked. When there is nothing sensitive
 * the input is returned byte-for-byte (so ordinary reported URLs are unchanged),
 * and a URL that cannot be parsed is returned as-is (it already passed SSRF
 * validation, which parses it).
 *
 * `extraSecretNames` are additional parameter names to mask, matched
 * case-insensitively like the built-in set. An api-key auth block names its own
 * query parameter and that name is usually NOT one of the well-known ones, so
 * without passing it here the credential the request actually sent is the one
 * secret the redactor cannot see.
 */
export function redactUrl(raw: string, extraSecretNames?: readonly string[]): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  const extra = new Set((extraSecretNames ?? []).map(n => n.toLowerCase()));
  const secretNames = [...u.searchParams.keys()].filter(n => {
    const lower = n.toLowerCase();
    return SECRET_QUERY_PARAMS.has(lower) || extra.has(lower);
  });
  if (!u.username && !u.password && secretNames.length === 0) {
    return raw;
  }
  u.username = '';
  u.password = '';
  for (const name of secretNames) {
    u.searchParams.set(name, 'REDACTED');
  }
  return u.toString();
}

/**
 * Append a query-placed credential to a URL.
 *
 * Uses `URL.searchParams.set`, which is what Bruno itself does for a
 * `queryparams`-placed api-key: it survives a fragment (string concatenation put
 * the parameter *inside* the `#fragment`, so the credential never reached the
 * server) and it replaces a stale parameter of the same name instead of sending
 * two.
 *
 * A URL with no scheme cannot be parsed at this stage — the executor only
 * prefixes one later, if `settings.encodeUrl` is on — so concatenation remains
 * the path for that case rather than dropping the credential.
 */
export function appendQueryCredential(url: string, key: string, value: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set(key, value);
    return u.toString();
  } catch {
    return (
      url +
      (url.includes('?') ? '&' : '?') +
      `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    );
  }
}

/** Credential headers always dropped on a cross-origin redirect, in addition to the request's own auth headers. */
const CROSS_ORIGIN_STRIP_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

/**
 * Drop credential-bearing headers when a redirect crosses to a different origin
 *. Real fetch() strips these on a cross-origin redirect; the
 * manual redirect loop must do the same, or a target that 302s to an attacker
 * hands it the caller's Authorization / api-key / cookies. `authHeaderNames`
 * are the header names auth was actually applied to, so a caller-named api-key
 * header (e.g. X-Api-Key) is stripped too — not just the standard set.
 */
export function stripCredentialHeaders(
  headers: Record<string, string>,
  authHeaderNames: string[],
): Record<string, string> {
  const deny = new Set([
    ...CROSS_ORIGIN_STRIP_HEADERS,
    ...authHeaderNames.map(n => n.toLowerCase()),
  ]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!deny.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}
