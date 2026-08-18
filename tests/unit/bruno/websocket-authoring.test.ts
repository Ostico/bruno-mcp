/**
 * A WebSocket request has to be authorable, in both dialects.
 *
 * The server could run one and could read one, but nothing could write one:
 * `create_request` was HTTP-shaped throughout — a required method enum, a body,
 * query and path parameters — so the only way to get a WebSocket request into a
 * collection was to hand-write the file. The transports were reachable and their
 * requests were not.
 *
 * What each dialect expects, measured against upstream rather than inferred:
 *
 *   .bru   `meta.type: ws`, a `ws { url, body, auth }` block in place of `http`,
 *          headers in the ordinary top-level `headers` block, and one `body:ws`
 *          dictionary per message
 *          (`@usebruno/lang/v2/src/jsonToBru.js`, the `ws` and `body.ws` branches)
 *   .yml   `info.type: websocket` and a `websocket:` block carrying url, headers,
 *          the message list and auth, in that order
 *          (`@usebruno/filestore/src/formats/yml/items/stringifyWebsocketRequest.ts`)
 *
 * Assertions are on the bytes, and on what upstream's own reader and writer make
 * of them: reading our output back with our own parser proves only that we are
 * self-consistent, and this codebase has shipped files that only its own tolerant
 * parser could read.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseRequest, stringifyRequest } = require('@usebruno/filestore');
import { createRequestBuilder, RequestBuilder } from '../../../src/bruno/request';
import { createCollectionManager } from '../../../src/bruno/collection';
import type { CreateRequestInput } from '../../../src/bruno/types';

let builder: RequestBuilder;

beforeEach(() => {
  builder = createRequestBuilder();
});

async function makeCollection(format: 'bru' | 'yaml'): Promise<string> {
  const tmpDir = await fs.mkdtemp(join(tmpdir(), `ws-authoring-${format}-`));
  const result = await createCollectionManager().createCollection({
    name: 'Sockets',
    outputPath: tmpDir,
    format,
  });
  if (!result.success) throw new Error(`collection setup failed: ${result.error}`);
  return join(tmpDir, 'Sockets');
}

/**
 * Author one request and hand back its bytes.
 *
 * The path comes from the result rather than being rebuilt from the name: the
 * writer lowercases request filenames, so a reconstructed path passes on a
 * case-insensitive filesystem and fails on Linux.
 */
async function author(
  format: 'bru' | 'yaml',
  input: Partial<CreateRequestInput> = {},
): Promise<string> {
  const collectionPath = await makeCollection(format);
  const result = await builder.createRequest({
    collectionPath,
    name: 'Echo',
    kind: 'ws',
    url: 'ws://localhost:8080',
    sequence: 1,
    ...input,
  });
  if (!result.success || !result.path) throw new Error(`create failed: ${result.error}`);
  return fs.readFile(result.path, 'utf-8');
}

/** The refusal message, for a create that is expected to fail. */
async function refusal(
  format: 'bru' | 'yaml',
  input: Partial<CreateRequestInput>,
): Promise<string> {
  const collectionPath = await makeCollection(format);
  const result = await builder.createRequest({
    collectionPath,
    name: 'Echo',
    kind: 'ws',
    url: 'ws://localhost:8080',
    ...input,
  });
  if (result.success) throw new Error('expected the create to be refused');
  return result.error ?? '';
}

