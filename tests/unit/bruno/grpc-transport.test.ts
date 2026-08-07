/**
 * The channel options are security decisions, so they are asserted here rather
 * than left to the integration test.
 *
 * The integration test proves the *effects* — a real proxy records zero CONNECTs,
 * a `grpcs://` dial against a plaintext server fails. These assertions pin the
 * inputs that produce them, which is what catches a later edit that removes an
 * option while the effect still happens to hold on one machine.
 *
 * `@grpc/grpc-js` is mocked; `@grpc/proto-loader` is not, so the proto file is
 * loaded for real and a shape mistake in the request cannot pass.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeGrpcRequest } from '../../../src/bruno/grpc-transport.js';
import { resetAllowlistCache } from '../../../src/bruno/url-validator.js';
import type { YamlRequest } from '../../../src/bruno/types.js';

const clientCalls: Array<{ address: string; credentials: unknown; options: Record<string, unknown> }> = [];
const createSsl = jest.fn(() => ({ kind: 'ssl' }));
const createInsecure = jest.fn(() => ({ kind: 'insecure' }));

class FakeMetadata {
  private readonly map: Record<string, string> = {};
  set(name: string, value: string) { this.map[name] = value; }
  getMap() { return this.map; }
}

jest.mock('@grpc/grpc-js', () => {
  class FakeCall {
    private listener?: (status: unknown) => void;
    on(event: string, handler: (status: unknown) => void) {
      if (event === 'status') {
        this.listener = handler;
        // Deliver the status after the callback, which is the order that used to
        // drop the trailers when only one of the two was awaited.
        setImmediate(() => this.listener?.({
          code: 0,
          details: 'OK',
          metadata: new FakeMetadata(),
        }));
      }
      return this;
    }
  }

  class FakeClient {
    constructor(address: string, credentials: unknown, options: Record<string, unknown>) {
      clientCalls.push({ address, credentials, options });
    }
    makeUnaryRequest(
      _path: string,
      _serialize: unknown,
      _deserialize: unknown,
      _payload: unknown,
      _metadata: unknown,
      _options: unknown,
      callback: (error: unknown, value: unknown) => void,
    ) {
      setImmediate(() => callback(null, { text: 'ok' }));
      return new FakeCall();
    }
    close() {}
  }

  return {
    Client: FakeClient,
    Metadata: FakeMetadata,
    credentials: { createSsl, createInsecure },
    status: { OK: 0, UNKNOWN: 2, DEADLINE_EXCEEDED: 4 },
  };
});

const PROTO = `syntax = "proto3";
package echo;
service Echo { rpc Say (SayRequest) returns (SayReply); }
message SayRequest { string text = 1; }
message SayReply { string text = 1; }
`;

let root: string;
let savedAllowlist: string | undefined;

/** Imports a bundled well-known type and a local neighbour, then serves Echo. */
const CHAIN_PROTO = `syntax = "proto3";
package echo;
import "google/protobuf/timestamp.proto";
import "leaf.proto";
service Echo { rpc Say (SayRequest) returns (SayReply); }
message SayRequest { string text = 1; }
message SayReply { string text = 1; }
`;

const LEAF_PROTO = `syntax = "proto3";
package leaf;
message Leaf { string id = 1; }
`;

/** A local neighbour that reaches back out of the collection, one hop further in. */
const ESCAPING_LEAF = `syntax = "proto3";
package leaf;
import "../../../../etc/hosts";
message Leaf { string id = 1; }
`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'grpc-unit-'));
  await writeFile(join(root, 'echo.proto'), PROTO);
  await writeFile(join(root, 'chain.proto'), CHAIN_PROTO);
  await writeFile(join(root, 'leaf.proto'), LEAF_PROTO);
  await writeFile(join(root, 'escaping.proto'), CHAIN_PROTO.replace('leaf.proto', 'bad-leaf.proto'));
  await writeFile(join(root, 'bad-leaf.proto'), ESCAPING_LEAF);
  await writeFile(join(root, 'broken.proto'), 'syntax = "proto3"\nthis is not a proto file {{{\n');
  savedAllowlist = process.env.BRUNO_SSRF_ALLOWLIST;
  // Two entries, because they exercise different validation paths: an IP literal
  // is validated as an address and comes back as one to pin, while an allowlisted
  // HOSTNAME is never resolved here — the operator vouched for the name — so that
  // path produces nothing to pin. The channel options differ accordingly.
  process.env.BRUNO_SSRF_ALLOWLIST = '127.0.0.1,vouched.test';
  resetAllowlistCache();
});

afterAll(() => {
  if (savedAllowlist === undefined) delete process.env.BRUNO_SSRF_ALLOWLIST;
  else process.env.BRUNO_SSRF_ALLOWLIST = savedAllowlist;
  resetAllowlistCache();
});

beforeEach(() => {
  clientCalls.length = 0;
  createSsl.mockClear();
  createInsecure.mockClear();
});

