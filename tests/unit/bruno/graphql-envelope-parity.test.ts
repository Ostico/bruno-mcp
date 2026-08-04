/**
 * The graphql envelope, byte for byte against Bruno.
 *
 * Upstream builds it in one object literal (`prepare-request.js:443-447`):
 *
 *     const graphqlQuery = {
 *       query: get(request, 'body.graphql.query'),
 *       variables: decomment(get(request, 'body.graphql.variables') || '{}')
 *     };
 *
 * Two consequences this file pins. `variables` is always there, because the `||`
 * substitutes `{}` for anything falsy. `query` is there unless nothing at all is
 * stored for it, because a bare `get` yields `undefined` and `JSON.stringify`
 * drops an undefined value — reachable from `.bru` only, since the `.yml` reader
 * flattens an absent query to `''` first (`parseGraphQLRequest.ts:33`).
 */

import { parseBruRequest, generateBruRequest } from '../../../src/bruno/bru-parser';
import { parseYamlRequest } from '../../../src/bruno/yaml-parser';
import { bruFileToYamlRequest, buildFetchOptions } from '../../../src/bruno/request-executor';

const graphqlYml = (body: string): string =>
  `info:\n  name: g\n  type: graphql\n  seq: 1\ngraphql:\n  url: https://api.example.com/gql\n${body}`;

const sendYml = async (yml: string, vars: Map<string, string> = new Map()) => {
  const { options, warnings } = await buildFetchOptions(parseYamlRequest(yml), vars, '/nowhere');
  return { body: String(options.body ?? ''), headers: options.headers, warnings: warnings ?? [] };
};

const sendBru = async (bru: string) => {
  const parsed = parseBruRequest(bru);
  const { options, warnings } = await buildFetchOptions(
    bruFileToYamlRequest(parsed),
    new Map(),
    '/nowhere',
  );
  return { body: String(options.body ?? ''), headers: options.headers, warnings: warnings ?? [] };
};

const contentType = (headers: Record<string, string> | undefined): string | undefined =>
  Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1];

describe('variables is always on the envelope', () => {
  it('sends an empty object when the request stores none', async () => {
    const { body } = await sendYml(graphqlYml('  body:\n    query: "{ a }"\n'));

    expect(body).toBe('{"query":"{ a }","variables":{}}');
  });

  it('sends an empty object when the block was authored empty', async () => {
    // `'' || '{}'` upstream. Reporting "your variables do not parse" for a block
    // the author left blank would fail a request Bruno runs.
    const { body } = await sendYml(graphqlYml('  body:\n    query: "{ a }"\n    variables: ""\n'));

    expect(body).toBe('{"query":"{ a }","variables":{}}');
  });

  it('still fails on a block holding only whitespace, as upstream does', async () => {
    // A space is not falsy, so upstream reaches `JSON.parse(' ')` and throws.
    // Substituting `{}` here would be kinder than Bruno and diverge from it.
    await expect(sendYml(graphqlYml('  body:\n    query: "{ a }"\n    variables: " "\n'))).rejects.toThrow(
      /Failed to parse GraphQL variables/,
    );
  });

  it('keeps what was stored when the block has variables in it', async () => {
    const { body } = await sendYml(
      graphqlYml('  body:\n    query: "{ a }"\n    variables: |-\n      {"id":7}\n'),
    );

    expect(body).toBe('{"query":"{ a }","variables":{"id":7}}');
  });

  it('puts query before variables, as upstream\'s object literal does', async () => {
    // Byte assertion, not a parsed comparison: key order is part of the payload a
    // proxy, a cache key or a recorded fixture sees.
    const { body } = await sendYml(
      graphqlYml('  body:\n    query: "{ a }"\n    variables: |-\n      {"id":7}\n'),
    );

    expect(body.indexOf('"query"')).toBeLessThan(body.indexOf('"variables"'));
  });
});

describe('a .bru file with no graphql block still sends an envelope', () => {
  const bru = [
    'meta {',
    '  name: g',
    '  type: graphql',
    '  seq: 1',
    '}',
    '',
    'post {',
    '  url: https://api.example.com/gql',
    '  body: graphql',
    '  auth: none',
    '}',
    '',
  ].join('\n');

  it('omits the query key rather than sending an empty one', async () => {
    // Upstream's `get(request, 'body.graphql.query')` is undefined here, and
    // JSON.stringify drops it. This is the one case where the two dialects differ
    // on the wire, and the difference is Bruno's rather than ours.
    const { body } = await sendBru(bru);

    expect(body).toBe('{"variables":{}}');
  });

  it('sends application/json anyway', async () => {
    // The branch used to be skipped when nothing was stored, which sent no body
    // and no content type — a graphql request that looked like a bodyless GET.
    const { headers } = await sendBru(bru);

    expect(contentType(headers)).toBe('application/json');
  });

  it('warns that there is no query', async () => {
    const { warnings } = await sendBru(bru);

    expect(warnings.some((w) => w.includes('no query'))).toBe(true);
  });

  it('keeps the declaration through a rewrite, without inventing a block', async () => {
    // The declared type is on the model now, which means the writer sees it. It
    // has to write the `body:` line back and nothing else: an empty
    // `body:graphql {}` block is a parse error in the grammar, so inventing one
    // would produce a file neither this tool nor Bruno can read again.
    const written = generateBruRequest(parseBruRequest(bru));

    expect(written).toContain('body: graphql');
    expect(written).not.toContain('body:graphql');
    expect(() => parseBruRequest(written)).not.toThrow();
  });
});
