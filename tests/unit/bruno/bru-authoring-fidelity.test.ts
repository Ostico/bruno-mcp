/**
 * The bytes we write have to be the bytes Bruno reads.
 *
 * Every test here was found by looking at the file on disk rather than by
 * round-tripping through our own parser. That distinction is the whole point:
 * our parser is tolerant of our own malformed output, so a read-back-and-compare
 * test passes while Bruno chokes. Four defects hid behind exactly that.
 *
 *  1. `seq: undefined` written literally into meta whenever no sequence was
 *     given. Upstream's serializer iterates every key present in `meta` and
 *     stringifies the value, so leaving the key present with an undefined value
 *     emits a value that is not a number. Omitting the key was the first fix and
 *     only half of one: a request with no `seq` sorts as MAX_SAFE_INTEGER, so
 *     every request created without one tied for last. `write_request` now
 *     defaults `seq` to one past the folder's highest.
 *  2. The method block said `auth: api-key`. Bruno's token is `apikey`, so the
 *     `auth:apikey` block we correctly emitted was ignored.
 *  3. `placement` was never written. We stored `in`, which upstream's serializer
 *     does not read, so the field came out empty.
 *  4. `placement` was never read. A request authored in Bruno reached
 *     normalizeAuth as type `apikey`, missed the `api-key`-only branch, and lost
 *     its key and value entirely — the request went out with no credential and
 *     warned "api-key auth has no key name" about a file that plainly had one.
 *
 * Bruno's vocabulary is `placement: header | queryparams`. Ours was
 * `in: header | query`. We now write Bruno's spelling. The old one survives only
 * as tool INPUT, which is translated — never as a file field, because upstream's
 * parser discards unknown keys, so `in` was never readable back even by us.
 */
import { createRequestBuilder, RequestBuilder } from '../../../src/bruno/request.js';
import { createCollectionManager } from '../../../src/bruno/collection.js';
import { parseBruRequest } from '../../../src/bruno/bru-parser.js';
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

async function makeCollection(label: string): Promise<string> {
  const tmpDir = await fs.mkdtemp(join(tmpdir(), `bruno-fidelity-${label}-`));
  const result = await createCollectionManager().createCollection({
    name: 'FidelityAPI',
    outputPath: tmpDir,
    format: 'bru',
  });
  if (!result.success) throw new Error(`collection setup failed: ${result.error}`);
  return join(tmpDir, 'FidelityAPI');
}

/** Write a .bru by hand, as Bruno itself would, and run it. */
async function runHandWritten(label: string, source: string) {
  const dir = await fs.mkdtemp(join(tmpdir(), `bruno-hand-${label}-`));
  await fs.writeFile(
    join(dir, 'bruno.json'),
    JSON.stringify({ version: '1', name: 'c', type: 'collection' }),
  );
  await fs.writeFile(join(dir, 'R.bru'), source);
  const run = await RequestExecutor.executeCollection(dir, {});
  const call = mockFetch.mock.calls[0];
  return {
    url: String(call?.[0] ?? ''),
    headers: (call?.[1]?.headers ?? {}) as Record<string, string>,
    warnings: run.groups[0]!.results[0]?.warnings ?? [],
  };
}

function brunoApiKeyRequest(placement: string): string {
  return `meta {
  name: R
  type: http
  seq: 1
}

get {
  url: https://api.example.com/x
  body: none
  auth: apikey
}

auth:apikey {
  key: api_key
  value: secret123
  placement: ${placement}
}
`;
}

// ----------------------------------------------------------------------------
// 1. seq
// ----------------------------------------------------------------------------

describe('meta seq is never the literal string "undefined"', () => {
  it('defaults to a real number when no sequence was given', async () => {
    // Upstream writes `${key}: ${meta[key]}` for every key present, so leaving
    // seq on the object with an undefined value produces "seq: undefined" —
    // syntactically a value, and not a number.
    //
    // This used to assert the key was omitted altogether, which was the safe
    // half of the fix and the wrong end state: a request with no `seq` sorts as
    // MAX_SAFE_INTEGER, so every request created without one tied for last and
    // ran in an order decided by nothing. The first request in a collection is
    // now `seq: 1`.
    const collectionPath = await makeCollection('seq');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Plain',
      method: 'GET',
      url: 'https://api.example.com/x',
    });
    expect(created.success).toBe(true);

    const raw = await fs.readFile(created.path!, 'utf-8');
    expect(raw).not.toContain('undefined');
    expect(raw).toMatch(/^\s*seq: 1$/m);
  });

  it('still writes the sequence when one was given', async () => {
    const collectionPath = await makeCollection('seq-given');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Ordered',
      method: 'GET',
      url: 'https://api.example.com/x',
      sequence: 4,
    });

    const raw = await fs.readFile(created.path!, 'utf-8');
    expect(raw).toMatch(/^\s*seq: 4$/m);
    expect(parseBruRequest(raw).meta?.seq).toBe(4);
  });
});

// ----------------------------------------------------------------------------
// 2 & 3. what we write for api-key
// ----------------------------------------------------------------------------

