/**
 * The response headers a run result carries.
 *
 * Returned by default, like the response body, and for the same reason: the
 * runner already had them in hand, and the alternative was authoring a test
 * script to read something it could have been told.
 *
 * They are bounded two ways, for two different reasons.
 *
 * Credentials, because a response can echo one back and `set-cookie` always
 * carries one — which is where the policy has to be more careful than
 * `redactMetadata` is for a request: see below.
 *
 * And size, because `undici`'s 16 KB `maxHeaderSize` bounds ONE response and a
 * result set is many. A sixteen-request run returned 54.9 KB, most of it header
 * maps repeated across fourteen results with a ~350-character bearer token in
 * each; the run was green and unreadable, and re-running it to recover the
 * transcripts cost more than the run. So a caller can turn the maps off, and
 * each value is capped — long values are the bloat, and dropping whole headers
 * would take the names with them, which are the part worth reading.
 */

import type { IncomingHttpHeaders } from 'node:http';

import type { ExecutionOptions } from './execution-options.js';
import type { RequestExecutionResult } from './run-results.js';
import type { MockResponseData } from './types.js';
import { REDACTED, isCredentialHeaderName } from './transport-redaction.js';

/** Headers as reported on a result: `set-cookie` is a list, everything else a string. */
export type ResponseHeaders = Record<string, string | string[]>;

/**
 * Mask a cookie's value while keeping its attributes.
 *
 * Whole-value redaction is right for a request's `Cookie` header and wrong here.
 * The value is the credential; `HttpOnly`, `Secure`, `SameSite`, `Path`,
 * `Max-Age` are the answer to the question that made response headers worth
 * returning at all. Redacting them too would leave the caller with the same
 * scripted workaround it had before, so only the bytes between the first `=`
 * and the first `;` are replaced.
 *
 * A value with no `=` before its first `;` is not a cookie this can take apart,
 * so it is withheld whole rather than guessed at.
 */
function maskCookieValue(cookie: string): string {
  const equals = cookie.indexOf('=');
  const semicolon = cookie.indexOf(';');
  if (equals === -1 || (semicolon !== -1 && semicolon < equals)) return REDACTED;

  const name = cookie.slice(0, equals);
  const attributes = semicolon === -1 ? '' : cookie.slice(semicolon);
  return `${name}=${REDACTED}${attributes}`;
}

/**
 * Every response header, credential values masked.
 *
 * `set-cookie` comes from the response's own list rather than the flat map,
 * because the flat map comma-joins repeated headers and a cookie value may
 * contain a comma — a joined `set-cookie` cannot be split back into the cookies
 * that produced it, and two cookies is the ordinary case (a session and a CSRF
 * token). It is reported as a list even when there is one of them, so a caller
 * reading `set-cookie` never has to test which shape it got.
 */
export function collectResponseHeaders(
  response: Pick<MockResponseData, 'headers' | 'setCookies'>,
): ResponseHeaders {
  const headers: ResponseHeaders = {};

  for (const [name, value] of Object.entries(response.headers)) {
    if (name.toLowerCase() === 'set-cookie') continue;
    headers[name] = isCredentialHeaderName(name) ? REDACTED : value;
  }

  // The list is absent, rather than merely empty, on a runtime whose `Headers`
  // has no `getSetCookie` — `wrapFetchResponse` tests for one before calling it.
  // There the joined value is all there is, so report it rather than drop the
  // header: one cookie, which is the common case, survives a join intact.
  const cookies = response.setCookies?.length
    ? response.setCookies
    : asJoinedCookie(response.headers);
  if (cookies.length > 0) headers['set-cookie'] = cookies.map(maskCookieValue);

  return headers;
}

/**
 * The same, for a Node `IncomingMessage` — the WebSocket upgrade response.
 *
 * A WebSocket's response headers are the ones on its 101, and they are worth the
 * same as an HTTP response's: an upgrade can set a session cookie, and
 * `sec-websocket-protocol` is the server's answer to what was offered. Node
 * gives `set-cookie` as a list already and joins every other repeated header, so
 * a non-cookie array cannot occur here; one is dropped rather than guessed at if
 * it ever does.
 */
