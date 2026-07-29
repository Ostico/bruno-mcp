/**
 * Checked conversions from file data into the closed unions (finding Q17a).
 *
 * HttpMethod, BodyType and AuthType are unions, but the parsers used to reach
 * them with a bare `as`. A type assertion is a claim, not a check: whatever
 * string sat in a .yml or .bru file became a value every later stage treated as
 * a union member, with nothing between the parse and the fetch call verifying
 * it. A collection saying `method: BOGUS` travelled all the way to the request
 * path, including the redirect logic that branches on the method.
 *
 * These helpers replace the assertions with the check the assertion implied.
 * Each one is total: it returns a real union member or throws.
 *
 * There is deliberately no auth guard, and no body guard for the .bru path: a
 * .bru file carries Bruno's own vocabulary (`multipartForm`, `formUrlEncoded`,
 * `sparql`, `inherit`), which is a different set from BodyType/AuthType.
 * Validating those against these unions was tried and rejected six suites'
 * worth of real fixtures. That mismodelling is tracked as D16.
 *
 * Where a guard does apply, an unknown value is rejected rather than coerced: a
 * wrong request that looks successful is harder to diagnose than a refusal
 * naming the field and the value. An ABSENT value still gets a default, since
 * that is a normal, unambiguous case rather than a mistake.
 */

import { BrunoError, type BodyType, type HttpMethod } from './types.js';

export const HTTP_METHODS: readonly HttpMethod[] = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
];

export const BODY_TYPES: readonly BodyType[] = [
  'none',
  'json',
  'text',
  'xml',
  'graphql',
  'form-data',
  'multipart-form',
  'form-urlencoded',
  'file',
  'binary',
];

/** Keep a malformed file from putting an unbounded string into an error message. */
function forMessage(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : String(raw);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

function reject(field: string, raw: unknown, allowed: readonly string[]): never {
  throw new BrunoError(
    `Invalid ${field} "${forMessage(raw)}": expected one of ${allowed.join(', ')}`,
    'VALIDATION_ERROR',
  );
}

/**
 * An absent method means GET — the .bru parser already defaulted that way, and
 * the .yml parser used to produce the empty string for the same missing field.
 * A present but unrecognised method is a mistake in the collection, not a
 * default to guess at.
 */
export function toHttpMethod(raw: unknown, field = 'method'): HttpMethod {
  if (raw === undefined || raw === null || raw === '') return 'GET';
  const upper = String(raw).toUpperCase();
  return HTTP_METHODS.includes(upper as HttpMethod)
    ? (upper as HttpMethod)
    : reject(field, raw, HTTP_METHODS);
}

/** An absent body is 'none'; an unrecognised one is rejected. */
export function toBodyType(raw: unknown, field = 'body type'): BodyType {
  if (raw === undefined || raw === null || raw === '') return 'none';
  const value = String(raw);
  return BODY_TYPES.includes(value as BodyType)
    ? (value as BodyType)
    : reject(field, raw, BODY_TYPES);
}

