/**
 * The top-level `graphql:` block a `.yml` graphql request lives in.
 *
 * Bruno does not put a graphql request under `http:`. It writes a sibling
 * `graphql:` block carrying its own `method`, `url`, `headers`, `params`, `body`
 * and `auth`, and dispatches on `info.type` to decide which parser reads the
 * file — verified by reading `stringifyGraphQLRequest.ts` and
 * `parseGraphQLRequest.ts` in `/Volumes/Projects/tools/working_dir/bruno-tool`,
 * where the writer ends `ocRequest.graphql = graphql` and the reader takes
 * `ocRequest.graphql` with no `http` fallback of any kind.
 *
 * This server wrote the whole request under `http:` with the query in
 * `http.body`, the same place it puts every other body. Both halves of this
 * codebase agreed with each other, so such a request round-tripped here and
 * executed correctly — it simply was not the file Bruno would have produced, and
 * Bruno reading it gets a graphql request with no url and no query.
 *
 * Two shape differences, not just a move:
 *
 * - **The body is `{ query, variables }` directly**, not the `{ type, data }`
 *   envelope the model uses for every body. There is no `type` to record because
 *   the block itself is the type.
 * - **`variables` is a string**, the raw JSON text as authored. Upstream keeps it
 *   that way rather than parsing it, so a template placeholder inside it survives
 *   to substitution time.
 *
 * What stays outside the block: `runtime`, `settings` and `docs` are top-level
 * siblings for a graphql request exactly as they are for an http one, so nothing
 * about those changes here.
 */

import { BruGraphql, YamlBody } from './types.js';

/** Keys of a `graphql:` block that the writer here produces itself. */
export const YAML_GRAPHQL_KEYS: ReadonlySet<string> = new Set([
  'method',
  'url',
  'headers',
  'params',
  'body',
  'auth',
]);

/**
 * Is this request a graphql one?
 *
 * `info.type` is what upstream switches on, so it decides. A graphql *body* also
 * counts, because a request carrying one is a graphql request whatever the type
 * field says, and writing the block without the matching `info.type` would
 * produce a file Bruno routes to its http parser and reads as empty.
 */
export function isGraphqlRequest(
  infoType: string | undefined,
  body: YamlBody | undefined,
): boolean {
  return infoType === 'graphql' || body?.type === 'graphql';
}

/**
 * Turn a graphql body into the block's `body`, or undefined when there is
 * nothing worth writing.
 *
 * Upstream writes each half only when it is a non-empty string and omits `body`
 * entirely when neither is, which is why an empty query does not produce
 * `body: { query: '' }`.
 */
export function graphqlBodyToYaml(body: YamlBody | undefined): Record<string, unknown> | undefined {
  if (!body || body.type !== 'graphql') return undefined;

  const data = body.data;

  // A graphql body's data comes in two shapes, and BOTH are ours. The envelope is
  // what a Bruno-authored file yields, but this server's own authoring path stores
  // a query given as `content` as a bare string — the same split the executor
  // already handles when it wraps a body for the wire. Treating a string as "not a
  // graphql body" silently dropped the query of every request created here.
  if (typeof data === 'string') {
    return data !== '' ? { query: data } : undefined;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;

  const graphql = data as BruGraphql;
  const out: Record<string, unknown> = {};
  if (typeof graphql.query === 'string' && graphql.query !== '') out.query = graphql.query;
  if (typeof graphql.variables === 'string' && graphql.variables !== '') {
    out.variables = graphql.variables;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Read a `graphql:` block's `body` back into the model's envelope.
 *
 * Always returns a graphql body when the block exists, even with no query: the
 * block's presence is what makes this a graphql request, and dropping the body
 * would let a later write emit the request as if it had none.
 */
export function graphqlBodyFromYaml(raw: unknown): YamlBody {
  const data: BruGraphql = { query: '' };

  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.query === 'string') data.query = obj.query;
    // Kept as the authored text rather than parsed. Parsing here would force a
    // re-serialisation on write, which reformats the author's JSON and would
    // corrupt a `{{placeholder}}` that is not valid JSON on its own.
    //
    // An empty string is dropped rather than carried, matching what the writer
    // emits: keeping it would make the model hold a member the file never has, so
    // a parse of our own output would not equal the model that produced it.
    if (typeof obj.variables === 'string' && obj.variables !== '') {
      data.variables = obj.variables;
    }
  }

  return { type: 'graphql', data };
}
