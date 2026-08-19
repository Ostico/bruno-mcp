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

import { createCollectionManager } from '../../../src/bruno/collection';
import { createRequestBuilder } from '../../../src/bruno/request';
import { resolveWriteTarget, registerWriteRequestTool } from '../../../src/tools/request-write';
import type { ToolContext } from '../../../src/tools/context';

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

  it('surfaces a locator refusal as an error', async () => {
    const handler = registerAndCapture();

    const result = await handler({ filePath: '/c/req.bru', collectionPath, name: 'Login' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('filePath');
    expect(result.content[0].text).toContain('collectionPath');
  });
});
