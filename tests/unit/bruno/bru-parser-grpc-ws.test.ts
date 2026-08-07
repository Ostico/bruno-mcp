import { parseBruRequest, collectBruExtra } from '../../../src/bruno/bru-parser.js';

// `body:grpc` is a DICTIONARY block: `name:` / `content:` pairs. Written as a bare
// text block it parses to [{name:'', content:''}] with the content silently
// destroyed and no error, so this fixture shape is load-bearing. There is a test
// below that pins that behaviour so nobody reintroduces the lossy form.
const GRPC = `meta {
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

body:grpc {
  name: message 2
  content: '''
    {"id":2}
  '''
}
`;

const WS = `meta {
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

describe('.bru gRPC parse', () => {
  it('captures every key of the grpc block, the body mode string included', () => {
    const grpc = parseBruRequest(GRPC).grpc;
    expect(grpc?.url).toBe('grpc://localhost:50051');
    expect(grpc?.method).toBe('/pkg.Svc/Method');
    expect(grpc?.protoPath).toBe('./svc.proto');
    expect(grpc?.auth).toBe('bearer');
    expect(grpc?.methodType).toBe('unary');
    // A real field in this dialect, not a derived one: dropping it would rewrite
    // the file without the `body:` line and orphan the message blocks.
    expect(grpc?.body).toBe('grpc');
  });

  it('leaves http absent, so nothing can run it as a GET to an empty URL', () => {
    expect(parseBruRequest(GRPC).http).toBeUndefined();
  });

  // Same convention as `headersList`: `enabled` is recorded only when it is
  // false, so absence means enabled. Writing it both ways would give the
  // generator two spellings of the same state to disagree about.
  it('captures the metadata block, which only gRPC has', () => {
    expect(parseBruRequest(GRPC).metadata).toEqual([
      { name: 'authorization', value: 'Bearer live' },
      { name: 'x-disabled', value: 'nope', enabled: false },
    ]);
  });

  // Count alone is unfalsifiable here: jsonToBru.js:617 writes `content || '{}'`,
  // so two messages whose content was destroyed still round-trip as two blocks.
  it('captures message content, distinct and in file order', () => {
    const messages = parseBruRequest(GRPC).grpc?.messages;
    expect(messages).toHaveLength(2);
    expect(messages?.[0]).toEqual({ name: 'message 1', content: '{"id":1}' });
    expect(messages?.[1]).toEqual({ name: 'message 2', content: '{"id":2}' });
  });

  // Repeated blocks concatenate because bruToJson merges with a concat-arrays
  // customiser, which is why two blocks genuinely yield two entries above.
  it('gives a grpc message no type, because this dialect has none for it', () => {
    expect(parseBruRequest(GRPC).grpc?.messages?.[0]).not.toHaveProperty('type');
  });

  it('carries an unmodelled key of the grpc block, which is a dictionary block', () => {
    const src = GRPC.replace('  methodType: unary\n', '  methodType: unary\n  reflection: true\n');
    expect(parseBruRequest(src).grpc?.extra).toEqual({ reflection: 'true' });
  });

  // The reason the fixtures above use name/content pairs. Kept as a test rather
  // than a comment so the silent-loss form cannot be reintroduced unnoticed.
  it('proves the bare-text block form destroys the content with no error', () => {
    const bare = `meta {
  name: Bare
  type: grpc
  seq: 1
}

grpc {
  url: grpc://h:1
}

body:grpc {
  {"id":1}
}
`;
    expect(parseBruRequest(bare).grpc?.messages).toEqual([{ name: '', content: '' }]);
  });
});

describe('.bru WebSocket parse', () => {
  it('captures the ws block', () => {
    const ws = parseBruRequest(WS).ws;
    expect(ws?.url).toBe('ws://localhost:8080');
    expect(ws?.body).toBe('ws');
    expect(ws?.auth).toBe('none');
  });

  // Dropping `type` would send a binary message as text.
  it('captures each message type', () => {
    expect(parseBruRequest(WS).ws?.messages).toEqual([
      { name: 'hello', type: 'binary', content: 'cGF5' },
    ]);
  });

  // WebSocket credentials arrive in the ordinary headers block, so they are
  // already handled; a second path would write them twice.
  it('reads websocket credentials through headersList, not a ws-specific path', () => {
    const parsed = parseBruRequest(WS);
    expect(parsed.headersList).toEqual([
      { name: 'authorization', value: 'Bearer live' },
      { name: 'x-off', value: 'nope', enabled: false },
    ]);
    expect(parsed.ws).not.toHaveProperty('headers');
    expect(parsed.metadata).toBeUndefined();
  });
});

describe('the top-level passthrough bag', () => {
  const WITH_EXAMPLE = `meta {
  name: X
  type: http
  seq: 1
}

get {
  url: https://api.example.test/
}

example {
  name: e1

  request: {
    url: https://api.example.test/x
    method: get
  }
}
`;

  // Measured both ways: the reader produces `examples` from an `example {}` block
  // and the writer emits it again, so this really is preserved rather than
  // advertised. Before this it was read and then dropped on the next write.
  it('carries examples, the one re-emittable key the model does not name', () => {
    expect(parseBruRequest(WITH_EXAMPLE).extra).toEqual({
      examples: [{ name: 'e1', request: { url: 'https://api.example.test/x', method: 'get' } }],
    });
  });

  it('leaves the bag off a request that has nothing unmodelled', () => {
    expect(parseBruRequest(WS).extra).toBeUndefined();
  });

  // The allowlist is a guard against a future model or grammar change, not a live
  // path: the grammar refuses an unknown top-level block on read (see below). It
  // is tested at the function boundary because that is the only place a key
  // outside the set can be produced at all.
  it('warns instead of carrying a key the writer would drop', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(collectBruExtra({ examples: [1], mystery: { a: 1 } })).toEqual({ examples: [1] });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('mystery'));
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn about a key the model itself writes', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(collectBruExtra({ meta: {}, http: {}, grpc: {}, ws: {} })).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses an unknown top-level block at the grammar, before the bag is reached', () => {
    const src = `meta {
  name: X
  type: http
  seq: 1
}

get {
  url: https://h/
}

mystery {
  a: 1
}
`;
    expect(() => parseBruRequest(src)).toThrow(/Failed to parse \.bru file/);
  });
});
