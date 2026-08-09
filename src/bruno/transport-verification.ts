/**
 * What a gRPC call and a WebSocket session look like to a post-response script.
 *
 * Scripts and assertions ran only on the HTTP path, so a gRPC or WebSocket request
 * could not fail: its declared checks were parsed, written back faithfully, and
 * never evaluated. In a mixed collection both kinds inflated `passed` with zero
 * verification, and the only signal was `requestsWithoutTests`, which reads as an
 * author's omission rather than as a capability that did not exist.
 *
 * Nothing about the sandbox is HTTP-specific — `MockResponseData` is a plain shape
 * and `res.getBody()` parses by content type — so the fix is to describe each
 * transport's outcome in that shape rather than to build a second test runner.
 *
 * The rule followed here is that `res` reports what happened, not a translation of
 * it into HTTP. A gRPC status stays a gRPC status; a session that recorded no
 * response does not acquire a 200.
 */
import type { MockResponseData, RequestExecutionResult } from './types.js';
import type { GrpcResultDetail, WebsocketTranscriptEntry } from './transport-results.js';

/** The content type that makes `res.getBody()` hand a script parsed structure. */
const JSON_CONTENT_TYPE = 'application/json';

/**
 * What a transport hands back: the result, and what a script may examine.
 *
 * Two fields rather than one because `response` carries unredacted payloads and
 * `result` is surfaced to the caller. Keeping them structurally apart means no
 * spread, merge or careless `...outcome` can move a secret from one into the
 * other — the separation is enforced by the shape rather than by remembering.
 *
 * `response` is absent whenever there is nothing to verify: a refusal, a blocked
 * target, a handshake that never completed. Those already carry an `error`, and
 * running assertions against a request that never happened would turn one failure
 * into two reports of it.
 */
export interface TransportOutcome {
  result: RequestExecutionResult;
  response?: MockResponseData;
}

/**
 * A gRPC call as `res`.
 *
 * `status` is the gRPC code, which means **`res.getStatus() === 0` is success**
 * here and a refusal everywhere else in this API. The alternative — mapping OK to
 * 200 — would make an assertion that passes against this runner say something
 * untrue about the call, so the collision is kept and documented instead. It is
 * also why `GrpcResultDetail.code` is deliberately never copied onto the result's
 * own `status` field.
 *
 * Trailers become headers because that is what they are: `res.getHeader('…')`
 * reads them with no new vocabulary. They arrive already masked by name.
 */
export function grpcResponse(
  detail: GrpcResultDetail,
  body: string,
  responseTime: number,
): MockResponseData {
  return {
    status: detail.code,
    // The server's own words when it supplied any. `details` is empty on a
    // successful call, so the code's own name is the honest fallback.
    statusText: detail.details.length > 0 ? detail.details : grpcCodeName(detail.code),
    headers: { ...(detail.trailers ?? {}), 'content-type': JSON_CONTENT_TYPE },
    body: parsedOrRaw(body),
    rawBody: body,
    responseTime,
  };
}

/**
 * `body` must arrive already parsed.
 *
 * The sandbox hands `res.getBody()` back verbatim — the content-type decision is
 * made here on the host, in `wrapFetchResponse`, and the worker only relays it. A
 * builder that passed the JSON *string* would give every script a string where the
 * HTTP path gives an object, so `res.getBody().field` would read undefined and
 * every assertion against it would fail for a reason no author could see.
 */
function parsedOrRaw(body: string): unknown {
  if (body.length === 0) return body;
  try {
    return JSON.parse(body);
  } catch {
    // A server that answered with something other than JSON. The raw text is
    // still the truthful answer to "what came back".
    return body;
  }
}

/**
 * A WebSocket session as `res`.
 *
 * `body` is the transcript, so `res.getBody()` yields the same array a caller
 * already reads in the result and there is one shape to learn rather than two. A
 * script asserts on a session the way it reads one: by looking at the frames.
 *
 * **The payloads here are unredacted, deliberately.** The transcript in the
 * *result* omits them unless `includePayloads` is set, because outbound frames are
 * recorded after `{{var}}` interpolation and would otherwise write every supplied
 * secret into something surfaced by default. A script is not that: it is the
 * author's own code, and withholding the payloads would leave assertions unable to
 * check the one thing a WebSocket session produces. This is exactly the split the
 * HTTP path already has — `res.body` always carries the full body while
 * `response_body` is gated by `includeResponseBody` — so it is the existing
 * contract rather than a new exception. A script can still copy a payload into a
 * variable and surface it, as it can on HTTP; that is the author's own act.
 *
 * `status` is 0 because a WebSocket session has no status and inventing one would
 * be worse than having none. The session's outcome is in `statusText`, which
 * carries the stop reason.
 */
export function websocketResponse(
  transcript: WebsocketTranscriptEntry[],
  stopReason: string,
  responseTime: number,
): MockResponseData {
  return {
    status: 0,
    statusText: stopReason,
    headers: { 'content-type': JSON_CONTENT_TYPE },
    // The array itself, not its JSON text: `res.getBody()` is relayed verbatim by
    // the sandbox, so a script must receive the structure the HTTP path would give
    // it. `rawBody` keeps the serialised form for anything that wants the text.
    body: transcript,
    rawBody: JSON.stringify(transcript),
    responseTime,
  };
}

/**
 * The canonical name for a gRPC status code.
 *
 * Spelled out rather than imported from `@grpc/grpc-js` so that a status can be
 * named in a result built without the transport ever loading — a refusal, or a
 * unit test — and so the name a script reads never depends on the dependency's
 * enum ordering.
 */
export function grpcCodeName(code: number): string {
  return GRPC_CODE_NAMES[code] ?? `UNKNOWN_CODE_${code}`;
}

const GRPC_CODE_NAMES: Record<number, string> = {
  0: 'OK',
  1: 'CANCELLED',
  2: 'UNKNOWN',
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND',
  6: 'ALREADY_EXISTS',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION',
  10: 'ABORTED',
  11: 'OUT_OF_RANGE',
  12: 'UNIMPLEMENTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  15: 'DATA_LOSS',
  16: 'UNAUTHENTICATED',
};
