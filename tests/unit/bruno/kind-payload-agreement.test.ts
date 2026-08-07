/**
 * A request's declared kind and the block carrying its target have to agree.
 *
 * Without this, `type: grpc` plus an `http:` block parses: `read_request`
 * describes the request by one signal while the executor dispatches on another,
 * so a collection can present as a confined internal gRPC call and reach an
 * arbitrary host over HTTP. Our own writer can now produce that shape, which is
 * what makes it worth a refusal rather than a warning — a warning on a run is easy
 * to miss, and this one changes which host is contacted.
 *
 * Three exemptions are load-bearing, and each has a test here. Folders keep their
 * own type token; a graphql request may carry its payload under `http:` (every
 * graphql `.yml` this server wrote before the writer was corrected did); and a
 * `.bru` gRPC file must not be refused, which is only true because the parser no
 * longer synthesises an http block for a kind that has none.
 */
import { parseYamlRequest, parseYamlFolder } from '../../../src/bruno/yaml-parser.js';
import { parseBruRequest } from '../../../src/bruno/bru-parser.js';

const YML_GRPC = `info:
  name: X
  type: grpc
  seq: 1
grpc:
  url: grpc://localhost:50051
`;

const YML_WEBSOCKET = `info:
  name: X
  type: websocket
  seq: 1
websocket:
  url: ws://localhost:8080
`;

const YML_HTTP = `info:
  name: X
  type: http
  seq: 1
http:
  method: get
  url: https://example.test
`;

const YML_GRAPHQL_OWN_BLOCK = `info:
  name: X
  type: graphql
  seq: 1
graphql:
  url: https://example.test/graphql
  body:
    query: '{ me { id } }'
`;

const YML_GRAPHQL_UNDER_HTTP = `info:
  name: X
  type: graphql
  seq: 1
http:
  method: post
  url: https://example.test/graphql
  body:
    type: graphql
    data:
      query: '{ me { id } }'
`;

const BRU_HTTP = `meta {
  name: X
  type: http
  seq: 1
}

get {
  url: https://example.test
}
`;

const BRU_GRAPHQL = `meta {
  name: X
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
`;

const BRU_GRPC = `meta {
  name: X
  type: grpc
  seq: 1
}

grpc {
  url: grpc://localhost:50051
}
`;

const BRU_WS = `meta {
  name: X
  type: ws
  seq: 1
}

ws {
  url: ws://localhost:8080
}
`;

describe('.yml: kind and payload must agree', () => {
  it('refuses a grpc-typed request carrying an http block', () => {
    expect(() => parseYamlRequest(
      'info:\n  name: X\n  type: grpc\n  seq: 1\nhttp:\n  method: get\n  url: http://evil.example\n',
    )).toThrow(/declared grpc.*http/is);
  });

  it('refuses an http-typed request carrying a grpc block', () => {
    expect(() => parseYamlRequest(
      'info:\n  name: X\n  type: http\n  seq: 1\ngrpc:\n  url: grpc://h:1\n',
    )).toThrow(/declared http.*grpc/is);
  });

  it('refuses a websocket-typed request carrying a grpc block', () => {
    expect(() => parseYamlRequest(
      'info:\n  name: X\n  type: websocket\n  seq: 1\nwebsocket:\n  url: ws://h:1\ngrpc:\n  url: grpc://h:1\n',
    )).toThrow(/declared websocket.*grpc/is);
  });

  it('reports a mismatch as a malformed file rather than degrading it', () => {
    // The refusal has to carry the code the tool layer reports as a parse failure:
    // a mismatch is not a runtime condition to warn about, it is a file that
    // cannot be read unambiguously.
    expect(() => parseYamlRequest(
      'info:\n  name: X\n  type: grpc\n  seq: 1\nhttp:\n  method: get\n  url: http://evil.example\n',
    )).toThrow(expect.objectContaining({ code: 'PARSE_ERROR' }));
  });

  it('refuses an unrecognised type token instead of degrading it to a kind', () => {
    expect(() => parseYamlRequest(
      'info:\n  name: X\n  type: gopher\n  seq: 1\nhttp:\n  method: get\n  url: https://h\n',
    )).toThrow(/unknown request type/i);
  });
});

describe('the three exemptions are not collateral damage', () => {
  // parseInfo serves both the request and the folder parser, so a token
  // restriction placed there would reject every folder.yml in existence.
  it('still parses a folder, whose type token is not a request kind', () => {
    expect(parseYamlFolder('info:\n  name: Admin\n  type: folder\n  seq: 2\n').info.name)
      .toBe('Admin');
  });

  it('still parses a graphql request carrying its payload under http', () => {
    const parsed = parseYamlRequest(YML_GRAPHQL_UNDER_HTTP);
    expect(parsed.info.type).toBe('graphql');
    expect(parsed.http?.url).toBe('https://example.test/graphql');
  });

  // True only because the .bru parser no longer synthesises an http block for a
  // kind that has none. If that synthesis came back, every .bru gRPC file would
  // be refused by the check this file is about.
  it('does not refuse a .bru gRPC file', () => {
    expect(parseBruRequest(BRU_GRPC).grpc?.url).toBe('grpc://localhost:50051');
    expect(parseBruRequest(BRU_GRPC).http).toBeUndefined();
  });
});

describe('.bru: kind and payload must agree', () => {
  it('refuses a grpc-typed request carrying a method block', () => {
    const src = BRU_GRPC.replace('grpc {\n  url: grpc://localhost:50051\n}\n',
      'get {\n  url: http://evil.example\n}\n');
    expect(() => parseBruRequest(src)).toThrow(/declared grpc.*http/is);
  });

  it('refuses an http-typed request carrying a grpc block', () => {
    const src = `${BRU_HTTP}\ngrpc {\n  url: grpc://h:1\n}\n`;
    expect(() => parseBruRequest(src)).toThrow(/declared http.*grpc/is);
  });

  it('refuses a ws-typed request carrying a grpc block', () => {
    const src = `${BRU_WS}\ngrpc {\n  url: grpc://h:1\n}\n`;
    expect(() => parseBruRequest(src)).toThrow(/declared ws.*grpc/is);
  });

  it('refuses an unrecognised type token instead of degrading it to a kind', () => {
    expect(() => parseBruRequest(BRU_HTTP.replace('type: http', 'type: gopher')))
      .toThrow(/unknown request type/i);
  });
});

describe('every legitimate kind still parses, in both dialects', () => {
  it.each([
    ['.yml http', () => parseYamlRequest(YML_HTTP)],
    ['.yml graphql', () => parseYamlRequest(YML_GRAPHQL_OWN_BLOCK)],
    ['.yml grpc', () => parseYamlRequest(YML_GRPC)],
    ['.yml websocket', () => parseYamlRequest(YML_WEBSOCKET)],
    ['.bru http', () => parseBruRequest(BRU_HTTP)],
    ['.bru graphql', () => parseBruRequest(BRU_GRAPHQL)],
    ['.bru grpc', () => parseBruRequest(BRU_GRPC)],
    ['.bru ws', () => parseBruRequest(BRU_WS)],
  ])('parses %s', (_name, parse) => {
    expect(parse).not.toThrow();
  });
});
