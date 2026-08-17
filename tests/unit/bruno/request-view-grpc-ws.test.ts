/**
 * `read_request` on a gRPC or WebSocket request has to say what the file holds.
 *
 * These files parse now, so the read tools no longer error on them — which is a
 * silently wrong answer replacing a loud one unless the view carries the new
 * blocks: no method, no url, and no gRPC information at all, on a request that
 * plainly has a target. `type` already carries the kind, so a caller could see
 * `grpc` and nothing else about where it points.
 *
 * The view is asserted equal across dialects from equivalent files, because the
 * whole purpose of this layer is to hide which format the request was authored in.
 */
import { toRequestView } from '../../../src/bruno/request-view.js';
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
  name: m1
  content: {"a":1}
}

body:grpc {
  name: m2
  content: {"b":2}
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
}

body:ws {
  name: hello
  type: binary
  content: cGF5
  selected: true
}
`;

/**
 * The same request with the flag omitted, which `.bru` cannot distinguish from a
 * deliberate `selected: false` — so the runner treats both as not sent, and the
 * view has to report what the runner will do rather than what the file spells.
 */
const BRU_WS_UNSELECTED = `meta {
  name: Socket
  type: ws
  seq: 2
}

ws {
  url: ws://localhost:8080
  body: ws
  auth: none
}

body:ws {
  name: hello
  type: text
  content: hi
}
`;

/**
 * Two messages in each dialect, for the assertion that matters most here: the
 * payloads come back verbatim and in order, so a caller can tell `40` from `4O`
 * without running the request.
 */
const BRU_WS_PAIR = `meta {
  name: Socket
  type: ws
  seq: 2
}

ws {
  url: ws://localhost:8080
  body: ws
  auth: none
}

body:ws {
  name: subscribe
  type: json
  content: {"op":"subscribe","id":40}
  selected: true
}

body:ws {
  name: ping
  type: text
  content: ping
}
`;

const YML_WS_PAIR = `info:
  name: Socket
  type: websocket
  seq: 2
websocket:
  url: ws://localhost:8080
  message:
    - title: subscribe
      selected: true
      message:
        type: json
        data: '{"op":"subscribe","id":40}'
    - title: ping
      selected: false
      message:
        type: text
        data: ping
`;

/**
 * The shape this server's own `.yml` writer emits for a single untitled message:
 * a flat `message:` rather than a list. A reader that only understood the list
 * form would report no messages for a file it had written itself.
 */
const YML_WS_FLAT = `info:
  name: Socket
  type: websocket
  seq: 2
websocket:
  url: ws://localhost:8080
  message:
    type: text
    data: hi
`;

const YML_WS = `info:
  name: Socket
  type: websocket
  seq: 2
websocket:
  url: ws://localhost:8080
  headers:
    - name: authorization
      value: Bearer live
  message:
    - title: hello
      selected: true
      message:
        type: binary
        data: cGF5
`;

const BRU_HTTP = `meta {
  name: Plain
  type: http
  seq: 1
}

