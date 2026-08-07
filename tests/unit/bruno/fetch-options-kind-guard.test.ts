/**
 * `buildFetchOptions` refuses a request with no http block, at the boundary.
 *
 * This branch cannot be reached through a collection run: the executor refuses a
 * kind with no http block before it gets here, which is the whole point of having
 * the refusal there. So it is tested at the function boundary, the same way the
 * `.bru` passthrough guard is — it protects a future caller, and there is nowhere
 * else to exercise it.
 *
 * Without the guard the narrowing below it would be a non-null assertion in all
 * but name, and a grpc request that somehow reached this function would fail with
 * a TypeError deep in the pipeline rather than a named error at the door.
 */
import { buildFetchOptions } from '../../../src/bruno/request-executor.js';
import { BrunoError } from '../../../src/bruno/types.js';
import type { YamlRequest } from '../../../src/bruno/types.js';

const grpcRequest: YamlRequest = {
  info: { name: 'Streamer', type: 'grpc' },
  grpc: { url: 'grpc://localhost:50051', method: '/pkg.Svc/Method' },
};

describe('buildFetchOptions on a request that has no http block', () => {
  it('rejects rather than resolving with an empty request', async () => {
    await expect(buildFetchOptions(grpcRequest, new Map())).rejects.toThrow(BrunoError);
  });

  it('names the kind and what it is missing', async () => {
    await expect(buildFetchOptions(grpcRequest, new Map()))
      .rejects.toThrow(/"grpc" request: it has no http block/);
  });

  it('reports it as a validation error, not as a transport failure', async () => {
    await expect(buildFetchOptions(grpcRequest, new Map()))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  // A request with no declared kind at all is the http default, and saying "http"
  // is more useful than saying "undefined" to whoever has to fix the file.
  it('calls an undeclared kind http', async () => {
    await expect(buildFetchOptions({ info: { name: 'X' } }, new Map()))
      .rejects.toThrow(/"http" request: it has no http block/);
  });
});

describe('an http block with nothing optional in it', () => {
  // Every other fixture in the suite gives the request a headers array, so the
  // branch that copes with its absence was never taken. A request authored with no
  // headers at all is the most ordinary thing there is.
  it('builds without headers, params or a body', async () => {
    const built = await buildFetchOptions(
      { info: { name: 'Bare' }, http: { method: 'GET', url: 'https://example.test/x' } },
      new Map(),
    );
    expect(built.url).toBe('https://example.test/x');
    expect(built.options.method).toBe('GET');
  });
});
