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
import { stripJsonComments } from './json-body.js';
import type { BruGraphql, FormUrlEncodedPart } from './types.js';

/** Records every `{{name}}` in a template that no variable resolves. */
export type TrackUnresolved = (template: string) => void;

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
  'This graphql body has no query, so the envelope goes on the wire without one and the server ' +
  'will reject it. Sent rather than refused because Bruno sends a queryless body too.';

/**
 * Wrap a graphql body in the JSON envelope a graphql server expects.
 *
 * Both stored shapes are accepted: a `{ query, variables }` mapping, which is
 * what Bruno writes, and the bare query text, which is what this tool writes.
 * The bare form matters because the caller's chain has a branch that sends any
 * string payload verbatim — reaching it with a graphql query would put naked
 * query text on the wire with no envelope around it, which every graphql server
 * rejects. So the graphql check has to come first, and it has to handle both.
 *
 * The envelope is built to match upstream's byte for byte
 * (`prepare-request.js:443-447`):
 *
 * - `variables` is **always** present. Upstream reads it as
 *   `decomment(get(request, 'body.graphql.variables') || '{}')`, so nothing
 *   stored, or an empty block, sends `"variables":{}` rather than omitting the
 *   key. A block holding only whitespace is *not* falsy there and fails to parse,
 *   which is upstream's outcome too.
 * - `query` is present unless nothing is stored for it at all, because upstream
 *   reads it with a bare `get` and `JSON.stringify` drops an `undefined` value.
 *   That case is reachable from one dialect only: a `.bru` file declaring
 *   `body: graphql` with no `body:graphql` block. The `.yml` reader flattens an
 *   absent query to `''` before this is ever asked (`parseGraphQLRequest.ts:33`),
 *   so a `.yml` graphql request always carries the key, empty or not.
 *
 * Key order is `query` then `variables`, as upstream's object literal has it.
 */
export function buildGraphqlBody(
  data: BruGraphql | string | undefined,
  vars: Map<string, string>,
  trackUnresolved: TrackUnresolved,
  warn?: (message: string) => void,
): string {
  const graphql: BruGraphql | undefined = typeof data === 'string' ? { query: data } : data;
  const envelope: { query?: string; variables?: unknown } = {};
  if (graphql?.query !== undefined) {
    trackUnresolved(graphql.query);
    envelope.query = substitute(graphql.query, vars);
  }
  // Checked after substitution, not before: a `{{q}}` that resolves to nothing
  // puts an empty query on the wire exactly like an absent one, and it is the
  // case most likely to be a surprise rather than a typo.
  if ((envelope.query ?? '').trim() === '') {
    warn?.(EMPTY_GRAPHQL_QUERY_WARNING);
  }
  const stored = graphql?.variables;
  if (stored) trackUnresolved(stored);
  // Comments out before substitution, matching where upstream strips them, so a
  // variable value containing `//` is left alone. Falsy stands in as `{}` first,
  // the way upstream's `|| '{}'` does, so an author who left the block empty sends
  // an empty object rather than being told their variables do not parse.
  const substituted = substitute(stripJsonComments(stored ? stored : '{}'), vars);
  // A `body:graphql:vars` block is stored as text and has to reach the server as
  // real JSON. Upstream parses it and throws `Failed to parse GraphQL variables`
  // when it cannot, and that is the better failure: the request never leaves,
  // and the message names the block. Sending the raw text instead — which this
  // used to do — produces `"variables": "{ oops }"`, a string where an object
  // belongs, and a server error about a field the author did not write.
  try {
    envelope.variables = JSON.parse(substituted) as unknown;
  } catch (error) {
    throw new Error(
      `Failed to parse GraphQL variables: ${error instanceof Error ? error.message : String(error)}`,
    );
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
