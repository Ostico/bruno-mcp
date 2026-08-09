/**
 * A unary gRPC call, end to end, against a real grpc-js server.
 *
 * Every claim here is behavioural. The channel options this transport sets are
 * security-relevant — proxying disabled, the authority preserved, TLS never
 * downgraded — and asserting our own inputs would only prove we passed what we
 * meant to pass. So the proxy is a real listener that counts CONNECTs, the
 * deadline is a server that accepts and never answers, and "no downgrade" is a
 * `grpcs://` dial against a plaintext server: if it downgraded, it would succeed.
 *
 * The server binds on port 0 and the target is 127.0.0.1, which SSRF validation
 * blocks by default — so BRUNO_SSRF_ALLOWLIST is set and restored around the
 * suite. That path is also the one where validation returns no addresses to pin,
 * which is exactly when `ssl_target_name_override` must be absent.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { createServer, type Server as HttpServer } from 'node:http';
import { RequestExecutor } from '../../src/bruno/request-executor.js';
import { TestRunner } from '../../src/bruno/test-runner.js';
import { resetAllowlistCache } from '../../src/bruno/url-validator.js';

const PROTO = `syntax = "proto3";
package echo;

service Echo {
  rpc Say (SayRequest) returns (SayReply);
  rpc Never (SayRequest) returns (SayReply);
  rpc Fail (SayRequest) returns (SayReply);
}

message SayRequest {
  string text = 1;
}

message SayReply {
  string text = 1;
}
`;

interface Started {
  server: grpc.Server;
  port: number;
}

async function startEchoServer(): Promise<Started> {
  const dir = await mkdtemp(join(tmpdir(), 'grpc-proto-'));
  const protoFile = join(dir, 'echo.proto');
  await writeFile(protoFile, PROTO);
  const packageDefinition = protoLoader.loadSync(protoFile, { keepCase: true, defaults: true });
  const loaded = grpc.loadPackageDefinition(packageDefinition) as unknown as {
    echo: { Echo: { service: grpc.ServiceDefinition } };
  };

  const server = new grpc.Server();
  server.addService(loaded.echo.Echo.service, {
    Say: (
      call: grpc.ServerUnaryCall<{ text: string }, { text: string }>,
      callback: grpc.sendUnaryData<{ text: string }>,
    ) => {
      const metadata = new grpc.Metadata();
      metadata.set('x-trailer', 'yes');
      metadata.set('authorization', 'secret-should-be-masked');
      callback(null, { text: `echo:${call.request.text}` }, metadata);
    },
    // Accepts and never answers: the deadline is the only thing that can end it.
    Never: () => {},
    Fail: (
      _call: grpc.ServerUnaryCall<{ text: string }, { text: string }>,
      callback: grpc.sendUnaryData<{ text: string }>,
    ) => {
      callback({
        code: grpc.status.PERMISSION_DENIED,
        details: 'nope',
      } as grpc.ServiceError);
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

/** A collection holding a proto file and whatever requests the case needs. */
async function collection(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'grpc-run-'));
  await writeFile(join(root, 'bruno.json'), JSON.stringify({ version: '1', name: 'c', type: 'collection' }));
  await writeFile(join(root, 'echo.proto'), PROTO);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, name), content);
  }
  return root;
}

const bruSay = (port: number, extra = '', message = '{"text":"hi"}') => `meta {
  name: BruSay
  type: grpc
  seq: 1
}

grpc {
  url: grpc://127.0.0.1:${port}
  method: /echo.Echo/Say
  body: grpc
  protoPath: ./echo.proto
  methodType: unary
${extra}}

body:grpc {
  name: m1
  content: ${message}
}
`;

const ymlSay = (port: number) => `info:
  name: YmlSay
  type: grpc
  seq: 2
grpc:
  url: grpc://127.0.0.1:${port}
  method: /echo.Echo/Say
  protoFilePath: ./echo.proto
  methodType: unary
  message:
    - title: m1
      message: '{"text":"hi"}'
`;

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
  started = await startEchoServer();
});

