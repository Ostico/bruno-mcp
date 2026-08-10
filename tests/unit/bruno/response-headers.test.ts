/**
 * Tests for collectResponseHeaders — what a run result is told about a
 * response's headers, and what it is not told.
 *
 * The cookie cases carry the design: a request's `Cookie` header is withheld
 * whole, and a response's `Set-Cookie` cannot be, because its attributes are the
 * reason the field exists. Checking `HttpOnly` and `SameSite` without authoring
 * a script is what B2 was filed for.
 */

import {
  collectResponseHeaders,
  collectIncomingHeaders,
} from '../../../src/bruno/response-headers';

describe('collectResponseHeaders', () => {
  it('reports ordinary headers as they arrived', () => {
    const headers = collectResponseHeaders({
      headers: {
        'content-type': 'application/json',
        'strict-transport-security': 'max-age=31536000; includeSubDomains',
        'access-control-allow-origin': '*',
      },
    });

    expect(headers).toEqual({
      'content-type': 'application/json',
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
      'access-control-allow-origin': '*',
    });
  });

  it('masks a credential a response echoed back', () => {
    const headers = collectResponseHeaders({
      headers: { 'x-api-key': 'live_abc123', 'x-request-id': 'req-7' },
    });

    expect(headers['x-api-key']).toBe('[redacted]');
    // The name is kept, so a reader can see the response carried it.
    expect(Object.keys(headers)).toContain('x-api-key');
    expect(headers['x-request-id']).toBe('req-7');
  });

  it('keeps every cookie attribute while withholding the value', () => {
    const headers = collectResponseHeaders({
      headers: { 'set-cookie': 'session=s3cret; Path=/; HttpOnly; Secure; SameSite=Lax' },
      setCookies: ['session=s3cret; Path=/; HttpOnly; Secure; SameSite=Lax'],
    });

    expect(headers['set-cookie']).toEqual([
      'session=[redacted]; Path=/; HttpOnly; Secure; SameSite=Lax',
    ]);
  });

  it('reports each cookie separately, since a joined value cannot be split back', () => {
    // A cookie value may contain a comma, which is why the flat map is not the
    // source here: two cookies is the ordinary case, not an edge one.
    const headers = collectResponseHeaders({
      headers: { 'set-cookie': 'session=a,b; HttpOnly, csrf=t0ken; SameSite=Strict' },
      setCookies: ['session=a,b; HttpOnly', 'csrf=t0ken; SameSite=Strict'],
    });

    expect(headers['set-cookie']).toEqual([
      'session=[redacted]; HttpOnly',
      'csrf=[redacted]; SameSite=Strict',
    ]);
  });

  it('reports a single attribute-less cookie as a list too', () => {
    const headers = collectResponseHeaders({
      headers: { 'set-cookie': 'sid=abc' },
      setCookies: ['sid=abc'],
    });

    // A list of one, so a caller reading set-cookie never tests which shape it got.
    expect(headers['set-cookie']).toEqual(['sid=[redacted]']);
  });

  it('withholds a value it cannot take apart', () => {
    const headers = collectResponseHeaders({
      headers: { 'set-cookie': 'x' },
      setCookies: ['no-equals-at-all', '; Path=/; sid=abc'],
    });

    // Guessing which half of an unparseable value is the credential is how one
    // gets copied into a result.
    expect(headers['set-cookie']).toEqual(['[redacted]', '[redacted]']);
  });

  it('falls back to the joined header when the response carried no cookie list', () => {
    // `wrapFetchResponse` tests for `Headers.getSetCookie` before calling it, so
    // on a runtime without it the joined value is all there is.
    const headers = collectResponseHeaders({
      headers: { 'Set-Cookie': 'session=s3cret; HttpOnly' },
      setCookies: [],
    });

    expect(headers['set-cookie']).toEqual(['session=[redacted]; HttpOnly']);
    // Reported once, under the lowercase name, not twice.
    expect(Object.keys(headers)).toEqual(['set-cookie']);
  });

  it('omits set-cookie entirely when the response set none', () => {
    const headers = collectResponseHeaders({
      headers: { 'content-type': 'text/plain' },
      setCookies: [],
    });

    expect(headers).toEqual({ 'content-type': 'text/plain' });
  });
});

describe('collectIncomingHeaders', () => {
  it('reads a WebSocket upgrade response, cookie list included', () => {
    const headers = collectIncomingHeaders({
      'sec-websocket-protocol': 'chat',
      'set-cookie': ['session=s3cret; HttpOnly', 'csrf=t0ken'],
    });

    expect(headers).toEqual({
      'sec-websocket-protocol': 'chat',
      'set-cookie': ['session=[redacted]; HttpOnly', 'csrf=[redacted]'],
    });
  });

  it('drops a repeated non-cookie header rather than guessing at it', () => {
    // Node joins every repeated header except set-cookie, so this cannot arrive
    // from the runtime — it is refused rather than flattened on a guess.
    const headers = collectIncomingHeaders({
      'x-multi': ['a', 'b'],
      'x-single': 'kept',
      'x-absent': undefined,
    });

    expect(headers).toEqual({ 'x-single': 'kept' });
  });
});
