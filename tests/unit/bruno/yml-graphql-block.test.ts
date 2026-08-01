/**
 * A `.yml` graphql request belongs in its own top-level `graphql:` block.
 *
 * Bruno does not put one under `http:`. It writes a sibling `graphql:` block with
 * its own `method`, `url`, `headers`, `params`, `body` and `auth`, and dispatches
 * on `info.type` to pick a parser — read from `stringifyGraphQLRequest.ts` and
 * `parseGraphQLRequest.ts` in the upstream checkout, not inferred. This server
 * wrote the whole request under `http:` with the query in `http.body`. Both halves
 * of this codebase agreed, so it round-tripped here and executed correctly; Bruno
 * opening the same file got a graphql request with no url and no query.
 *
 * Assertions read the emitted text and the key order in it, because agreement
 * between our writer and our parser is exactly what hid this: a round-trip oracle
 * confirms only that we are self-consistent.
 *
 * The migration direction matters as much as the fix. Every graphql `.yml` this
 * server has already written uses `http:`, so those files must keep loading, and
 * the next write must move them.
 */

import { parseYamlRequest } from '../../../src/bruno/yaml-parser.js';
import { generateYamlRequest } from '../../../src/bruno/yaml-generator.js';

/** A graphql request as Bruno writes one. */
const BRUNO_AUTHORED = `info:
  name: Fetch me
  type: graphql
  seq: 1

graphql:
  method: POST
  url: https://api.example.test/graphql
  headers:
    - name: Authorization
      value: Bearer {{token}}
  params:
    - name: trace
      value: "1"
      type: query
  body:
    query: |-
      query Me {
        me { id }
      }
    variables: |-
      {
        "id": "{{userId}}"
      }
  auth:
    type: bearer
    token: "{{token}}"

runtime:
  scripts:
    - type: before-request
      code: bru.setVar('x', 1)

settings:
  encodeUrl: true

docs: fetches the current user
`;

/** Re-emit a document without changing anything. */
function rewrite(source: string): string {
  return generateYamlRequest(parseYamlRequest(source));
}

/** Top-level keys of the emitted document, in order. */
function topLevelKeys(yaml: string): string[] {
  return yaml
    .split('\n')
    .filter((l) => l.length > 0 && !/^\s/.test(l) && l.includes(':'))
    .map((l) => l.split(':')[0]);
}

/** Keys of a block, in the order they were emitted. */
function blockKeys(yaml: string, block: string): string[] {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === `${block}:`);
  if (start === -1) return [];
  const keys: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.length > 0 && !/^\s/.test(line)) break;
    const m = /^ {2}([A-Za-z]\w*):/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

describe('a graphql request is written where Bruno reads it', () => {
  it('emits a top-level graphql block and no http block', () => {
    const out = rewrite(BRUNO_AUTHORED);
    expect(out).toMatch(/^graphql:/m);
    expect(out).not.toMatch(/^http:/m);
  });

  it('keeps upstream key order inside the block, params before body', () => {
    // Not cosmetic: the http block puts params AFTER body, and copying that order
    // here would differ from Bruno byte for byte.
    expect(blockKeys(rewrite(BRUNO_AUTHORED), 'graphql')).toEqual([
      'method',
      'url',
      'headers',
      'params',
      'body',
      'auth',
    ]);
  });

  it('writes the body as query and variables, with no envelope keys', () => {
    const out = rewrite(BRUNO_AUTHORED);
    expect(out).toContain('query:');
    expect(out).toContain('variables:');
    // The block IS the type, so the body has nothing to record. `info.type` is the
    // only legitimate `type: graphql` in the file, hence exactly one.
    expect(out.match(/type: graphql/g)).toHaveLength(1);
    expect(out).not.toMatch(/^\s+data:/m);
  });

  it('leaves runtime, settings and docs as top-level siblings', () => {
    expect(topLevelKeys(rewrite(BRUNO_AUTHORED))).toEqual([
      'info',
      'graphql',
      'runtime',
      'settings',
      'docs',
    ]);
  });

  it('always records info.type, because Bruno dispatches on it', () => {
    expect(rewrite(BRUNO_AUTHORED)).toContain('type: graphql');
  });

  it('separates the block with a blank line, as Bruno does', () => {
    expect(rewrite(BRUNO_AUTHORED)).toMatch(/\n\ngraphql:/);
  });
});

