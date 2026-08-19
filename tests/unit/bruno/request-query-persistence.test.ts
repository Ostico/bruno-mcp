/**
 * Query parameters supplied through the MCP surface must reach the file on disk.
 *
 * `write_request` and `write_request` both advertise a `query` input. PR #67
 * made declared parameters actually get *sent*, but that only helps a file that
 * declares them — and the writing side had its own holes:
 *
 *  - `write_request` on a .bru collection stored the pairs on `bruFile.query`,
 *    a field the .bru writer never serializes. The request landed on disk with
 *    no params block at all.
 *  - `write_request` ignored `updates.query` in *both* formats, so the call
 *    reported success and changed nothing.
 *
 * These tests assert against the bytes on disk and, for the .bru path, against a
 * request a real server received — not against the object handed to a mock. The
 * pre-existing coverage for `query` mocked `updateRequest` itself, which is the
 * function that dropped the data.
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createServer, Server } from 'http';
import { createCollectionManager } from '../../../src/bruno/collection.js';
import { createRequestBuilder, RequestBuilder } from '../../../src/bruno/request.js';
import { parseBruRequest } from '../../../src/bruno/bru-parser.js';
import { parseYamlRequest } from '../../../src/bruno/yaml-parser.js';
import { bruFileToYamlRequest, buildFetchOptions } from '../../../src/bruno/request-executor.js';

let builder: RequestBuilder;

beforeEach(() => {
  builder = createRequestBuilder();
});

/** Create a collection in the requested format and return its path. */
async function makeCollection(format: 'yaml' | 'bru', label: string): Promise<string> {
  const tmpDir = await fs.mkdtemp(join(tmpdir(), `bruno-query-${label}-`));
  const manager = createCollectionManager();
  const result = await manager.createCollection({
    name: 'QueryAPI',
    outputPath: tmpDir,
    format,
  });
  expect(result.success).toBe(true);
  return join(tmpDir, 'QueryAPI');
}

describe('write_request persists query parameters', () => {
  it('writes a params block into a .bru request', async () => {
    const collectionPath = await makeCollection('bru', 'create-bru');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Search',
      method: 'GET',
      url: 'https://api.example.com/search',
      query: { page: '2', limit: 50 },
    });
    expect(created.success).toBe(true);

    const content = await fs.readFile(created.path!, 'utf-8');
    // The pairs must survive as a real params block, not vanish into a field the
    // writer does not know about.
    expect(content).toContain('params:query');

    const parsed = parseBruRequest(content);
    const pairs = (parsed.params ?? []).map((p) => [p.name, p.value, p.type]);
    expect(pairs).toEqual([
      ['page', '2', 'query'],
      ['limit', '50', 'query'],
    ]);
    expect(parsed.params?.every((p) => p.enabled)).toBe(true);
  });

  it('writes query params into a .yml request (already worked — pinned)', async () => {
    const collectionPath = await makeCollection('yaml', 'create-yml');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Search',
      method: 'GET',
      url: 'https://api.example.com/search',
      query: { page: '2' },
    });
    expect(created.success).toBe(true);

    const parsed = parseYamlRequest(await fs.readFile(created.path!, 'utf-8'));
    expect(parsed.http.params).toEqual([{ name: 'page', value: '2', type: 'query' }]);
  });
});

describe('write_request persists query parameters', () => {
  it('adds a params block to an existing .bru request', async () => {
    const collectionPath = await makeCollection('bru', 'modify-bru');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Search',
      method: 'GET',
      url: 'https://api.example.com/search',
    });
    const updated = await builder.updateRequest(created.path!, { query: { page: '3' } });
    expect(updated.success).toBe(true);

    const parsed = parseBruRequest(await fs.readFile(created.path!, 'utf-8'));
    expect((parsed.params ?? []).map((p) => [p.name, p.value])).toEqual([['page', '3']]);
  });

  it('adds params to an existing .yml request', async () => {
    const collectionPath = await makeCollection('yaml', 'modify-yml');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Search',
      method: 'GET',
      url: 'https://api.example.com/search',
    });
    const updated = await builder.updateRequest(created.path!, { query: { page: '3' } });
    expect(updated.success).toBe(true);

    const parsed = parseYamlRequest(await fs.readFile(created.path!, 'utf-8'));
    expect(parsed.http.params).toEqual([{ name: 'page', value: '3', type: 'query' }]);
  });

  it('replaces query params without discarding declared path params', async () => {
    // Query params are replaced wholesale, the way `headers` already are. Path
    // params address a different thing and must not be collateral damage.
    const collectionPath = await makeCollection('yaml', 'modify-keeps-path');
    const created = await builder.createRequest({
      collectionPath,
      name: 'ById',
      method: 'GET',
      url: 'https://api.example.com/u/:id',
      query: { old: 'gone' },
    });

    // Author a path param alongside the query one.
    const withPath = parseYamlRequest(await fs.readFile(created.path!, 'utf-8'));
    withPath.http.params = [
      ...(withPath.http.params ?? []),
      { name: 'id', value: '42', type: 'path' },
    ];
    const { generateYamlRequest } = await import('../../../src/bruno/yaml-generator.js');
    await fs.writeFile(created.path!, generateYamlRequest(withPath), 'utf-8');

    await builder.updateRequest(created.path!, { query: { fresh: '1' } });

    const parsed = parseYamlRequest(await fs.readFile(created.path!, 'utf-8'));
    expect(parsed.http.params).toEqual([
      { name: 'id', value: '42', type: 'path' },
      { name: 'fresh', value: '1', type: 'query' },
    ]);
  });
});

describe('a created .bru request actually sends its query string', () => {
  let server: Server;
  let port: number;
  let receivedUrl: string | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      receivedUrl = req.url;
      res.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reaches the wire end to end, write_request through send', async () => {
    // The whole point: an agent creates a request with query params and running
    // the collection must send them. Asserting only on the file would miss a
    // break anywhere downstream.
    const collectionPath = await makeCollection('bru', 'wire');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Search',
      method: 'GET',
      url: `http://127.0.0.1:${port}/search`,
      query: { page: '2' },
    });

    const yaml = bruFileToYamlRequest(parseBruRequest(await fs.readFile(created.path!, 'utf-8')));
    const { url, options } = await buildFetchOptions(yaml, new Map());
    await fetch(url, options);
    expect(receivedUrl).toBe('/search?page=2');
  });
});

describe('request settings survive the .bru translation', () => {
  it('forwards settings so a .bru timeout is not silently ignored', async () => {
    // buildFetchOptions reads the timeout, redirect policy, TLS options and proxy
    // off yaml.settings. bruFileToYamlRequest did not forward settings at all, so
    // every one of them was unreachable from a .bru request.
    const source = `meta {
  name: r
  type: http
  seq: 1
}

get {
  url: https://api.example.com/x
  body: none
  auth: none
}

settings {
  timeout: 1234
}
`;
    const parsed = parseBruRequest(source);
    expect(parsed.settings?.timeout).toBe(1234);

    const yaml = bruFileToYamlRequest(parsed);
    expect(yaml.settings?.timeout).toBe(1234);
  });
});
