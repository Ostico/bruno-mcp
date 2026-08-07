import {
  redactMetadata,
  toTranscriptEntry,
  transcriptBytes,
  transcriptCapReached,
  toWebsocketDetail,
  REDACTED,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_TRANSCRIPT_BYTES,
} from '../../../src/bruno/transport-redaction.js';

describe('redactMetadata', () => {
  it('masks the value and keeps the key, so the reader knows a credential was sent', () => {
    expect(redactMetadata({ authorization: 'Bearer live-token' })).toEqual({
      authorization: REDACTED,
    });
  });

  it('leaves a non-credential entry alone', () => {
    expect(redactMetadata({ 'x-request-id': 'abc123' })).toEqual({ 'x-request-id': 'abc123' });
  });

  it('matches case-insensitively', () => {
    expect(redactMetadata({ Authorization: 'Bearer x' })).toEqual({ Authorization: REDACTED });
  });

  // Auth may be applied under a header the collection named itself, so the
  // standard list alone is not enough.
  it('masks a caller-named credential header too', () => {
    expect(redactMetadata({ 'x-tenant-key': 'sekret' }, ['X-Tenant-Key'])).toEqual({
      'x-tenant-key': REDACTED,
    });
  });

  it('passes undefined through', () => {
    expect(redactMetadata(undefined)).toBeUndefined();
  });
});

describe('the transcript does not leak an interpolated secret', () => {
  const SENTINEL = 'S3CRET-SENTINEL-VALUE';

  // The decisive assertion for this module. Outbound frames are recorded AFTER
  // {{var}} interpolation, and run_collection documents `variables` as the only
  // correct way to supply a secret — so a default-on payload would write it into a
  // result that is surfaced by default.
  it('omits payloads by default, keeping direction and byte length', () => {
    const entry = toTranscriptEntry({
      direction: 'sent',
      offset_ms: 3,
      payload: `{"token":"${SENTINEL}"}`,
    });
    expect(entry.payload).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain(SENTINEL);
    expect(entry.bytes).toBeGreaterThan(0);
    expect(entry.direction).toBe('sent');
  });

  it('records the payload once the caller explicitly opts in', () => {
    const entry = toTranscriptEntry(
      { direction: 'sent', offset_ms: 3, payload: `{"token":"${SENTINEL}"}` },
      { includePayloads: true },
    );
    expect(entry.payload).toContain(SENTINEL);
  });

  it('counts wire bytes even when the payload is not recorded', () => {
    const payload = 'x'.repeat(100);
    expect(toTranscriptEntry({ direction: 'received', offset_ms: 1, payload }).bytes).toBe(100);
  });
});

describe('frame and transcript ceilings', () => {
  it('does not leave the per-frame ceiling at the ws library default', () => {
    // ws defaults maxPayload to 100 MB; 50 frames of that is a 5 GB transcript.
    expect(DEFAULT_MAX_FRAME_BYTES).toBeLessThan(100 * 1024 * 1024);
    expect(DEFAULT_MAX_TRANSCRIPT_BYTES).toBeLessThan(100 * 1024 * 1024);
  });

  it('truncates an oversized frame rather than dropping it', () => {
    const entry = toTranscriptEntry(
      { direction: 'received', offset_ms: 1, payload: 'y'.repeat(200) },
      { includePayloads: true, maxFrameBytes: 50 },
    );
    // The recorded payload is capped, but `bytes` still reports what arrived, so
    // the entry testifies to the real size.
    expect(entry.payload).toHaveLength(50);
    expect(entry.bytes).toBe(200);
  });

  it('sums wire bytes across the transcript', () => {
    const entries = [
      toTranscriptEntry({ direction: 'sent', offset_ms: 0, payload: 'a'.repeat(10) }),
      toTranscriptEntry({ direction: 'received', offset_ms: 1, payload: 'b'.repeat(15) }),
    ];
    expect(transcriptBytes(entries)).toBe(25);
  });

  it('reports the cumulative cap independently of the count and timeout bounds', () => {
    const entries = [
      toTranscriptEntry({ direction: 'received', offset_ms: 1, payload: 'z'.repeat(120) }),
    ];
    expect(transcriptCapReached(entries, { maxTranscriptBytes: 100 })).toBe(true);
    expect(transcriptCapReached(entries, { maxTranscriptBytes: 1000 })).toBe(false);
  });
});

describe('toWebsocketDetail', () => {
  it.each(['count', 'timeout', 'bytes'] as const)(
    'marks the transcript truncated when the %s bound bit',
    (reason) => {
      const detail = toWebsocketDetail([], reason);
      expect(detail.stop_reason).toBe(reason);
      expect(detail.truncated).toBe(true);
    },
  );

  it('does not mark a naturally closed session as truncated', () => {
    expect(toWebsocketDetail([], 'closed').truncated).toBe(false);
  });

  it('does not mark an errored session as truncated, since a bound did not cut it', () => {
    expect(toWebsocketDetail([], 'error').truncated).toBe(false);
  });
});
