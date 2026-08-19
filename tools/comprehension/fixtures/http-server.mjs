/**
 * The only network the trials are allowed to reach.
 *
 * `run_collection` is a third of the tool surface and writes nothing, so the
 * only way to grade a run behaviourally is to let it really run. Every endpoint
 * here is deterministic, and the two identities differ only in what
 * /admin/reports answers, which is what makes an authorization task gradeable:
 * a run that shares one token across both groups gets 200 twice.
 */

import { createServer } from 'node:http';

const VIEWER = 'viewer-token';
const ADMIN = 'admin-token';

function send(res, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(text);
}

/** Start on an ephemeral port. Returns the base URL and a close function. */
export async function startFixtureServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const auth = req.headers.authorization ?? '';
    const path = url.pathname.replace(/\/$/, '') || '/';

    if (path === '/ping') return send(res, 200, { pong: true });

    if (path === '/login' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        // Whichever identity the body names; an empty body is the viewer.
        const admin = /admin/i.test(raw);
        send(res, 200, { token: admin ? ADMIN : VIEWER, role: admin ? 'admin' : 'viewer' });
      });
      return undefined;
    }

    if (path === '/items') {
      if (!auth.startsWith('Bearer ')) return send(res, 401, { error: 'unauthenticated' });
      return send(res, 200, { items: [{ id: 1, name: 'Widget', price: 9.5 }] });
    }

    if (path === '/admin/reports') {
      if (auth === `Bearer ${ADMIN}`) return send(res, 200, { reports: ['q1'] });
      return send(res, 403, { error: 'forbidden' });
    }

    if (path === '/echo' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => send(res, 200, {
        contentType: req.headers['content-type'] ?? null,
        length: raw.length,
        body: raw.slice(0, 2000),
      }));
      return undefined;
    }

    return send(res, 404, { error: 'not found', path });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
