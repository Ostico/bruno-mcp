import type { ResponseData, MockResponseData } from './types.js';

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

    const contentType = this.getHeader('content-type') ?? '';
    if (contentType.toLowerCase().includes('json')) {
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
 * (finding X3). The body stream is read incrementally and cancelled once this
 * many decompressed bytes have accumulated.
 */
export const MAX_RESPONSE_BYTES = 50 * 1024 * 1024; // 50 MB

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
  const decoder = new TextDecoder('utf-8');
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

  // X7: Headers.forEach comma-joins multiple Set-Cookie into one value, which
  // is lossy (cookie values may contain commas). getSetCookie() preserves each.
  const setCookies =
    typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];

  const { text: rawText, truncated } = await readBodyCapped(response, maxBytes);
  if (truncated) {
    console.warn(
      `[bruno-mcp] response body exceeded ${maxBytes} bytes and was truncated to protect the server`,
    );
  }

  let body: unknown = rawText;
  const contentType = headers['content-type'] ?? '';
  if (contentType.includes('application/json') || contentType.includes('+json')) {
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
