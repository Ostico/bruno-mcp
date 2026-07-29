/**
 * Assertions, vars and path parameters must be AUTHORABLE through the MCP surface.
 *
 * This is the mirror of the "parsed, persisted, round-tripped, never applied"
 * class that PRs #67-#72 closed. Those PRs made three declared features actually
 * execute. This one makes them reachable: an agent driving this server had no way
 * to write any of them, so the execution engine was unusable from the outside.
 *
 *  - `assert`        — evaluated since #70/#71, but no tool could author a block.
 *  - `vars`          — applied since #72, same.
 *  - `params:path`   — substituted by request-params.ts, but only `query` was
 *                      authorable, so a `:id` segment had no way to get a value.
 *
 * The polarity trap shows up for the FOURTH time: `.bru` spells switched-off as
 * `enabled: false` (serialized `~name`) while `.yml` spells it `disabled: true`.
 * The tool surface picks ONE spelling — `disabled`, absent meaning active — and
 * each writer converts. Both formats are asserted here rather than one.
 *
 * Assertions are against the bytes on disk, and the closing test runs the whole
 * thing through the executor: authoring that produces a correct-looking file but
 * a request that does not actually assert anything would be the same defect
 * wearing a new hat.
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createCollectionManager } from '../../../src/bruno/collection.js';
import { createRequestBuilder, RequestBuilder } from '../../../src/bruno/request.js';
import { parseBruRequest } from '../../../src/bruno/bru-parser.js';
import { parseYamlRequest } from '../../../src/bruno/yaml-parser.js';
import { RequestExecutor } from '../../../src/bruno/request-executor.js';

// The closing test runs the executor. fetch is mocked rather than pointed at a
// local server: a real socket would add nothing — path substitution, vars and
// assertion evaluation all happen in this process — and it would make the suite
// depend on process-global undici state another test file owns. Matching
// request-executor-varsets.test.ts, url-validator is stubbed too, since
// otherwise the host never resolves and no request is attempted.
const mockFetch = jest.fn();
(global as unknown as { fetch: unknown }).fetch = mockFetch;

jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
}));

let builder: RequestBuilder;

beforeEach(() => {
  builder = createRequestBuilder();
});

/** Create a collection in the requested format and return its path. */
async function makeCollection(format: 'yaml' | 'bru', label: string): Promise<string> {
  const tmpDir = await fs.mkdtemp(join(tmpdir(), `bruno-author-${label}-`));
  const manager = createCollectionManager();
  const result = await manager.createCollection({
    name: 'AuthorAPI',
    outputPath: tmpDir,
    format,
  });
  if (!result.success) throw new Error(`collection setup failed: ${result.error}`);
  return join(tmpDir, 'AuthorAPI');
}

async function readBru(path: string) {
  return parseBruRequest(await fs.readFile(path, 'utf-8'));
}

async function readYaml(path: string) {
  return parseYamlRequest(await fs.readFile(path, 'utf-8'));
}

// ----------------------------------------------------------------------------
// assert
// ----------------------------------------------------------------------------

describe('create_request authors an assert block', () => {
  it('writes assertions into a .bru request', async () => {
    const collectionPath = await makeCollection('bru', 'assert-bru');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Check',
      method: 'GET',
      url: 'https://api.example.com/widgets',
      assert: [
        { name: 'res.status', value: 'eq 200' },
        { name: 'res.body.id', value: 'isNumber' },
        { name: 'res.body.gone', value: 'isUndefined', disabled: true },
      ],
    });
    expect(created.success).toBe(true);

    const parsed = await readBru(created.path!);
    expect((parsed.assertions ?? []).map((a) => [a.name, a.value, a.enabled])).toEqual([
      ['res.status', 'eq 200', true],
      ['res.body.id', 'isNumber', true],
      ['res.body.gone', 'isUndefined', false],
    ]);
  });

  it('writes assertions into a .yml request, inverting the polarity', async () => {
    const collectionPath = await makeCollection('yaml', 'assert-yml');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Check',
      method: 'GET',
      url: 'https://api.example.com/widgets',
      assert: [
        { name: 'res.status', value: 'eq 200' },
        { name: 'res.body.gone', value: 'isUndefined', disabled: true },
      ],
    });
    expect(created.success).toBe(true);

    const parsed = await readYaml(created.path!);
    expect(parsed.assert).toEqual([
      { name: 'res.status', value: 'eq 200' },
      { name: 'res.body.gone', value: 'isUndefined', disabled: true },
    ]);
  });
});

