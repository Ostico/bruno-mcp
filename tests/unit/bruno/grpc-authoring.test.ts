/**
 * Authoring a gRPC request, checked against the bytes Bruno writes.
 *
 * The oracle is upstream's own `stringifyRequest`, not a round-trip through our
 * parser: our parser tolerates our own output, so a field written into the wrong
 * block or under the wrong key survives a round-trip and fails only in Bruno. The
 * two dialects disagree about more here than they do for WebSocket — `.bru` spells
 * the proto file `protoPath` inside its `grpc` block and keeps metadata in a
 * top-level block, `.yml` spells it `protoFilePath` and nests metadata in the
 * block — so both are asserted whole rather than by the keys we expect to differ.
 */
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestBuilder } from '../../../src/bruno/request';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { stringifyRequest, parseRequest } = require('@usebruno/filestore');

const PROTO = `syntax = "proto3";
package greet;
service Greeter { rpc SayHello (HelloRequest) returns (HelloReply); }
message HelloRequest { string name = 1; }
message HelloReply { string message = 1; }
`;

/**
 * A collection of the given format with `protos/greet.proto` in it.
 *
 * The proto has to exist before the request that names it: authoring confines the
 * path the same way the run path does, and confinement is checked on the real path,
 * which a file that is not there does not have.
 */
async function collection(format: 'bru' | 'yaml'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `grpc-author-${format}-`));
  await writeFile(
    join(root, format === 'yaml' ? 'collection.yml' : 'bruno.json'),
    format === 'yaml'
      ? 'name: Authored\ntype: collection\nversion: "1"\n'
      : JSON.stringify({ version: '1', name: 'Authored', type: 'collection' }),
  );
  await mkdir(join(root, 'protos'));
  await writeFile(join(root, 'protos', 'greet.proto'), PROTO);
  return root;
}

const authorGreet = (root: string, overrides: Record<string, unknown> = {}) =>
  createRequestBuilder().createRequest({
    collectionPath: root,
    name: 'Greet',
    kind: 'grpc',
    url: 'grpc://127.0.0.1:50051',
    sequence: 1,
    grpc: {
      method: '/greet.Greeter/SayHello',
      protoPath: 'protos/greet.proto',
      methodType: 'unary',
      messages: [{ title: 'first', content: '{"name":"world"}' }],
    },
    ...overrides,
  });

/** The item shape upstream's writer takes for the same request. */
const upstreamItem = (overrides: Record<string, unknown> = {}) => ({
  name: 'Greet',
  type: 'grpc-request',
  seq: 1,
  request: {
    url: 'grpc://127.0.0.1:50051',
    method: '/greet.Greeter/SayHello',
    methodType: 'unary',
    protoPath: 'protos/greet.proto',
    auth: { mode: 'none' },
    body: { mode: 'grpc', grpc: [{ name: 'first', content: '{"name":"world"}' }] },
    ...overrides,
  },
});

describe('authoring a gRPC request in .bru', () => {
  it('writes a grpc block, a metadata block and no http block', async () => {
    const root = await collection('bru');

    const created = await authorGreet(root, { headers: { 'X-Authored': 'yes' } });

    expect(created.success).toBe(true);
    const bytes = await readFile(created.path as string, 'utf-8');
    expect(bytes).toBe(
      'meta {\n  name: Greet\n  type: grpc\n  seq: 1\n}\n\n'
      + 'grpc {\n  url: grpc://127.0.0.1:50051\n  method: /greet.Greeter/SayHello\n'
      + '  body: grpc\n  protoPath: protos/greet.proto\n  auth: none\n  methodType: unary\n}\n\n'
      + 'metadata {\n  X-Authored: yes\n}\n\n'
      + 'body:grpc {\n  name: first\n  content: \'\'\'\n    {"name":"world"}\n  \'\'\'\n}\n',
    );
    expect(bytes).not.toContain('http {');
    expect(bytes).not.toContain('headers {');
  });

  it('names an untitled message by its position, as Bruno does', async () => {
    const root = await collection('bru');

    const created = await authorGreet(root, {
      grpc: {
        method: '/greet.Greeter/SayHello',
        protoPath: 'protos/greet.proto',
        messages: [{ content: '{"name":"a"}' }, { content: '{"name":"b"}' }],
      },
    });

    const bytes = await readFile(created.path as string, 'utf-8');
    expect(bytes).toContain('body:grpc {\n  name: message 1\n');
    expect(bytes).toContain('body:grpc {\n  name: message 2\n');
  });

  it('writes empty content as {}, which is what Bruno substitutes', async () => {
    const root = await collection('bru');

    const created = await authorGreet(root, {
      grpc: { protoPath: 'protos/greet.proto', messages: [{ title: 'ping', content: '' }] },
    });

    const bytes = await readFile(created.path as string, 'utf-8');
    expect(bytes).toContain('body:grpc {\n  name: ping\n  content: \'\'\'\n    {}\n  \'\'\'\n}');
  });
});

