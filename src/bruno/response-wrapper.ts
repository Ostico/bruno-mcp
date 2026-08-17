import type { ResponseData, MockResponseData } from './types.js';

/**
 * Single source of truth for "should this response body be parsed as JSON?"
 *. Two divergent rules previously lived in this file — a loose
 * `.includes('json')` in `BrunoResponse.getBody()` and a stricter
 * `application/json` / `+json` check in `wrapFetchResponse()` — which disagreed
 * for content types like `text/json`, so the same response could be typed as a
 * parsed object on one path and a raw string on the other.
 *
 * The rule matches a media type whose subtype is exactly `json` or uses the
 * `+json` structured-syntax suffix (RFC 6839): `application/json`, `text/json`,
 * `application/ld+json`, `application/vnd.api+json`, … It is case-insensitive
 * and ignores parameters (`; charset=…`). Subtypes that merely contain the
 * substring `json` (e.g. `application/notjson`) are intentionally NOT matched.
 *
 * This is the exact set `detectDoubleParse` refers to when it warns callers that
 * `res.getBody()` already returns parsed JSON "when the response Content-Type is
 * JSON": routing every JSON decision through this predicate makes that contract
 * consistent across the wrapper.
 */
export function isJsonContentType(contentType: string | null | undefined): boolean {
  if (!contentType) {
    return false;
  }
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
  const subtype = mediaType.split('/')[1] ?? '';
  return subtype === 'json' || subtype.endsWith('+json');
}

export class BrunoResponse {
  private readonly status: number;
  private readonly statusText: string;
  private readonly headers: Record<string, string>;
  private readonly body: string;
  private readonly responseTime: number;

  private readonly headersLower: Record<string, string>;

  private parsedBody: unknown | undefined;
  private bodyParsed = false;

  constructor(data: ResponseData) {
    this.status = data.status;
    this.statusText = data.statusText;
    this.headers = data.headers;
    this.body = data.body;
    this.responseTime = data.responseTime;

    this.headersLower = {};
    for (const key of Object.keys(data.headers)) {
      this.headersLower[key.toLowerCase()] = data.headers[key];
    }
  }

  getStatus(): number {
    return this.status;
  }

  getStatusText(): string {
    return this.statusText;
  }

  getHeaders(): Record<string, string> {
    return this.headers;
  }

  getHeader(name: string): string | null {
    return this.headersLower[name.toLowerCase()] ?? null;
  }

  getBody(): unknown {
    if (this.bodyParsed) {
      return this.parsedBody;
    }

    this.bodyParsed = true;

    const contentType = this.getHeader('content-type');
    if (isJsonContentType(contentType)) {
      try {
        this.parsedBody = JSON.parse(this.body);
      } catch {
        this.parsedBody = this.body;
      }
    } else {
      this.parsedBody = this.body;
    }

    return this.parsedBody;
  }

  getResponseTime(): number {
    return this.responseTime;
  }
}

/**
 * Hard ceiling on the response bytes buffered in memory — a server-protection
 * cap, independent of the caller's display truncation. undici transparently
 * decompresses gzip/deflate/br, so a small "decompression bomb" or a multi-GB
 * body would otherwise be fully buffered by response.text() and OOM the process
 *. The body stream is read incrementally and cancelled once this
 * many decompressed bytes have accumulated.
 */
export const MAX_RESPONSE_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Build a TextDecoder that honors the response's declared Content-Type charset
 *. Decoding a non-UTF-8 body (e.g. `text/html; charset=ISO-8859-1`
 * or Shift_JIS) as UTF-8 mojibakes the text. Rules:
 *   - no `charset=` token  → default to UTF-8
 *   - known/valid label    → decode with that charset
 *   - unknown/invalid label (TextDecoder throws RangeError) → fall back to UTF-8
 *     rather than failing the whole read.
 */
function decoderForContentType(contentType: string | null): TextDecoder {
  const charset = contentType
    ?.match(/;\s*charset\s*=\s*"?([^";]+)"?/i)?.[1]
    ?.trim();
  if (!charset) {
    return new TextDecoder('utf-8');
  }
  try {
    return new TextDecoder(charset);
  } catch {
    // Unknown/unsupported label — TextDecoder throws RangeError. Degrade to UTF-8.
    return new TextDecoder('utf-8');
  }
}

/**
 * Read a response body as UTF-8 text without buffering more than `maxBytes`.
 *
 * Real (undici) responses expose a ReadableStream `body`, which is read
 * incrementally and cancelled at the cap so a hostile/bomb response cannot
 * exhaust memory. A response with no stream body (e.g. a test double that only
 * implements text()) falls back to text(). Multibyte sequences that straddle a
 * chunk boundary — or the cap — are decoded via a streaming TextDecoder.
 */
export async function readBodyCapped(
  response: Response,
  maxBytes: number = MAX_RESPONSE_BYTES,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body || typeof response.body.getReader !== 'function') {
    return { text: await response.text(), truncated: false };
  }

  const reader = response.body.getReader();
  const decoder = decoderForContentType(response.headers.get('content-type'));
  let text = '';
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      if (total + value.byteLength > maxBytes) {
        const take = maxBytes - total;
        if (take > 0) {
          text += decoder.decode(value.subarray(0, take), { stream: true });
        }
        truncated = true;
        break;
      }

      text += decoder.decode(value, { stream: true });
      total += value.byteLength;
    }
  } finally {
    // Stop undici pulling/decompressing any more of a runaway body.
    await reader.cancel().catch(() => {});
  }

  text += decoder.decode(); // flush any pending multibyte state
  return { text, truncated };
}

export async function wrapFetchResponse(
  response: Response,
  durationMs: number,
  maxBytes: number = MAX_RESPONSE_BYTES,
): Promise<MockResponseData> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  // `getSetCookie()` is the only way to see every cookie. `forEach` walks the
  // sorted-and-combined header list, which combines repeated headers into one
  // comma-joined value for every name except `set-cookie` — that one it yields
  // once per cookie, so the loop above assigned each in turn and the flat map
  // was left holding whichever came last. A login setting a session cookie and
  // a persistent-login cookie lost one of them, and nothing said so.
  const setCookies =
    typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];

  // The flat map gets the joined form, so a script asking `res.getHeader
  // ('set-cookie')` sees every cookie rather than one of them. Splitting that
  // string back apart is still not safe — an `Expires` attribute contains a
  // comma — which is why the list is carried beside it for `res.getSetCookies()`
  // and for the reported headers to use in preference.
  if (setCookies.length > 0) headers['set-cookie'] = setCookies.join(', ');

  const { text: rawText, truncated } = await readBodyCapped(response, maxBytes);
  if (truncated) {
    console.warn(
      `[bruno-mcp] response body exceeded ${maxBytes} bytes and was truncated to protect the server`,
    );
  }

  let body: unknown = rawText;
  const contentType = headers['content-type'];
  if (isJsonContentType(contentType)) {
    try {
      body = JSON.parse(rawText);
    } catch {
      // Keep raw text if JSON parse fails
    }
  }

  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body,
    responseTime: durationMs,
    rawBody: rawText,
    ...(setCookies.length > 0 ? { setCookies } : {}),
  };
}