afterAll(async () => {
  // forceShutdown, not tryShutdown: the deadline test deliberately leaves a call
  // the server never answers, and a graceful shutdown waits for it — which turned
  // this hook into a five-second timeout and failed the suite after every
  // assertion in it had passed.
  started.server.forceShutdown();
  if (savedAllowlist === undefined) delete process.env.BRUNO_SSRF_ALLOWLIST;
  else process.env.BRUNO_SSRF_ALLOWLIST = savedAllowlist;
  resetAllowlistCache();
});

describe('a unary call succeeds in both dialects', () => {
  it('echoes the message, with code 0 and details OK', async () => {
    const root = await collection({
      'brusay.bru': bruSay(started.port),
      'ymlsay.yml': ymlSay(started.port),
    });
    const results = await run(root);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.error).toBeUndefined();
      expect(result.grpc?.code).toBe(0);
      expect(result.grpc?.details).toBe('OK');
      expect(result.response_body).toContain('echo:hi');
    }
  });

  it('masks a credential-bearing trailer by name', async () => {
    const root = await collection({ 'brusay.bru': bruSay(started.port) });
    const [result] = await run(root);
    expect(result.grpc?.trailers?.['x-trailer']).toBe('yes');
    expect(result.grpc?.trailers?.authorization).not.toBe('secret-should-be-masked');
  });

  it('reports the kind rather than an http method', async () => {
    const root = await collection({ 'brusay.bru': bruSay(started.port) });
    const [result] = await run(root);
    expect(result.method).toBe('GRPC');
  });
});

describe('a failing call surfaces the gRPC status, not a generic error', () => {
  it('carries PERMISSION_DENIED and its details', async () => {
    const root = await collection({
      'fail.bru': bruSay(started.port).replace('/echo.Echo/Say', '/echo.Echo/Fail'),
    });
    const [result] = await run(root);
    expect(result.grpc?.code).toBe(grpc.status.PERMISSION_DENIED);
    expect(result.grpc?.details).toContain('nope');
  });
});

describe('what is refused before a channel is built', () => {
  it('refuses a streaming methodType, naming the kind', async () => {
    const root = await collection({
      'stream.bru': bruSay(started.port).replace('methodType: unary', 'methodType: server-streaming'),
    });
    const [result] = await run(root);
    expect(result.error).toMatch(/server-streaming/);
    expect(result.grpc).toBeUndefined();
  });

  // Count, not selection: neither dialect gives a gRPC message a `selected` flag,
  // so a "more than one selected message" rule would have nothing to read.
  it('refuses a request carrying two messages', async () => {
    const two = `${bruSay(started.port)}
body:grpc {
  name: m2
  content: {"text":"second"}
}
`;
    const [result] = await run(await collection({ 'two.bru': two }));
    expect(result.error).toMatch(/more than one message|two messages|single message/i);
    expect(result.grpc).toBeUndefined();
  });

  it('refuses a proto path outside the collection', async () => {
    const root = await collection({
      'escape.bru': bruSay(started.port).replace('./echo.proto', '../../../etc/hosts'),
    });
    const [result] = await run(root);
    expect(result.error).toMatch(/proto/i);
    expect(result.grpc).toBeUndefined();
  });
});

describe('a server that never answers does not hang the run', () => {
  it('produces a deadline result inside the authored timeout', async () => {
    const never = `${bruSay(started.port).replace('/echo.Echo/Say', '/echo.Echo/Never')}
settings {
  timeout: 1500
}
`;
    const root = await collection({ 'never.bru': never });
    const started_at = Date.now();
    const [result] = await run(root);
    expect(Date.now() - started_at).toBeLessThan(4000);
    expect(result.grpc?.code).toBe(grpc.status.DEADLINE_EXCEEDED);
  }, 8000);
});

