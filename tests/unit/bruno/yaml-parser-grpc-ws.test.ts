import { parseYamlRequest } from '../../../src/bruno/yaml-parser.js';
import { generateYamlRequest } from '../../../src/bruno/yaml-generator.js';
import { BrunoError } from '../../../src/bruno/types.js';

const GRPC = `info:
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
      value: Bearer x
  message:
    - title: first
      message: '{"id":1}'
    - title: second
      message: '{"id":2}'
`;

const WEBSOCKET = `info:
  name: Socket
  type: websocket
  seq: 1
websocket:
  url: ws://localhost:8080
  headers:
    - name: x-tenant-key
      value: sekret
      disabled: true
  message:
    - title: hello
      selected: false
      message:
        type: text
        data: '{"op":"subscribe"}'
`;

describe('parseYamlRequest for the new kinds', () => {
  it('parses a grpc request and normalises protoFilePath to protoPath', () => {
    const parsed = parseYamlRequest(GRPC);
    expect(parsed.info.type).toBe('grpc');
    expect(parsed.grpc?.url).toBe('grpc://localhost:50051');
    expect(parsed.grpc?.method).toBe('/pkg.Svc/Method');
    expect(parsed.grpc?.protoPath).toBe('./svc.proto');
    expect(parsed.grpc?.methodType).toBe('unary');
  });

  // `protoFilePath` is the on-disk key and `protoPath` the model's; keeping both
  // would let a writer emit the same path twice under two names.
  it('does not keep the on-disk protoFilePath name on the model', () => {
    expect(parseYamlRequest(GRPC).grpc).not.toHaveProperty('protoFilePath');
  });

  it('carries grpc metadata with the disabled polarity the dialect uses', () => {
    const parsed = parseYamlRequest(GRPC);
    expect(parsed.grpc?.metadata).toEqual([{ name: 'authorization', value: 'Bearer x' }]);
  });

  // The plan drafted `auth` as a bare mode string, which is right for `.bru` and
  // lossy for `.yml`: the credential lives in the same object as the mode, so
  // keeping only the mode would drop the token on the next write.
  it('keeps the whole .yml auth object, not just the mode', () => {
    const auth = parseYamlRequest(GRPC).grpc?.auth;
    expect(auth).toEqual({ type: 'bearer', token: 'live-token' });
  });

  it('reads grpc messages from the singular `message` key as title/message variants', () => {
    const messages = parseYamlRequest(GRPC).grpc?.messages;
    expect(messages).toEqual([
      { name: 'first', content: '{"id":1}' },
      { name: 'second', content: '{"id":2}' },
    ]);
  });

  // Upstream accepts a bare string in place of the variant list.
  it('reads a bare-string grpc message as a single unnamed message', () => {
    const parsed = parseYamlRequest(
      'info:\n  name: S\n  type: grpc\n  seq: 1\ngrpc:\n  url: grpc://h:1\n  message: \'{"id":9}\'\n',
    );
    expect(parsed.grpc?.messages).toEqual([{ name: '', content: '{"id":9}' }]);
  });

  it('parses a websocket request under the websocket token', () => {
    const parsed = parseYamlRequest(WEBSOCKET);
    expect(parsed.info.type).toBe('ws');
    expect(parsed.websocket?.url).toBe('ws://localhost:8080');
  });

  // WebSocket carries its credentials in the ordinary headers block; only gRPC
  // has metadata. Dropping `disabled` would re-arm a disabled credential header.
  it('carries websocket headers including the disabled flag', () => {
    expect(parseYamlRequest(WEBSOCKET).websocket?.headers).toEqual([
      { name: 'x-tenant-key', value: 'sekret', disabled: true },
    ]);
  });

  // A websocket variant nests its payload one level deeper than a grpc one:
  // `message: {type, data}` rather than a bare string.
  it('reads a websocket message from the nested type/data pair', () => {
    expect(parseYamlRequest(WEBSOCKET).websocket?.messages).toEqual([
      { name: 'hello', type: 'text', content: '{"op":"subscribe"}', selected: false },
    ]);
  });

  it('preserves selected: false rather than treating it as absent', () => {
    const [message] = parseYamlRequest(WEBSOCKET).websocket?.messages ?? [];
    expect(message?.selected).toBe(false);
  });

  it('reads a flat single websocket message with no variant wrapper', () => {
    const parsed = parseYamlRequest(
      'info:\n  name: S\n  type: websocket\n  seq: 1\nwebsocket:\n  url: ws://h:1\n  message:\n    type: binary\n    data: cGF5\n',
    );
    expect(parsed.websocket?.messages).toEqual([
      { name: '', type: 'binary', content: 'cGF5' },
    ]);
  });

  it('still throws PARSE_ERROR for a document with no target block at all', () => {
    expect(() => parseYamlRequest('info:\n  name: Nothing\n  seq: 1\n')).toThrow(BrunoError);
    try {
      parseYamlRequest('info:\n  name: Nothing\n  seq: 1\n');
    } catch (error) {
      expect((error as BrunoError).code).toBe('PARSE_ERROR');
    }
  });

  it('rejects a kind token the dialect does not define', () => {
    expect(() =>
      parseYamlRequest('info:\n  name: S\n  type: telnet\n  seq: 1\nhttp:\n  url: http://h\n'),
    ).toThrow(/telnet/);
  });
});