describe('modify_request authors an assert block', () => {
  it('adds assertions to an existing .bru request', async () => {
    const collectionPath = await makeCollection('bru', 'assert-mod-bru');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Check',
      method: 'GET',
      url: 'https://api.example.com/widgets',
    });
    const updated = await builder.updateRequest(created.path!, {
      assert: [{ name: 'res.status', value: 'eq 201' }],
    });
    expect(updated.success).toBe(true);

    const parsed = await readBru(created.path!);
    expect((parsed.assertions ?? []).map((a) => [a.name, a.value])).toEqual([
      ['res.status', 'eq 201'],
    ]);
  });

  it('adds assertions to an existing .yml request', async () => {
    const collectionPath = await makeCollection('yaml', 'assert-mod-yml');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Check',
      method: 'GET',
      url: 'https://api.example.com/widgets',
    });
    const updated = await builder.updateRequest(created.path!, {
      assert: [{ name: 'res.status', value: 'eq 201' }],
    });
    expect(updated.success).toBe(true);

    expect((await readYaml(created.path!)).assert).toEqual([
      { name: 'res.status', value: 'eq 201' },
    ]);
  });

  it('replaces the whole block, the way headers already are', async () => {
    const collectionPath = await makeCollection('bru', 'assert-replace');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Check',
      method: 'GET',
      url: 'https://api.example.com/widgets',
      assert: [{ name: 'res.status', value: 'eq 200' }],
    });
    await builder.updateRequest(created.path!, {
      assert: [{ name: 'res.body.ok', value: 'isTrue' }],
    });

    const parsed = await readBru(created.path!);
    expect((parsed.assertions ?? []).map((a) => a.name)).toEqual(['res.body.ok']);
  });

  it('leaves an existing block untouched when assert is not supplied', async () => {
    // Partial-merge semantics: modify_request must not be a way to silently
    // delete assertions a human wrote by hand.
    const collectionPath = await makeCollection('bru', 'assert-preserve');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Check',
      method: 'GET',
      url: 'https://api.example.com/widgets',
      assert: [{ name: 'res.status', value: 'eq 200' }],
    });
    await builder.updateRequest(created.path!, { headers: { 'X-A': '1' } });

    const parsed = await readBru(created.path!);
    expect((parsed.assertions ?? []).map((a) => a.name)).toEqual(['res.status']);
  });
});

// ----------------------------------------------------------------------------
// vars
// ----------------------------------------------------------------------------

describe('create_request authors vars blocks', () => {
  it('writes both halves into a .bru request', async () => {
    const collectionPath = await makeCollection('bru', 'vars-bru');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Vars',
      method: 'GET',
      url: 'https://api.example.com/{{version}}/widgets',
      vars: {
        preRequest: [
          { name: 'version', value: 'v3' },
          { name: 'unused', value: 'nope', disabled: true },
        ],
        postResponse: [{ name: 'widgetId', value: 'res.body.id' }],
      },
    });
    expect(created.success).toBe(true);

    const parsed = await readBru(created.path!);
    expect((parsed.varSets?.req ?? []).map((v) => [v.name, v.value, v.enabled])).toEqual([
      ['version', 'v3', true],
      ['unused', 'nope', false],
    ]);
    expect((parsed.varSets?.res ?? []).map((v) => [v.name, v.value, v.enabled])).toEqual([
      ['widgetId', 'res.body.id', true],
    ]);
  });

  it('writes both halves into a .yml request', async () => {
    const collectionPath = await makeCollection('yaml', 'vars-yml');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Vars',
      method: 'GET',
      url: 'https://api.example.com/{{version}}/widgets',
      vars: {
        preRequest: [{ name: 'version', value: 'v3' }],
        postResponse: [{ name: 'widgetId', value: 'res.body.id', disabled: true }],
      },
    });
    expect(created.success).toBe(true);

    const parsed = await readYaml(created.path!);
    expect(parsed.vars).toEqual({
      preRequest: [{ name: 'version', value: 'v3' }],
      postResponse: [{ name: 'widgetId', value: 'res.body.id', disabled: true }],
    });
  });

  it('carries the local flag into a .yml request too', async () => {
    // Covered on both formats: the two writers build their entries separately, so
    // a flag working in one says nothing about the other.
    const collectionPath = await makeCollection('yaml', 'vars-local-yml');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Vars',
      method: 'GET',
      url: 'https://api.example.com/x',
      vars: { preRequest: [{ name: 'secret', value: 's', local: true }] },
    });

    expect((await readYaml(created.path!)).vars).toEqual({
      preRequest: [{ name: 'secret', value: 's', local: true }],
    });
  });

  it('writes only the supplied half into a .yml request', async () => {
    const collectionPath = await makeCollection('yaml', 'vars-half-yml');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Vars',
      method: 'GET',
      url: 'https://api.example.com/{{version}}/x',
      vars: { preRequest: [{ name: 'version', value: 'v3' }] },
    });

    const parsed = await readYaml(created.path!);
    expect(parsed.vars).toEqual({ preRequest: [{ name: 'version', value: 'v3' }] });
    expect(parsed.vars?.postResponse).toBeUndefined();
  });

  it('carries the local flag, which only pre-request vars use', async () => {
    const collectionPath = await makeCollection('bru', 'vars-local');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Vars',
      method: 'GET',
      url: 'https://api.example.com/x',
      vars: { preRequest: [{ name: 'secret', value: 's', local: true }] },
    });

    const parsed = await readBru(created.path!);
    expect(parsed.varSets?.req?.[0].local).toBe(true);
  });

  it('writes only the half that was supplied', async () => {
    const collectionPath = await makeCollection('bru', 'vars-half');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Vars',
      method: 'GET',
      url: 'https://api.example.com/x',
      vars: { postResponse: [{ name: 'id', value: 'res.body.id' }] },
    });

    const parsed = await readBru(created.path!);
    expect(parsed.varSets?.req ?? []).toEqual([]);
    expect((parsed.varSets?.res ?? []).map((v) => v.name)).toEqual(['id']);
  });
});

