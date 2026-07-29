/**
 * Tests for BrunoResponse wrapper.
 *
 * TDD RED phase: these tests are written before the implementation exists.
 * They define the contract for src/bruno/response-wrapper.ts.
 */

import {
  BrunoResponse,
  wrapFetchResponse,
  readBodyCapped,
  isJsonContentType,
  MAX_RESPONSE_BYTES,
} from '../../../src/bruno/response-wrapper';

// ---------------------------------------------------------------------------
// Helpers — build a minimal ResponseData that BrunoResponse accepts
// ---------------------------------------------------------------------------

interface MockResponseInit {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  responseTime?: number;
}

function buildResponseData(init: MockResponseInit = {}) {
  const {
    status = 200,
    statusText = 'OK',
    headers = { 'content-type': 'text/plain' },
    body = '',
    responseTime = 42,
  } = init;

  return { status, statusText, headers, body, responseTime };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BrunoResponse', () => {
  // -- getStatus() ----------------------------------------------------------

  describe('getStatus()', () => {
    it('returns the HTTP status code', () => {
      const res = new BrunoResponse(buildResponseData({ status: 200 }));
      expect(res.getStatus()).toBe(200);
    });

    it('returns non-200 status codes', () => {
      const res = new BrunoResponse(buildResponseData({ status: 404 }));
      expect(res.getStatus()).toBe(404);
    });

    it('returns 500 for server errors', () => {
      const res = new BrunoResponse(buildResponseData({ status: 500 }));
      expect(res.getStatus()).toBe(500);
    });
  });

  // -- getStatusText() ------------------------------------------------------

  describe('getStatusText()', () => {
    it('returns the status text', () => {
      const res = new BrunoResponse(
        buildResponseData({ statusText: 'Not Found' }),
      );
      expect(res.getStatusText()).toBe('Not Found');
    });

    it('returns "OK" for 200 responses', () => {
      const res = new BrunoResponse(buildResponseData({ statusText: 'OK' }));
      expect(res.getStatusText()).toBe('OK');
    });
  });

  // -- getHeaders() ---------------------------------------------------------

  describe('getHeaders()', () => {
    it('returns all headers as a Record<string, string>', () => {
      const headers = {
        'content-type': 'application/json',
        'x-request-id': 'abc123',
      };
      const res = new BrunoResponse(buildResponseData({ headers }));
      expect(res.getHeaders()).toEqual(headers);
    });

    it('returns an empty object when there are no headers', () => {
      const res = new BrunoResponse(buildResponseData({ headers: {} }));
      expect(res.getHeaders()).toEqual({});
    });
  });

  // -- getHeader(name) — case-insensitive -----------------------------------

  describe('getHeader(name)', () => {
    it('returns the header value by exact name', () => {
      const headers = { 'content-type': 'application/json' };
      const res = new BrunoResponse(buildResponseData({ headers }));
      expect(res.getHeader('content-type')).toBe('application/json');
    });

    it('is case-insensitive (lower → mixed)', () => {
      const headers = { 'Content-Type': 'text/html' };
      const res = new BrunoResponse(buildResponseData({ headers }));
      expect(res.getHeader('content-type')).toBe('text/html');
    });

    it('is case-insensitive (upper → lower)', () => {
      const headers = { 'x-custom-header': 'value' };
      const res = new BrunoResponse(buildResponseData({ headers }));
      expect(res.getHeader('X-Custom-Header')).toBe('value');
    });

    it('returns null for a missing header', () => {
      const res = new BrunoResponse(buildResponseData({ headers: {} }));
      expect(res.getHeader('x-missing')).toBeNull();
    });
  });

  // -- getBody() — JSON parsing ---------------------------------------------

  describe('getBody() — JSON content', () => {
    it('returns parsed JSON object when content-type is application/json', () => {
      const body = JSON.stringify({ id: 1, name: 'test' });
      const res = new BrunoResponse(
        buildResponseData({
          headers: { 'content-type': 'application/json' },
          body,
        }),
      );
      expect(res.getBody()).toEqual({ id: 1, name: 'test' });
    });

    it('handles application/json with charset suffix', () => {
      const body = JSON.stringify({ ok: true });
      const res = new BrunoResponse(
        buildResponseData({
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body,
        }),
      );
      expect(res.getBody()).toEqual({ ok: true });
    });

    it('returns parsed JSON array', () => {
      const body = JSON.stringify([1, 2, 3]);
      const res = new BrunoResponse(
        buildResponseData({
          headers: { 'content-type': 'application/json' },
          body,
        }),
      );
      expect(res.getBody()).toEqual([1, 2, 3]);
    });

    it('returns raw string when JSON parsing fails on application/json', () => {
      const body = 'not-valid-json{{{';
      const res = new BrunoResponse(
        buildResponseData({
          headers: { 'content-type': 'application/json' },
          body,
        }),
      );
      // When JSON.parse fails, fall back to raw text
      expect(res.getBody()).toBe('not-valid-json{{{');
    });
  });

  // -- getBody() — non-JSON content -----------------------------------------

  describe('getBody() — non-JSON content', () => {
    it('returns raw text for text/plain', () => {
      const res = new BrunoResponse(
        buildResponseData({
          headers: { 'content-type': 'text/plain' },
          body: 'hello world',
        }),
      );
      expect(res.getBody()).toBe('hello world');
    });

    it('returns raw text for text/html', () => {
      const html = '<html><body>hi</body></html>';
      const res = new BrunoResponse(
        buildResponseData({
          headers: { 'content-type': 'text/html' },
          body: html,
        }),
      );
      expect(res.getBody()).toBe(html);
    });

    it('returns raw text when content-type header is missing', () => {
      const res = new BrunoResponse(
        buildResponseData({
          headers: {},
          body: 'raw data',
        }),
      );
      expect(res.getBody()).toBe('raw data');
    });

    it('returns empty string for empty body', () => {
      const res = new BrunoResponse(
        buildResponseData({
          headers: { 'content-type': 'text/plain' },
          body: '',
        }),
      );
      expect(res.getBody()).toBe('');
    });
  });

  // -- getResponseTime() ----------------------------------------------------

  describe('getResponseTime()', () => {
    it('returns the response time in milliseconds', () => {
      const res = new BrunoResponse(buildResponseData({ responseTime: 150 }));
      expect(res.getResponseTime()).toBe(150);
    });

    it('returns 0 when response time is 0', () => {
      const res = new BrunoResponse(buildResponseData({ responseTime: 0 }));
      expect(res.getResponseTime()).toBe(0);
    });
  });

  // -- Edge cases -----------------------------------------------------------

  describe('edge cases', () => {
    it('handles case-insensitive content-type for JSON detection', () => {
      const body = JSON.stringify({ a: 1 });
      const res = new BrunoResponse(
        buildResponseData({
          headers: { 'Content-Type': 'Application/JSON' },
          body,
        }),
      );
      expect(res.getBody()).toEqual({ a: 1 });
    });

    it('handles application/vnd.api+json as JSON', () => {
      const body = JSON.stringify({ data: [] });
      const res = new BrunoResponse(
        buildResponseData({
          headers: { 'content-type': 'application/vnd.api+json' },
          body,
        }),
      );
      expect(res.getBody()).toEqual({ data: [] });
    });

    it('getBody() called multiple times returns same result', () => {
      const body = JSON.stringify({ x: 1 });
      const res = new BrunoResponse(
        buildResponseData({
          headers: { 'content-type': 'application/json' },
          body,
        }),
      );
      const first = res.getBody();
      const second = res.getBody();
      expect(first).toEqual(second);
    });
  });
});

