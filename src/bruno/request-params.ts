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
 * Values are substituted first and encoded second. The reverse order is the same
 * trap as form bodies: a variable holding `&` or `=` would forge extra
 * parameters, and one holding `/` would silently address a different resource.
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
 * Replace `:name` path segments with their declared values.
 *
 * The lookbehind requires a `/` before the colon so a colon *inside* a segment
 * is left alone — `/t/12:30/:id` must substitute only `:id`. An unmatched
 * `:name` is deliberately left standing: it is wrong but visible, whereas
 * dropping it would quietly address a different resource.
 */
function applyPathParams(url: string, active: YamlParam[], resolve: ResolveParam): string {
  const byName = new Map(
    active.filter((param) => param.type === 'path').map((param) => [param.name, param.value]),
  );
  if (byName.size === 0) return url;

  return url.replace(/(?<=\/):([A-Za-z0-9_-]+)/g, (whole, name: string) => {
    const raw = byName.get(name);
    // encodeURIComponent, not encodeURI: a value containing `/` must stay inside
    // its own segment.
    return raw === undefined ? whole : encodeURIComponent(resolve(raw));
  });
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

  const encoded = query
    .map(
      (param) =>
        `${encodeURIComponent(resolve(param.name))}=${encodeURIComponent(resolve(param.value))}`,
    )
    .join('&');

  // A URL ending in a bare `?` would otherwise produce `?&name=value`.
  const base = url.endsWith('?') ? url.slice(0, -1) : url;
  return `${base}${base.includes('?') ? '&' : '?'}${encoded}`;
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
