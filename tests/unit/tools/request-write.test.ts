/**
 * The merged write tool infers what it is doing from which locator the caller
 * passed, rather than from a `mode` field that would only restate it.
 *
 * A batch hands the resolver its own `collectionPath` as `ambient`, once for the
 * whole call, so a caller writing ten requests into one collection names it once.
 * That is why the both-locators refusal is scoped to the keys the caller wrote in
 * *this item*: an ambient collection alongside an item's `filePath` is the normal
 * shape of a mixed batch, and refusing it would make batching useless for any run
 * that edits one request and creates another.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { BrunoMcpServer } from '../../../src/server';
import { createCollectionManager } from '../../../src/bruno/collection';
import { createRequestBuilder } from '../../../src/bruno/request';
import { resolveWriteTarget, registerWriteRequestTool } from '../../../src/tools/request-write';
import type { ToolContext } from '../../../src/tools/context';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * Register the tool against a stand-in server and keep the handler.
 *
 * Deliberately a real RequestBuilder writing to a real directory. A mocked
 * writer would report whatever it was told to report, and the property under
 * test here is what ends up in the file - above all, that a refused create
 * leaves the existing bytes exactly as they were.
 */
function registerAndCapture(): ToolHandler {
  let captured: ToolHandler | undefined;
  const ctx = {
    server: {
      registerTool: (_name: string, _config: unknown, handler: ToolHandler) => {
        captured = handler;
      },
    },
    requestBuilder: createRequestBuilder(),
  } as unknown as ToolContext;

  registerWriteRequestTool(ctx);
  if (!captured) throw new Error('write_request did not register a handler');
  return captured;
}

describe('resolveWriteTarget', () => {
  it('reads a filePath as an edit', () => {
    expect(resolveWriteTarget({ filePath: '/c/req.bru' }))
      .toEqual({ mode: 'edit', filePath: '/c/req.bru' });
  });

  it('reads collectionPath plus name as a create', () => {
    expect(resolveWriteTarget({ collectionPath: '/c', name: 'Login' }))
      .toEqual({ mode: 'create', collectionPath: '/c', name: 'Login' });
  });

  it('refuses both locators in one item rather than guessing which one wins', () => {
    const result = resolveWriteTarget({ filePath: '/c/req.bru', collectionPath: '/c', name: 'Login' });
    expect(result).toEqual({ error: expect.stringContaining('filePath') });
    expect((result as { error: string }).error).toContain('collectionPath');
  });

  it('refuses neither locator', () => {
    expect(resolveWriteTarget({})).toEqual({ error: expect.stringContaining('filePath') });
  });

  it('refuses a create-only field on an edit', () => {
    expect(resolveWriteTarget({ filePath: '/c/req.bru', folder: 'Auth' }))
      .toEqual({ error: expect.stringContaining('folder') });
  });

  it('refuses an edit-only field on a create', () => {
    expect(resolveWriteTarget({ collectionPath: '/c', name: 'Login', scriptMode: 'replace' }))
      .toEqual({ error: expect.stringContaining('scriptMode') });
  });

  // `name` is the one locator field both modes read, so it must not be treated
  // as create-only: an edit renames the request inside the file with it.
  it('accepts a name on an edit', () => {
    expect(resolveWriteTarget({ filePath: '/c/req.bru', name: 'Renamed' }))
      .toEqual({ mode: 'edit', filePath: '/c/req.bru' });
  });

  it('refuses a collectionPath with no name, naming the field it wants', () => {
    expect(resolveWriteTarget({ collectionPath: '/c' }))
      .toEqual({ error: expect.stringContaining('name') });
  });

  // Every mode-specific field is checked, not just the first one: a caller who
  // passes `kind` on an edit would otherwise have it silently dropped and
  // believe the transport changed.
  it.each(['kind', 'folder', 'sequence'])('refuses create-only field %s on an edit', (field) => {
    const result = resolveWriteTarget({ filePath: '/c/req.bru', [field]: 'x' });
    expect(result).toEqual({ error: expect.stringContaining(field) });
    expect((result as { error: string }).error).toContain('edit');
  });

  it.each(['filename', 'scriptMode'])('refuses edit-only field %s on a create', (field) => {
    const result = resolveWriteTarget({ collectionPath: '/c', name: 'Login', [field]: 'x' });
    expect(result).toEqual({ error: expect.stringContaining(field) });
    expect((result as { error: string }).error).toContain('create');
  });

  // A value the caller passed and a key that merely exists must not be treated
  // alike: the SDK hands the handler an object carrying the optional keys as
  // undefined, so rejecting on key presence would refuse every real call.
  it('ignores mode-specific keys explicitly set to undefined', () => {
    expect(resolveWriteTarget({ filePath: '/c/req.bru', folder: undefined, kind: undefined }))
      .toEqual({ mode: 'edit', filePath: '/c/req.bru' });
    expect(resolveWriteTarget({ collectionPath: '/c', name: 'Login', filename: undefined }))
      .toEqual({ mode: 'create', collectionPath: '/c', name: 'Login' });
  });

  // `sequence: 0` and an empty filename are falsy but present. Presence is what
  // the mode rule is about, so a truthiness test here would let both through.
  it('refuses a falsy but present mode-specific value', () => {
    expect(resolveWriteTarget({ filePath: '/c/req.bru', sequence: 0 }))
      .toEqual({ error: expect.stringContaining('sequence') });
    expect(resolveWriteTarget({ collectionPath: '/c', name: 'Login', filename: '' }))
      .toEqual({ error: expect.stringContaining('filename') });
  });

  // The batch form names its collection once, for the whole call. An ambient
  // value is not a locator the caller wrote in this item, so it neither triggers
  // the both-locators refusal nor outranks an item that names its own collection.
  it('reads an ambient collectionPath as a create when the item has no locator', () => {
    expect(resolveWriteTarget({ name: 'Login' }, { collectionPath: '/c' }))
      .toEqual({ mode: 'create', collectionPath: '/c', name: 'Login' });
  });

  it('lets an item filePath win over an ambient collectionPath, with no refusal', () => {
    expect(resolveWriteTarget({ filePath: '/c/req.bru' }, { collectionPath: '/c' }))
      .toEqual({ mode: 'edit', filePath: '/c/req.bru' });
  });

  it("prefers the item's own collectionPath over the ambient one", () => {
    expect(resolveWriteTarget({ collectionPath: '/other', name: 'Login' }, { collectionPath: '/c' }))
      .toEqual({ mode: 'create', collectionPath: '/other', name: 'Login' });
  });

  it('still wants a name when only the ambient collectionPath is available', () => {
    expect(resolveWriteTarget({}, { collectionPath: '/c' }))
      .toEqual({ error: expect.stringContaining('name') });
  });
});

