/**
 * Encoding a stored body payload into the bytes that go on the wire.
 *
 * Split out of request-executor.ts, which had grown past the max-lines ceiling.
 * These two share one rule that is easy to get backwards and expensive when it
 * is: substitute variables FIRST, then encode. Encoding first and substituting
 * into the encoded string lets a variable whose value contains `&`, `=` or `"`
 * splice extra fields into the body, which is a request the author did not
 * write.
 */

import { substitute } from './env-loader.js';
import type { BruGraphql, FormUrlEncodedPart } from './types.js';

/** Records every `{{name}}` in a template that no variable resolves. */
export type TrackUnresolved = (template: string) => void;

/**
 * Wrap a graphql body in the JSON envelope a graphql server expects.
 *
 * Both stored shapes are accepted: a `{ query, variables }` mapping, which is
 * what Bruno writes, and the bare query text, which is what this tool writes.
 * The bare form matters because the caller's chain has a branch that sends any
 * string payload verbatim — reaching it with a graphql query would put naked
 * query text on the wire with no envelope around it, which every graphql server
 * rejects. So the graphql check has to come first, and it has to handle both.
 */
/**
 * Said once per request whose graphql body resolves to no query.
 *
 * Warned about rather than refused: upstream reads `body.graphql.query` with no
 * fallback and no check, so it sends a queryless body too, and refusing here
 * would make a collection behave differently under this tool than under
 * `bru run`. The server's rejection is the correct outcome — it just does not
 * say which of the requests was incomplete, which is what this supplies.
 */
export const EMPTY_GRAPHQL_QUERY_WARNING =
  'This graphql body has no query, so `{"query":""}` is what goes on the wire and the server ' +
  'will reject it. Sent rather than refused because Bruno sends a queryless body too.';

export function buildGraphqlBody(
  data: BruGraphql | string,
  vars: Map<string, string>,
  trackUnresolved: TrackUnresolved,
  warn?: (message: string) => void,
): string {
  const graphql: BruGraphql = typeof data === 'string' ? { query: data } : data;
  trackUnresolved(graphql.query);
  const query = substitute(graphql.query, vars);
  // Checked after substitution, not before: a `{{q}}` that resolves to nothing
  // puts an empty query on the wire exactly like an absent one, and it is the
  // case most likely to be a surprise rather than a typo.
  if (query.trim() === '') {
    warn?.(EMPTY_GRAPHQL_QUERY_WARNING);
  }
  const envelope: { query: string; variables?: unknown } = {
    query,
  };
  if (graphql.variables !== undefined) {
    trackUnresolved(graphql.variables);
    const substituted = substitute(graphql.variables, vars);
    // A `body:graphql:vars` block is stored as text. Send it as real JSON when
    // it parses, and as the raw string when it does not, so a malformed vars
    // block surfaces as a server-side error rather than being dropped here.
    try {
      envelope.variables = JSON.parse(substituted) as unknown;
    } catch {
      envelope.variables = substituted;
    }
  }
  return JSON.stringify(envelope);
}

/** Encode form-urlencoded pairs, skipping the ones the author switched off. */
export function buildFormUrlEncodedBody(
  parts: readonly FormUrlEncodedPart[],
  vars: Map<string, string>,
  trackUnresolved: TrackUnresolved,
): string {
  const params = new URLSearchParams();
  for (const pair of parts) {
    // Skipped before tracking, so a disabled pair's placeholders raise no
    // unresolved-variable warning about a value that is never sent.
    if (pair.enabled === false) continue;
    trackUnresolved(pair.name);
    trackUnresolved(pair.value);
    params.append(substitute(pair.name, vars), substitute(pair.value, vars));
  }
  return params.toString();
}