describe('the block is modelled, so the passthrough bag no longer carries it', () => {
  // The redundancy these two tests used to assert was deliberate and temporary: it
  // was what kept a .yml gRPC or WebSocket request intact while the blocks were
  // parsed but unwritable. The generator emits them now, so a bag still holding
  // them would write each block twice.
  it('keeps grpc out of extra now that the generator writes it', () => {
    const parsed = parseYamlRequest(GRPC);
    expect(parsed.grpc?.url).toBe('grpc://localhost:50051');
    expect(parsed.extra ?? {}).not.toHaveProperty('grpc');
  });

  it('keeps websocket out of extra now that the generator writes it', () => {
    expect(parseYamlRequest(WEBSOCKET).extra ?? {}).not.toHaveProperty('websocket');
  });

  // The block is written from the model rather than from the bag, so the round
  // trip has to keep it — and the file spelling has to be restored on the way out.
  it('round-trips a grpc block through the generator from the model', () => {
    const written = generateYamlRequest(parseYamlRequest(GRPC));
    expect(written).toContain('grpc://localhost:50051');
    expect(written).toContain('protoFilePath: ./svc.proto');
    // Once, not twice: the bag emitting the same block again would be invisible to
    // a `toContain` assertion.
    expect(written.match(/^grpc:$/gm)).toHaveLength(1);
  });
});

describe('info.type is written back as the wire token', () => {
  // The model's kind for a WebSocket request is `ws`; the `.yml` token is
  // `websocket`. Writing the model's name would produce a file Bruno dispatches
  // to no parser at all.
  it('writes websocket, not the model kind ws', () => {
    const written = generateYamlRequest(parseYamlRequest(WEBSOCKET));
    expect(written).toContain('type: websocket');
    expect(written).not.toMatch(/type: ws$/m);
  });

  it('leaves the tokens that spell themselves alone', () => {
    expect(generateYamlRequest(parseYamlRequest(GRPC))).toContain('type: grpc');
  });
});

/**
 * A message payload written as a YAML mapping.
 *
 * YAML's advantage over a quoted JSON string is that a structured payload can be
 * written as structure. Before this, `String()` turned that structure into the
 * literal characters `[object Object]` and sent them: the declared type was
 * accepted, the frame went out, and the run passed. The assertions below are on
 * the payload the transport would send, because a round trip is exactly what did
 * not catch this — the writer wrote back what the parser had already destroyed.
 */
describe('a structured message payload', () => {
  const MAPPING = '        data:\n          hello: world\n          nested:\n            n: 1\n';
  const structured = `info:
  name: Structured
  type: websocket
  seq: 1
websocket:
  url: wss://example.test/socket
  message:
    - title: mapping
      selected: true
      message:
        type: json
${MAPPING}`;

  it('is serialised as JSON rather than stringified into [object Object]', () => {
    const parsed = parseYamlRequest(structured);
    const content = parsed.websocket?.messages?.[0]?.content;

    expect(content).not.toContain('[object Object]');
    expect(JSON.parse(content ?? '')).toEqual({ hello: 'world', nested: { n: 1 } });
  });

  it('serialises a sequence the same way', () => {
    const parsed = parseYamlRequest(
      structured.replace(MAPPING, '        data:\n          - 1\n          - two\n'),
    );

    expect(JSON.parse(parsed.websocket?.messages?.[0]?.content ?? '')).toEqual([1, 'two']);
  });

  it('leaves a string payload byte-for-byte alone', () => {
    // The common case, and the only one upstream ever has. Running JSON.stringify
    // over it would wrap every existing file's frames in a fresh pair of quotes.
    const parsed = parseYamlRequest(
      structured.replace(MAPPING, '        data: \'{"already":"json"}\'\n'),
    );

    expect(parsed.websocket?.messages?.[0]?.content).toBe('{"already":"json"}');
  });

  it('stringifies a scalar rather than JSON-quoting it', () => {
    const parsed = parseYamlRequest(structured.replace(MAPPING, '        data: 42\n'));

    expect(parsed.websocket?.messages?.[0]?.content).toBe('42');
  });

  it('applies the same rule to a gRPC message', () => {
    // The gRPC branch carried the identical `String()` and is easier to miss,
    // because its transport JSON.parses the payload and so failed with a parse
    // error rather than sending nonsense down the wire. A mapping body now works.
    const parsed = parseYamlRequest(`info:
  name: Structured
  type: grpc
  seq: 1
grpc:
  url: grpc://localhost:50051
  method: /pkg.Svc/Method
  message:
    - title: one
      message:
        id: 7
`);

    expect(JSON.parse(parsed.grpc?.messages?.[0]?.content ?? '')).toEqual({ id: 7 });
  });
});