describe('write_request handler', () => {
  let collectionPath: string;

  beforeEach(async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'bruno-write-request-'));
    const created = await createCollectionManager().createCollection({
      name: 'WriteAPI',
      outputPath: root,
      format: 'bru',
    });
    if (!created.success) throw new Error(`collection setup failed: ${created.error}`);
    collectionPath = join(root, 'WriteAPI');
  });

  /** The path is read back from the response, never rebuilt: the writer lowercases it. */
  function writtenPath(text: string): string {
    const at = text.lastIndexOf(': ');
    return text.slice(at + 2).trim();
  }

  it('creates a request and reports the path it wrote', async () => {
    const handler = registerAndCapture();

    const result = await handler({
      collectionPath,
      name: 'Login',
      method: 'POST',
      url: 'https://api.test/login',
    });

    expect(result.isError).toBeUndefined();
    const written = writtenPath(result.content[0].text);
    await expect(fs.readFile(written, 'utf8')).resolves.toContain('https://api.test/login');
  });

  // The whole reason the merged tool cannot simply forward every call to
  // createRequest: it is ensureDirectory plus writeFileAtomic, with no existence
  // check anywhere, so an edit-shaped call would silently overwrite the file and
  // report success.
  it('refuses to create over an existing file rather than overwriting it', async () => {
    const handler = registerAndCapture();
    const first = await handler({
      collectionPath,
      name: 'Login',
      method: 'POST',
      url: 'https://api.test/login',
    });
    const written = writtenPath(first.content[0].text);
    const original = await fs.readFile(written, 'utf8');

    const second = await handler({
      collectionPath,
      name: 'Login',
      method: 'GET',
      url: 'https://api.test/elsewhere',
    });

    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain('already exists');
    expect(second.content[0].text).toContain(written);
    await expect(fs.readFile(written, 'utf8')).resolves.toBe(original);
  });

  it('edits only the fields the call passed', async () => {
    const handler = registerAndCapture();
    const created = await handler({
      collectionPath,
      name: 'Login',
      method: 'POST',
      url: 'https://api.test/login',
    });
    const written = writtenPath(created.content[0].text);

    const edited = await handler({ filePath: written, method: 'PATCH' });

    expect(edited.isError).toBeUndefined();
    const onDisk = await fs.readFile(written, 'utf8');
    expect(onDisk).toContain('patch');
    expect(onDisk).toContain('https://api.test/login');
  });

  it('refuses a create with no url, naming the field', async () => {
    const handler = registerAndCapture();

    const result = await handler({ collectionPath, name: 'Login', method: 'GET' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('url');
  });

  describe('a batch of items', () => {
    /** Item lines are reported in input order, one per line, after a summary line. */
    function reportedPaths(text: string): string[] {
      return text
        .split('\n')
        .filter((line) => /^\d+\. /.test(line))
        .map((line) => line.slice(line.indexOf(': ') + 2).trim());
    }

    it('writes a mixed batch: one edit item and one create item under one collectionPath', async () => {
      const handler = registerAndCapture();
      const created = await handler({
        collectionPath,
        name: 'Login',
        method: 'POST',
        url: 'https://api.test/login',
      });
      const existing = writtenPath(created.content[0].text);

      const result = await handler({
        collectionPath,
        requests: [
          { filePath: existing, method: 'PATCH' },
          { name: 'List Users', method: 'GET', url: 'https://api.test/users' },
        ],
      });

      expect(result.isError).toBeUndefined();
      const paths = reportedPaths(result.content[0].text);
      expect(paths).toHaveLength(2);
      expect(paths[0]).toBe(existing);
      await expect(fs.readFile(existing, 'utf8')).resolves.toContain('patch');
      await expect(fs.readFile(paths[1], 'utf8')).resolves.toContain('https://api.test/users');
    });

    // The writer lowercases and hyphenates, so a caller cannot predict the path.
    // Reporting it per item is the only way a batch stays usable: without it the
    // caller has to list the collection again to find out what it just wrote.
    it('reports the path actually written for each item, in input order', async () => {
      const handler = registerAndCapture();

      const result = await handler({
        collectionPath,
        requests: [
          { name: 'Log In', method: 'POST', url: 'https://api.test/login' },
          { name: 'Fetch Me', method: 'GET', url: 'https://api.test/me' },
        ],
      });

      expect(reportedPaths(result.content[0].text)).toEqual([
        join(collectionPath, 'log-in.bru'),
        join(collectionPath, 'fetch-me.bru'),
      ]);
    });

    it('reports a per-item failure without abandoning the remaining items, and sets isError', async () => {
      const handler = registerAndCapture();

      const result = await handler({
        collectionPath,
        requests: [
          { name: 'First', method: 'GET', url: 'https://api.test/first' },
          { filePath: join(collectionPath, 'absent.bru'), method: 'GET' },
          { name: 'Third', method: 'GET', url: 'https://api.test/third' },
        ],
      });

      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain('2 of 3');
      // The items either side of the failure were still written.
      await expect(fs.readFile(join(collectionPath, 'first.bru'), 'utf8'))
        .resolves.toContain('https://api.test/first');
      await expect(fs.readFile(join(collectionPath, 'third.bru'), 'utf8'))
        .resolves.toContain('https://api.test/third');
    });

    // "Log In" and "log-in" are one file. Without this the second item silently
    // replaces the first and both are reported as written.
    it('refuses two items whose names resolve to the same file, before writing either', async () => {
      const handler = registerAndCapture();

      const result = await handler({
        collectionPath,
        requests: [
          { name: 'Log In', method: 'POST', url: 'https://api.test/login' },
          { name: 'log-in', method: 'GET', url: 'https://api.test/other' },
        ],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('log-in');
      await expect(fs.readFile(join(collectionPath, 'log-in.bru'), 'utf8')).rejects.toThrow();
    });

    it('refuses an edit item whose filePath is outside the batch collection', async () => {
      const handler = registerAndCapture();

      const result = await handler({
        collectionPath,
        requests: [
          { name: 'Inside', method: 'GET', url: 'https://api.test/inside' },
          { filePath: join(collectionPath, '..', 'elsewhere.bru'), method: 'GET' },
        ],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('elsewhere.bru');
      // Refused before anything was written, including the item that was fine.
      await expect(fs.readFile(join(collectionPath, 'inside.bru'), 'utf8')).rejects.toThrow();
    });

    it('refuses a batch with no collectionPath, naming the field', async () => {
      const handler = registerAndCapture();

      const result = await handler({
        requests: [{ name: 'Login', method: 'GET', url: 'https://api.test/login' }],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('collectionPath');
    });

    it('refuses a call that is both a batch and a single write', async () => {
      const handler = registerAndCapture();

      const result = await handler({
        collectionPath,
        name: 'Login',
        url: 'https://api.test/login',
        requests: [{ name: 'Other', method: 'GET', url: 'https://api.test/other' }],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('requests');
      expect(result.content[0].text).toContain('name');
    });

    it('refuses an empty batch', async () => {
      const handler = registerAndCapture();

      const result = await handler({ collectionPath, requests: [] });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('empty');
    });

    // Dependencies decide write order, and the builder numbers an unnumbered
    // request after the folder's existing ones, so the seq falls out of the order
    // it was written in. No second pass rewriting seq afterwards.
    it('writes items in dependency order, and still reports them in input order', async () => {
      const handler = registerAndCapture();

      const result = await handler({
        collectionPath,
        requests: [
          { name: 'Use Token', method: 'GET', url: 'https://api.test/me', dependencies: ['Get Token'] },
          { name: 'Get Token', method: 'POST', url: 'https://api.test/token' },
        ],
      });

      expect(result.isError).toBeUndefined();
      expect(reportedPaths(result.content[0].text)).toEqual([
        join(collectionPath, 'use-token.bru'),
        join(collectionPath, 'get-token.bru'),
      ]);
      const token = await fs.readFile(join(collectionPath, 'get-token.bru'), 'utf8');
      const use = await fs.readFile(join(collectionPath, 'use-token.bru'), 'utf8');
      expect(token).toContain('seq: 1');
      expect(use).toContain('seq: 2');
    });

    it('refuses a dependency on an item the batch does not contain', async () => {
      const handler = registerAndCapture();

      const result = await handler({
        collectionPath,
        requests: [
          { name: 'Use Token', method: 'GET', url: 'https://api.test/me', dependencies: ['Absent'] },
        ],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Absent');
      await expect(fs.readFile(join(collectionPath, 'use-token.bru'), 'utf8')).rejects.toThrow();
    });

    it('refuses a cycle in the batch dependencies, before writing anything', async () => {
      const handler = registerAndCapture();

      const result = await handler({
        collectionPath,
        requests: [
          { name: 'First', method: 'GET', url: 'https://api.test/first', dependencies: ['Second'] },
          { name: 'Second', method: 'GET', url: 'https://api.test/second', dependencies: ['First'] },
        ],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Circular');
      await expect(fs.readFile(join(collectionPath, 'first.bru'), 'utf8')).rejects.toThrow();
    });

    // The loop must not take the path lock: `createRequest` and `updateRequest`
    // each take it themselves and it is not reentrant, so a loop that took it
    // would deadlock. That failure is a hang rather than a throw, which at the
    // default timeout reports "failed to run" with no diagnosis — hence the
    // explicit, generous per-test timeout and the two items on one path.
    it('completes a two-item batch on one path within the timeout', async () => {
      const handler = registerAndCapture();

      const result = await handler({
        collectionPath,
        requests: [
          { name: 'Login', method: 'POST', url: 'https://api.test/login' },
          { filePath: join(collectionPath, 'login.bru'), method: 'PATCH' },
        ],
      });

      expect(result.isError).toBeUndefined();
      await expect(fs.readFile(join(collectionPath, 'login.bru'), 'utf8')).resolves.toContain('patch');
    }, 15_000);
  });

  it('surfaces a locator refusal as an error', async () => {
    const handler = registerAndCapture();

    const result = await handler({ filePath: '/c/req.bru', collectionPath, name: 'Login' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('filePath');
    expect(result.content[0].text).toContain('collectionPath');
  });
});

/**
 * The batch array must not re-send the field prose.
 *
 * `zod-to-json-schema` emits a bare `$ref` for a second occurrence of an
 * identical schema instance, but re-emits the `description` next to the ref when
 * only the inner type is shared and the `.optional()` wrapper is not. The
 * difference is the whole cost of the array: shared wrappers make it a few
 * hundred characters, and separate wrappers make it a second copy of every
 * description on the tool.
 */
describe('the shape write_request sends a client', () => {
  let schema: any;

  beforeAll(async () => {
    const server = new BrunoMcpServer();
    const client = new Client({ name: 'write-request-shape', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await (server as any).server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    await client.close();

    schema = tools.find((tool) => tool.name === 'write_request')?.inputSchema;
  });

  it('refers to the top-level fields from inside the array instead of repeating them', () => {
    const items = schema.properties.requests.items.properties;

    for (const field of ['name', 'url', 'method', 'body', 'auth', 'settings', 'scripts']) {
      expect(items[field]).toEqual({ $ref: `#/properties/${field}` });
    }
  });

  it('states each field description exactly once', () => {
    const serialised = JSON.stringify(schema);
    const described = schema.properties.name.description;

    expect(typeof described).toBe('string');
    expect(serialised.split(JSON.stringify(described).slice(1, -1)).length - 1).toBe(1);
  });
});
