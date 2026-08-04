/**
 * A graphql body with no query, at both ends (defect-register L9).
 *
 * The two ends get opposite treatment on purpose. On the **run** path an empty
 * query is still sent, because upstream sends a queryless body too and a server
 * 400 is the honest answer — but it is now named in a warning, because the
 * request looks fine from the outside and its failure does not say why. On the
 * **author** path it is refused, because writing a request that cannot run and
 * reporting success is the shape a caller cannot diagnose from inside.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequestBuilder, RequestBuilder } from '../../../src/bruno/request';
import { createCollectionManager } from '../../../src/bruno/collection';
import { parseYamlRequest } from '../../../src/bruno/yaml-parser';
import { buildFetchOptions } from '../../../src/bruno/request-executor';

let builder: RequestBuilder;

/** A `.yml` graphql request: a top-level `graphql:` section, not `http:`. */
const graphqlYml = (body: string): string =>
  `info:\n  name: g\n  type: graphql\n  seq: 1\ngraphql:\n  url: https://api.example.com/gql\n${body}`;

const send = async (yml: string, vars: Map<string, string> = new Map()) => {
  const { options, warnings } = await buildFetchOptions(parseYamlRequest(yml), vars, '/nowhere');
  return { body: options.body, warnings: warnings ?? [] };
};

const emptyQueryWarning = (warnings: string[]): string | undefined =>
  warnings.find((w) => w.includes('no query'));

describe('the run path sends an empty query and says so', () => {
  it('warns when the graphql body has no query at all', async () => {
    const { body, warnings } = await send(graphqlYml(''));

    // Unchanged on the wire: upstream sends a queryless body rather than
    // refusing, and diverging would make a collection behave differently here
    // than under `bru run`.
    expect(body).toBe('{"query":""}');
    expect(emptyQueryWarning(warnings)).toContain('no query');
  });

  it('warns when the body carries variables but no query', async () => {
    const { body, warnings } = await send(graphqlYml('  body:\n    variables: |\n      {"a":1}\n'));

    expect(body).toBe('{"query":"","variables":{"a":1}}');
    expect(emptyQueryWarning(warnings)).toBeDefined();
  });

  it('warns when a query is whitespace only, which no server accepts either', async () => {
    const { warnings } = await send(graphqlYml('  body:\n    query: "   "\n'));

    expect(emptyQueryWarning(warnings)).toBeDefined();
  });

  it('warns on the substituted query, not the authored one', async () => {
    // The author wrote something; it resolved to nothing. What goes on the wire
    // is what the warning has to be about, or a `{{q}}` that resolves empty is
    // exactly the case that stays silent.
    const { body, warnings } = await send(
      graphqlYml('  body:\n    query: "{{q}}"\n'),
      new Map([['q', '']]),
    );

    expect(body).toBe('{"query":""}');
    expect(emptyQueryWarning(warnings)).toBeDefined();
  });

  it('stays quiet for a request that has a query', async () => {
    const { body, warnings } = await send(graphqlYml('  body:\n    query: "query { a }"\n'));

    expect(body).toBe('{"query":"query { a }"}');
    expect(emptyQueryWarning(warnings)).toBeUndefined();
  });
});

describe('the author path refuses to write a graphql body with no query', () => {
  const create = async (
    format: 'yaml' | 'bru',
    body: NonNullable<Parameters<RequestBuilder['createRequest']>[0]['body']>,
    name = 'R',
  ) => {
    const tmpDir = await fs.mkdtemp(join(tmpdir(), 'gql-empty-'));
    const created = await createCollectionManager().createCollection({
      name: 'C',
      outputPath: tmpDir,
      format,
    });
    if (!created.success) throw new Error(`setup failed: ${created.error}`);
    return builder.createRequest({
      collectionPath: join(tmpDir, 'C'),
      name,
      method: 'POST',
      url: 'https://api.example.com/gql',
      body,
    });
  };

  beforeEach(() => {
    builder = createRequestBuilder();
  });

  it.each(['yaml', 'bru'] as const)('refuses variables without a query (%s)', async (format) => {
    const result = await create(format, { type: 'graphql', variables: '{"a":1}' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/query/i);
  });

  it.each(['yaml', 'bru'] as const)('refuses a graphql body with nothing in it (%s)', async (format) => {
    const result = await create(format, { type: 'graphql' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/query/i);
  });

  it('refuses a query that is only whitespace', async () => {
    const result = await create('yaml', { type: 'graphql', content: '   ' });

    expect(result.success).toBe(false);
  });

  it.each(['yaml', 'bru'] as const)('still writes a real graphql body (%s)', async (format) => {
    const result = await create(format, {
      type: 'graphql',
      content: 'query { a }',
      variables: '{"a":1}',
    });

    expect(result.success).toBe(true);
    const raw = await fs.readFile(result.path!, 'utf-8');
    expect(raw).toContain('query { a }');
  });

  it('refuses on modify too, rather than only on create', async () => {
    const tmpDir = await fs.mkdtemp(join(tmpdir(), 'gql-empty-mod-'));
    const created = await createCollectionManager().createCollection({
      name: 'C',
      outputPath: tmpDir,
      format: 'yaml',
    });
    if (!created.success) throw new Error(`setup failed: ${created.error}`);
    const collectionPath = join(tmpDir, 'C');

    const request = await builder.createRequest({
      collectionPath,
      name: 'M',
      method: 'POST',
      url: 'https://api.example.com/gql',
      body: { type: 'graphql', content: 'query { a }' },
    });
    if (!request.success) throw new Error(`setup failed: ${request.error}`);

    const modified = await builder.updateRequest(request.path!, {
      body: { type: 'graphql', variables: '{"a":1}' },
    });

    expect(modified.success).toBe(false);
    expect(modified.error).toMatch(/query/i);
    // The query that was there is still there: a refused modify writes nothing.
    expect(await fs.readFile(request.path!, 'utf-8')).toContain('query { a }');
  });
});