describe('an ambient proxy cannot take effect', () => {
  let proxy: HttpServer;
  let connects = 0;
  let savedProxy: string | undefined;

  beforeAll(async () => {
    proxy = createServer();
    proxy.on('connect', (_req, socket) => {
      connects += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve()));
    const address = proxy.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    savedProxy = process.env.http_proxy;
    process.env.http_proxy = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (savedProxy === undefined) delete process.env.http_proxy;
    else process.env.http_proxy = savedProxy;
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });

  it('reaches the server directly and logs zero CONNECTs', async () => {
    const root = await collection({ 'brusay.bru': bruSay(started.port) });
    const [result] = await run(root);
    expect(result.grpc?.code).toBe(0);
    // grpc-js honours ambient http_proxy unless told not to, while undici's fetch
    // does not — so leaving it enabled would have silently voided SSRF pinning.
    expect(connects).toBe(0);
  });
});

describe('TLS is not downgraded on demand', () => {
  it('fails a grpcs:// dial against a plaintext server rather than falling back', async () => {
    const root = await collection({
      'tls.bru': bruSay(started.port).replace('grpc://', 'grpcs://'),
    });
    const [result] = await run(root);
    // A downgrade would have succeeded, so success here is the failure.
    expect(result.grpc?.code).not.toBe(0);
    expect(result.response_body ?? '').not.toContain('echo:hi');
  }, 15000);
});

/**
 * A gRPC call that can fail.
 *
 * It could not, before: the executor returned from the gRPC branch before the path
 * that runs scripts and assertions, so a call's declared checks were parsed,
 * written back faithfully and never evaluated. In a mixed collection that inflated
 * `passed` with zero verification, and `requestsWithoutTests` was the only signal —
 * which reads as an author's omission rather than as a capability that did not
 * exist.
 *
 * The first test below is the one that matters: it must FAIL. A suite where the
 * negative case cannot go red is exactly the condition being fixed here.
 */
const withTests = (port: number, body: string) => `${ymlSay(port)}runtime:
  scripts:
    - type: tests
      code: |
${body.split('\n').map((line) => `        ${line}`).join('\n')}
`;

describe('a gRPC call is verified, not assumed', () => {
  it('fails the run when its test fails', async () => {
    const root = await collection({
      'checked.yml': withTests(
        started.port,
        "test('the server did not echo', function () {\n"
        + "  expect(res.getBody().text).to.equal('nothing like it');\n"
        + '});',
      ),
    });
    const [result] = await run(root);

    expect(result.tests).toHaveLength(1);
    expect(result.tests[0].status).toBe('fail');
  }, 15000);

  it('passes a test that reads the response body', async () => {
    const root = await collection({
      'ok.yml': withTests(
        started.port,
        "test('the server echoed', function () {\n"
        + "  expect(res.getBody().text).to.contain('hi');\n"
        + '});',
      ),
    });
    const [result] = await run(root);

    expect(result.tests[0]?.status).toBe('pass');
  }, 15000);

  it('gives a script the gRPC status code, where 0 means OK', async () => {
    // The single most misreadable field in this API: `status: 0` is the refusal
    // sentinel everywhere else, and gRPC's OK is also 0. Mapping OK to 200 would
    // make a passing assertion say something untrue about the call, so the
    // collision is kept and the script sees the real code.
    const root = await collection({
      'code.yml': withTests(
        started.port,
        "test('OK is zero here', function () {\n"
        + '  expect(res.getStatus()).to.equal(0);\n'
        + '});',
      ),
    });
    const [result] = await run(root);

    expect(result.tests[0]?.status).toBe('pass');
    // And the result's own status stays the refusal sentinel, unchanged.
    expect(result.status).toBe(0);
    expect(result.grpc?.code).toBe(0);
  }, 15000);

  it('counts a verified call in the run summary rather than as untested', async () => {
    const root = await collection({
      'summary.yml': withTests(
        started.port,
        "test('echoed', function () {\n"
        + "  expect(res.getBody().text).to.contain('hi');\n"
        + '});',
      ),
    });
    const summary = (await RequestExecutor.executeCollection(root, { scriptRunner: TestRunner }))
      .summary;

    expect(summary.tests.total).toBe(1);
    expect(summary.tests.passed).toBe(1);
    // The field that used to be the only signal that nothing was checked.
    expect(summary.requestsWithoutTests).toBe(0);
  }, 15000);
});