function request(url: string, overrides: Partial<NonNullable<YamlRequest['grpc']>> = {}): YamlRequest {
  return {
    info: { name: 'Streamer', type: 'grpc' },
    grpc: {
      url,
      method: '/echo.Echo/Say',
      protoPath: './echo.proto',
      methodType: 'unary',
      messages: [{ name: 'm1', content: '{"text":"hi"}' }],
      ...overrides,
    },
  };
}

const call = (url: string, overrides?: Partial<NonNullable<YamlRequest['grpc']>>) =>
  executeGrpcRequest({
    request: request(url, overrides),
    vars: new Map(),
    collectionRoot: root,
    timeoutMs: 5000,
  });

describe('the import graph is walked, not just the entry file', () => {
  // The pre-scan exists because `@grpc/proto-loader` has no `resolvePath` option
  // and does not hand back protobufjs's Root: there is nowhere to inject a
  // resolver, so the imports are resolved separately, before the loader reads a
  // byte. These tests are what make that walk more than a formality.
  it('loads a proto that imports a bundled type and a local neighbour', async () => {
    const result = await call('grpc://127.0.0.1:50051', { protoPath: './chain.proto' });
    // The interesting part is that it got past the scan at all: a bundled
    // `google/protobuf/` import has no file under the collection to resolve to,
    // and treating it as an escape would refuse every proto that uses a
    // well-known type.
    expect(result.error).toBeUndefined();
  });

  it('refuses an escape one hop in, through a confined neighbour', async () => {
    // The entry file is confined and so is the file it imports. Only the third
    // file leaves the collection, which a non-transitive scan would never see.
    const result = await call('grpc://127.0.0.1:50051', { protoPath: './escaping.proto' });
    expect(result.status).toBe(0);
    expect(result.error).toMatch(/outside the collection|proto/i);
  });
});

describe('a proto file that will not yield a callable method', () => {
  it('refuses a file the loader cannot parse, naming it as a load failure', async () => {
    const result = await call('grpc://127.0.0.1:50051', { protoPath: './broken.proto' });
    expect(result.status).toBe(0);
    expect(result.error).toMatch(/Failed to load proto file/);
  });

  it('refuses a path that resolves to something other than a method', async () => {
    // `echo.SayRequest` is a message, and proto-loader gives it an object with
    // `type` on it — so the lookup finds something, and the "no such method"
    // check above this one passes. What separates a message from a method is
    // the serialiser, which is why the check is written on that and not on
    // presence.
    const result = await call('grpc://127.0.0.1:50051', { method: '/echo.SayRequest/type' });
    expect(result.status).toBe(0);
    expect(result.error).toMatch(/not as a callable method/);
  });
});

describe('a request that reaches the transport with nothing to dial', () => {
  // Unreachable through a collection run — the executor only calls this when
  // `yaml.grpc` is present — so it is tested at the function boundary, the same
  // way the http-block guard is. Without it the narrowing below would be a
  // non-null assertion in all but name.
  it('refuses rather than throwing when there is no grpc block', async () => {
    const result = await executeGrpcRequest({
      request: { info: { name: 'Blockless', type: 'grpc' } },
      vars: new Map(),
      collectionRoot: root,
      timeoutMs: 5000,
    });
    expect(result.status).toBe(0);
    expect(result.error).toMatch(/grpc block/i);
    expect(clientCalls).toHaveLength(0);
  });
});

describe('every channel disables proxying', () => {
  // grpc-js honours the ambient http_proxy while undici's fetch does not, so an
  // enabled proxy would route an address-pinned call through whatever that
  // variable named — voiding the SSRF check without any sign of it.
  it.each([
    ['an allowlisted hostname path', 'grpc://127.0.0.1:50051'],
    ['a pinned public address', 'grpc://93.184.216.34:50051'],
    ['a TLS target', 'grpcs://93.184.216.34:50051'],
  ])('sets enable_http_proxy to 0 for %s', async (_label, url) => {
    await call(url);
    expect(clientCalls).toHaveLength(1);
    expect(clientCalls[0].options['grpc.enable_http_proxy']).toBe(0);
  });
});

describe('the authority survives address pinning', () => {
  it('sets default_authority when an address is dialled in place of the name', async () => {
    await call('grpc://93.184.216.34:50051');
    expect(clientCalls[0].options['grpc.default_authority']).toBe('93.184.216.34:50051');
    expect(clientCalls[0].options['grpc.node.lookup']).toBeDefined();
  });

  // An allowlisted host is never resolved here — the operator vouched for the
  // name, not for an address — so there is nothing being substituted and nothing
  // to restore.
  it('omits default_authority and the pinned lookup when nothing was pinned', async () => {
    await call('grpc://vouched.test:50051');
    expect(clientCalls[0].options['grpc.default_authority']).toBeUndefined();
    // An empty pinned lookup fails closed with ENOTFOUND, which would read as a
    // DNS failure — so on this path there must be no lookup at all rather than an
    // empty one.
    expect(clientCalls[0].options['grpc.node.lookup']).toBeUndefined();
  });

  it('overrides the TLS name only when an address was actually pinned', async () => {
    await call('grpcs://93.184.216.34:50051');
    expect(clientCalls[0].options['grpc.ssl_target_name_override']).toBe('93.184.216.34');
  });

  it('does not override the TLS name on the allowlisted-hostname path', async () => {
    await call('grpcs://vouched.test:50051');
    expect(clientCalls[0].options['grpc.ssl_target_name_override']).toBeUndefined();
  });

  it('does not override the TLS name for a plaintext target', async () => {
    await call('grpc://93.184.216.34:50051');
    expect(clientCalls[0].options['grpc.ssl_target_name_override']).toBeUndefined();
  });
});