describe('authoring a gRPC request in .yml', () => {
  it('writes a grpc block with protoFilePath and nested metadata', async () => {
    const root = await collection('yaml');

    const created = await authorGreet(root, { headers: { 'X-Authored': 'yes' } });

    expect(created.success).toBe(true);
    const bytes = await readFile(created.path as string, 'utf-8');
    expect(bytes).toBe(
      'info:\n  name: Greet\n  type: grpc\n  seq: 1\n\n'
      + 'grpc:\n  url: grpc://127.0.0.1:50051\n  method: /greet.Greeter/SayHello\n'
      + '  methodType: unary\n  protoFilePath: protos/greet.proto\n'
      + '  metadata:\n    - name: X-Authored\n      value: yes\n'
      + '  message:\n    - title: first\n      message: \'{"name":"world"}\'\n',
    );
    expect(bytes).not.toContain('protoPath');
    expect(bytes).not.toContain('headers:');
  });
});

describe('what upstream makes of an authored gRPC request', () => {
  it.each([['bru'], ['yaml']] as const)('reads the %s back as a gRPC request', async (format) => {
    const root = await collection(format);
    const created = await authorGreet(root, { headers: { 'X-Authored': 'yes' } });
    const bytes = await readFile(created.path as string, 'utf-8');

    const model = parseRequest(bytes, { format: format === 'yaml' ? 'yml' : 'bru' });

    expect(model.type).toBe('grpc-request');
    expect(model.request.url).toBe('grpc://127.0.0.1:50051');
    expect(model.request.method).toBe('/greet.Greeter/SayHello');
    expect(model.request.methodType).toBe('unary');
    expect(model.request.protoPath).toBe('protos/greet.proto');
    // Metadata reaches upstream as headers whichever block carried it.
    expect(model.request.headers).toEqual([
      expect.objectContaining({ name: 'X-Authored', value: 'yes' }),
    ]);
    expect(model.request.body.grpc).toEqual([
      expect.objectContaining({ name: 'first', content: '{"name":"world"}' }),
    ]);
  });
});

describe('byte parity with what Bruno writes', () => {
  it.each([['bru'], ['yaml']] as const)('writes the same %s bytes as upstream', async (format) => {
    const root = await collection(format);
    const created = await authorGreet(root, { headers: { 'X-Authored': 'yes' } });

    const ours = await readFile(created.path as string, 'utf-8');
    const theirs = stringifyRequest(
      upstreamItem({ headers: [{ name: 'X-Authored', value: 'yes', enabled: true }] }),
      { format: format === 'yaml' ? 'yml' : 'bru' },
    );

    expect(ours).toBe(theirs);
  });
});

describe('fields a gRPC request cannot carry', () => {
  it('refuses an HTTP method and points at grpc.method', async () => {
    const root = await collection('bru');

    const created = await authorGreet(root, { method: 'POST' });

    expect(created.success).toBe(false);
    expect(created.error).toContain('A gRPC request has no HTTP method');
    expect(created.error).toContain('grpc.method');
  });

  it('refuses a body, query parameters and path parameters together', async () => {
    const root = await collection('bru');

    const created = await authorGreet(root, {
      body: { type: 'json', content: '{}' },
      query: { a: '1' },
      pathParams: { id: '2' },
    });

    expect(created.success).toBe(false);
    expect(created.error).toContain('A gRPC request cannot carry body, query, pathParams');
    expect(created.error).toContain('grpc.messages');
  });

  it('refuses a websocket object on a gRPC request', async () => {
    const root = await collection('bru');

    const created = await authorGreet(root, { websocket: { messages: [{ content: 'x' }] } });

    expect(created.success).toBe(false);
    expect(created.error).toContain('`websocket` object does not apply to kind `grpc`');
  });

  it('refuses a grpc object on an http request', async () => {
    const root = await collection('bru');

    const created = await createRequestBuilder().createRequest({
      collectionPath: root,
      name: 'Plain',
      method: 'GET',
      url: 'https://example.com/x',
      grpc: { method: '/a.B/C' },
    });

    expect(created.success).toBe(false);
    expect(created.error).toContain('applies to its own kind only');
  });
});

describe('the proto path an authored request may name', () => {
  it('refuses one outside the collection', async () => {
    const root = await collection('bru');
    const outside = await mkdtemp(join(tmpdir(), 'grpc-outside-'));
    await writeFile(join(outside, 'other.proto'), PROTO);

    const created = await authorGreet(root, {
      grpc: { protoPath: join(outside, 'other.proto') },
    });

    expect(created.success).toBe(false);
    expect(created.error).toContain('outside the collection');
  });

  it('refuses one that escapes with ..', async () => {
    const root = await collection('bru');

    const created = await authorGreet(root, {
      grpc: { protoPath: '../../etc/hosts' },
    });

    expect(created.success).toBe(false);
    expect(created.error).toMatch(/outside the collection|does not exist/);
  });

  it('refuses one that does not exist', async () => {
    const root = await collection('bru');

    const created = await authorGreet(root, { grpc: { protoPath: 'protos/absent.proto' } });

    expect(created.success).toBe(false);
    expect(created.error).toContain('does not exist or is unreadable');
  });

  it('stores an absolute path inside the collection as a relative one', async () => {
    // Absolute would break the moment the collection is cloned somewhere else, and
    // would write the operator's directory layout into a committed file.
    const root = await collection('bru');

    const created = await authorGreet(root, {
      grpc: { protoPath: join(root, 'protos', 'greet.proto') },
    });

    expect(created.success).toBe(true);
    const bytes = await readFile(created.path as string, 'utf-8');
    expect(bytes).toContain('protoPath: protos/greet.proto');
    expect(bytes).not.toContain(root);
  });
});