describe('readBodyCapped (bounded response read)', () => {
  it('reads a small streamed body in full', async () => {
    const res = new Response('hello world');
    expect(await readBodyCapped(res, 1000)).toEqual({ text: 'hello world', truncated: false });
  });

  it('caps a body larger than the limit and flags truncation', async () => {
    const res = new Response('x'.repeat(10_000));
    const out = await readBodyCapped(res, 100);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBe(100);
  });

  it('does not flag truncation when the body exactly fits the cap', async () => {
    const res = new Response('x'.repeat(50));
    const out = await readBodyCapped(res, 50);
    expect(out.truncated).toBe(false);
    expect(out.text.length).toBe(50);
  });

  it('decodes multibyte characters that span chunk boundaries', async () => {
    // Split a 3-byte UTF-8 char (€ = E2 82 AC) across two chunks.
    const euro = new Uint8Array([0xe2, 0x82, 0xac]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(euro.subarray(0, 1));
        controller.enqueue(euro.subarray(1));
        controller.close();
      },
    });
    const out = await readBodyCapped(new Response(stream), 1000);
    expect(out.text).toBe('€');
  });

  it('falls back to text() when the response has no stream body', async () => {
    const fake = { body: undefined, text: async () => 'from-text' } as unknown as Response;
    expect(await readBodyCapped(fake, 1000)).toEqual({ text: 'from-text', truncated: false });
  });

  it('exposes a positive default ceiling', () => {
    expect(MAX_RESPONSE_BYTES).toBeGreaterThan(0);
  });
});

