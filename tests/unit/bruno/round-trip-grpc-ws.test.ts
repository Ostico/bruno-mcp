/**
 * A gRPC or WebSocket request has to survive a read-modify-write in both dialects.
 *
 * Nothing here asserts byte-identity, and that is deliberate. Measured: even a
 * correctly shaped, correctly ordered `.bru` fixture does not come back unchanged
 * — the writer rewrites a single-line `content:` into `'''` multiline form and
 * reorders `body:ws` keys to `name, type, content`, on top of the fixed block key
 * orders the grammar imposes. So every assertion here re-parses and compares the
 * model. Comparing bytes would fail on a correct writer and pass on a writer that
 * merely echoed its input.
 *
 * Message assertions look at CONTENT, never at count alone. `jsonToBru.js:617`
 * writes `content || '{}'`, so two messages whose content was destroyed still
 * round-trip as two blocks holding `{}` — a count assertion passes on total data
 * loss.
 */
import { parseBruRequest, generateBruRequest } from '../../../src/bruno/bru-parser.js';
import { parseYamlRequest } from '../../../src/bruno/yaml-parser.js';
import { generateYamlRequest } from '../../../src/bruno/yaml-generator.js';

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
  name: m1
  content: {"a":1}
}

body:grpc {
  name: m2
  content: {"b":2}
}
`;

const BRU_WS = `meta {
  name: Socket
  type: ws
  seq: 2
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
  content: cGF5
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
    - title: m1
      message: '{"a":1}'
    - title: m2
      message: '{"b":2}'
  reflection: true
`;

const YML_WEBSOCKET = `info:
  name: Socket
  type: websocket
  seq: 2
websocket:
  url: ws://localhost:8080
  auth:
    type: basic
    username: u
    password: p
  headers:
    - name: authorization
      value: Bearer live
    - name: x-off
      value: nope
      disabled: true
  message:
    - title: hello
      selected: false
      message:
        type: binary
        data: cGF5
  subprotocols:
    - graphql-ws
`;

const reparseBru = (source: string) => parseBruRequest(generateBruRequest(parseBruRequest(source)));
const reparseYaml = (source: string) => parseYamlRequest(generateYamlRequest(parseYamlRequest(source)));

describe('.bru round trip for the new kinds', () => {
  it('does not fabricate an http block for a grpc request', () => {
    const out = generateBruRequest(parseBruRequest(BRU_GRPC));
    expect(out).not.toContain('get {');
    expect(out).not.toContain('http {');
    expect(out).toContain('grpc {');
    expect(out).toContain('grpc://localhost:50051');
  });

  it('keeps message content and order across a round trip', () => {
    const messages = reparseBru(BRU_GRPC).grpc?.messages ?? [];
    expect(messages.map((m) => m.name)).toEqual(['m1', 'm2']);
    expect(messages[0].content).toContain('"a":1');
    expect(messages[1].content).toContain('"b":2');
  });

  it('keeps the target, method and proto path', () => {
    const grpc = reparseBru(BRU_GRPC).grpc;
    expect(grpc?.url).toBe('grpc://localhost:50051');
    expect(grpc?.method).toBe('/pkg.Svc/Method');
    expect(grpc?.protoPath).toBe('./svc.proto');
    expect(grpc?.methodType).toBe('unary');
  });

  it('keeps a disabled metadata entry disabled', () => {
    // The `~` prefix is how the dialect spells it, so the bytes are checked here
    // as well as the model: an entry written without the prefix is a credential
    // the author switched off and the file re-arms.
    expect(generateBruRequest(parseBruRequest(BRU_GRPC))).toContain('~x-disabled');
    expect(reparseBru(BRU_GRPC).metadata).toEqual([
      { name: 'authorization', value: 'Bearer live' },
      { name: 'x-disabled', value: 'nope', enabled: false },
    ]);
  });

  it('keeps the auth mode on the block and the credential in its own block', () => {
    const reparsed = reparseBru(BRU_GRPC);
    expect(reparsed.grpc?.auth).toBe('bearer');
    expect(reparsed.auth?.bearer?.token).toBe('live-token');
  });

  it('keeps a websocket target, its headers and each message type', () => {
    const reparsed = reparseBru(BRU_WS);
    expect(reparsed.ws?.url).toBe('ws://localhost:8080');
    expect(reparsed.headersList).toEqual([
      { name: 'authorization', value: 'Bearer live' },
      { name: 'x-off', value: 'nope', enabled: false },
    ]);
    expect(reparsed.ws?.messages).toEqual([
      { name: 'hello', type: 'binary', content: 'cGF5' },
    ]);
  });
});

describe('.yml round trip for the new kinds', () => {
  it('writes protoPath back under the name the file uses', () => {
    const written = generateYamlRequest(parseYamlRequest(YML_GRPC));
    expect(written).toContain('protoFilePath: ./svc.proto');
    // The model's own spelling must not reach the file: Bruno's gRPC parser does
    // not read it, so the proto file would be forgotten on the next open.
    expect(written).not.toContain('protoPath:');
  });

  it('keeps message content and order across a round trip', () => {
    const messages = reparseYaml(YML_GRPC).grpc?.messages ?? [];
    expect(messages.map((m) => m.name)).toEqual(['m1', 'm2']);
    expect(messages[0].content).toBe('{"a":1}');
    expect(messages[1].content).toBe('{"b":2}');
  });

  it('keeps the whole grpc block, unmodelled key included', () => {
    expect(reparseYaml(YML_GRPC).grpc).toEqual(parseYamlRequest(YML_GRPC).grpc);
  });

  it('keeps a websocket message nested, typed and explicitly unselected', () => {
    const messages = reparseYaml(YML_WEBSOCKET).websocket?.messages ?? [];
    expect(messages).toEqual([
      { name: 'hello', type: 'binary', content: 'cGF5', selected: false },
    ]);
  });

  it('does not read a websocket payload the gRPC way', () => {
    // The two shapes differ upstream: gRPC holds the payload as a bare string,
    // WebSocket nests it as {type, data}. Serialising a nested payload as a bare
    // string puts "[object Object]" on disk, which this is here to catch.
    const written = generateYamlRequest(parseYamlRequest(YML_WEBSOCKET));
    expect(written).not.toContain('[object Object]');
    expect(written).toContain('data: cGF5');
  });

  it('keeps the whole websocket block, unmodelled key included', () => {
    expect(reparseYaml(YML_WEBSOCKET).websocket).toEqual(parseYamlRequest(YML_WEBSOCKET).websocket);
  });

  it('writes the kind token the file uses, not the model kind', () => {
    expect(generateYamlRequest(parseYamlRequest(YML_WEBSOCKET))).toContain('type: websocket');
  });
});
