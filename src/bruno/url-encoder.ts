/**
 * The `settings.encodeUrl` transform, ported from Bruno so this server sends the
 * same bytes Bruno does.
 *
 * This is a deliberate byte-for-byte port rather than a reimplementation. The
 * point of running a Bruno collection here is that it behaves as it does in
 * Bruno; a "safer" or "tidier" encoding would make this server misreport what the
 * collection actually sends, and anyone debugging against the Bruno UI would be
 * chasing a difference introduced by us.
 *
 * Upstream shape (Bruno `packages/bruno-common/src/utils/url/index.ts`, applied
 * at the wire boundary in `bruno-electron/src/ipc/network/index.js` and the CLI's
 * `run-single-request.js`):
 *
 *     if (request.settings?.encodeUrl) request.url = encodeUrl(request.url);
 *
 * Two consequences of *where* it sits that matter more than the algorithm:
 *
 *  - It runs on the whole, already-assembled URL — after variable interpolation,
 *    after path parameters are substituted, after any pre-request script has
 *    rewritten the URL. It is a normalization pass over a finished string, not a
 *    per-value encoder.
 *  - Because it is a pass over a string, it cannot tell a separator that came
 *    from the template apart from one that arrived inside a variable's value. It
 *    normalizes; it does not sanitize. See `encodeRequestUrl` below.
 */

/**
 * `decodeURIComponent` that tolerates malformed input.
 *
 * A bare `%` or a truncated `%A` makes the built-in throw. Bruno decodes what it
 * can and leaves the rest alone so one stray percent in a path cannot fail the
 * whole request.
 */
export function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replace(/%[0-9A-Fa-f]{2}/g, (match) => {
      try {
        return decodeURIComponent(match);
      } catch {
        return match;
      }
    });
  }
}

/**
 * Encode path segments idempotently: decode first, then re-encode.
 *
 * The decode step is what makes a second pass harmless. Upstream, a URL reaches
 * this transform having already been through `new URL(url).pathname`, which
 * percent-encodes path characters on its own (` ` becomes `%20`). Encoding
 * blindly on top of that would yield `%2520`.
 *
 * The idempotency is path-side only — the query side is deliberately content
 * blind. See `encodeRequestUrl`.
 */
function encodePathSegments(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(safeDecodeURIComponent(segment)))
    .join('/');
}

interface QueryPair {
  name: string;
  /** `undefined` distinguishes `?flag` from `?flag=`, which must round-trip differently. */
  value: string | undefined;
}

/**
 * Split a query string into pairs without decoding them.
 *
 * A pair with an empty name is dropped, matching upstream. Note that the split
 * happens on the raw string: a `&` that arrived as part of a variable's value is
 * indistinguishable here from one written in the template, and becomes its own
 * pair. That is upstream behaviour and the reason this transform normalizes
 * rather than sanitizes.
 */
function parseQueryPairs(query: string): QueryPair[] {
  if (!query) return [];

  return query
    .split('&')
    .map((pair): QueryPair | null => {
      const [name, ...valueParts] = pair.split('=');
      if (!name) return null;
      // `?flag` carries no '=' at all and must not gain one.
      return { name, value: pair.includes('=') ? valueParts.join('=') : undefined };
    })
    .filter((pair): pair is QueryPair => pair !== null);
}

/**
 * Apply Bruno's URL encoding to a fully assembled URL.
 *
 * - Scheme and authority are preserved verbatim; only the path is encoded. The
 *   authority pattern accepts userinfo, port and bracketed IPv6 literals.
 * - The query side is **content blind**: an already-encoded value is encoded
 *   again, so `?q=%20` becomes `?q=%2520`. This is upstream's documented
 *   contract, not an oversight — it is what lets a pre-encoded redirect URL
 *   survive a server-side decode pass.
 * - `#` is treated as data, not as an RFC 3986 fragment delimiter, and ends up
 *   as `%23`. To send a literal fragment, the setting has to be off, which
 *   preserves the URL byte for byte.
 * - Pairs that end up empty, or that would start with `=`, are dropped.
 */
export function encodeRequestUrl(url: string): string {
  if (!url) return url;

  // `#` is not split off here: it flows into the path or the query value and is
  // encoded there.
  const queryIndex = url.indexOf('?');
  const originAndPath = queryIndex >= 0 ? url.slice(0, queryIndex) : url;
  const queryString = queryIndex >= 0 ? url.slice(queryIndex + 1) : '';

  // `#` is excluded from the authority class so a misplaced `#` before the first
  // `/` is treated as path data and encoded rather than silently splitting the
  // authority.
  const originMatch = originAndPath.match(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)?(.*)$/i);
  const origin = originMatch?.[1] ?? '';
  const path = originMatch?.[2] ?? originAndPath;

  let result = origin + encodePathSegments(path);

  if (queryIndex >= 0) {
    const rebuilt = parseQueryPairs(queryString)
      .map(({ name, value }) => {
        const encodedName = encodeURIComponent(name);
        return value === undefined ? encodedName : `${encodedName}=${encodeURIComponent(value)}`;
      })
      .filter((pair) => pair.length > 0 && !pair.startsWith('='))
      .join('&');
    result += `?${rebuilt}`;
  }

  return result;
}

/**
 * Whether the transform applies.
 *
 * The rule looks asymmetric and is: no settings object means off, a settings
 * object without `encodeUrl` means on. That is correct, but not for the reason
 * this comment used to give — it claimed the parser fills the key in as `true`
 * and that Bruno writes it explicitly on save. Both are wrong, and the real
 * mechanism is that **the two dialects disagree, upstream, about what an
 * omitted key means**:
 *
 *  - **`.bru`** — `@usebruno/lang` resolves the key while parsing and returns
 *    `encodeUrl: false` for a block that omits it (measured; see
 *    `settings-parser-oracle.test.ts`). `bruFileToYamlRequest` passes `settings`
 *    through verbatim, so a `.bru` request always arrives here with the flag
 *    already explicit. The `?? true` branch below is unreachable for it.
 *  - **`.yml`** — nothing resolves it, so an omitted key arrives as `undefined`,
 *    and upstream's own reader defaults it to `true`
 *    (`bruno-filestore/.../yml/items/parseHttpRequest.ts`: `else { settings.encodeUrl = true }`).
 *    That is the branch below.
 *
 * So `?? true` is the `.yml` default, not a statement about settings blocks in
 * general — and changing it to `=== true` silently breaks every `.yml` request
 * whose block sets only a timeout, which is how this was nearly "fixed" into a
 * regression.
 *
 * A settings object that is entirely absent means off in both dialects, which is
 * what upstream's runner does with `if (request.settings?.encodeUrl)`.
 */
export function shouldEncodeUrl(settings: { encodeUrl?: boolean } | undefined): boolean {
  if (settings === undefined) return false;
  return settings.encodeUrl ?? true;
}

/**
 * Ensure a scheme is present before encoding.
 *
 * Without `://`, the authority pattern above cannot match, so `localhost:6000`
 * looks like a path segment and its port colon is encoded to `localhost%3A6000`
 * — which then resolves to a nonsense host. Upstream guards the same way.
 */
export function hasExplicitScheme(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
}