describe('readBodyCapped — Content-Type charset', () => {
  it('decodes a non-UTF-8 body using the declared charset (ISO-8859-1)', async () => {
    // 0xE9 is 'é' in ISO-8859-1 (latin1) but an invalid UTF-8 lead byte.
    const body = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" in latin1
    const res = new Response(body, {
      headers: { 'content-type': 'text/plain; charset=ISO-8859-1' },
    });
    const out = await readBodyCapped(res, 1000);
    expect(out.text).toBe('café');
    expect(out.truncated).toBe(false);
  });

  it('defaults to UTF-8 when no charset is declared', async () => {
    // "café" in UTF-8: é = 0xC3 0xA9.
    const body = new Uint8Array([0x63, 0x61, 0x66, 0xc3, 0xa9]);
    const res = new Response(body, {
      headers: { 'content-type': 'text/plain' },
    });
    const out = await readBodyCapped(res, 1000);
    expect(out.text).toBe('café');
  });

  it('defaults to UTF-8 when there is no content-type header at all', async () => {
    const body = new Uint8Array([0x63, 0x61, 0x66, 0xc3, 0xa9]);
    const res = new Response(body);
    const out = await readBodyCapped(res, 1000);
    expect(out.text).toBe('café');
  });

  it('falls back to UTF-8 when the declared charset is unknown', async () => {
    const body = new Uint8Array([0x63, 0x61, 0x66, 0xc3, 0xa9]);
    const res = new Response(body, {
      headers: { 'content-type': 'text/plain; charset=totally-bogus-label' },
    });
    // Must not throw; unknown label falls back to UTF-8 decoding.
    const out = await readBodyCapped(res, 1000);
    expect(out.text).toBe('café');
  });
});

describe('wrapFetchResponse — Set-Cookie preservation', () => {
  it('preserves every Set-Cookie value individually', async () => {
    const headers = new Headers();
    headers.append('set-cookie', 'a=1; Path=/');
    headers.append('set-cookie', 'b=2; Expires=Wed, 21 Oct 2099 00:00:00 GMT');
    const out = await wrapFetchResponse(new Response('ok', { headers }), 5);
    expect(out.setCookies).toEqual(['a=1; Path=/', 'b=2; Expires=Wed, 21 Oct 2099 00:00:00 GMT']);
  });

  it('omits setCookies when the response set no cookies', async () => {
    const out = await wrapFetchResponse(new Response('ok'), 5);
    expect(out.setCookies).toBeUndefined();
  });
});

describe('isJsonContentType — unified predicate boundary', () => {
  it.each([
    ['application/json', true],
    ['application/json; charset=utf-8', true],
    ['Application/JSON', true],
    ['text/json', true],
    ['application/ld+json', true],
    ['application/vnd.api+json', true],
    ['text/plain', false],
    ['application/xml', false],
    ['text/html; charset=utf-8', false],
    ['application/notjson', false],
    ['json', false],
    ['', false],
  ])('%s → %s', (contentType, expected) => {
    expect(isJsonContentType(contentType)).toBe(expected);
  });

  it('returns false for null / undefined content types', () => {
    expect(isJsonContentType(null)).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
  });
});

describe('JSON content-type detection consistency', () => {
  it('text/json: getBody() and wrapFetchResponse agree — both parse to the same object', async () => {
    const jsonBody = JSON.stringify({ ok: true });

    // Path 1: BrunoResponse.getBody()
    const wrapper = new BrunoResponse(
      buildResponseData({
        headers: { 'content-type': 'text/json' },
        body: jsonBody,
      }),
    );

    // Path 2: wrapFetchResponse()
    const out = await wrapFetchResponse(
      new Response(jsonBody, { headers: { 'content-type': 'text/json' } }),
      1,
    );

    expect(wrapper.getBody()).toEqual({ ok: true });
    expect(out.body).toEqual({ ok: true });
    // The two JSON-detection paths must not disagree.
    expect(out.body).toEqual(wrapper.getBody());
  });
});

describe('wrapFetchResponse — body handling', () => {
  it('parses a JSON body read through the capped stream', async () => {
    const res = new Response('{"a":1}', { headers: { 'content-type': 'application/json' } });
    const out = await wrapFetchResponse(res, 1);
    expect(out.body).toEqual({ a: 1 });
    expect(out.rawBody).toBe('{"a":1}');
  });

  it('caps an oversized body and warns', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await wrapFetchResponse(new Response('y'.repeat(1000)), 1, 20);
    expect(out.rawBody!.length).toBe(20);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('truncated to protect the server'));
    warn.mockRestore();
  });
});