describe('authoring a WebSocket request in .bru', () => {
  it('writes a ws block and no http block', async () => {
    const content = await author('bru', {
      websocket: { messages: [{ title: 'hello', type: 'text', content: 'ping' }] },
    });

    expect(content).toBe(
      'meta {\n'
      + '  name: Echo\n'
      + '  type: ws\n'
      + '  seq: 1\n'
      + '}\n'
      + '\n'
      + 'ws {\n'
      + '  url: ws://localhost:8080\n'
      + '  body: ws\n'
      + '  auth: none\n'
      + '}\n'
      + '\n'
      + 'body:ws {\n'
      + '  name: hello\n'
      + '  type: text\n'
      + '  selected: true\n'
      + "  content: '''\n"
      + '    ping\n'
      + "  '''\n"
      + '}\n',
    );
  });

  it('puts headers in the top-level block and the credential in its own', async () => {
    const content = await author('bru', {
      headers: { Authorization: 'Bearer shhh' },
      auth: { type: 'bearer', config: { token: 'shhh' } },
      websocket: { messages: [{ content: 'ping' }] },
    });

    expect(content).toContain('  auth: bearer\n');
    expect(content).toContain('headers {\n  Authorization: Bearer shhh\n}');
    expect(content).toContain('auth:bearer {\n  token: shhh\n}');
    // The ws block never carries headers of its own in this dialect; two homes
    // for one list would write it twice.
    expect(content).not.toContain('ws {\n  url: ws://localhost:8080\n  headers');
  });

  it('names an untitled message by its position, as Bruno does', async () => {
    const content = await author('bru', {
      websocket: { messages: [{ content: 'first' }, { content: 'second' }] },
    });

    expect(content).toContain('  name: message 1\n');
    expect(content).toContain('  name: message 2\n');
  });

  it('omits the type of a message that did not declare one', async () => {
    const content = await author('bru', { websocket: { messages: [{ content: 'ping' }] } });

    // The whole block, because `meta` has a `type` line of its own and a bare
    // substring search would find that one instead.
    expect(content).toContain(
      'body:ws {\n'
      + '  name: message 1\n'
      + '  selected: true\n'
      + "  content: '''\n",
    );
  });

  it('writes a ws request with no messages at all', async () => {
    const content = await author('bru', {});

    expect(content).toContain('ws {\n');
    expect(content).not.toContain('body:ws');
  });
});

describe('authoring a WebSocket request in .yml', () => {
  it('writes a websocket block and no http block', async () => {
    const content = await author('yaml', {
      headers: { Authorization: 'Bearer shhh' },
      auth: { type: 'bearer', config: { token: 'shhh' } },
      settings: { timeout: 0 },
      websocket: { messages: [{ title: 'hello', type: 'text', content: 'ping' }] },
    });

    expect(content).toBe(
      'info:\n'
      + '  name: Echo\n'
      + '  type: websocket\n'
      + '  seq: 1\n'
      + '\n'
      + 'websocket:\n'
      + '  url: ws://localhost:8080\n'
      + '  headers:\n'
      + '    - name: Authorization\n'
      + '      value: Bearer shhh\n'
      + '  message:\n'
      + '    - title: hello\n'
      + '      selected: true\n'
      + '      message:\n'
      + '        type: text\n'
      + '        data: ping\n'
      + '  auth:\n'
      + '    type: bearer\n'
      + '    token: shhh\n'
      + '\n'
      + 'settings:\n'
      + '  timeout: 0\n'
      + '  keepAliveInterval: 0\n',
    );
  });

  it('defaults an undeclared message type to text, as both writers do', async () => {
    const content = await author('yaml', { websocket: { messages: [{ content: 'ping' }] } });

    expect(content).toContain('        type: text\n');
  });

  it('records a deselected message as one, which this dialect can carry', async () => {
    const content = await author('yaml', {
      websocket: {
        messages: [
          { title: 'sent', content: 'ping' },
          { title: 'held', content: 'pong', selected: false },
        ],
      },
    });

    expect(content).toContain('    - title: sent\n      selected: true\n');
    expect(content).toContain('    - title: held\n      selected: false\n');
  });
});