describe('modify_request authors vars blocks', () => {
  it('adds vars to an existing .bru request', async () => {
    const collectionPath = await makeCollection('bru', 'vars-mod-bru');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Vars',
      method: 'GET',
      url: 'https://api.example.com/x',
    });
    const updated = await builder.updateRequest(created.path!, {
      vars: { preRequest: [{ name: 'version', value: 'v9' }] },
    });
    expect(updated.success).toBe(true);

    const parsed = await readBru(created.path!);
    expect((parsed.varSets?.req ?? []).map((v) => [v.name, v.value])).toEqual([
      ['version', 'v9'],
    ]);
  });

  it('adds vars to an existing .yml request', async () => {
    const collectionPath = await makeCollection('yaml', 'vars-mod-yml');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Vars',
      method: 'GET',
      url: 'https://api.example.com/x',
    });
    await builder.updateRequest(created.path!, {
      vars: { postResponse: [{ name: 'id', value: 'res.body.id' }] },
    });

    expect((await readYaml(created.path!)).vars).toEqual({
      postResponse: [{ name: 'id', value: 'res.body.id' }],
    });
  });

  it('replaces one half without discarding the other', async () => {
    // The two halves mean different things, so supplying preRequest must not be
    // a way to lose a postResponse block.
    const collectionPath = await makeCollection('bru', 'vars-half-keep');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Vars',
      method: 'GET',
      url: 'https://api.example.com/x',
      vars: { postResponse: [{ name: 'keep', value: 'res.body.id' }] },
    });
    await builder.updateRequest(created.path!, {
      vars: { preRequest: [{ name: 'fresh', value: '1' }] },
    });

    const parsed = await readBru(created.path!);
    expect((parsed.varSets?.req ?? []).map((v) => v.name)).toEqual(['fresh']);
    expect((parsed.varSets?.res ?? []).map((v) => v.name)).toEqual(['keep']);
  });

  it('leaves existing vars untouched when vars is not supplied', async () => {
    const collectionPath = await makeCollection('bru', 'vars-preserve');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Vars',
      method: 'GET',
      url: 'https://api.example.com/x',
      vars: { preRequest: [{ name: 'version', value: 'v3' }] },
    });
    await builder.updateRequest(created.path!, { headers: { 'X-A': '1' } });

    const parsed = await readBru(created.path!);
    expect((parsed.varSets?.req ?? []).map((v) => v.name)).toEqual(['version']);
  });
});

// ----------------------------------------------------------------------------
// params:path
// ----------------------------------------------------------------------------

