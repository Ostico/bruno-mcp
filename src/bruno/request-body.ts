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

import { readFile } from 'node:fs/promises';
import { substitute } from './env-loader.js';
import { stripJsonComments } from './json-body.js';
import { confineUploadPath } from './upload-path.js';
import type { BruFilePart, BruGraphql, FormUrlEncodedPart } from './types.js';

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
  // Escaped for JSON, because the next line parses this text: a generator that
  // produces a newline would otherwise fail the parse and refuse the request.
  // The query above is not escaped — it is a string in an envelope this function
  // stringifies itself, so escaping there would reach the server doubled.
  const substituted = substitute(stripJsonComments(stored ? stored : '{}'), vars, {
    escapeJSONStrings: true,
  });
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

/** What a `file`-mode body resolved to: the bytes, and what Content-Type to send. */
export interface FileBodyResult {
  /** Absent when nothing was sent — no selected entry, or a read that failed. */
  data?: Uint8Array<ArrayBuffer>;
  /**
   * `undefined` leaves the `application/octet-stream` default alone, a string
   * replaces it, and `null` means send no Content-Type at all.
   */
  contentType?: string | null;
}

/**
 * Read the file a `file`-mode body names and say what to send it as.
 *
 * Upstream is `prepare-request.js:397-427`, and the rules there are less obvious
 * than they look:
 *
 * - Only the **first selected** entry is sent. A file body can hold several, and
 *   the others are stored history, not payload.
 * - The selected entry's own `contentType` is assigned over the top of anything
 *   already set, author-supplied headers included. An entry with no content type
 *   assigns `undefined`, which is axios's way of sending none at all — so an
 *   entry that names no type sends no Content-Type rather than falling back to
 *   `application/octet-stream`.
 * - A read that fails is logged and the request goes out **without a body**
 *   rather than failing. Mirrored, with the log turned into a warning the caller
 *   actually receives: a request that quietly sent nothing and came back 2xx is
 *   the failure mode that makes an assertion pass for the wrong reason.
 *
 * What is deliberately not mirrored is where the file may live. Upstream reads
 * any path a collection names; `confineUploadPath` restricts that to the trusted
 * upload locations, and a refusal there is thrown rather than warned — it is a
 * collection trying to read something it should not, not a missing file.
 *
 * Which entries count as selected is decided by the readers, per dialect: a
 * `.bru` entry is selected unless it carries `~`, a `.yml` entry only when it
 * says `selected: true`. Both arrive here as the same model, where the flag is
 * absent or true for a selected entry and false for a skipped one.
 */
export async function buildFileBody(
  parts: readonly BruFilePart[],
  vars: Map<string, string>,
  trackUnresolved: TrackUnresolved,
  collectionRoot: string | undefined,
  warn: (message: string) => void,
): Promise<FileBodyResult> {
  const selected = parts.find(part => part.selected !== false);
  if (!selected) {
    // Upstream still sets the octet-stream default in this case and sends no
    // data, so the header is left to the caller's default and nothing is read.
    warn(
      'this file body has no selected file, so it goes on the wire with no body at all. ' +
        'Sent rather than refused because Bruno sends it empty too.',
    );
    return {};
  }
  if (selected.contentType !== undefined) trackUnresolved(selected.contentType);
  // Three states, not two. An entry with no `contentType` key at all is
  // upstream's `undefined` assignment, which sends no Content-Type — that is
  // mirrored as null. An entry whose content type is **blank** is not: upstream
  // would put an empty Content-Type on the wire, but a blank value is what its
  // own `.yml` writer produces for an entry that simply names no type
  // (`contentType: file.contentType || ''`), so it is read as "none named" and
  // the octet-stream default is left standing instead.
  let contentType: string | null | undefined = null;
  if (selected.contentType !== undefined) {
    const named = substitute(selected.contentType, vars);
    contentType = named.trim() === '' ? undefined : named;
  }
  trackUnresolved(selected.filePath);
  const filePath = substitute(selected.filePath, vars);
  // Caught before confinement: an empty path resolves to the collection root
  // itself, and reading a directory raises EISDIR — a confusing way to report a
  // file body that simply names nothing. Upstream's `if (filePath)` skips it too.
  if (filePath.trim() === '') {
    warn('this file body names no file, so it goes on the wire with no body at all.');
    return { contentType };
  }
  const resolvedPath = confineUploadPath(filePath, collectionRoot, 'file body');
  try {
    // Copied out of the Buffer node hands back: a Buffer can be backed by a
    // SharedArrayBuffer as far as the types are concerned, and `Blob` will not
    // take one of those.
    return { data: new Uint8Array(await readFile(resolvedPath)), contentType };
  } catch (error) {
    warn(
      `the file body could not be read (${
        error instanceof Error ? error.message : String(error)
      }), so the request goes on the wire with no body at all.`,
    );
    return { contentType };
  }
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
