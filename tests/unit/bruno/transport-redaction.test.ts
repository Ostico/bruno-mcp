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

  // A CSRF or XSRF token is a credential for the next request, and one arriving
  // on a WebSocket upgrade or in gRPC metadata is written into the result and
  // into any report the run was asked for.
  it.each([
    'xsrf-token',
    'x-xsrf-token',
    'csrf-token',
    'x-csrf-token',
    'x-amz-security-token',
  ])('masks %s while keeping the name', (name) => {
    expect(redactMetadata({ [name]: 'eyJhbGciOiJIUzI1NiJ9.token' })).toEqual({
      [name]: REDACTED,
    });
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

  // The cumulative ceiling used to be enforced only by the caller's stop check,
  // which runs after the entry is appended — so a single frame arriving under a
  // small budget was recorded whole. Measured against the live service: a
  // 100-byte budget held a 1968-byte payload, twenty times over.
  describe('the cumulative ceiling clips the payload, not just the session', () => {
    it('keeps one oversized frame within the whole-transcript budget', () => {
      const entry = toTranscriptEntry(
        { direction: 'received', offset_ms: 1, payload: 'q'.repeat(2000) },
        { includePayloads: true, maxTranscriptBytes: 100 },
      );
      expect(entry.payload).toHaveLength(100);
      // Still the honest number: something 2000 bytes long really did arrive.
      expect(entry.bytes).toBe(2000);
    });

    it('clips to what is LEFT of the budget, not to the whole of it', () => {
      const first = toTranscriptEntry(
        { direction: 'sent', offset_ms: 0, payload: 'a'.repeat(60) },
        { includePayloads: true, maxTranscriptBytes: 100 },
      );
      const second = toTranscriptEntry(
        { direction: 'received', offset_ms: 1, payload: 'b'.repeat(500) },
        { includePayloads: true, maxTranscriptBytes: 100 },
        transcriptBytes([first]),
      );
      expect(second.payload).toHaveLength(40);
    });

    it('records no payload at all once the budget is spent', () => {
      const entry = toTranscriptEntry(
        { direction: 'received', offset_ms: 2, payload: 'c'.repeat(500) },
        { includePayloads: true, maxTranscriptBytes: 100 },
        120,
      );
      expect(entry.payload).toBe('');
      expect(entry.bytes).toBe(500);
    });

    it('still lets the smaller per-frame ceiling win when it is the tighter one', () => {
      const entry = toTranscriptEntry(
        { direction: 'received', offset_ms: 1, payload: 'd'.repeat(500) },
        { includePayloads: true, maxFrameBytes: 10, maxTranscriptBytes: 100_000 },
      );
      expect(entry.payload).toHaveLength(10);
    });

    it('leaves a frame that fits untouched', () => {
      const entry = toTranscriptEntry(
        { direction: 'sent', offset_ms: 0, payload: 'short' },
        { includePayloads: true, maxTranscriptBytes: 100 },
      );
      expect(entry.payload).toBe('short');
    });
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

  it('does not mark an idle stop as truncated: the clock budget went unspent', () => {
    expect(toWebsocketDetail([], 'idle').truncated).toBe(false);
  });
});

describe('what a transcript entry records beyond its bytes', () => {
  it('calls a frame text unless told otherwise', () => {
    expect(toTranscriptEntry({ direction: 'received', offset_ms: 1, payload: 'hi' }).type)
      .toBe('text');
  });

  it('carries a title and a close code only when there is one', () => {
    const titled = toTranscriptEntry({
      direction: 'sent',
      offset_ms: 1,
      payload: 'hi',
      title: 'greeting',
    });
    expect(titled.title).toBe('greeting');

    const closed = toTranscriptEntry({
      direction: 'received',
      offset_ms: 2,
      payload: 'bye',
      type: 'close',
      closeCode: 1000,
    });
    expect(closed).toMatchObject({ type: 'close', close_code: 1000 });

    const plain = toTranscriptEntry({ direction: 'received', offset_ms: 3, payload: 'hi' });
    expect('title' in plain).toBe(false);
    expect('close_code' in plain).toBe(false);
  });

  it('reports a supplied wire size rather than the size of an encoding of it', () => {
    // Base64 of three bytes is four characters. The entry has to testify to what
    // arrived, not to what recording it cost.
    const entry = toTranscriptEntry({
      direction: 'received',
      offset_ms: 1,
      payload: 'AP8Q',
      type: 'binary',
      bytes: 3,
    });
    expect(entry.bytes).toBe(3);
  });

  it('holds a base64 payload to the display cap it was recorded under', () => {
    const entry = toTranscriptEntry(
      {
        direction: 'received',
        offset_ms: 1,
        payload: 'AAAAAAAAAAAA',
        type: 'binary',
        bytes: 9,
      },
      { includePayloads: true, maxFrameBytes: 4 },
    );
    // Measured against the recorded payload: a wire size under the cap must not
    // let a longer encoding of it through.
    expect(entry.payload).toBe('AAAA');
    expect(entry.bytes).toBe(9);
  });
});