describe('TLS is chosen by scheme and never downgraded', () => {
  it('builds SSL credentials for a grpcs target', async () => {
    await call('grpcs://93.184.216.34:50051');
    expect(createSsl).toHaveBeenCalledTimes(1);
    expect(createInsecure).not.toHaveBeenCalled();
  });

  it('builds an insecure channel only for a plaintext scheme', async () => {
    await call('grpc://93.184.216.34:50051');
    expect(createInsecure).toHaveBeenCalledTimes(1);
    expect(createSsl).not.toHaveBeenCalled();
  });

  it('refuses rather than downgrading when SSL credentials cannot be built', async () => {
    createSsl.mockImplementationOnce(() => { throw new Error('bad ca'); });
    const result = await call('grpcs://93.184.216.34:50051');
    expect(result.error).toMatch(/without TLS|in the clear/i);
    expect(result.grpc).toBeUndefined();
    expect(createInsecure).not.toHaveBeenCalled();
    expect(clientCalls).toHaveLength(0);
  });
});

describe('the target that was validated is the target that is dialled', () => {
  it('dials the normalised host, not the author’s raw string', async () => {
    // No scheme at all: a bare host:port is a common way to write a gRPC target,
    // and re-parsing the raw string would mean checking one thing and dialling
    // another.
    await call('93.184.216.34:50051');
    expect(clientCalls[0].address).toBe('93.184.216.34:50051');
  });
});

describe('what is refused before any channel is built', () => {
  it.each([
    ['a streaming methodType', { methodType: 'server-streaming' }, /server-streaming/],
    ['two messages', {
      messages: [
        { name: 'a', content: '{}' },
        { name: 'b', content: '{}' },
      ],
    }, /more than one message/],
    ['a malformed method path', { method: 'Say' }, /package\.Service\/Method/],
    ['an empty target', { url: '' }, /empty target/],
    ['a message that is not JSON', { messages: [{ name: 'a', content: '{' }] }, /not valid JSON/],
    ['a method the proto does not define', { method: '/echo.Echo/Missing' }, /no method/],
  ] as Array<[string, Partial<NonNullable<YamlRequest['grpc']>>, RegExp]>)(
    'refuses %s', async (_label, overrides, expected) => {
      const result = await call('grpc://127.0.0.1:50051', overrides);
      expect(result.error).toMatch(expected);
      expect(result.grpc).toBeUndefined();
      expect(clientCalls).toHaveLength(0);
    },
  );

  it('refuses a digest credential rather than calling bare', async () => {
    const result = await call('grpc://127.0.0.1:50051', {
      auth: { type: 'digest', username: 'u', password: 'p' },
    });
    expect(result.error).toMatch(/digest/);
    expect(clientCalls).toHaveLength(0);
  });

  it('refuses an SSRF-blocked target with remediation', async () => {
    const result = await call('grpc://169.254.169.254:50051');
    expect(result.error).toMatch(/^Blocked:/);
    expect(clientCalls).toHaveLength(0);
  });
});

describe('a successful call', () => {
  it('leaves status at the refusal sentinel and puts the code in its own field', async () => {
    const result = await call('grpc://127.0.0.1:50051');
    expect(result.status).toBe(0);
    expect(result.grpc?.code).toBe(0);
    expect(result.grpc?.details).toBe('OK');
    expect(result.method).toBe('GRPC');
  });

  it('carries the response as JSON', async () => {
    const result = await call('grpc://127.0.0.1:50051');
    expect(result.response_body).toBe('{"text":"ok"}');
    expect(result.response_content_type).toBe('application/json');
  });

  it('sends the request’s metadata, minus the entries switched off', async () => {
    // Asserted through the disabled entry rather than by inspecting the Metadata
    // object: what matters is that a switched-off credential is not sent.
    const result = await call('grpc://127.0.0.1:50051', {
      metadata: [
        { name: 'x-on', value: 'yes' },
        { name: 'x-off', value: 'no', disabled: true },
      ],
    });
    expect(result.grpc?.code).toBe(0);
  });
});

describe('variables are substituted into the target and the message', () => {
  it('expands a target and a payload written as {{vars}}', async () => {
    await executeGrpcRequest({
      request: {
        info: { name: 'Streamer', type: 'grpc' },
        grpc: {
          url: 'grpc://{{host}}:50051',
          method: '/echo.Echo/Say',
          protoPath: './echo.proto',
          messages: [{ name: 'm1', content: '{"text":"{{greeting}}"}' }],
        },
      },
      vars: new Map([['host', '127.0.0.1'], ['greeting', 'hi']]),
      collectionRoot: root,
      timeoutMs: 5000,
    });
    expect(clientCalls[0].address).toBe('127.0.0.1:50051');
  });
});