get {
  url: https://example.test/one
}
`;

const grpcView = (source: string, format: 'bru' | 'yaml') => (format === 'bru'
  ? toRequestView(parseBruRequest(source), 'bru', 'streamer.bru')
  : toRequestView(parseYamlRequest(source), 'yaml', 'streamer.yml'));

describe('the view shows a gRPC request', () => {
  it.each([
    ['bru', BRU_GRPC],
    ['yaml', YML_GRPC],
  ] as const)('reports the target, method and proto path (%s)', (format, source) => {
    const view = grpcView(source, format);
    expect(view.type).toBe('grpc');
    expect(view.grpc?.url).toBe('grpc://localhost:50051');
    expect(view.grpc?.method).toBe('/pkg.Svc/Method');
    expect(view.grpc?.protoPath).toBe('./svc.proto');
    expect(view.grpc?.methodType).toBe('unary');
  });

  it.each([
    ['bru', BRU_GRPC],
    ['yaml', YML_GRPC],
  ] as const)('reports the stored messages themselves, in order (%s)', (format, source) => {
    expect(grpcView(source, format).grpc?.messages).toEqual([
      { title: 'm1', content: '{"a":1}' },
      { title: 'm2', content: '{"b":2}' },
    ]);
  });

  it.each([
    ['bru', BRU_GRPC],
    ['yaml', YML_GRPC],
  ] as const)('gives a gRPC message no type and no selected flag (%s)', (format, source) => {
    // Neither dialect stores either for gRPC, and reporting a default would
    // invent a fact about the file.
    const first = grpcView(source, format).grpc?.messages[0];
    expect(first).not.toHaveProperty('type');
    expect(first).not.toHaveProperty('selected');
  });

  it.each([
    ['bru', BRU_GRPC],
    ['yaml', YML_GRPC],
  ] as const)('reports the metadata block, disabled flags included (%s)', (format, source) => {
    expect(grpcView(source, format).grpc?.metadata).toEqual([
      { name: 'authorization', value: 'Bearer live' },
      { name: 'x-disabled', value: 'nope', disabled: true },
    ]);
  });

  it('leaves method and url — the http fields — absent', () => {
    const view = grpcView(BRU_GRPC, 'bru');
    expect(view.method).toBeUndefined();
    expect(view.url).toBeUndefined();
  });

  it('gives a WebSocket request no gRPC summary', () => {
    expect(toRequestView(parseBruRequest(BRU_WS), 'bru', 'socket.bru').grpc).toBeUndefined();
  });
});

describe('the view shows a WebSocket request', () => {
  it('reports the target and the messages from a .bru file', () => {
    const view = toRequestView(parseBruRequest(BRU_WS), 'bru', 'socket.bru');
    expect(view.type).toBe('ws');
    expect(view.websocket?.url).toBe('ws://localhost:8080');
    expect(view.websocket?.messages).toEqual([
      { title: 'hello', type: 'binary', content: 'cGF5', selected: true },
    ]);
  });

  it('reports the same from a .yml file, whose token is spelled differently', () => {
    const view = toRequestView(parseYamlRequest(YML_WS), 'yaml', 'socket.yml');
    // `websocket` on disk, `ws` as the kind. The view reports the kind, so a
    // caller matching on it does not have to know both spellings.
    expect(view.type).toBe('ws');
    expect(view.websocket?.url).toBe('ws://localhost:8080');
    expect(view.websocket?.messages).toEqual([
      { title: 'hello', type: 'binary', content: 'cGF5', selected: true },
    ]);
  });

  it.each([
    ['bru', BRU_WS_PAIR, 'socket.bru'],
    ['yaml', YML_WS_PAIR, 'socket.yml'],
  ] as const)('returns both payloads verbatim and in order (%s)', (format, source, path) => {
    const view = format === 'bru'
      ? toRequestView(parseBruRequest(source), 'bru', path)
      : toRequestView(parseYamlRequest(source), 'yaml', path);

    // Byte-level: a caller confirming what it authored has to be able to tell
    // `"id":40` from `"id":4O`, which a count cannot answer.
    expect(view.websocket?.messages).toEqual([
      {
        title: 'subscribe',
        type: 'json',
        content: '{"op":"subscribe","id":40}',
        selected: true,
      },
      { title: 'ping', type: 'text', content: 'ping', selected: false },
    ]);
  });

  it('reads a .bru message with no selected flag back as one the runner will not send', () => {
    const view = toRequestView(parseBruRequest(BRU_WS_UNSELECTED), 'bru', 'socket.bru');
    expect(view.websocket?.messages).toEqual([
      { title: 'hello', type: 'text', content: 'hi', selected: false },
    ]);
  });

  it('reads the flat single-message .yml shape this server writes', () => {
    const view = toRequestView(parseYamlRequest(YML_WS_FLAT), 'yaml', 'socket.yml');
    // Untitled, so no title key — and selected, because a `.yml` message is sent
    // unless it says otherwise.
    expect(view.websocket?.messages).toEqual([
      { type: 'text', content: 'hi', selected: true },
    ]);
  });

  it('shows its credentials as ordinary headers, not as metadata', () => {
    const fromBru = toRequestView(parseBruRequest(BRU_WS), 'bru', 'socket.bru');
    expect(fromBru.headers).toEqual([{ name: 'authorization', value: 'Bearer live' }]);
    expect(fromBru.websocket).not.toHaveProperty('metadata');
  });
});

describe('both dialects produce the same view', () => {
  it('agrees on the whole gRPC summary', () => {
    expect(grpcView(BRU_GRPC, 'bru').grpc).toEqual(grpcView(YML_GRPC, 'yaml').grpc);
  });

  it('agrees on the whole WebSocket summary', () => {
    expect(toRequestView(parseBruRequest(BRU_WS), 'bru', 'a').websocket)
      .toEqual(toRequestView(parseYamlRequest(YML_WS), 'yaml', 'b').websocket);
  });

  // The dialects store a WebSocket request's headers in different places — `.bru`
  // in the top-level headers block, `.yml` nested inside the websocket block — so
  // this agreement is the one that had actually been broken: the `.yml` side read
  // back with no headers at all while the `.bru` side showed them.
  it('agrees on a WebSocket request’s headers, which the two dialects nest differently', () => {
    const expected = [{ name: 'authorization', value: 'Bearer live' }];
    expect(toRequestView(parseBruRequest(BRU_WS), 'bru', 'a').headers).toEqual(expected);
    expect(toRequestView(parseYamlRequest(YML_WS), 'yaml', 'b').headers).toEqual(expected);
  });
});

describe('an http request is untouched by this', () => {
  it('gains neither summary', () => {
    const view = toRequestView(parseBruRequest(BRU_HTTP), 'bru', 'plain.bru');
    expect(view).not.toHaveProperty('grpc');
    expect(view).not.toHaveProperty('websocket');
  });

  it('still reports its method and url', () => {
    const view = toRequestView(parseBruRequest(BRU_HTTP), 'bru', 'plain.bru');
    expect(view.method).toBe('GET');
    expect(view.url).toBe('https://example.test/one');
  });

  // The key set, not a snapshot file: what has to hold is that this task added no
  // key to a view that has no such block, and a key list says that directly.
  it.each([
    ['http', BRU_HTTP],
    ['graphql', `meta {
  name: Q
  type: graphql
  seq: 1
}

post {
  url: https://example.test/graphql
  body: graphql
}

body:graphql {
  { me { id } }
}
`],
  ])('has the same keys as before for a %s request', (_kind, source) => {
    const keys = Object.keys(toRequestView(parseBruRequest(source), 'bru', 'x.bru'));
    expect(keys).not.toContain('grpc');
    expect(keys).not.toContain('websocket');
    // Every key an http view has is one it had before this task. Listed rather
    // than counted, so an accidental addition names itself.
    expect(keys.sort()).toEqual(expect.arrayContaining([
      'assert', 'auth', 'filePath', 'format', 'headers', 'method', 'name',
      'notes', 'params', 'scripts', 'seq', 'settings', 'type', 'url', 'vars',
    ]));
    expect(keys.filter((k) => ![
      'assert', 'auth', 'body', 'filePath', 'format', 'headers', 'method', 'name',
      'notes', 'params', 'scripts', 'seq', 'settings', 'tags', 'docs', 'type', 'url', 'vars',
    ].includes(k))).toEqual([]);
  });
});
