/**
 * A gRPC request this server authored, run against a real gRPC server.
 *
 * The byte-level tests prove the file matches what Bruno writes; they cannot
 * prove our own runner can read it back. The two are separate code paths — the
 * writer builds a `BruFile`, the runner parses one from disk — and a field
 * written under a key the runner does not read costs nothing at write time. So
 * this authors a request through `create_request` and then runs it, in both
 * dialects, with no hand-written file anywhere in the path.
 *
 * The proto imports `google/protobuf/timestamp.proto` on purpose. Import
 * confinement walks the graph before the loader reads anything, and a bundled
 * well-known type is not a file on disk — a confinement check that treated it as
 * one would refuse the timestamp and duration types half the world's protos use.
 *
 * The server binds on port 0 and the target is 127.0.0.1, which SSRF validation
 * blocks by default, so BRUNO_SSRF_ALLOWLIST is set and restored around the suite.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { createRequestBuilder } from '../../src/bruno/request.js';
import { RequestExecutor } from '../../src/bruno/request-executor.js';
import { TestRunner } from '../../src/bruno/test-runner.js';
import { resetAllowlistCache } from '../../src/bruno/url-validator.js';

const PROTO = `syntax = "proto3";
package greet;

import "google/protobuf/timestamp.proto";

service Greeter {
  rpc SayHello (HelloRequest) returns (HelloReply);
}

message HelloRequest {
  string name = 1;
}

message HelloReply {
  string text = 1;
  google.protobuf.Timestamp when = 2;
}
`;

/** A proto whose import graph leaves the collection one hop past the entry file. */
const ESCAPING_PROTO = `syntax = "proto3";
package escape;

import "../../outside/shared.proto";

service Escape {
  rpc Do (shared.Thing) returns (shared.Thing);
}
`;

const SHARED_PROTO = `syntax = "proto3";
package shared;

message Thing {
  string a = 1;
}
`;

interface Started {
  server: grpc.Server;
  port: number;
}

async function startGreeter(): Promise<Started> {
  const dir = await mkdtemp(join(tmpdir(), 'grpc-authored-proto-'));
  const protoFile = join(dir, 'greet.proto');
  await writeFile(protoFile, PROTO);
  const packageDefinition = protoLoader.loadSync(protoFile, { keepCase: true, defaults: true });
  const loaded = grpc.loadPackageDefinition(packageDefinition) as unknown as {
    greet: { Greeter: { service: grpc.ServiceDefinition } };
  };

  const server = new grpc.Server();
  server.addService(loaded.greet.Greeter.service, {
    SayHello: (
      call: grpc.ServerUnaryCall<{ name: string }, unknown>,
      callback: grpc.sendUnaryData<unknown>,
    ) => {
      callback(null, {
        text: `hello ${call.request.name}`,
        when: { seconds: 1770000000, nanos: 0 },
      });
    },
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, bound) => {
      if (err) reject(err);
      else resolve(bound);
    });
  });
  return { server, port };
}

/**
 * A collection of the given dialect with `protos/greet.proto` in it.
 *
 * The root is a subdirectory of its own temporary directory so an escaping import
 * has somewhere real to point at that is still inside a tree this suite owns.
 */
async function collection(format: 'bru' | 'yaml'): Promise<{ root: string; base: string }> {
  const base = await mkdtemp(join(tmpdir(), `grpc-authored-${format}-`));
  const root = join(base, 'collection');
  await mkdir(join(root, 'protos'), { recursive: true });
  await writeFile(
    // `opencollection.yml` is the name that declares a yaml collection, both here
    // and in `bru run`. A differently named file declares nothing, and the writer
    // then falls back to yaml — which passes for the wrong reason.
    join(root, format === 'yaml' ? 'opencollection.yml' : 'bruno.json'),
    format === 'yaml'
      ? 'opencollection: "1.0"\ninfo:\n  name: Authored\n'
      : JSON.stringify({ version: '1', name: 'Authored', type: 'collection' }),
  );
  await writeFile(join(root, 'protos', 'greet.proto'), PROTO);
  return { root, base };
}

const run = async (root: string) => {
  const result = await RequestExecutor.executeCollection(root, { scriptRunner: TestRunner });
  return result.groups.flatMap((g) => g.results);
};

let started: Started;
let savedAllowlist: string | undefined;

