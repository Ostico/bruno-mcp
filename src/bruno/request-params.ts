/**
 * Applying declared query and path parameters to the outgoing URL.
 *
 * Both request formats declare these, both parsers populate them and both
 * generators write them back — but nothing ever applied them, so a `params:query`
 * entry never reached the query string and a `params:path` entry left `:id` in
 * the path verbatim. It was reachable end to end through the MCP surface:
 * create_request stores its `query` input, the file on disk looks correct, and
 * the request went out without it.
 *
 * Values are substituted **raw**, exactly as Bruno does. Encoding is not this
 * module's job: upstream applies a single normalization pass over the finished
 * URL at the wire boundary, and only when `settings.encodeUrl` is on — see
 * `url-encoder.ts`. Percent-encoding here instead would make this server send
 * different bytes than Bruno for the same collection, which defeats the point of
 * running the collection here at all.
 *
 * A consequence worth stating plainly, because it is upstream behaviour rather
 * than an accident: a value containing `&`, `=`, `?` or `/` changes the structure
 * of the request, not just its content. `q={{v}}` with `v` set to `a&b=c` sends
 * two query parameters. Bruno's own transform splits pairs on the raw string too,
 * so it does not prevent this either. The host cannot be affected — substitution
 * only ever happens after the authority — and the SSRF check still runs on the
 * final URL.
 */
import type { YamlParam } from './types.js';

/**
 * Resolve `{{var}}` references in a parameter name or value.
 *
 * Passed in rather than imported so this module stays free of the substitution
 * and warning machinery, and so the caller decides what counts as unresolved.
 */
export type ResolveParam = (raw: string) => string;

/**
 * Segments of the form `Name(...)`, which Bruno treats as OData syntax:
 * `Customers('ALFKI')`, `Orders(Key1=1,Key2=2)`, `Function(param=value)`.
 */
const ODATA_SEGMENT = /^[A-Za-z0-9_.-]+\([^)]*\)$/;

/** A `:name` reference inside an OData segment, per upstream's pattern. */
const ODATA_PARAM = /:([a-zA-Z_]\w*)/g;

/**
 * Replace `:name` path segments with their declared values.
 *
 * Two forms are substituted, matching Bruno:
 *
 *  - A whole segment that begins with `:` — `/users/:id`. The lookbehind requires
 *    a `/` before the colon so a colon *inside* an ordinary segment is left
 *    alone: `/t/12:30/:id` must substitute only `:id`.
 *  - A `:name` inside an OData-style segment — `/Customers(:id)`. Upstream
 *    handles this and a lookbehind alone cannot, since the character before the
 *    colon is `(`.
 *
 * Values are inserted raw. An unmatched `:name` is deliberately left standing: it
 * is wrong but visible, whereas dropping it would quietly address a different
 * resource.
 */
function applyPathParams(url: string, active: YamlParam[], resolve: ResolveParam): string {
  const byName = new Map(
    active.filter((param) => param.type === 'path').map((param) => [param.name, param.value]),
  );
  if (byName.size === 0) return url;

  const substituteOData = (segment: string): string =>
    segment.replace(ODATA_PARAM, (whole, name: string) => {
      const raw = byName.get(name);
      return raw === undefined ? whole : resolve(raw);
    });

  // Only the path is eligible. Upstream substitutes into `url.pathname` and
  // reattaches the raw query string afterwards, so a `:name` that appears in a
  // query value is left alone. Splitting the whole URL would rewrite it.
  const queryIndex = url.indexOf('?');
  const path = queryIndex >= 0 ? url.slice(0, queryIndex) : url;
  const query = queryIndex >= 0 ? url.slice(queryIndex) : '';

  // The scheme and authority survive this untouched: `http:` does not begin with
  // a colon, and a `host:6000` authority has no parentheses so it is not mistaken
  // for an OData segment.
  const substituted = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        const raw = byName.get(segment.slice(1));
        return raw === undefined ? segment : resolve(raw);
      }
      return ODATA_SEGMENT.test(segment) ? substituteOData(segment) : segment;
    })
    .join('/');

  return substituted + query;
}

/**
 * Append declared query parameters, preserving any query string already in the
 * URL.
 *
 * A missing `type` counts as 'query', which is both the common case and what a
 * .yml document that omits the field means.
 */
function appendQueryParams(url: string, active: YamlParam[], resolve: ResolveParam): string {
  const query = active.filter((param) => param.type !== 'path');
  if (query.length === 0) return url;

  // Raw, not percent-encoded: in Bruno the query string in the URL is the source
  // of truth at send time and the params block is a view synced into it, so what
  // reaches the wire is whatever the flag-controlled pass in `url-encoder.ts`
  // makes of it.
  const pairs = query
    .map((param) => `${resolve(param.name)}=${resolve(param.value)}`)
    .join('&');

  // A URL ending in a bare `?` would otherwise produce `?&name=value`.
  const base = url.endsWith('?') ? url.slice(0, -1) : url;
  return `${base}${base.includes('?') ? '&' : '?'}${pairs}`;
}

/**
 * Apply every enabled parameter to `url`.
 *
 * `disabled` is the .yml spelling of the flag; the .bru side carries `enabled`
 * and is translated on the way in, the same way headers already are.
 */
export function applyParams(
  url: string,
  params: YamlParam[] | undefined,
  resolve: ResolveParam,
): string {
  if (params === undefined || params.length === 0) return url;

  const active = params.filter((param) => param.disabled !== true);
  if (active.length === 0) return url;

  return appendQueryParams(applyPathParams(url, active, resolve), active, resolve);
}
