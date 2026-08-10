/**
 * The response headers a run result carries.
 *
 * Returned by default, like the response body, and for the same reason: the
 * runner already had them in hand, and the alternative was authoring a test
 * script to read something it could have been told. No flag gates them — a
 * header map is the small, high-signal part of a response, and `undici` bounds
 * the whole of it at its 16 KB `maxHeaderSize` before we ever see it, so there
 * is nothing here for a size knob to protect.
 *
 * What is bounded is credentials, not size. A response can echo one back, and
 * `set-cookie` always carries one, which is where the policy has to be more
 * careful than `redactMetadata` is for a request: see below.
 */

import type { IncomingHttpHeaders } from 'node:http';

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

function asJoinedCookie(headers: Record<string, string>): string[] {
  const joined = Object.entries(headers)
    .find(([name]) => name.toLowerCase() === 'set-cookie')?.[1];
  return joined === undefined ? [] : [joined];
}
