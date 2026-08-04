/**
 * What the .bru writer persists for each body mode, on create and on modify.
 *
 * Two of Bruno's body modes are not plain strings, and the writer treated every
 * mode as one:
 *
 *   graphql  upstream expects `{ query, variables? }`. Handed a bare string, its
 *            generator tests `body.graphql.query`, finds undefined on a string,
 *            and skips the block entirely. The method header still said
 *            `body: graphql`, so the file looked authored while the query text
 *            was gone and the request went out with no body at all.
 *
 *   file     upstream expects an array of `{ filePath, contentType?, selected? }`
 *            and calls `.filter` on it. Handed a bare string it threw
 *            `items.filter is not a function`, so authoring a file body failed
 *            outright.
 *
 * Separately, the modify path had drifted from the create path: create knew
 * about multipart formData, modify did not, so switching a request to a
 * multipart body silently dropped every part. Both paths now go through one
 * shared builder, which is what stops them drifting again.
 *
 * Assertions read the bytes on disk. A round-trip through our own parser proves
 * nothing, because our parser tolerates our own malformed output.
 *
 * Shapes verified against @usebruno/lang v2 jsonToBru.js: `body:file` at :577-599
 * (`enabled(body.file, 'selected')`) and `body:graphql` at :601-611
 * (`body.graphql.query`).
 */

import { createRequestBuilder, RequestBuilder } from '../../../src/bruno/request.js';
import { createCollectionManager } from '../../../src/bruno/collection.js';
import { RequestExecutor } from '../../../src/bruno/request-executor.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const mockFetch = jest.fn();
(global as unknown as { fetch: unknown }).fetch = mockFetch;

jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
}));

let builder: RequestBuilder;

beforeEach(() => {
  builder = createRequestBuilder();
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    text: async () => '{}',
    ok: true,
  } as unknown as Response);
});

async function bruCollection(label: string): Promise<string> {
  const tmpDir = await fs.mkdtemp(join(tmpdir(), `bruno-brubody-${label}-`));
  const result = await createCollectionManager().createCollection({
    name: 'BodyAPI',
    outputPath: tmpDir,
    format: 'bru',
  });
  if (!result.success) throw new Error(`collection setup failed: ${result.error}`);
  return join(tmpDir, 'BodyAPI');
}

/** Author a request with the given body and hand back its bytes and path. */
async function create(
  label: string,
  body: { type: string; content?: string; formData?: Array<Record<string, unknown>> },
): Promise<{ source: string; filePath: string; collectionPath: string }> {
  const collectionPath = await bruCollection(label);
  const created = await builder.createRequest({
    collectionPath,
    name: 'Bodied',
    method: 'POST',
    url: 'https://api.example.com/x',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: body as any,
  });
  if (!created.success) throw new Error(`create failed: ${created.error}`);
  // Read back the path the writer reports rather than rebuilding it from the
  // request name: the writer lowercases that name, so a hardcoded `Bodied.bru`
  // resolves on a case-insensitive filesystem and fails on a case-sensitive one.
  const filePath = created.path;
  if (!filePath) throw new Error('create reported success but returned no path');
  return { source: await fs.readFile(filePath, 'utf-8'), filePath, collectionPath };
}

describe('.bru create writes the structured body modes', () => {
  it('writes the query into a body:graphql block', async () => {
    const { source } = await create('gql-create', {
      type: 'graphql',
      content: '{ hero { name } }',
    });

    // The block itself, not just the `body: graphql` mode in the method header —
    // the header alone is what made a dropped query look like a written one.
    expect(source).toContain('body:graphql {');
    expect(source).toContain('{ hero { name } }');
  });

  it('writes a file body as a body:file entry instead of failing', async () => {
    const { source } = await create('file-create', {
      type: 'file',
      content: '/var/data/payload.bin',
    });

    expect(source).toContain('body:file {');
    // Upstream renders each entry as `file: @file(path)`.
    expect(source).toContain('@file(/var/data/payload.bin)');
  });
});

describe('.bru modify writes the structured body modes', () => {
  it('writes a body:graphql block when switching a request to graphql', async () => {
    const { filePath } = await create('gql-modify', { type: 'json', content: '{"a":1}' });

    const result = await builder.updateRequest(filePath, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: { type: 'graphql', content: 'query Q { id }' } as any,
    });
    expect(result.success).toBe(true);

    const source = await fs.readFile(filePath, 'utf-8');
    expect(source).toContain('body:graphql {');
    expect(source).toContain('query Q { id }');
  });

  it('writes a body:file entry when switching a request to a file body', async () => {
    const { filePath } = await create('file-modify', { type: 'json', content: '{"a":1}' });

    const result = await builder.updateRequest(filePath, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: { type: 'file', content: '/var/data/other.bin' } as any,
    });
    expect(result.success).toBe(true);

    const source = await fs.readFile(filePath, 'utf-8');
    expect(source).toContain('body:file {');
    expect(source).toContain('@file(/var/data/other.bin)');
  });

  it('keeps multipart parts when switching a request to a multipart body', async () => {
    const { filePath } = await create('multi-modify', { type: 'json', content: '{"a":1}' });

    const result = await builder.updateRequest(filePath, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: {
        type: 'multipart-form',
        formData: [{ name: 'field', value: 'val', type: 'text' }],
      } as any,
    });
    expect(result.success).toBe(true);

    const source = await fs.readFile(filePath, 'utf-8');
    // The create path knew about formData and the modify path did not, so every
    // part was dropped and the multipart body arrived empty.
    expect(source).toContain('field');
    expect(source).toContain('val');
  });

  it('still writes form-urlencoded entries', async () => {
    const { filePath } = await create('urlenc-modify', { type: 'json', content: '{"a":1}' });

    const result = await builder.updateRequest(filePath, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: { type: 'form-urlencoded', content: 'grant_type=password' } as any,
    });
    expect(result.success).toBe(true);

    const source = await fs.readFile(filePath, 'utf-8');
    expect(source).toContain('grant_type: password');
  });
});

describe('the graphql file we write is executable', () => {
  it('sends the authored query on the wire', async () => {
    // The write side and the read side have to agree. The executor builds its
    // envelope from `body.data.query`, so a body written as a bare string would
    // reach here as no body at all.
    const { collectionPath } = await create('gql-exec', {
      type: 'graphql',
      content: '{ hero { name } }',
    });

    const run = await RequestExecutor.executeCollection(collectionPath, {});
    expect(run.summary.failed).toBe(0);

    const sent = String(mockFetch.mock.calls[0]?.[1]?.body ?? '');
    // `variables` with nothing in it, not an absent key: upstream reads the block
    // as `... || '{}'`, so every graphql envelope carries one.
    expect(JSON.parse(sent)).toEqual({ query: '{ hero { name } }', variables: {} });
  });
});
