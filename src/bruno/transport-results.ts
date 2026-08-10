/**
 * Per-transport result detail for the kinds whose outcome is not HTTP-shaped.
 *
 * Kept out of `types.ts` for two reasons: that file is at its `max-lines` ceiling,
 * and these shapes belong next to the transports that produce them rather than in
 * the shared model. `RequestExecutionResult` references them from there.
 */

/** A gRPC call's own outcome, which does not fit the HTTP-shaped fields. */
export interface GrpcResultDetail {
  /**
   * The gRPC status code. Kept HERE and never mapped onto the result's `status`,
   * because gRPC's OK is 0 and 0 is that field's refusal sentinel — a successful
   * call and a security refusal would otherwise be indistinguishable in the field
   * an agent reads first.
   */
  code: number;
  details: string;
  /** Trailing metadata, with credential-bearing entries masked by name. */
  trailers?: Record<string, string>;
}

/**
 * What kind of frame a transcript entry records.
 *
 * `text` and `binary` are the data frames a session is about; `ping`, `pong` and
 * `close` are control frames, which carry no application payload and are excluded
 * from the inbound message count for that reason. A caller that reads only
 * `direction` cannot tell an answer apart from a keepalive.
 */
export type WebsocketFrameType = 'text' | 'binary' | 'ping' | 'pong' | 'close';

/** One recorded frame of a WebSocket session. */
export interface WebsocketTranscriptEntry {
  direction: 'sent' | 'received';
  /** Milliseconds after the socket opened, so ordering survives serialisation. */
  offset_ms: number;
  bytes: number;
  /**
   * The frame's kind. Also states how to read `payload`: a `binary` frame's
   * payload is base64, because the bytes of one are not text and decoding them as
   * UTF-8 would replace every invalid sequence and report a size that never went
   * over the wire. `bytes` is always the true wire size.
   */
  type: WebsocketFrameType;
  /**
   * The name the request gave this message, on frames the session sent. A file
   * usually authors several, and without their names a transcript of four
   * outbound frames says nothing about which one is which.
   */
  title?: string;
  /**
   * The close code, on a `close` entry only. Reported unconditionally, unlike the
   * payload, because it is the whole diagnosis: 1000 is an ordinary goodbye, 1006
   * means the peer vanished without one, 1008 and 1011 are a refusal and a server
   * error. The reason string that accompanies it is the frame's payload and is
   * gated with every other payload.
   */
  close_code?: number;
  /**
   * Present only when payload recording was explicitly enabled. Off by default:
   * outbound frames are recorded AFTER `{{var}}` interpolation, so a transcript
   * that included them by default would write every supplied secret into a result
   * that is surfaced by default.
   */
  payload?: string;
}

/** A recorded WebSocket session's own outcome. */
export interface WebsocketResultDetail {
  transcript: WebsocketTranscriptEntry[];
  /**
   * Which bound ended collection: the message count, the timeout, the byte cap,
   * or `idle` for a session that went quiet before any of them was reached.
   */
  stop_reason: 'count' | 'timeout' | 'bytes' | 'closed' | 'error' | 'idle';
  /**
   * True when a bound cut the recording short, so a reader cannot mistake a
   * partial transcript for the whole session.
   */
  truncated: boolean;
}