describe('an authored api-key request is one Bruno can read', () => {
  it('writes Bruno’s mode token, not the hyphenated one', async () => {
    // The block is named auth:apikey. If the method block says `auth: api-key`
    // the two do not agree and Bruno applies no auth at all.
    const collectionPath = await makeCollection('token');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Keyed',
      method: 'GET',
      url: 'https://api.example.com/x',
      auth: { type: 'api-key', config: { key: 'api_key', value: 'secret123' } },
    });

    const raw = await fs.readFile(created.path!, 'utf-8');
    expect(raw).toMatch(/^\s*auth: apikey$/m);
    expect(raw).not.toContain('auth: api-key');
    expect(raw).toContain('auth:apikey {');
  });

  it('writes a non-empty placement using Bruno’s vocabulary', async () => {
    const collectionPath = await makeCollection('placement');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Keyed',
      method: 'GET',
      url: 'https://api.example.com/x',
      auth: {
        type: 'api-key',
        config: { key: 'api_key', value: 'secret123', placement: 'queryparams' },
      },
    });

    const raw = await fs.readFile(created.path!, 'utf-8');
    expect(raw).toMatch(/^\s*placement: queryparams$/m);
  });

  it('defaults placement to header rather than leaving it blank', async () => {
    const collectionPath = await makeCollection('placement-default');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Keyed',
      method: 'GET',
      url: 'https://api.example.com/x',
      auth: { type: 'api-key', config: { key: 'api_key', value: 'secret123' } },
    });

    const raw = await fs.readFile(created.path!, 'utf-8');
    expect(raw).toMatch(/^\s*placement: header$/m);
    expect(raw).not.toMatch(/^\s*placement:\s*$/m);
  });

  it('accepts the legacy `in` spelling on the tool surface', async () => {
    // `in: query` is what this server used to take. Translating it keeps
    // existing callers working while the file gets Bruno's spelling.
    const collectionPath = await makeCollection('legacy-in');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Keyed',
      method: 'GET',
      url: 'https://api.example.com/x',
      auth: { type: 'api-key', config: { key: 'api_key', value: 'v', in: 'query' } },
    });

    const raw = await fs.readFile(created.path!, 'utf-8');
    expect(raw).toMatch(/^\s*placement: queryparams$/m);
  });

  it('write_request writes the same bytes as write_request', async () => {
    const collectionPath = await makeCollection('modify');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Keyed',
      method: 'GET',
      url: 'https://api.example.com/x',
    });
    await builder.updateRequest(created.path!, {
      auth: {
        type: 'api-key',
        config: { key: 'api_key', value: 'secret123', placement: 'queryparams' },
      },
    });

    const raw = await fs.readFile(created.path!, 'utf-8');
    expect(raw).toMatch(/^\s*auth: apikey$/m);
    expect(raw).toMatch(/^\s*placement: queryparams$/m);
  });
});

// ----------------------------------------------------------------------------
// 4. what we read for api-key
// ----------------------------------------------------------------------------

describe('a Bruno-authored api-key request actually sends its credential', () => {
  it('sends the key as a header when placement is header', async () => {
    const { headers, warnings } = await runHandWritten(
      'header',
      brunoApiKeyRequest('header'),
    );
    expect(headers['api_key']).toBe('secret123');
    expect(warnings).toEqual([]);
  });

  it('appends the key to the query string when placement is queryparams', async () => {
    // Previously this fell through normalizeAuth's api-key-only branch, lost the
    // key and value, and went out bare.
    const { url, headers, warnings } = await runHandWritten(
      'queryparams',
      brunoApiKeyRequest('queryparams'),
    );
    expect(url).toBe('https://api.example.com/x?api_key=secret123');
    expect(headers['api_key']).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('never claims a key name is missing when the file supplies one', async () => {
    // The old warning was actively misleading: it named the one thing the file
    // did have.
    const { warnings } = await runHandWritten('warn', brunoApiKeyRequest('header'));
    expect(warnings.join('\n')).not.toMatch(/no key name/);
  });

  it('defaults to a header when the file omits placement', async () => {
    const source = brunoApiKeyRequest('header').replace(/\n  placement: header/, '');
    const { headers } = await runHandWritten('no-placement', source);
    expect(headers['api_key']).toBe('secret123');
  });

  it('cannot recover a legacy `in` field, because the parser discards it', async () => {
    // Worth pinning rather than assuming: upstream maps the block's known keys
    // and drops the rest, so the `in: query` this server used to write comes
    // back missing entirely. Those files were already resolving as `header`
    // before this change — there is no back-compat to preserve on the FILE side,
    // only on the tool input, and a test claiming otherwise would be fiction.
    const source = brunoApiKeyRequest('header').replace(
      '  placement: header',
      '  in: queryparams',
    );
    const parsed = parseBruRequest(source);
    expect((parsed.auth?.apikey as Record<string, unknown>).in).toBeUndefined();

    const { url, headers } = await runHandWritten('legacy-file', source);
    expect(url).toBe('https://api.example.com/x');
    expect(headers['api_key']).toBe('secret123');
  });
});

// ----------------------------------------------------------------------------
// The loop: what we write, we can read
// ----------------------------------------------------------------------------

describe('an api-key request we authored runs correctly when we run it', () => {
  it('round-trips queryparams from write_request through to the wire', async () => {
    // Writing Bruno's spelling is only half a fix if our own reader then drops
    // it. Both halves, one test.
    const collectionPath = await makeCollection('roundtrip');
    await builder.createRequest({
      collectionPath,
      name: 'Keyed',
      method: 'GET',
      url: 'https://api.example.com/x',
      auth: {
        type: 'api-key',
        config: { key: 'api_key', value: 'secret123', placement: 'queryparams' },
      },
    });

    const run = await RequestExecutor.executeCollection(collectionPath, {});
    expect(String(mockFetch.mock.calls[0][0])).toBe(
      'https://api.example.com/x?api_key=secret123',
    );
    expect(run.groups[0]!.results[0]?.warnings ?? []).toEqual([]);
  });
});