describe('the body survives exactly as authored', () => {
  it('does not reformat the variables JSON', () => {
    // Kept as text rather than parsed. Parsing would re-serialise on write, which
    // reflows the author's JSON and would break a placeholder that is not valid
    // JSON on its own.
    const parsed = parseYamlRequest(BRUNO_AUTHORED);
    const variables = (parsed.http.body?.data as { variables?: string }).variables;
    expect(variables).toContain('"id": "{{userId}}"');
    expect(rewrite(BRUNO_AUTHORED)).toContain('"id": "{{userId}}"');
  });

  it('keeps the query text through a round-trip', () => {
    const parsed = parseYamlRequest(rewrite(BRUNO_AUTHORED));
    expect((parsed.http.body?.data as { query?: string }).query).toContain('me { id }');
  });

  it('omits body entirely when there is no query and no variables', () => {
    // Upstream writes each half only when non-empty and omits the key when neither
    // is, so an empty query must not become `body: { query: "" }`.
    const out = generateYamlRequest({
      info: { name: 'Empty', type: 'graphql' },
      http: { method: 'POST', url: 'https://e.test/graphql', body: { type: 'graphql', data: { query: '' } } },
    });
    expect(out).toMatch(/^graphql:/m);
    expect(out).not.toContain('body:');
  });

  it('takes a query stored as a bare string, which is what this server authors', () => {
    // The authoring path stores a query given as `content` as a plain string rather
    // than the envelope. Treating that as "not a graphql body" dropped the query of
    // every graphql request created here.
    const out = generateYamlRequest({
      info: { name: 'FromContent', type: 'graphql' },
      http: { method: 'POST', url: 'https://e.test/graphql', body: { type: 'graphql', data: '{ me { id } }' } },
    });
    expect(out).toContain('query: "{ me { id } }"');
  });

  it.each([
    ['no body at all', undefined],
    ['an empty string where the query should be', { type: 'graphql', data: '' }],
    ['a null where the envelope should be', { type: 'graphql', data: null }],
    ['a pair list, which belongs to a form body', { type: 'graphql', data: [{ name: 'a', value: '1' }] }],
    ['a body of some other mode', { type: 'json', data: '{"a":1}' }],
  ])('writes the block with no body given %s', (_label, body) => {
    // Each of these still has to produce a usable request rather than throwing or
    // emitting `body:` with nothing under it.
    const out = generateYamlRequest({
      info: { name: 'R', type: 'graphql' },
      http: { method: 'POST', url: 'https://e.test/graphql', body: body as never },
    });
    expect(out).toMatch(/^graphql:/m);
    expect(out).toContain('url: https://e.test/graphql');
    expect(out).not.toMatch(/^\s+body:/m);
  });

  it('defaults the method to POST, not GET, when the block omits it', () => {
    const parsed = parseYamlRequest(`info:
  name: R
  type: graphql

graphql:
  url: https://e.test/graphql
`);
    expect(parsed.http.method).toBe('POST');
  });
});

describe('against a file Bruno actually generated', () => {
  /**
   * Copied verbatim from upstream's own test collection
   * (`tests/graphql/query-builder/fixtures/collection/test-graphql.yml`), so the
   * structure here is Bruno's output rather than this repo's reading of a writer.
   *
   * Note `auth: inherit` as a bare token, and that upstream writes all four
   * `settings` defaults for a graphql request. This server writes `settings` only
   * when the model carries one — the open question about emitting defaults a caller
   * never asked for is M9's second half, deliberately not settled here.
   */
  const UPSTREAM_FIXTURE = `info:
  name: test-graphql
  type: graphql
  seq: 1

graphql:
  method: POST
  url: http://localhost:8081/api/graphql
  body:
    query: |-

    variables: |-
      {}
  auth: inherit

settings:
  encodeUrl: true
  timeout: 0
  followRedirects: true
  maxRedirects: 5
`;

  it('reads every part of it', () => {
    const parsed = parseYamlRequest(UPSTREAM_FIXTURE);
    expect(parsed.info.type).toBe('graphql');
    expect(parsed.info.seq).toBe(1);
    expect(parsed.http.method).toBe('POST');
    expect(parsed.http.url).toBe('http://localhost:8081/api/graphql');
    expect(parsed.http.body?.type).toBe('graphql');
    expect((parsed.http.body?.data as { variables?: string }).variables).toBe('{}');
    expect(parsed.http.auth).toBe('inherit');
    expect(parsed.settings?.encodeUrl).toBe(true);
    expect(parsed.settings?.timeout).toBe(0);
    expect(parsed.settings?.maxRedirects).toBe(5);
  });

  it('re-emits it in the same shape, keeping the bare inherit token', () => {
    const out = rewrite(UPSTREAM_FIXTURE);
    expect(topLevelKeys(out)).toEqual(['info', 'graphql', 'settings']);
    expect(out).toContain('auth: inherit');
    expect(out).toContain('url: http://localhost:8081/api/graphql');
    expect(out).toContain('timeout: 0');
  });

  it('drops the empty query rather than writing a blank block scalar', () => {
    // Upstream's own writer only emits `query` when it is a non-empty string, so an
    // empty one is not round-tripped back. The fixture carries a blank `query: |-`
    // from a different write path; matching the writer is the correct target.
    const out = rewrite(UPSTREAM_FIXTURE);
    expect(out).toContain('variables:');
    expect(out).not.toMatch(/^\s+query:/m);
  });
});

