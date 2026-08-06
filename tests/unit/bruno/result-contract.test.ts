import type { RequestExecutionResult } from '../../../src/bruno/types.js';

/**
 * The collision this contract exists to avoid: `status: 0` is the refusal
 * sentinel on every kind, and gRPC's OK code is also 0. Mapping the gRPC code
 * onto `status` would make a successful call and a security refusal identical in
 * the field an agent reads first.
 */
describe('the result contract keeps gRPC status out of the http status field', () => {
  const grpcOk: RequestExecutionResult = {
    name: 'Streamer',
    method: 'GRPC',
    url: 'grpc://localhost:50051',
    status: 0,
    duration_ms: 12,
    tests: [],
    grpc: { code: 0, details: 'OK' },
  };

  const ssrfRefused: RequestExecutionResult = {
    name: 'Streamer',
    method: 'GRPC',
    url: 'grpc://169.254.169.254:50051',
    status: 0,
    duration_ms: 0,
    tests: [],
    error: 'Blocked: link-local address',
  };

  it('gives both the same status, which is exactly why status alone cannot decide', () => {
    expect(grpcOk.status).toBe(ssrfRefused.status);
  });

  it('distinguishes them by whether the call produced a gRPC outcome at all', () => {
    expect(grpcOk.grpc).toBeDefined();
    expect(ssrfRefused.grpc).toBeUndefined();
  });

  it('carries the gRPC code in its own field, where 0 means OK', () => {
    expect(grpcOk.grpc?.code).toBe(0);
    expect(grpcOk.grpc?.details).toBe('OK');
  });

  it('reports a failing call by its gRPC code rather than a generic error', () => {
    const notFound: RequestExecutionResult = {
      ...grpcOk,
      grpc: { code: 5, details: 'NOT_FOUND' },
    };
    expect(notFound.grpc?.code).toBe(5);
    expect(notFound.error).toBeUndefined();
  });
});

describe('the websocket detail records its own bound', () => {
  it('names which bound stopped collection and whether the transcript is partial', () => {
    const recorded: RequestExecutionResult = {
      name: 'Socket',
      method: 'WS',
      url: 'ws://localhost:8080',
      status: 0,
      duration_ms: 5000,
      tests: [],
      websocket: {
        transcript: [
          { direction: 'sent', offset_ms: 1, bytes: 12 },
          { direction: 'received', offset_ms: 4, bytes: 30 },
        ],
        stop_reason: 'count',
        truncated: true,
      },
    };
    expect(recorded.websocket?.stop_reason).toBe('count');
    expect(recorded.websocket?.truncated).toBe(true);
    expect(recorded.websocket?.transcript).toHaveLength(2);
  });

  // Payload is opt-in: outbound frames are recorded after interpolation, so a
  // default-on payload would write supplied secrets into a surfaced result.
  it('omits payloads by default, keeping direction and byte length', () => {
    const entry = { direction: 'sent' as const, offset_ms: 1, bytes: 12 };
    expect(entry).not.toHaveProperty('payload');
    expect(entry.bytes).toBe(12);
  });
});

describe('an existing HTTP result is unaffected', () => {
  it('still needs only the original fields', () => {
    const http: RequestExecutionResult = {
      name: 'Get user',
      method: 'GET',
      url: 'http://example.test/u',
      status: 200,
      duration_ms: 9,
      tests: [],
    };
    expect(http.status).toBe(200);
    expect(http.grpc).toBeUndefined();
    expect(http.websocket).toBeUndefined();
  });
});