beforeAll(async () => {
  savedAllowlist = process.env.BRUNO_SSRF_ALLOWLIST;
  process.env.BRUNO_SSRF_ALLOWLIST = '127.0.0.1';
  resetAllowlistCache();
  started = await startGreeter();
});

afterAll(async () => {
  started.server.forceShutdown();
  if (savedAllowlist === undefined) delete process.env.BRUNO_SSRF_ALLOWLIST;
  else process.env.BRUNO_SSRF_ALLOWLIST = savedAllowlist;
  resetAllowlistCache();
});

describe('an authored gRPC request runs', () => {
  it.each([['bru'], ['yaml']] as const)('completes a unary call authored in %s', async (format) => {
    const { root } = await collection(format);

    const created = await createRequestBuilder().createRequest({
      collectionPath: root,
      name: 'Greet',
      kind: 'grpc',
      url: `grpc://127.0.0.1:${started.port}`,
      grpc: {
        method: '/greet.Greeter/SayHello',
        protoPath: 'protos/greet.proto',
        methodType: 'unary',
        messages: [{ title: 'first', content: '{"name":"world"}' }],
      },
    });
    expect(created.success).toBe(true);

    const results = await run(root);

    expect(results).toHaveLength(1);
    expect(results[0].error).toBeUndefined();
    expect(results[0].grpc?.code).toBe(0);
    expect(results[0].grpc?.details).toBe('OK');
    expect(results[0].response_body).toContain('hello world');
    // The reply's Timestamp field is proof the bundled well-known type resolved:
    // an unresolved import would have failed the load, not produced a field.
    expect(results[0].response_body).toContain('seconds');
  });
});

/** A collection with an entry proto whose import leaves the collection. */
async function escapingCollection(): Promise<string> {
  const { root, base } = await collection('bru');
  await mkdir(join(base, 'outside'));
  await writeFile(join(base, 'outside', 'shared.proto'), SHARED_PROTO);
  await writeFile(join(root, 'protos', 'escape.proto'), ESCAPING_PROTO);
  return root;
}

describe('confinement, at both ends of the path', () => {
  it('refuses an escaping import at authoring time, though the entry file is confined', async () => {
    // The named file has nothing wrong with it — the escape is one hop further in,
    // so a check that stopped at the entry file would write this request happily.
    const root = await escapingCollection();

    const created = await createRequestBuilder().createRequest({
      collectionPath: root,
      name: 'Escape',
      kind: 'grpc',
      url: `grpc://127.0.0.1:${started.port}`,
      grpc: {
        method: '/escape.Escape/Do',
        protoPath: 'protos/escape.proto',
        methodType: 'unary',
        messages: [{ content: '{"a":"x"}' }],
      },
    });

    expect(created.success).toBe(false);
    expect(created.error).toMatch(/outside the collection/);
  });

  it('refuses the same import at run time, for a file authoring never saw', async () => {
    // The write-time check cannot stand in for the run-time one: the proto can
    // change after the request is written, and a hand-written request never passed
    // through the writer at all. This one is hand-written for exactly that reason.
    const root = await escapingCollection();
    await writeFile(
      join(root, 'escape.bru'),
      'meta {\n  name: Escape\n  type: grpc\n  seq: 1\n}\n\n'
      + `grpc {\n  url: grpc://127.0.0.1:${started.port}\n  method: /escape.Escape/Do\n`
      + '  body: grpc\n  protoPath: protos/escape.proto\n  methodType: unary\n}\n\n'
      + 'body:grpc {\n  name: m1\n  content: {"a":"x"}\n}\n',
    );

    const [result] = await run(root);

    expect(result.error).toMatch(/outside the collection/);
    expect(result.grpc).toBeUndefined();
  });

  it('refuses a proto path outside the collection at authoring time', async () => {
    const { root, base } = await collection('bru');
    await mkdir(join(base, 'outside'));
    await writeFile(join(base, 'outside', 'shared.proto'), SHARED_PROTO);

    const created = await createRequestBuilder().createRequest({
      collectionPath: root,
      name: 'Outside',
      kind: 'grpc',
      url: `grpc://127.0.0.1:${started.port}`,
      grpc: { protoPath: '../outside/shared.proto', methodType: 'unary' },
    });

    expect(created.success).toBe(false);
    expect(created.error).toContain('outside the collection');
  });
});
