/**
 * Redaction and size bounds for the two transports whose results are not
 * HTTP-shaped.
 *
 * The WebSocket transcript is the sharper of the two problems. Outbound frames are
 * recorded AFTER `{{var}}` interpolation, and `run_collection` documents
 * `variables` as the only correct way to supply a secret — so a transcript that
 * recorded payloads by default would write every supplied secret into a result
 * that `includeResponseBody` surfaces by default. That would be strictly worse
 * than the gRPC-metadata leak this module also closes. Payload recording is
 * therefore opt-in, and the default entry carries direction, offset and byte
 * length only.
 */

import type {
  WebsocketFrameType,
  WebsocketTranscriptEntry,
  SessionOutcome,
  WebsocketResultDetail,
} from './transport-results.js';

/**
 * Metadata and handshake-header names whose values are never recorded.
 *
 * A superset of the cross-origin redirect strip list in `request-redaction.ts`,
 * which withholds only what a redirect to another origin must not carry. This
 * list answers a wider question — what must not be written down at all — so it
 * also covers the gRPC spellings, the vendor session tokens, and the names a
 * server mints a token *under* rather than reads one from: a CSRF or XSRF token
 * arriving on a response is a credential for the next request, and a run result
 * is not the only place it would land. The same names reach an HTML or JUnit
 * report, which is a file someone commits.
 *
 * Kept as names rather than patterns: masking by name says which field was
 * withheld without leaking a prefix of its value. Only the reported copy is
 * masked — a script still reads the response's own headers, so a token can be
 * captured and chained without the report carrying it.
 */
const CREDENTIAL_NAMES: readonly string[] = [
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'grpc-authorization',
  'xsrf-token',
  'x-xsrf-token',
  'csrf-token',
  'x-csrf-token',
  'x-amz-security-token',
];

export const REDACTED = '[redacted]';

/** Per-frame ceiling handed to `ws` as `maxPayload`. */
export const DEFAULT_MAX_FRAME_BYTES = 65_536;

/**
 * Cumulative transcript ceiling, which becomes a third stop reason alongside the
 * message count and the timeout.
 *
 * `ws` defaults `maxPayload` to 100 MB. At the default 50-message cap that is a
 * 5 GB in-memory transcript serialised into an MCP response, so neither bound may
 * be left at its library default.
 */
export const DEFAULT_MAX_TRANSCRIPT_BYTES = 1_048_576;

/**
 * Whether a header name is one whose value is never recorded.
 *
 * Exported for the response-header path, which shares this vocabulary but not
 * the whole-value policy: a response's `set-cookie` is masked in part, since its
 * attributes are the reason those headers are reported. See
 * `response-headers.ts`.
 */
export function isCredentialHeaderName(name: string): boolean {
  return isCredentialName(name, []);
}

function isCredentialName(name: string, extraNames: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return (
    CREDENTIAL_NAMES.includes(lower) || extraNames.some((n) => n.toLowerCase() === lower)
  );
}

/**
 * Mask credential-bearing entries in a gRPC metadata or WebSocket handshake map.
 *
 * The key is kept so a reader can see the credential was sent; only the value is
 * replaced. `extraNames` carries the header names auth was actually applied to, so
 * a caller-named api-key header is masked too and not just the standard set.
 */
export function redactMetadata(
  metadata: Record<string, string> | undefined,
  extraNames: readonly string[] = [],
): Record<string, string> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    out[key] = isCredentialName(key, extraNames) ? REDACTED : value;
  }
  return out;
}

export interface TranscriptEntryInput {
  direction: 'sent' | 'received';
  offset_ms: number;
  /**
   * The frame as it went on or came off the wire, already interpolated — and, for
   * a binary frame, already base64-encoded, which is why `bytes` can be supplied
   * separately.
   */
  payload: string;
  /** Defaults to `text`, the only kind a caller that predates this had. */
  type?: WebsocketFrameType;
  /** The authored name of an outbound message. */
  title?: string;
  /** The code carried by a close frame. */
  closeCode?: number;
  /**
   * The frame's true size on the wire, when the payload is an encoding of it
   * rather than the bytes themselves. Derived from the payload when omitted.
   */
  bytes?: number;
}

export interface TranscriptOptions {
  /**
   * Record frame contents, not just their size. Off by default because outbound
   * frames are post-interpolation and would carry supplied secrets verbatim.
   */
  includePayloads?: boolean;
  maxFrameBytes?: number;
  maxTranscriptBytes?: number;
}