describe('files this server already wrote keep loading, and get moved', () => {
  const LEGACY_UNDER_HTTP = `info:
  name: Legacy
  type: graphql

http:
  method: POST
  url: https://api.example.test/graphql
  body:
    type: graphql
    data:
      query: "{ me { id } }"
      variables: "{}"
`;

  it('reads a graphql request that was stored under http', () => {
    const parsed = parseYamlRequest(LEGACY_UNDER_HTTP);
    expect(parsed.http.url).toBe('https://api.example.test/graphql');
    expect(parsed.http.body?.type).toBe('graphql');
    expect((parsed.http.body?.data as { query?: string }).query).toBe('{ me { id } }');
  });

  it('moves it into the graphql block on the next write', () => {
    const out = rewrite(LEGACY_UNDER_HTTP);
    expect(out).toMatch(/^graphql:/m);
    expect(out).not.toMatch(/^http:/m);
    expect(out).toContain('query:');
  });

  it('prefers the graphql block when a file somehow carries both', () => {
    // Upstream's block is the one Bruno reads, so it is the one that describes the
    // request as Bruno sees it.
    const parsed = parseYamlRequest(`info:
  name: Both
  type: graphql

graphql:
  method: POST
  url: https://correct.example.test/graphql

http:
  method: GET
  url: https://stale.example.test/graphql
`);
    expect(parsed.http.url).toBe('https://correct.example.test/graphql');
    expect(parsed.http.method).toBe('POST');
  });

  it('does not emit the block twice when it arrived as an unmodelled key', () => {
    // Before the block was modelled, M7's passthrough carried it in `extra`. If it
    // were still carried there it would now be written twice.
    const out = rewrite(BRUNO_AUTHORED);
    expect(out.match(/^graphql:/gm)).toHaveLength(1);
    expect(out).not.toContain('extra:');
  });

  it('still requires a request block of some kind', () => {
    expect(() => parseYamlRequest('info:\n  name: R\n')).toThrow(/Missing required/);
  });
});

describe('the change is confined to graphql requests', () => {
  it('leaves an ordinary http request under http, params after body', () => {
    const out = rewrite(`info:
  name: Plain
  type: http

http:
  method: POST
  url: https://api.example.test/orders
  body:
    type: json
    data: '{"a":1}'
  params:
    - name: q
      value: "1"
      type: query
`);
    expect(out).toMatch(/^http:/m);
    expect(out).not.toMatch(/^graphql:/m);
    expect(blockKeys(out, 'http')).toEqual(['method', 'url', 'body', 'params']);
  });

  it('settles info.type from the body when the two disagree', () => {
    // A graphql body under `info.type: http` would send the file to Bruno's http
    // parser, which finds no `http:` block and reads the request as empty.
    const out = generateYamlRequest({
      info: { name: 'Mismatched', type: 'http' },
      http: {
        method: 'POST',
        url: 'https://e.test/graphql',
        body: { type: 'graphql', data: { query: '{ me { id } }' } },
      },
    });
    expect(out).toContain('type: graphql');
    expect(out).not.toContain('type: http');
    expect(out).toMatch(/^graphql:/m);
  });

  it('carries unmodelled keys inside the graphql block', () => {
    const out = rewrite(`info:
  name: R
  type: graphql

graphql:
  method: POST
  url: https://e.test/graphql
  somethingNewInBruno: keep-me
`);
    expect(out).toContain('somethingNewInBruno: keep-me');
  });
});
