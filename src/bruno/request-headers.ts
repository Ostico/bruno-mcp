/**
 * Building the outgoing header map.
 *
 * Split out of request-executor.ts, which had grown past the max-lines ceiling.
 * These pieces form one concern: deciding what a header field ends up holding
 * when the collection, the body type and HTTP's own rules all have a say.
 */
/**
 * Request headers whose value is NOT defined as a comma-separated list, so a
 * sender must not repeat them at all.
 *
 * RFC 9110 §5.2/§5.3 permit combining repeated field lines only when the field
 * is defined as a list (ABNF `#rule`). Repeating a singleton field and joining
 * with a comma produces a syntactically invalid value — `Content-Type` becomes
 * "application/json, text/plain" — which the origin will usually reject. The
 * combine still happens, because fetch cannot emit two field lines for one
 * name under any input shape; the warning is what keeps that from being a
 * second silent behaviour replacing the first.
 *
 * Deliberately a known set rather than an exhaustive one: warning on "every
 * header not known to be a list" would fire on legitimate custom list headers,
 * and noisy warnings get ignored. Missing an entry only costs a warning.
 *
 * `cookie` is excluded on purpose — repeating it is normal authoring and
 * appendHeader already joins it the way RFC 6265 §5.4 requires.
 */
export const SINGLE_VALUE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'content-type',
  'content-length',
  'content-location',
  'host',
  'user-agent',
  'referer',
  'from',
  'date',
  'max-forwards',
  'range',
  'if-range',
  'if-modified-since',
  'if-unmodified-since',
  'origin',
]);

/**
 * Add one authored header to the outgoing set, combining rather than replacing
 * when the name has already been seen.
 *
 * A collection may author the same header twice — two Accept values, two Cookie
 * pairs, an X-Forwarded-For chain. The previous `headers[h.name] = value` kept
 * only the last, so every earlier value was silently dropped before the request
 * was ever sent.
 *
 * Combining (rather than carrying a list further down) is what the transport
 * actually does: undici's fetch emits ONE field-line for a repeated request
 * header no matter how it is handed over — an array of pairs and
 * Headers.append both arrive combined. RFC 9110 §5.3 permits exactly that, and
 * RFC 6265 §5.4 makes Cookie the exception that joins with "; ". Building the
 * combined value here therefore produces the same bytes on the wire while
 * keeping the rest of the pipeline — auth application, the pre-request script
 * API, and stripCredentialHeaders — on the simple Record it already expects.
 *
 * Names are matched case-insensitively (RFC 9110 §5.1) but emitted with the
 * first occurrence's casing. Routing through undici's Headers would have been
 * shorter and was rejected because it lowercases every name, changing what a
 * case-sensitive server receives.
 */
export function appendHeader(
  headers: Record<string, string>,
  headerKeys: Map<string, string>,
  name: string,
  value: string,
): void {
  const lower = name.toLowerCase();
  const existingKey = headerKeys.get(lower);
  if (existingKey === undefined) {
    headerKeys.set(lower, name);
    headers[name] = value;
    return;
  }
  const separator = lower === 'cookie' ? '; ' : ', ';
  headers[existingKey] = `${headers[existingKey]}${separator}${value}`;
}

/**
 * The media type each textual body type implies.
 *
 * Needed because the Fetch standard labels *any* string body
 * `text/plain;charset=UTF-8`. Without an entry here a JSON payload went out
 * announced as plain text, which is worse than sending no type at all: a server
 * given an explicit — wrong — type has no reason to sniff the content, so
 * express.json() leaves req.body empty and Spring answers 415.
 *
 * 'text' is deliberately absent. text/plain is already the correct type for a
 * text body and the Fetch default additionally declares the charset, so
 * overriding it would lose information.
 *
 * Registered types are used rather than guessing at Bruno's internal table:
 * application/json (RFC 8259 §11), application/xml (RFC 7303 §9.1) and
 * application/sparql-query (SPARQL 1.1 Protocol §2.1.4). A collection needing
 * the other registered XML spelling, or a vendor type, sets the header itself
 * and that always wins.
 */
export const BODY_TYPE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  json: 'application/json',
  xml: 'application/xml',
  sparql: 'application/sparql-query',
};

/**
 * Set Content-Type for a body whose type implies one, without overriding the
 * author.
 *
 * A collection may deliberately send a charset or a vendor media type, so an
 * explicit header always wins. Matched case-insensitively (RFC 9110 §5.1)
 * because a .bru file may spell the name any way — a case-sensitive check would
 * add a second, conflicting Content-Type.
 */
export function setDefaultContentType(headers: Record<string, string>, value: string): void {
  const existing = Object.keys(headers).find(
    (name) => name.toLowerCase() === 'content-type',
  );
  if (existing !== undefined) return;
  headers['Content-Type'] = value;
}