/**
 * Build a transcript entry, recording the payload only when asked.
 *
 * A frame longer than the per-frame ceiling is truncated rather than dropped, so
 * the entry still testifies that something arrived and how much of it there was.
 */
export function toTranscriptEntry(
  input: TranscriptEntryInput,
  options: TranscriptOptions = {},
  // Bytes already recorded by this transcript. Defaults to 0 so a caller that
  // records a single entry, and every existing test, needs no change.
  recordedBytes = 0,
): WebsocketTranscriptEntry {
  const bytes = input.bytes ?? Buffer.byteLength(input.payload, 'utf8');
  const entry: WebsocketTranscriptEntry = {
    direction: input.direction,
    offset_ms: input.offset_ms,
    bytes,
    type: input.type ?? 'text',
  };
  if (input.title !== undefined) entry.title = input.title;
  if (input.closeCode !== undefined) entry.close_code = input.closeCode;
  if (options.includePayloads) {
    // Two ceilings, and the smaller wins. The per-frame one bounds any single
    // frame; the cumulative one bounds the whole tool response, and it is the
    // reason this function needs to know what came before.
    //
    // The cumulative bound used to be enforced only by the caller's stop check,
    // which runs AFTER the entry is appended — so one frame arriving under a
    // small budget was recorded whole, and a 100-byte budget could hold 2000
    // bytes. Clipping here is what makes the option a bound rather than a hint.
    //
    // `bytes` still reports the frame's true size in both cases. That is the
    // honest way round: the entry testifies that something that big arrived,
    // while the payload we chose to keep stays within budget.
    const frameCap = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    const transcriptCap = options.maxTranscriptBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES;
    const remaining = Math.max(0, transcriptCap - recordedBytes);
    const cap = Math.min(frameCap, remaining);
    // Measured against the payload as recorded, not against the wire size, so a
    // binary frame's base64 — a third longer than the bytes it stands for — is
    // held to the same budget as text. The two are equal for a text frame.
    const recorded = Buffer.byteLength(input.payload, 'utf8');
    entry.payload = recorded > cap ? input.payload.slice(0, cap) : input.payload;
  }
  return entry;
}

/**
 * Total bytes a transcript has accounted for, whether or not payloads were kept.
 *
 * Counted from the wire size rather than from what was recorded, so turning
 * payload recording off does not silently raise the effective cap.
 */
export function transcriptBytes(entries: readonly WebsocketTranscriptEntry[]): number {
  return entries.reduce((sum, e) => sum + e.bytes, 0);
}

/**
 * Decide whether the cumulative ceiling has been reached.
 *
 * Separate from the count and timeout bounds because it is reported as its own
 * stop reason — "bytes" and "count" mean different things to whoever reads the
 * result, and collapsing them would hide which limit actually bit.
 */
export function transcriptCapReached(
  entries: readonly WebsocketTranscriptEntry[],
  options: TranscriptOptions = {},
): boolean {
  return transcriptBytes(entries) >= (options.maxTranscriptBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES);
}

/** Assemble the result detail, stating truncation rather than leaving it implied. */
export function toWebsocketDetail(
  transcript: WebsocketTranscriptEntry[],
  stopReason: WebsocketResultDetail['stop_reason'],
): WebsocketResultDetail {
  return {
    transcript,
    stop_reason: stopReason,
    // `idle` is deliberately absent: a cap bit in the other three cases, whereas an
    // idle stop means the wall-clock budget was NOT spent and the peer had gone
    // quiet. Marking it truncated would put the flag on almost every session that
    // finished early and normally, which is how a warning stops being read.
    truncated: stopReason === 'count' || stopReason === 'timeout' || stopReason === 'bytes',
  };
}

/**
 * The outcome a script reads, taken FROM the detail the result reports.
 *
 * Deriving it rather than assembling it beside the detail is the whole point:
 * `res.getStopReason()` and `result.websocket.stop_reason` are one value read
 * twice, so an assertion cannot pass against an outcome the result denies. The
 * close code is read from the transcript for the same reason — it is where the
 * result already carries it, so there is no second copy to drift.
 *
 * The LAST close entry wins. A session records at most one, and taking the last
 * means a reader gets the code the session actually ended on if that ever stops
 * being true.
 */
export function toSessionOutcome(detail: WebsocketResultDetail): SessionOutcome {
  const closes = detail.transcript.filter(
    (entry) => entry.type === 'close' && entry.close_code !== undefined,
  );
  const closeCode = closes[closes.length - 1]?.close_code;
  return {
    stopReason: detail.stop_reason,
    ...(closeCode !== undefined ? { closeCode } : {}),
    truncated: detail.truncated,
  };
}
