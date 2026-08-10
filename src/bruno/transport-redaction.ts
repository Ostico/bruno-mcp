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
  WebsocketTranscriptEntry,
  WebsocketResultDetail,
} from './transport-results.js';

/**
 * Metadata and handshake-header names whose values are never recorded.
 *
 * Same vocabulary as the cross-origin redirect strip list in
 * `request-redaction.ts`, plus the gRPC-specific spellings. Kept as names rather
 * than patterns: masking by name says which field was withheld without leaking a
 * prefix of its value.
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
  /** The frame as it went on or came off the wire, already interpolated. */
  payload: string;
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
  const bytes = Buffer.byteLength(input.payload, 'utf8');
  const entry: WebsocketTranscriptEntry = {
    direction: input.direction,
    offset_ms: input.offset_ms,
    bytes,
  };
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
    entry.payload = bytes > cap ? input.payload.slice(0, cap) : input.payload;
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
    truncated: stopReason === 'count' || stopReason === 'timeout' || stopReason === 'bytes',
  };
}