describe('create_request authors path parameters', () => {
  it('writes a params:path entry into a .bru request', async () => {
    const collectionPath = await makeCollection('bru', 'path-bru');
    const created = await builder.createRequest({
      collectionPath,
      name: 'ById',
      method: 'GET',
      url: 'https://api.example.com/users/:id',
      pathParams: { id: '42' },
    });
    expect(created.success).toBe(true);

    const parsed = await readBru(created.path!);
    expect((parsed.params ?? []).map((p) => [p.name, p.value, p.type])).toEqual([
      ['id', '42', 'path'],
    ]);
  });

  it('writes a path param into a .yml request', async () => {
    const collectionPath = await makeCollection('yaml', 'path-yml');
    const created = await builder.createRequest({
      collectionPath,
      name: 'ById',
      method: 'GET',
      url: 'https://api.example.com/users/:id',
      pathParams: { id: 42 },
    });

    expect((await readYaml(created.path!)).http.params).toEqual([
      { name: 'id', value: '42', type: 'path' },
    ]);
  });

  it('keeps query and path params side by side', async () => {
    const collectionPath = await makeCollection('bru', 'path-and-query');
    const created = await builder.createRequest({
      collectionPath,
      name: 'ById',
      method: 'GET',
      url: 'https://api.example.com/users/:id',
      pathParams: { id: '42' },
      query: { page: '2' },
    });

    const parsed = await readBru(created.path!);
    expect((parsed.params ?? []).map((p) => [p.name, p.type]).sort()).toEqual([
      ['id', 'path'],
      ['page', 'query'],
    ]);
  });

  it('adds path params to a .bru request that had no params block at all', async () => {
    // The no-existing-params case is separate: the merge helper has to cope with
    // the field being absent rather than an empty list.
    const collectionPath = await makeCollection('bru', 'path-mod-bru');
    const created = await builder.createRequest({
      collectionPath,
      name: 'ById',
      method: 'GET',
      url: 'https://api.example.com/users/:id',
    });
    const updated = await builder.updateRequest(created.path!, { pathParams: { id: '7' } });
    expect(updated.success).toBe(true);

    const parsed = await readBru(created.path!);
    expect((parsed.params ?? []).map((p) => [p.name, p.value, p.type])).toEqual([
      ['id', '7', 'path'],
    ]);
  });

  it('replaces path params without discarding query params', async () => {
    const collectionPath = await makeCollection('yaml', 'path-mod-keeps-query');
    const created = await builder.createRequest({
      collectionPath,
      name: 'ById',
      method: 'GET',
      url: 'https://api.example.com/users/:id',
      pathParams: { id: '1' },
      query: { page: '2' },
    });
    await builder.updateRequest(created.path!, { pathParams: { id: '99' } });

    const parsed = await readYaml(created.path!);
    expect(parsed.http.params).toEqual([
      { name: 'page', value: '2', type: 'query' },
      { name: 'id', value: '99', type: 'path' },
    ]);
  });
});

// ----------------------------------------------------------------------------
// End to end: authored, then actually run
// ----------------------------------------------------------------------------

describe('an authored request actually asserts and substitutes when run', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ id: 7 }),
      ok: true,
    } as unknown as Response);
  });

  it('runs an authored assert, path param and vars end to end', async () => {
    // The whole point of both halves of this defect class: an agent authors a
    // request through the MCP surface, runs the collection, and the declared
    // assertions actually report. Asserting on the file alone would miss a break
    // anywhere downstream.
    const collectionPath = await makeCollection('bru', 'e2e');
    const created = await builder.createRequest({
      collectionPath,
      name: 'ById',
      method: 'GET',
      url: 'https://api.example.com/users/:id',
      pathParams: { id: '42' },
      vars: {
        preRequest: [{ name: 'unusedButParsed', value: 'x' }],
        postResponse: [{ name: 'widgetId', value: 'res.body.id' }],
      },
      assert: [
        { name: 'res.status', value: 'eq 200' },
        { name: 'bru.getVar("widgetId")', value: 'eq 7' },
      ],
    });
    expect(created.success).toBe(true);

    const run = await RequestExecutor.executeCollection(collectionPath, {});
    expect(String(mockFetch.mock.calls[0][0])).toBe('https://api.example.com/users/42');

    const request = run.results[0];
    expect(request.tests.map((t) => [t.description, t.status])).toEqual([
      ['res.status eq 200', 'pass'],
      ['bru.getVar("widgetId") eq 7', 'pass'],
    ]);
  });
});
