/**
 * End-to-end proof that address pinning actually takes effect (S20/S21).
 *
 * The rest of the dispatcher suite mocks undici, so it can only assert that a
 * `connect.lookup` was handed over. These tests run against the real undici and
 * a real socket to show that the lookup is honoured: the request lands on the
 * pinned address even though the URL names a host that cannot be resolved.
 *
 * The hostname uses the reserved `.invalid` TLD (RFC 2606), so a connection can
 * only ever succeed through the pin.
 *
 * These drive the dispatcher directly (`dispatcher.request`) rather than
 * `undici.fetch`. Pinning lives in the Agent's connector, which both paths
 * share, but undici's fetch layer cannot complete inside Jest on Node 22: it
 * reads `[Symbol.dispose]` off the disposable returned by
 * `events.addAbortListener`, and Jest's VM realm has no `Symbol.dispose` there,
 * so the lookup yields undefined and undici throws
 * "removeAbortListener is not a function" once the response settles. That is a
 * Jest-realm artifact — plain Node 22 runs the fetch path fine — and using the
 * dispatcher API keeps this suite testing the pin instead of that quirk.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildDispatcher, resetDispatcherTrustCache } from '../../../src/bruno/fetch-dispatcher';

const UNRESOLVABLE_HOST = 'pinned-target.test.invalid';

/** The slice of undici's Dispatcher these tests use. */
interface RequestingDispatcher {
  request(opts: { origin: string; path: string; method: string }): Promise<{
    statusCode: number;
    body: { text(): Promise<string> };
  }>;
}

describe('buildDispatcher pinning against a real socket', () => {
  let server: http.Server;
  let port: number;
  let hostHeaders: (string | undefined)[];

  beforeEach(async () => {
    hostHeaders = [];
    delete process.env.BRUNO_INSECURE_TLS_HOSTS;
    delete process.env.BRUNO_PROXY_HOSTS;
    resetDispatcherTrustCache();

    server = http.createServer((req, res) => {
      hostHeaders.push(req.headers.host);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('reached-pinned-address');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetDispatcherTrustCache();
  });

  it('connects to the pinned address instead of resolving the hostname', async () => {
    const result = await buildDispatcher({}, UNRESOLVABLE_HOST, ['127.0.0.1']);
    expect(result).toBeDefined();

    try {
      const response = await (result!.dispatcher as RequestingDispatcher).request({
        origin: `http://${UNRESOLVABLE_HOST}:${port}`,
        path: '/',
        method: 'GET',
      });

      expect(response.statusCode).toBe(200);
      await expect(response.body.text()).resolves.toBe('reached-pinned-address');
      // The pin changes where the socket goes, not what the request claims to
      // be talking to — virtual hosting and TLS SNI stay intact.
      expect(hostHeaders).toEqual([`${UNRESOLVABLE_HOST}:${port}`]);
    } finally {
      await result!.close();
    }
  });

  it('cannot reach the server without a pin, so the pin is what carried the request', async () => {
    // Same origin, an unpinned dispatcher: DNS has no answer for a .invalid
    // host, so the connection never arrives. Control for the test above.
    const undici = await import('undici');
    const plain = new undici.Agent();

    try {
      await expect(
        (plain as unknown as RequestingDispatcher).request({
          origin: `http://${UNRESOLVABLE_HOST}:${port}`,
          path: '/',
          method: 'GET',
        }),
      ).rejects.toThrow();
      expect(hostHeaders).toEqual([]);
    } finally {
      await plain.destroy();
    }
  });

  it('releases the socket so the process is not left with an open handle', async () => {
    const result = await buildDispatcher({}, UNRESOLVABLE_HOST, ['127.0.0.1']);
    const dispatcher = result!.dispatcher as RequestingDispatcher;

    const response = await dispatcher.request({
      origin: `http://${UNRESOLVABLE_HOST}:${port}`,
      path: '/',
      method: 'GET',
    });
    await response.body.text();

    await expect(result!.close()).resolves.toBeUndefined();
    // A destroyed agent refuses further work rather than silently reconnecting.
    await expect(
      dispatcher.request({
        origin: `http://${UNRESOLVABLE_HOST}:${port}`,
        path: '/',
        method: 'GET',
      }),
    ).rejects.toThrow();
  });
});
