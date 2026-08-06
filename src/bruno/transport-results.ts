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

/** One recorded frame of a WebSocket session. */
export interface WebsocketTranscriptEntry {
  direction: 'sent' | 'received';
  /** Milliseconds after the socket opened, so ordering survives serialisation. */
  offset_ms: number;
  bytes: number;
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
  /** Which bound ended collection: the message count, the timeout, or the byte cap. */
  stop_reason: 'count' | 'timeout' | 'bytes' | 'closed' | 'error';
  /**
   * True when a bound cut the recording short, so a reader cannot mistake a
   * partial transcript for the whole session.
   */
  truncated: boolean;
}
