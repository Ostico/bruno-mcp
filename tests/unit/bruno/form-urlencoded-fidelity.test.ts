/**
 * form-urlencoded bodies, on both ends of the file.
 *
 * Bruno spells this body type two different ways on purpose: the BLOCK is
 * kebab-case (`body:form-urlencoded {`) while the MODE inside the method block
 * is camelCase (`body: formUrlEncoded`). The generator already restores that
 * camelCase for multipart — `http.body = 'multipartForm'` — and simply never did
 * it for this one. Two defects followed:
 *
 *  1. Parsing a real Bruno request and writing it back downgraded the mode to
 *     `form-urlencoded`, which Bruno does not recognise. The block survived, so
 *     the file still LOOKED right, but the body stopped being sent. Any
 *     write_request on an existing form-urlencoded request did this.
 *  2. write_request never populated `body.formUrlEncoded` at all, so an
 *     authored body was dropped entirely — no block, empty POST.
 *
 * Upstream reads `body.formUrlEncoded` as an array of {name, value, enabled}.
 * Passing it a string, which is what the builder did, writes nothing.
 *
 * Assertions are on the bytes and on what upstream's own parser makes of them,
 * never on our own re-read: our parser normalises the mode back to kebab-case,
 * so a parse-then-compare test cannot see either bug.
 */
import { createRequestBuilder, RequestBuilder } from '../../../src/bruno/request.js';
import { createCollectionManager } from '../../../src/bruno/collection.js';
import { parseBruRequest, generateBruRequest } from '../../../src/bruno/bru-parser.js';
import { toBruBody, toYamlBody } from '../../../src/bruno/request-inputs.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { bruToJsonV2 } = require('@usebruno/lang');

let builder: RequestBuilder;

beforeEach(() => {
  builder = createRequestBuilder();
});

async function makeCollection(label: string): Promise<string> {
  const tmpDir = await fs.mkdtemp(join(tmpdir(), `bruno-fue-${label}-`));
  const result = await createCollectionManager().createCollection({
    name: 'FueAPI',
    outputPath: tmpDir,
    format: 'bru',
  });
  if (!result.success) throw new Error(`collection setup failed: ${result.error}`);
  return join(tmpDir, 'FueAPI');
}

/** A request as Bruno itself writes one. */
const BRUNO_AUTHORED = `meta {
  name: R
  type: http
  seq: 1
}

post {
  url: https://api.example.com/x
  body: formUrlEncoded
  auth: none
}

body:form-urlencoded {
  a: 1
  ~b: 2
}
`;

/** What upstream makes of a file — the only opinion that matters here. */
function upstream(raw: string) {
  const json = bruToJsonV2(raw);
  return {
    mode: json.http?.body,
    entries: json.body?.formUrlEncoded,
  };
}

// ----------------------------------------------------------------------------
// Round-tripping a file Bruno wrote
// ----------------------------------------------------------------------------

describe('a Bruno-authored form-urlencoded request survives a rewrite', () => {
  it('keeps the camelCase mode Bruno recognises', () => {
    // The block name stays kebab-case; only the mode is camelCase. Downgrading
    // it left a file that still looked correct and no longer sent its body.
    const regenerated = generateBruRequest(parseBruRequest(BRUNO_AUTHORED));

    expect(regenerated).toMatch(/^\s*body: formUrlEncoded$/m);
    expect(regenerated).toContain('body:form-urlencoded {');
    expect(upstream(regenerated).mode).toBe('formUrlEncoded');
  });

  it('keeps the fields, including the disabled one', () => {
    const regenerated = generateBruRequest(parseBruRequest(BRUNO_AUTHORED));

    expect(upstream(regenerated).entries).toEqual([
      { name: 'a', value: '1', enabled: true },
      { name: 'b', value: '2', enabled: false },
    ]);
  });

  it('leaves multipart alone, which already restored its own spelling', () => {
    // Guards the fix against being applied too broadly: these are the only two
    // body types whose mode differs from their block name.
    const multipart = `meta {
  name: R
  type: http
  seq: 1
}

post {
  url: https://api.example.com/x
  body: multipartForm
  auth: none
}

body:multipart-form {
  a: 1
}
`;
    const regenerated = generateBruRequest(parseBruRequest(multipart));
    expect(regenerated).toMatch(/^\s*body: multipartForm$/m);
  });
});

