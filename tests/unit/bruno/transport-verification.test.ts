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
import type { WebsocketTranscriptEntry } from '../../../src/bruno/transport-results';

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

  it('hands the script the transcript itself, not its JSON text', () => {
    const res = websocketResponse(frames, 'count', 20);

    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as WebsocketTranscriptEntry[])[1].payload).toBe('echo:hello');
  });

  it('serialises the same frames into rawBody', () => {
    expect(websocketResponse(frames, 'count', 20).rawBody).toBe(JSON.stringify(frames));
  });

  it('reports the stop reason as the status text', () => {
    // A session has no status, so the field that would carry one carries the
    // thing that actually ended it.
    expect(websocketResponse(frames, 'timeout', 20).statusText).toBe('timeout');
  });

  it('leaves status at 0 rather than inventing a successful HTTP one', () => {
    expect(websocketResponse(frames, 'closed', 20).status).toBe(0);
  });

  it('describes an empty session without failing', () => {
    const res = websocketResponse([], 'closed', 3);

    expect(res.body).toEqual([]);
    expect(res.responseTime).toBe(3);
  });
});