describe('what upstream makes of an authored WebSocket request', () => {
  it('reads the .bru back as a ws request with its message selected', async () => {
    const content = await author('bru', {
      headers: { Authorization: 'Bearer shhh' },
      auth: { type: 'bearer', config: { token: 'shhh' } },
      websocket: { messages: [{ title: 'hello', type: 'text', content: 'ping' }] },
    });

    // Upstream's reader reports the kind as `ws-request` and hangs everything off
    // `request`, whatever the dialect — the shape its own app consumes, not the
    // shape of the file.
    const model = parseRequest(content, { format: 'bru' });

    expect(model.type).toBe('ws-request');
    expect(model.request.url).toBe('ws://localhost:8080');
    expect(model.request.headers).toEqual([
      expect.objectContaining({ name: 'Authorization', value: 'Bearer shhh', enabled: true }),
    ]);
    expect(model.request.body.ws).toEqual([
      expect.objectContaining({ name: 'hello', type: 'text', content: 'ping', selected: true }),
    ]);
    expect(model.request.auth.bearer).toEqual(expect.objectContaining({ token: 'shhh' }));
  });

  it('reads the .yml back as a websocket request with its message selected', async () => {
    const content = await author('yaml', {
      headers: { Authorization: 'Bearer shhh' },
      auth: { type: 'bearer', config: { token: 'shhh' } },
      websocket: { messages: [{ title: 'hello', type: 'text', content: 'ping' }] },
    });

    const model = parseRequest(content, { format: 'yml' });

    expect(model.type).toBe('ws-request');
    expect(model.request.url).toBe('ws://localhost:8080');
    expect(model.request.headers).toEqual([
      expect.objectContaining({ name: 'Authorization', value: 'Bearer shhh' }),
    ]);
    expect(model.request.body.ws).toEqual([
      expect.objectContaining({ name: 'hello', type: 'text', content: 'ping', selected: true }),
    ]);
  });
});

/**
 * The bytes upstream's own writer produces for the same request.
 *
 * This is the oracle the acceptance criteria name: a file that only round-trips
 * through our parser proves nothing about what Bruno would write. The item shape
 * is upstream's — `type: 'ws-request'`, headers as a list, the payload under
 * `request.body.ws` — read from `@usebruno/filestore/src/formats/bru/index.ts`
 * and `.../yml/stringifyItem.ts`.
 */
const upstreamItem = {
  name: 'Echo',
  type: 'ws-request',
  seq: 1,
  request: {
    url: 'ws://localhost:8080',
    headers: [{ name: 'Authorization', value: 'Bearer shhh', enabled: true }],
    auth: { mode: 'bearer', bearer: { token: 'shhh' } },
    body: {
      mode: 'ws',
      ws: [{ name: 'hello', type: 'text', content: 'ping', selected: true }],
    },
  },
  settings: { timeout: 0 },
};

describe('byte parity with what Bruno writes', () => {
  it('writes the same .bru bytes as upstream', async () => {
    const content = await author('bru', {
      headers: { Authorization: 'Bearer shhh' },
      auth: { type: 'bearer', config: { token: 'shhh' } },
      // Authored so both writers emit the block. `.bru` writes a settings block
      // only for a request that has one, so leaving it out here would compare our
      // no-settings file against an upstream file that has one.
      settings: { timeout: 0 },
      websocket: { messages: [{ title: 'hello', type: 'text', content: 'ping' }] },
    });

    expect(content).toBe(stringifyRequest(upstreamItem, { format: 'bru' }));
  });

  it('writes the same .yml bytes as upstream', async () => {
    const content = await author('yaml', {
      headers: { Authorization: 'Bearer shhh' },
      auth: { type: 'bearer', config: { token: 'shhh' } },
      settings: { timeout: 0 },
      websocket: { messages: [{ title: 'hello', type: 'text', content: 'ping' }] },
    });

    expect(content).toBe(stringifyRequest(upstreamItem, { format: 'yml' }));
  });
});

