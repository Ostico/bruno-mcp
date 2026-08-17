/**
 * The `res` a post-response script sees for the two non-HTTP transports.
 *
 * The end-to-end proof that these transports can now fail lives in
 * `tests/integration/grpc-unary.test.ts` and `tests/integration/ws-verification.test.ts`.
 * What is pinned here is the shape, because two of its decisions are the kind that
 * a later reader would "correct" into a bug:
 *
 * - `body` must arrive PARSED. The sandbox relays `res.getBody()` verbatim and
 *   makes no content-type decision of its own, so a builder handing over the JSON
 *   *string* would give scripts a string where HTTP gives an object — and every
 *   `res.getBody().field` would silently read undefined.
 * - a gRPC OK is 0, which is the refusal sentinel everywhere else in this API.
 *   Mapping it to 200 would make a passing assertion say something untrue about
 *   the call.
 */
import {
  grpcResponse,
  websocketResponse,
  grpcCodeName,
} from '../../../src/bruno/transport-verification';
import { toWebsocketDetail } from '../../../src/bruno/transport-redaction';
import type {
  WebsocketResultDetail,
  WebsocketTranscriptEntry,
} from '../../../src/bruno/transport-results';

describe('a gRPC call as res', () => {
  const detail = (over: Partial<{ code: number; details: string }> = {}) => ({
    code: 0,
    details: '',
    ...over,
  });

  it('hands the script a parsed body, not the JSON text', () => {
    const res = grpcResponse(detail(), '{"text":"echo:hi"}', 12);

    expect(res.body).toEqual({ text: 'echo:hi' });
    // The text is still available for anything that wants it.
    expect(res.rawBody).toBe('{"text":"echo:hi"}');
  });

  it('keeps a non-JSON body as its raw text rather than losing it', () => {
    const res = grpcResponse(detail(), 'not json at all', 1);

    expect(res.body).toBe('not json at all');
  });

  it('keeps an empty body empty rather than turning it into a parse failure', () => {
    expect(grpcResponse(detail(), '', 1).body).toBe('');
  });

  it('reports the gRPC code as the status, where 0 is success', () => {
    // Deliberately colliding with the refusal sentinel. The alternative — mapping
    // OK to 200 — would make `res.getStatus()` describe an HTTP call that never
    // happened.
    expect(grpcResponse(detail({ code: 0 }), '{}', 1).status).toBe(0);
    expect(grpcResponse(detail({ code: 7 }), '{}', 1).status).toBe(7);
  });

  it('names the code when the server supplied no details', () => {
    expect(grpcResponse(detail({ code: 5 }), '{}', 1).statusText).toBe('NOT_FOUND');
  });

  it('prefers the server’s own words when it supplied any', () => {
    expect(grpcResponse(detail({ code: 5, details: 'no such user' }), '{}', 1).statusText)
      .toBe('no such user');
  });

  it('exposes trailers as headers, so getHeader reads them with no new vocabulary', () => {
    const res = grpcResponse(
      { code: 0, details: '', trailers: { 'x-trace': 'abc' } },
      '{}',
      1,
    );

    expect(res.headers['x-trace']).toBe('abc');
  });

  it('still declares a content type when trailers carry none', () => {
    // A trailer named content-type would otherwise be able to displace it; this
    // asserts the ordering that keeps the declared type last.
    expect(grpcResponse(detail(), '{}', 1).headers['content-type']).toBe('application/json');
  });
});

describe('a gRPC status code by name', () => {
  it('names the codes the spec defines', () => {
    expect(grpcCodeName(0)).toBe('OK');
    expect(grpcCodeName(16)).toBe('UNAUTHENTICATED');
  });

  it('says plainly that it does not recognise a code rather than inventing one', () => {
    // A server may send anything. Returning 'OK' or an empty string for an
    // unmapped code would be worse than admitting the gap.
    expect(grpcCodeName(99)).toBe('UNKNOWN_CODE_99');
  });
});

describe('a websocket session as res', () => {
  const frames: WebsocketTranscriptEntry[] = [
    { direction: 'sent', offset_ms: 1, bytes: 5, payload: 'hello' },
    { direction: 'received', offset_ms: 4, bytes: 11, payload: 'echo:hello' },
  ];

  const asRes = (
    stopReason: WebsocketResultDetail['stop_reason'],
    transcript: WebsocketTranscriptEntry[] = frames,
    responseTime = 20,
  ) => websocketResponse(toWebsocketDetail(transcript, stopReason), transcript, responseTime);

  it('hands the script the transcript itself, not its JSON text', () => {
    const res = asRes('count');

    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as WebsocketTranscriptEntry[])[1].payload).toBe('echo:hello');
  });

  it('serialises the same frames into rawBody', () => {
    expect(asRes('count').rawBody).toBe(JSON.stringify(frames));
  });

  it('reports the stop reason as the status text', () => {
    // A session has no status, so the field that would carry one carries the
    // thing that actually ended it.
    expect(asRes('timeout').statusText).toBe('timeout');
  });

  it('leaves status at 0 rather than inventing a successful HTTP one', () => {
    expect(asRes('closed').status).toBe(0);
  });

  it('describes an empty session without failing', () => {
    const res = asRes('closed', [], 3);

    expect(res.body).toEqual([]);
    expect(res.responseTime).toBe(3);
  });

  // One value read twice, never two constructions of it. Every stop reason is
  // exercised because the pair is only as safe as its worst case, and `idle` is
  // the one whose truncation answer differs from its neighbours'.
  const STOP_REASONS: WebsocketResultDetail['stop_reason'][] = [
    'count', 'timeout', 'bytes', 'closed', 'error', 'idle',
  ];

  it.each(STOP_REASONS)('reports the same outcome the result does, stopped by %s', (reason) => {
    const detail = toWebsocketDetail(frames, reason);
    const res = websocketResponse(detail, frames, 20);

    expect(res.session?.stopReason).toBe(detail.stop_reason);
    expect(res.session?.truncated).toBe(detail.truncated);
    // The stop reason is reachable two ways and both must say the same thing:
    // statusText predates the session object and assertions were written on it.
    expect(res.statusText).toBe(detail.stop_reason);
  });

  it('carries the close code the transcript recorded', () => {
    const closed: WebsocketTranscriptEntry[] = [
      ...frames,
      { direction: 'received', offset_ms: 9, bytes: 2, type: 'close', close_code: 1008 },
    ];

    const detail = toWebsocketDetail(closed, 'closed');

    expect(websocketResponse(detail, closed, 20).session?.closeCode).toBe(1008);
  });

  it('reports no close code for a session that ended without a close frame', () => {
    // A run stopped by its own bound terminates the socket, so there is usually
    // no close to report. 1000 would claim an ordinary goodbye that never came.
    const res = asRes('count');

    expect(res.session?.closeCode).toBeUndefined();
    expect(Object.keys(res.session!)).not.toContain('closeCode');
  });
});
