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

export async function wrapFetchResponse(
  response: Response,
  durationMs: number,
): Promise<MockResponseData> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const rawText = await response.text();

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
  };
}