describe('fields a WebSocket request cannot carry', () => {
  it('refuses an HTTP method', async () => {
    await expect(refusal('bru', { method: 'GET' })).resolves.toContain('no HTTP method');
  });

  it('refuses a body, query parameters and path parameters together', async () => {
    const message = await refusal('bru', {
      body: { type: 'json', content: '{}' },
      query: { page: '1' },
      pathParams: { id: '7' },
    });

    expect(message).toContain('body, query, pathParams');
  });

  it('refuses a websocket object on an http request', async () => {
    const collectionPath = await makeCollection('bru');
    const result = await builder.createRequest({
      collectionPath,
      name: 'Plain',
      method: 'GET',
      url: 'https://api.example.com/things',
      websocket: { messages: [{ content: 'ping' }] },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('applies to its own kind only, not to kind `http`');
  });

  it('still requires a method for an http request', async () => {
    const collectionPath = await makeCollection('bru');
    const result = await builder.createRequest({
      collectionPath,
      name: 'Plain',
      url: 'https://api.example.com/things',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('HTTP method is required');
  });

  it('writes a deselected message with no selected line, which is all .bru can record', async () => {
    const content = await author('bru', {
      websocket: {
        messages: [
          { title: 'sent', content: 'ping' },
          { title: 'held', content: 'pong', selected: false },
        ],
      },
    });

    const blocks = content.split('body:ws {').slice(1);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('name: sent');
    expect(blocks[0]).toContain('selected: true');
    // Nothing marks the second message. That is the whole of what this dialect can
    // say, and it is enough: Bruno and this runner both read an unflagged message as
    // one not to send, which is what the caller asked for. Writing `selected: false`
    // would be a line upstream's writer never emits and its reader collapses to the
    // same absence.
    expect(blocks[1]).toContain('name: held');
    expect(blocks[1]).not.toContain('selected');
  });

  it('numbers untitled messages and marks only the ones to send', async () => {
    const content = await author('bru', {
      websocket: { messages: [{ content: 'first' }, { content: 'second', selected: false }] },
    });

    const blocks = content.split('body:ws {').slice(1);
    expect(blocks[0]).toContain('name: message 1');
    expect(blocks[0]).toContain('selected: true');
    expect(blocks[1]).toContain('name: message 2');
    expect(blocks[1]).not.toContain('selected');
  });
});

describe('the ping interval a WebSocket session holds itself open with', () => {
  // Upstream names `keepAliveInterval` in both dialects: `bruToJsonV2` reads it
  // out of a `.bru` settings block, and the `.yml` WebSocket writer emits it
  // beside `timeout` for every request. It was readable here and not writable —
  // a read returned it under `settings.extra`, and the settings input rejects an
  // unmodelled key — so a read-modify-write could not put back what it had read.
  it('writes an authored interval into the .bru settings block', async () => {
    const content = await author('bru', {
      settings: { keepAliveInterval: 30000 },
      websocket: { messages: [{ title: 'hello', content: 'ping' }] },
    });

    expect(content).toContain('settings {\n  keepAliveInterval: 30000\n}\n');
    expect(parseRequest(content, { format: 'bru' }).settings)
      .toEqual(expect.objectContaining({ keepAliveInterval: 30000 }));
  });

  it('writes nothing for it in .bru when it was not authored, as upstream does', async () => {
    const content = await author('bru', {
      websocket: { messages: [{ title: 'hello', content: 'ping' }] },
    });

    expect(content).not.toContain('keepAliveInterval');
  });

  it('carries an authored interval in .yml, in upstream key order', async () => {
    const content = await author('yaml', {
      settings: { timeout: 4000, keepAliveInterval: 45000 },
      websocket: { messages: [{ title: 'hello', content: 'ping' }] },
    });

    expect(content).toContain('settings:\n  timeout: 4000\n  keepAliveInterval: 45000\n');
    expect(parseRequest(content, { format: 'yml' }).settings)
      .toEqual(expect.objectContaining({ keepAliveInterval: 45000 }));
  });

  it('survives a modify that sets some other setting', async () => {
    const collectionPath = await makeCollection('bru');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Echo',
      kind: 'ws',
      url: 'ws://localhost:8080',
      settings: { keepAliveInterval: 30000 },
      websocket: { messages: [{ title: 'hello', content: 'ping' }] },
    });
    if (!created.success || !created.path) throw new Error(`create failed: ${created.error}`);

    const modified = await builder.updateRequest(created.path, {
      settings: { timeout: 9000 },
    });
    if (!modified.success) throw new Error(`modify failed: ${modified.error}`);
    const content = await fs.readFile(created.path, 'utf-8');

    expect(content).toContain('timeout: 9000');
    expect(content).toContain('keepAliveInterval: 30000');
  });

  it('keeps a .bru interval of 0, which upstream drops on the way in', async () => {
    // 0 is upstream's spelling for "never ping", and its own reader takes the key
    // under a truthiness guard, so Bruno reads a file that says "never" as one
    // that says nothing. Both mean the same thing to a session, and keeping the
    // value is what lets a write reproduce the file it was read from.
    const content = await author('bru', {
      settings: { keepAliveInterval: 0 },
      websocket: { messages: [{ title: 'hello', content: 'ping' }] },
    });

    expect(content).toContain('keepAliveInterval: 0');
    expect(parseRequest(content, { format: 'bru' }).settings?.keepAliveInterval)
      .toBeUndefined();
  });
});
