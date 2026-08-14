import { bruFileToYamlRequest } from '../../../src/bruno/bru-to-yaml.js';
import { parseBruRequest } from '../../../src/bruno/bru-parser.js';
import { parseYamlRequest } from '../../../src/bruno/yaml-parser.js';

const BRU_GRPC = `meta {
  name: Streamer
  type: grpc
  seq: 1
}

grpc {
  url: grpc://localhost:50051
  method: /pkg.Svc/Method
  body: grpc
  protoPath: ./svc.proto
  auth: bearer
  methodType: unary
}

auth:bearer {
  token: live-token
}

metadata {
  authorization: Bearer live
  ~x-disabled: nope
}

body:grpc {
  name: message 1
  content: '''
    {"id":1}
  '''
}
`;

const YML_GRPC = `info:
  name: Streamer
  type: grpc
  seq: 1
grpc:
  url: grpc://localhost:50051
  method: /pkg.Svc/Method
  protoFilePath: ./svc.proto
  methodType: unary
  auth:
    type: bearer
    token: live-token
  metadata:
    - name: authorization
      value: Bearer live
    - name: x-disabled
      value: nope
      disabled: true
  message:
    - title: message 1
      message: '{"id":1}'
`;

const BRU_WS = `meta {
  name: Socket
  type: ws
  seq: 1
}

ws {
  url: ws://localhost:8080
  body: ws
  auth: none
}

headers {
  authorization: Bearer live
  ~x-off: nope
}

body:ws {
  name: hello
  type: binary
  content: '''
    cGF5
  '''
}
`;

describe('the .bru funnel carries the new kinds into the run model', () => {
  it('carries a gRPC request target, proto path and message content', () => {
    const model = bruFileToYamlRequest(parseBruRequest(BRU_GRPC));
    expect(model.info.type).toBe('grpc');
    expect(model.grpc?.url).toBe('grpc://localhost:50051');
    expect(model.grpc?.method).toBe('/pkg.Svc/Method');
    expect(model.grpc?.protoPath).toBe('./svc.proto');
    expect(model.grpc?.methodType).toBe('unary');
    expect(model.grpc?.messages?.[0].content).toContain('"id":1');
  });

  it('leaves http absent, so the kind refusal in the executor is what answers', () => {
    expect(bruFileToYamlRequest(parseBruRequest(BRU_GRPC)).http).toBeUndefined();
  });

  // `.bru` records enabled:false and leaves it absent when enabled; the run model
  // records disabled:true and leaves it absent when enabled. Forwarding without
  // inverting would re-arm exactly the credential the author switched off.
  it('preserves the disabled flag across the polarity flip', () => {
    expect(bruFileToYamlRequest(parseBruRequest(BRU_GRPC)).grpc?.metadata).toEqual([
      { name: 'authorization', value: 'Bearer live' },
      { name: 'x-disabled', value: 'nope', disabled: true },
    ]);
  });

  // The mode lives in the grpc block and the credential in a separate top-level
  // auth block, exactly as for http. Carrying only the mode — which an earlier
  // draft of this plan called for — would hand applyAuth a bearer scheme with no
  // token.
  it('joins the block mode to the credential from the auth block', () => {
    expect(bruFileToYamlRequest(parseBruRequest(BRU_GRPC)).grpc?.auth).toEqual({
      type: 'bearer',
      token: 'live-token',
    });
  });

  it('carries an unmodelled grpc block key through the funnel', () => {
    const src = BRU_GRPC.replace('  methodType: unary\n', '  methodType: unary\n  reflection: true\n');
    expect(bruFileToYamlRequest(parseBruRequest(src)).grpc?.extra).toEqual({ reflection: 'true' });
  });

  it('carries a WebSocket target, its typed message and its headers', () => {
    const model = bruFileToYamlRequest(parseBruRequest(BRU_WS));
    expect(model.info.type).toBe('ws');
    expect(model.websocket?.url).toBe('ws://localhost:8080');
    // The fixture states no `selected` line, which is how `.bru` says "not selected":
    // its writer emits the line only for a selected message. The run model resolves it
    // to an outright false, so the transport sends nothing for this request.
    expect(model.websocket?.messages).toEqual([
      { name: 'hello', type: 'binary', content: 'cGF5', selected: false },
    ]);
    // WebSocket credentials are ordinary headers, so they arrive from headersList
    // rather than a transport-specific block.
    expect(model.websocket?.headers).toEqual([
      { name: 'authorization', value: 'Bearer live' },
      { name: 'x-off', value: 'nope', disabled: true },
    ]);
  });

  // The other half of the same resolution: a stated flag has to survive it, or the
  // funnel would report every `.bru` message as one to skip and no session would
  // ever send anything.
  it('resolves a stated selected flag to true', () => {
    const src = BRU_WS.replace('  name: hello\n', '  name: hello\n  selected: true\n');
    expect(bruFileToYamlRequest(parseBruRequest(src)).websocket?.messages).toEqual([
      { name: 'hello', type: 'binary', content: 'cGF5', selected: true },
    ]);
  });

  it('does not give a WebSocket request gRPC metadata', () => {
    expect(bruFileToYamlRequest(parseBruRequest(BRU_WS)).grpc).toBeUndefined();
  });

  // gRPC has no `selected` in either dialect, so nothing downstream may require
  // one for it.
  it('gives a gRPC message no selected flag', () => {
    const [message] = bruFileToYamlRequest(parseBruRequest(BRU_GRPC)).grpc?.messages ?? [];
    expect(message).not.toHaveProperty('selected');
  });
});

describe('the two dialects agree on the shared field set', () => {
  // Field-by-field, not a deep equal: `grpc.body` — the mode string — exists only
  // in `.bru`, so an object-level comparison could never pass. This agreement is
  // what lets every execution-side criterion be written once for both dialects.
  const fromBru = bruFileToYamlRequest(parseBruRequest(BRU_GRPC));
  const fromYml = parseYamlRequest(YML_GRPC);

  it.each([
    ['kind', (r: typeof fromBru) => r.info.type],
    ['url', (r: typeof fromBru) => r.grpc?.url],
    ['method', (r: typeof fromBru) => r.grpc?.method],
    ['protoPath', (r: typeof fromBru) => r.grpc?.protoPath],
    ['methodType', (r: typeof fromBru) => r.grpc?.methodType],
    ['auth', (r: typeof fromBru) => r.grpc?.auth],
    ['metadata', (r: typeof fromBru) => r.grpc?.metadata],
    ['message content', (r: typeof fromBru) => r.grpc?.messages?.[0].content],
  ])('agrees on %s', (_name, pick) => {
    expect(pick(fromBru)).toEqual(pick(fromYml));
  });

  it('does not claim to agree on the .bru-only body mode string', () => {
    // Named so a future reader does not "fix" the comparison above into a deep
    // equal and then delete the field to make it pass.
    expect(parseBruRequest(BRU_GRPC).grpc?.body).toBe('grpc');
    expect(fromYml.grpc).not.toHaveProperty('body');
  });
});
