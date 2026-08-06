/**
 * A kind this server cannot run has to be refused as a result, not as a throw.
 *
 * These files parse now, in both dialects, so they reach the executor — and every
 * step of that pipeline from the URL onwards is HTTP-shaped. Without a refusal at
 * the boundary, `yaml.http.method` throws a TypeError: for `.yml` that turns a
 * clean refusal into a crash, and for `.bru` it replaces one failure mode with a
 * worse one. A throw would also take the rest of the collection down with it,
 * which is the part that matters most: one unsupported request must not stop the
 * requests around it from running.
 *
 * `status: 0` is this codebase's refusal sentinel, and the refusal contributes no
 * tests — a skipped request that reported tests would make the suite look larger
 * than it is.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestExecutor } from '../../../src/bruno/request-executor.js';
import { TestRunner } from '../../../src/bruno/test-runner.js';
import { toRequestView } from '../../../src/bruno/request-view.js';
import { discoverRequests } from '../../../src/bruno/request-discovery.js';
import { parseBruRequest } from '../../../src/bruno/bru-parser.js';
import { parseYamlRequest } from '../../../src/bruno/yaml-parser.js';

// example.test does not resolve, and SSRF validation is not what is under test.
jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
  ssrfRemediation: jest.fn().mockReturnValue(''),
}));

const BRU_HTTP = `meta {
  name: one
  type: http
  seq: 1
}

get {
  url: https://example.test/one
}
`;

const BRU_GRPC = `meta {
  name: streamer
  type: grpc
  seq: 2
}

grpc {
  url: grpc://localhost:50051
  method: /pkg.Svc/Method
}
`;

const BRU_WS = `meta {
  name: socket
  type: ws
  seq: 3
}

ws {
  url: ws://localhost:8080
}
`;

const YML_GRPC = `info:
  name: ymlstreamer
  type: grpc
  seq: 4
grpc:
  url: grpc://localhost:50052
  method: /pkg.Svc/Other
`;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kind-refusal-'));
  await writeFile(join(root, 'one.bru'), BRU_HTTP);
  await writeFile(join(root, 'streamer.bru'), BRU_GRPC);
  await writeFile(join(root, 'socket.bru'), BRU_WS);
  await writeFile(join(root, 'ymlstreamer.yml'), YML_GRPC);
  global.fetch = jest.fn().mockResolvedValue(
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
  ) as never;
});

const runAll = () => RequestExecutor.executeCollection(root, { scriptRunner: TestRunner });
const resultsOf = async () => (await runAll()).groups.flatMap((g) => g.results);
const byName = async (name: string) => (await resultsOf()).find((r) => r.name === name);

describe('a kind this server cannot run is refused, not crashed on', () => {
  it('does not reject the run', async () => {
    await expect(runAll()).resolves.toBeDefined();
  });

  it('refuses a .bru gRPC request by name, with the refusal sentinel', async () => {
    const result = await byName('streamer');
    expect(result?.status).toBe(0);
    expect(result?.error).toMatch(/cannot execute a "grpc" request/i);
  });

  it('refuses a .bru WebSocket request by name', async () => {
    const result = await byName('socket');
    expect(result?.status).toBe(0);
    expect(result?.error).toMatch(/cannot execute a "ws" request/i);
  });

  it('refuses a .yml gRPC request the same way — one rule, both dialects', async () => {
    const result = await byName('ymlstreamer');
    expect(result?.status).toBe(0);
    expect(result?.error).toMatch(/cannot execute a "grpc" request/i);
  });

  it('does not send a request for a refused kind', async () => {
    await runAll();
    // One fetch, for the one http request. A refusal that reached
    // buildFetchOptions would have contacted a host derived from an empty URL.
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('still runs the http request alongside them', async () => {
    const result = await byName('one');
    expect(result?.status).toBe(200);
    expect(result?.error).toBeUndefined();
  });

  it('counts each refusal exactly once and adds no tests', async () => {
    const run = await runAll();
    expect(run.summary.total).toBe(4);
    expect(run.summary.failed).toBe(3);
    expect(run.summary.passed).toBe(1);
    expect(run.summary.tests.total).toBe(0);
  });

  it('reports the kind where the method would be, rather than inventing one', async () => {
    // `method: 'GET'` on a gRPC refusal would read as an http request that failed,
    // which is the confusion this whole task exists to remove.
    expect((await byName('streamer'))?.method).toBe('GRPC');
    expect((await byName('socket'))?.method).toBe('WS');
  });

  it('leaves the url empty rather than guessing a target', async () => {
    expect((await byName('streamer'))?.url).toBe('');
  });
});

describe('the read path does not throw for these kinds either', () => {
  // What the view SHOWS for a gRPC or WebSocket request is the next task's
  // subject. All that is claimed here is that neither dialect's view builder
  // crashes on one, because a tool that throws is a tool an agent cannot use to
  // find out why a request was refused.
  it('builds a view for a .bru gRPC request', () => {
    expect(() => toRequestView(parseBruRequest(BRU_GRPC), 'bru', 'streamer.bru')).not.toThrow();
  });

  it('builds a view for a .bru WebSocket request', () => {
    expect(() => toRequestView(parseBruRequest(BRU_WS), 'bru', 'socket.bru')).not.toThrow();
  });

  it('builds a view for a .yml gRPC request', () => {
    expect(() => toRequestView(parseYamlRequest(YML_GRPC), 'yaml', 'ymlstreamer.yml')).not.toThrow();
  });

  it('discovers them without failing the directory scan', async () => {
    const discovered = await discoverRequests(root);
    expect(discovered.parseFailures).toEqual([]);
    expect(discovered.requests.map((r) => r.yaml.info.name).sort())
      .toEqual(['one', 'socket', 'streamer', 'ymlstreamer']);
  });
});