export function collectIncomingHeaders(raw: IncomingHttpHeaders): ResponseHeaders {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string') headers[name] = value;
  }
  return collectResponseHeaders({ headers, setCookies: raw['set-cookie'] ?? [] });
}

/** Truncate one header value to a maximum byte length (UTF-8). */
function capValue(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buf = Buffer.from(value, 'utf8');
  if (buf.byteLength <= maxBytes) return { value, truncated: false };
  return { value: buf.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

/**
 * The same headers with every value capped, and whether anything was cut.
 *
 * Per value rather than per map, so which headers a result reports does not
 * depend on the order they happen to arrive in: a caller checking for a header's
 * presence gets the same answer whatever the cap is, and only the long values —
 * the tokens and the CSP declarations — come back short. `set-cookie` is a list,
 * so each cookie is capped on its own; capping the list as a whole would drop
 * later cookies entirely.
 *
 * Truncation is reported, never silent, on the same reasoning as the response
 * body's flag: a value that was shortened is not the value the server sent, and
 * an assertion written against it would be asserting on this cap.
 */
export function capHeaderValues(
  headers: ResponseHeaders,
  maxBytes: number,
): { headers: ResponseHeaders; truncated: boolean } {
  const capped: ResponseHeaders = {};
  let truncated = false;

  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      capped[name] = value.map((entry) => {
        const result = capValue(entry, maxBytes);
        if (result.truncated) truncated = true;
        return result.value;
      });
      continue;
    }
    const result = capValue(value, maxBytes);
    if (result.truncated) truncated = true;
    capped[name] = result.value;
  }

  return { headers: capped, truncated };
}

/**
 * A fifth of the body default, because a header value is not a document. The
 * longest ordinary ones are a bearer token, a CSP declaration and a cookie with
 * its attributes, and 2 KB carries all three whole; what it cuts is the value
 * that was never going to be read in a result, which is the bloat this bounds.
 */
export const DEFAULT_MAX_RESPONSE_HEADER_BYTES = 2048;

export interface HeaderCaptureOptions {
  includeResponseHeaders: boolean;
  maxResponseHeaderBytes: number;
}

/** The header capture a run will use, defaults filled in. */
export function resolveHeaderCapture(
  options: Pick<ExecutionOptions, 'includeResponseHeaders' | 'maxResponseHeaderBytes'> | undefined,
): HeaderCaptureOptions {
  return {
    includeResponseHeaders: options?.includeResponseHeaders ?? true,
    maxResponseHeaderBytes: options?.maxResponseHeaderBytes ?? DEFAULT_MAX_RESPONSE_HEADER_BYTES,
  };
}

/**
 * Apply the header capture options to a finished result.
 *
 * Applied once, where every executed request passes through, rather than beside
 * each place that fills the field in: two transports fill it — HTTP from the
 * response, WebSocket from its 101 — a third (gRPC) has no header surface of its
 * own, and a refusal or a skipped request has no headers at all. One place
 * cannot disagree with itself about the flag; two would, and the copy that
 * drifted would be the transport nobody re-read.
 *
 * The result is mutated rather than copied: it is the run's own object, built a
 * few frames up and not yet handed anywhere.
 */
export function applyHeaderCapture(
  result: RequestExecutionResult,
  capture: HeaderCaptureOptions,
): RequestExecutionResult {
  if (result.response_headers === undefined) {
    return result;
  }
  if (!capture.includeResponseHeaders) {
    delete result.response_headers;
    return result;
  }
  const { headers, truncated } = capHeaderValues(
    result.response_headers,
    capture.maxResponseHeaderBytes,
  );
  result.response_headers = headers;
  if (truncated) {
    result.response_headers_truncated = true;
  }
  return result;
}

function asJoinedCookie(headers: Record<string, string>): string[] {
  const joined = Object.entries(headers)
    .find(([name]) => name.toLowerCase() === 'set-cookie')?.[1];
  return joined === undefined ? [] : [joined];
}
