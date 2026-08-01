import { Cookie, CookieJar } from 'tough-cookie';

/**
 * Per-run cookie jar, so a session survives from one request to the next.
 *
 * Without this, every session-based flow needs each request to parse
 * `set-cookie` in an after-response script, park it in a variable, and the next
 * request to send it back as an explicit `Cookie` header. The symptom of
 * getting it wrong is a 403 with no explanation.
 *
 * Semantics follow Bruno's CLI (`bruno-cli/src/runner/run-single-request.js`
 * and `bruno-requests/src/cookies`), which is also on `tough-cookie`:
 *
 *  - cookies are stored from responses and sent on later requests to matching
 *    hosts, with the library deciding domain/path/expiry matching;
 *  - `Cookie.parse(..., { loose: true })` and `setCookieSync(..., {
 *    ignoreError: true })`, so a malformed cookie from a server is skipped
 *    rather than failing the run;
 *  - `Secure` cookies are only sent to a potentially-trustworthy origin, which
 *    tough-cookie v6 derives from the URL itself: sent over https, withheld
 *    over http, and allowed to http://localhost. Upstream passes an explicit
 *    `{ secure }` option for this, but v6 removed it — verified by test rather
 *    than copied, since a silently-ignored option would have looked identical;
 *  - cookies are stored from error responses too, since a 4XX can set one.
 *
 * **Two deliberate divergences from upstream.**
 *
 *  1. Upstream keeps a module-level singleton jar, which is right for a CLI that
 *     exits after one run. This server is long-lived and runs unrelated
 *     collections, so a process-wide jar would send one collection's session
 *     cookie to whatever host a later, unrelated run happened to match. The jar
 *     is therefore created per run and discarded with it — nothing is persisted,
 *     and nothing is shared between runs.
 *  2. When the jar and a `Cookie` header the request wrote itself both have a
 *     value for the same cookie name, the request's value wins rather than the
 *     jar's. `mergeCookieHeader` below carries the argument.
 */
export interface RunCookieJar {
  /** Cookie header value for this URL, or '' when nothing matches. */
  cookieHeaderFor(url: string): string;
  /** Store the `set-cookie` values a response returned. */
  store(url: string, setCookieHeaders: string[]): void;
}

/** Split a `Cookie` header into name -> value, tolerating odd spacing. */
function parseCookieHeader(header: string): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 1) {
      continue;
    }
    const name = pair.slice(0, eq).trim();
    if (name.length > 0) {
      parsed.set(name, pair.slice(eq + 1).trim());
    }
  }
  return parsed;
}

/**
 * Merge jar cookies into a `Cookie` header the request already carried.
 *
 * An explicitly-authored cookie wins, per name. A name the request wrote itself
 * keeps the request's value; a name only the jar knows is still added, which is
 * what makes a login flow work at all.
 *
 * **A deliberate divergence from upstream.** Bruno's CLI spreads the jar's
 * cookies over the authored ones, so the jar wins the clash — the reasoning
 * being that a value the server just set is fresher than one written into the
 * request by hand. That reasoning fails the case an authored `Cookie` header
 * exists for. A request that writes `Cookie: session=<some credential>` is not
 * carrying a stale copy of the session the jar already holds; it is stating
 * which identity the assertions under it are about. Replacing that value ran
 * those assertions against whatever identity the run last logged in as, and they
 * PASSED — a contaminated run reads greener than reality, which is the worst
 * direction a wrong answer can point.
 *
 * Freshness remains the jar's job for every name nobody authored, and it still
 * does that job here, so a flow that writes no `Cookie` header behaves exactly
 * as before. Where the two sources disagree, author intent is both the better
 * guess at what the run is meant to test and the only one of the two a reader
 * can see in the collection.
 *
 * `shadowed` collects the names whose stored value was dropped, so a caller can
 * report a precedence decision the collection alone does not reveal.
 */
export function mergeCookieHeader(
  existing: string | undefined,
  fromJar: string,
  shadowed?: string[],
): string {
  if (!existing || existing.trim().length === 0) {
    return fromJar;
  }
  if (fromJar.length === 0) {
    return existing;
  }

  // Seeded from the authored header so its names keep both their values AND
  // their positions; jar-only names are appended after them, which is the same
  // emission order upstream produces.
  const merged = parseCookieHeader(existing);
  for (const [name, value] of parseCookieHeader(fromJar)) {
    if (merged.has(name)) {
      shadowed?.push(name);
      continue;
    }
    merged.set(name, value);
  }

  return Array.from(merged, ([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * Warning text for cookie names the request kept against a stored value.
 *
 * Names only, never values: a session cookie is a credential, and warnings are
 * returned to the caller. Worth reporting because nothing in the collection
 * shows that a stored cookie was in play, and because the same collection run
 * through Bruno's CLI would have sent the other value.
 */
export function shadowedCookieWarning(names: string[]): string {
  const quoted = names.map((name) => `"${name}"`).join(', ');
  return (
    `Cookie ${quoted} is set both by this request and by an earlier response in ` +
    'this run; the value the request authors was sent and the stored one was not. ' +
    "Bruno's CLI would send the stored value instead — remove the Cookie entry to " +
    'defer to the run\'s cookie jar.'
  );
}

/**
 * Put the jar's cookies for `url` into an outgoing header set.
 *
 * Writes back under the header name the request already used, so a collection
 * that wrote `cookie` in lower case keeps it — matching upstream, which looks
 * the name up case-insensitively and reuses it.
 *
 * Returns the cookie names whose stored value the authored header outranked, for
 * the caller to warn about. Empty for the ordinary case where the request wrote
 * no `Cookie` header of its own.
 */
export function applyCookiesToHeaders(
  headers: Record<string, string>,
  url: string,
  jar: RunCookieJar,
): string[] {
  const fromJar = jar.cookieHeaderFor(url);
  if (fromJar.length === 0) {
    return [];
  }

  const shadowed: string[] = [];
  const existingName = Object.keys(headers).find((name) => name.toLowerCase() === 'cookie');
  headers[existingName ?? 'Cookie'] = mergeCookieHeader(
    existingName ? headers[existingName] : undefined,
    fromJar,
    shadowed,
  );
  return shadowed;
}

/**
 * Store the cookies a response set.
 *
 * `Headers.forEach` comma-joins multiple Set-Cookie values into one string,
 * which is lossy because a cookie value may itself contain a comma;
 * `getSetCookie()` keeps them separate. Guarded because a hand-rolled Headers
 * stand-in may not implement it.
 */
export function storeResponseCookies(jar: RunCookieJar, url: string, response: Response): void {
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [];
  if (setCookies.length > 0) {
    jar.store(url, setCookies);
  }
}

export function createRunCookieJar(): RunCookieJar {
  const jar = new CookieJar();

  return {
    cookieHeaderFor(url: string): string {
      try {
        const cookies = jar.getCookiesSync(url);
        return cookies.map((cookie) => cookie.cookieString()).join('; ');
      } catch {
        // A URL the jar cannot parse is not a reason to fail a request that
        // the SSRF validator already accepted.
        return '';
      }
    },

    store(url: string, setCookieHeaders: string[]): void {
      for (const header of setCookieHeaders) {
        const cookie = Cookie.parse(header, { loose: true });
        if (!cookie) {
          continue;
        }
        try {
          jar.setCookieSync(cookie, url, { ignoreError: true });
        } catch {
          // ignoreError covers the documented cases; this catches the rest,
          // because a server's cookie must never abort the run that got it.
        }
      }
    },
  };
}