// ----------------------------------------------------------------------------
// Authoring one
// ----------------------------------------------------------------------------

describe('write_request authors a form-urlencoded body', () => {
  it('writes the fields given as form entries', async () => {
    const collectionPath = await makeCollection('entries');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Login',
      method: 'POST',
      url: 'https://api.example.com/login',
      body: {
        type: 'form-urlencoded',
        formData: [
          { name: 'username', value: 'ada' },
          { name: 'password', value: 'hunter2' },
        ],
      },
    });
    expect(created.success).toBe(true);

    const raw = await fs.readFile(created.path!, 'utf-8');
    expect(upstream(raw)).toEqual({
      mode: 'formUrlEncoded',
      entries: [
        { name: 'username', value: 'ada', enabled: true },
        { name: 'password', value: 'hunter2', enabled: true },
      ],
    });
  });

  it('accepts an encoded string as content', async () => {
    // The natural thing for a caller to send for this body type, and previously
    // the thing that silently produced an empty POST.
    const collectionPath = await makeCollection('content');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Login',
      method: 'POST',
      url: 'https://api.example.com/login',
      body: { type: 'form-urlencoded', content: 'username=ada&password=hunter2' },
    });

    const raw = await fs.readFile(created.path!, 'utf-8');
    expect(upstream(raw).entries).toEqual([
      { name: 'username', value: 'ada', enabled: true },
      { name: 'password', value: 'hunter2', enabled: true },
    ]);
  });

  it('percent-decodes a value from the content string', async () => {
    const collectionPath = await makeCollection('decode');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Search',
      method: 'POST',
      url: 'https://api.example.com/s',
      body: { type: 'form-urlencoded', content: 'q=a%20b%26c&plus=x+y' },
    });

    const raw = await fs.readFile(created.path!, 'utf-8');
    expect(upstream(raw).entries).toEqual([
      { name: 'q', value: 'a b&c', enabled: true },
      { name: 'plus', value: 'x y', enabled: true },
    ]);
  });

  it('never writes a bare mode with no block behind it', async () => {
    // The shape of the original defect: the method block advertised a body type
    // and nothing followed it.
    const collectionPath = await makeCollection('bare');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Empty',
      method: 'POST',
      url: 'https://api.example.com/x',
      body: { type: 'form-urlencoded', content: 'a=1' },
    });

    const raw = await fs.readFile(created.path!, 'utf-8');
    expect(raw).toContain('body:form-urlencoded {');
  });

  it('joins a repeated field given as an array', async () => {
    // formData allows an array value for repeated parts. This block is a flat
    // name/value dictionary, so the values are joined rather than silently
    // reduced to the first one.
    const collectionPath = await makeCollection('array-value');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Tags',
      method: 'POST',
      url: 'https://api.example.com/x',
      body: {
        type: 'form-urlencoded',
        formData: [{ name: 'tags', value: ['a', 'b'] }],
      },
    });

    const raw = await fs.readFile(created.path!, 'utf-8');
    expect(upstream(raw).entries).toEqual([{ name: 'tags', value: 'a,b', enabled: true }]);
  });

  it('writes no block when there is nothing to put in one', async () => {
    // An empty body must not produce an empty block; the mode alone is honest
    // about there being no fields.
    const collectionPath = await makeCollection('empty');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Empty',
      method: 'POST',
      url: 'https://api.example.com/x',
      body: { type: 'form-urlencoded' },
    });
    expect(created.success).toBe(true);

    const raw = await fs.readFile(created.path!, 'utf-8');
    expect(raw).not.toContain('body:form-urlencoded {');
  });

  it('builds the pairs alone, not the same names again as multipart parts', () => {
    // `formData` is the only key/value field on the body input, so it carries
    // these pairs too, and the multipart branch used to fire on its presence
    // alone. The file was unaffected — the writer emits the block the mode names
    // — so this is asserted on the model the writer is handed, which is where
    // the duplicate was.
    const body = toBruBody({
      type: 'form-urlencoded',
      formData: [{ name: 'username', value: 'ada' }],
    });

    expect(body.formUrlEncoded).toEqual([{ name: 'username', value: 'ada', enabled: true }]);
    expect(body.formData).toBeUndefined();
  });

  it('keeps the .yml body type form-urlencoded when the pairs arrive as formData', () => {
    // The other dialect's builder tests the type first and returns on the
    // multipart branch, so the same field reaching it decides the body type
    // rather than adding to it: without the type test this body is written as
    // multipart-form, and the request goes out with the wrong encoding.
    const body = toYamlBody({
      type: 'form-urlencoded',
      formData: [{ name: 'username', value: 'ada' }],
    });

    expect(body.type).toBe('form-urlencoded');
    expect(body.data).toEqual([{ name: 'username', value: 'ada', enabled: true }]);
  });

  it('accepts a pair typed as text, which is what it stores anyway', async () => {
    const collectionPath = await makeCollection('typed-text');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Login',
      method: 'POST',
      url: 'https://api.example.com/login',
      body: {
        type: 'form-urlencoded',
        formData: [{ name: 'username', value: 'ada', type: 'text' }],
      },
    });
    expect(created.success).toBe(true);

    const raw = await fs.readFile(created.path!, 'utf-8');
    expect(upstream(raw).entries).toEqual([{ name: 'username', value: 'ada', enabled: true }]);
  });

  it('refuses a pair typed as a file rather than sending it as text', async () => {
    // Accepted and dropped before: the request went out with a text pair of the
    // same name, and nothing said the file was not attached.
    const collectionPath = await makeCollection('typed-file');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Upload',
      method: 'POST',
      url: 'https://api.example.com/x',
      body: {
        type: 'form-urlencoded',
        formData: [{ name: 'avatar', value: './a.png', type: 'file' }],
      },
    });

    expect(created.success).toBe(false);
    expect(created.error).toContain('avatar');
    expect(created.error).toContain('multipart-form');
  });

  it('refuses a per-pair contentType, which the block cannot hold', async () => {
    const collectionPath = await makeCollection('typed-ct');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Upload',
      method: 'POST',
      url: 'https://api.example.com/x',
      body: {
        type: 'form-urlencoded',
        formData: [{ name: 'payload', value: '{}', contentType: 'application/json' }],
      },
    });

    expect(created.success).toBe(false);
    expect(created.error).toContain('contentType');
  });

  it('refuses the same two on a .yml collection, which has its own body builder', async () => {
    // Two builders, one rule: the assert is called from both, because the .yml
    // path dropped the fields in exactly the same way.
    const tmpDir = await fs.mkdtemp(join(tmpdir(), 'bruno-fue-yml-'));
    const collection = await createCollectionManager().createCollection({
      name: 'FueYmlAPI',
      outputPath: tmpDir,
      format: 'yaml',
    });
    expect(collection.success).toBe(true);

    const created = await builder.createRequest({
      collectionPath: join(tmpDir, 'FueYmlAPI'),
      name: 'Upload',
      method: 'POST',
      url: 'https://api.example.com/x',
      body: {
        type: 'form-urlencoded',
        formData: [{ name: 'avatar', value: './a.png', type: 'file' }],
      },
    });

    expect(created.success).toBe(false);
    expect(created.error).toContain('multipart-form');
  });

  it('write_request writes the same bytes', async () => {
    const collectionPath = await makeCollection('modify');
    const created = await builder.createRequest({
      collectionPath,
      name: 'Login',
      method: 'POST',
      url: 'https://api.example.com/login',
    });
    const updated = await builder.updateRequest(created.path!, {
      body: { type: 'form-urlencoded', content: 'username=ada' },
    });
    expect(updated.success).toBe(true);

    const raw = await fs.readFile(created.path!, 'utf-8');
    expect(upstream(raw)).toEqual({
      mode: 'formUrlEncoded',
      entries: [{ name: 'username', value: 'ada', enabled: true }],
    });
  });
});
