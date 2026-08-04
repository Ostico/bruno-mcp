/**
 * A drift gate: everything this server writes, read back by Bruno's own reader.
 *
 * Every other test here asserts our bytes against our expectations, which cannot
 * catch the failure that actually costs users — a field written under a key
 * Bruno does not read. That shape parses, round-trips through our own parser,
 * and arrives at the runner empty. It has happened twice: `.yml` variables and
 * assertions written at the top level when upstream reads `runtime.variables`
 * and `runtime.assertions`, and a single-line `tags:` the runner treats as no
 * tags at all.
 *
 * So this file hands our output to `@usebruno/filestore` — the package Bruno's
 * own app and CLI parse with — and asserts the values land where upstream's
 * model puts them. It is a devDependency and nothing here runs at runtime.
 *
 * Two directions of drift make this go red, and both are the point:
 *   - we change a writer and stop speaking Bruno's dialect
 *   - upstream renames or relocates a field, and we have not followed yet
 *
 * A failure here is not automatically our bug. Read it as "the two sides
 * disagree", then decide which one moved.
 *
 * `filestore` needs `nanoid` at runtime but declares only `@types/nanoid`, so
 * `nanoid` is a devDependency too, pinned to v3 because the published build is
 * CommonJS. Its own `@usebruno/lang` is pinned exactly (0.38.0) and installs
 * nested, so the oracle reads with upstream's grammar version rather than ours.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseRequest } = require('@usebruno/filestore');
import { createRequestBuilder, RequestBuilder } from '../../../src/bruno/request';
import { createCollectionManager } from '../../../src/bruno/collection';
import type { CreateRequestInput } from '../../../src/bruno/types';

type Dialect = { format: 'bru' | 'yml'; collectionFormat: 'bru' | 'yaml' };

const DIALECTS: Dialect[] = [
  { format: 'bru', collectionFormat: 'bru' },
  { format: 'yml', collectionFormat: 'yaml' },
];

let builder: RequestBuilder;

beforeEach(() => {
  builder = createRequestBuilder();
});

/** Author one request and hand back what upstream's reader makes of the bytes. */
async function upstreamModel(
  dialect: Dialect,
  label: string,
  input: Omit<CreateRequestInput, 'collectionPath' | 'name'>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const tmpDir = await fs.mkdtemp(join(tmpdir(), `oracle-${dialect.format}-${label}-`));
  const collection = await createCollectionManager().createCollection({
    name: 'Oracle',
    outputPath: tmpDir,
    format: dialect.collectionFormat,
  });
  if (!collection.success) throw new Error(`collection setup failed: ${collection.error}`);

  const created = await builder.createRequest({
    ...input,
    collectionPath: join(tmpDir, 'Oracle'),
    name: 'Probe',
  });
  if (!created.success) throw new Error(`create failed: ${created.error}`);
  // Read the path the writer reports: it lowercases the request name, so a
  // rebuilt path resolves on macOS and fails on a case-sensitive filesystem.
  const source = await fs.readFile(created.path!, 'utf-8');

  return parseRequest(source, { format: dialect.format });
}

describe.each(DIALECTS)('what we write, read by Bruno ($format)', (dialect) => {
  it('carries method, url, headers and query params where upstream reads them', async () => {
    const model = await upstreamModel(dialect, 'basics', {
      method: 'POST',
      url: 'https://api.example.com/orders',
      headers: { 'X-Trace': 'abc' },
      query: { page: 2 },
    });

    expect(String(model.request.method).toUpperCase()).toBe('POST');
    expect(model.request.url).toContain('https://api.example.com/orders');
    expect(model.request.headers).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'X-Trace', value: 'abc' })]),
    );
    expect(model.request.params).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'page', value: '2' })]),
    );
  });

  it('carries a json body as the json mode with the authored text', async () => {
    const model = await upstreamModel(dialect, 'json', {
      method: 'POST',
      url: 'https://api.example.com/x',
      body: { type: 'json', content: '{"a":1}' },
    });

    expect(model.request.body.mode).toBe('json');
    expect(String(model.request.body.json)).toContain('"a"');
  });

  it('carries a graphql query into the graphql slot, not a bare string', async () => {
    const model = await upstreamModel(dialect, 'graphql', {
      method: 'POST',
      url: 'https://api.example.com/graphql',
      body: { type: 'graphql', content: '{ hero { name } }', variables: '{"id":"7"}' },
    });

    expect(model.request.body.mode).toBe('graphql');
    // Upstream reads `body.graphql.query`. A body written as a bare string
    // leaves this undefined while the file still declares the graphql mode.
    expect(model.request.body.graphql.query).toContain('hero');
    expect(String(model.request.body.graphql.variables)).toContain('"7"');
  });

  it('carries form-urlencoded pairs as entries', async () => {
    const model = await upstreamModel(dialect, 'urlenc', {
      method: 'POST',
      url: 'https://api.example.com/token',
      body: { type: 'form-urlencoded', content: 'grant_type=password&scope=all' },
    });

    // Upstream's in-memory mode is camelCase even though the file key is
    // `form-urlencoded`. The two spellings are not interchangeable: this one is
    // the model's, and it is what the runner switches on.
    expect(model.request.body.mode).toBe('formUrlEncoded');
    expect(model.request.body.formUrlEncoded).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'grant_type', value: 'password' })]),
    );
  });

  it('carries multipart parts as entries', async () => {
    const model = await upstreamModel(dialect, 'multipart', {
      method: 'POST',
      url: 'https://api.example.com/upload',
      body: {
        type: 'multipart-form',
        formData: [{ name: 'field', value: 'val', type: 'text' }],
      },
    });

    expect(model.request.body.mode).toBe('multipartForm');
    expect(model.request.body.multipartForm).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'field', value: 'val' })]),
    );
  });

  it('carries auth as a mode plus the matching config block', async () => {
    const model = await upstreamModel(dialect, 'auth', {
      method: 'GET',
      url: 'https://api.example.com/me',
      auth: { type: 'bearer', config: { token: 'tok_123' } },
    });

    expect(model.request.auth.mode).toBe('bearer');
    expect(model.request.auth.bearer.token).toBe('tok_123');
  });

  it('carries assertions where the runner looks for them', async () => {
    const model = await upstreamModel(dialect, 'assert', {
      method: 'GET',
      url: 'https://api.example.com/x',
      assert: [{ name: 'res.status', value: 'eq 200' }],
    });

    // The `.yml` half of this once sat under a top-level `assert:` key that
    // upstream never reads, so the runner saw a request with no assertions.
    expect(model.request.assertions).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'res.status', value: 'eq 200' })]),
    );
  });

  it('carries post-response variables where the runner looks for them', async () => {
    const model = await upstreamModel(dialect, 'vars', {
      method: 'GET',
      url: 'https://api.example.com/login',
      vars: { postResponse: [{ name: 'token', value: 'res.body.token' }] },
    });

    expect(model.request.vars.res).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'token', value: 'res.body.token' })]),
    );
  });
});
