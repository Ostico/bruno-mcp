import { parseBruRequest } from '../../../src/bruno/bru-parser.js';
import { bruFileToYamlRequest } from '../../../src/bruno/bru-to-yaml.js';
import { parseYamlFolder } from '../../../src/bruno/yaml-parser.js';
import { generateYamlRequest } from '../../../src/bruno/yaml-generator.js';
import {
  BRU_TYPE_TOKENS,
  YAML_TYPE_TOKENS,
  YAML_TOKEN_FOR_KIND,
  BrunoError,
} from '../../../src/bruno/types.js';

const WS_BRU = `meta {
  name: Socket
  type: ws
  seq: 1
}

ws {
  url: ws://localhost:8080
}
`;

const GRPC_BRU = `meta {
  name: Streamer
  type: grpc
  seq: 1
}

grpc {
  url: grpc://localhost:50051
  method: /pkg.Svc/Method
}
`;

describe('the request-kind union', () => {
  it('keeps the .bru ws token as the ws kind rather than flattening it to http', () => {
    expect(parseBruRequest(WS_BRU).meta.type).toBe('ws');
  });

  it('keeps the .bru grpc token as the grpc kind', () => {
    expect(parseBruRequest(GRPC_BRU).meta.type).toBe('grpc');
  });

  // The two dialects disagree on the token for one kind: `.bru` writes `ws`,
  // `.yml` writes `websocket`. The token belongs at the edges; everything in
  // between speaks the kind.
  it('translates the dialect tokens in both directions', () => {
    expect(BRU_TYPE_TOKENS.ws).toBe('ws');
    expect(YAML_TYPE_TOKENS.websocket).toBe('ws');
    expect(YAML_TOKEN_FOR_KIND.ws).toBe('websocket');
    expect(YAML_TOKEN_FOR_KIND.grpc).toBe('grpc');
  });
});

describe('a non-http kind carries no http block', () => {
  it('does not synthesize an http block when parsing .bru', () => {
    expect(parseBruRequest(GRPC_BRU).http).toBeUndefined();
  });

  // Built from a real parse, deliberately: `tsconfig.json` excludes `tests/`, so
  // an `as never` cast would never be type-checked and the assertion would be
  // about a shape no parser can produce.
  //
  // Routed through the .bru parser rather than the .yml one because that is where
  // the model in this file comes from. This is enough to prove the generator no
  // longer fabricates a block, which is the claim here.
  it('does not emit an http key when generating a kind that has none', () => {
    const model = bruFileToYamlRequest(parseBruRequest(GRPC_BRU));
    expect(model.http).toBeUndefined();

    const generated = generateYamlRequest(model);
    expect(generated).not.toContain('http:');
    // A `method:` key is no longer a proxy for a fabricated http block. When this
    // test was written nothing could write a grpc block, so any `method:` in the
    // output had to be an http one; now the gRPC method name is written where it
    // belongs, and the claim has to be made against the block itself.
    expect(generated).toContain('grpc:');
    expect(generated).toMatch(/grpc:\n(?: +.*\n)* +method: \/pkg\.Svc\/Method\n/);
    expect(generated).toContain('name: Streamer');
  });
});

describe('collateral damage checks', () => {
  it('still parses a folder, whose info.type is not a request kind', () => {
    const folder = parseYamlFolder('info:\n  name: Admin\n  type: folder\n  seq: 2\n');
    expect(folder.info.name).toBe('Admin');
    expect(folder.info.type).toBe('folder');
  });

  it('reports an unrecognised type token as malformed rather than degrading it', () => {
    expect(() =>
      parseBruRequest('meta {\n  name: X\n  type: qwerty\n  seq: 1\n}\n\nget {\n  url: http://h\n}\n'),
    ).toThrow(BrunoError);
  });
});
