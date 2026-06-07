/**
 * Tests for BrunoResponse wrapper.
 *
 * TDD RED phase: these tests are written before the implementation exists.
 * They define the contract for src/bruno/response-wrapper.ts.
 */

import { BrunoResponse } from '../../../src/bruno/response-wrapper';

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
