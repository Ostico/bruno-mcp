/**
 * Reading a `.yml` request must not discard its body payload.
 *
 * `YamlBody.data` is a union — payload text for the text-ish types, a
 * `{ query, variables }` mapping for graphql, a list of parts for the two form
 * types — and BruBody keeps each on a different field. loadRequest used to copy
 * only `data` when it was a string, so graphql and form bodies came back with an
 * empty body. That matters because loadRequest is the read half of
 * modify_request: editing anything on such a request wrote the file back with
 * its payload gone.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequestBuilder } from '../../../src/bruno/request';

const QUERY = 'query Me { me { id } }';

const GRAPHQL_YML = `info:
  name: Gql
  type: graphql
  seq: 1
http:
  method: post
  url: https://example.test/graphql
  body:
    type: graphql
    data:
      query: ${JSON.stringify(QUERY)}
      variables: '{"id":1}'
`;

const FORM_URLENCODED_YML = `info:
  name: Form
  type: http
  seq: 1
http:
  method: post
  url: https://example.test/form
  body:
    type: form-urlencoded
    data:
      - name: grant_type
        value: password
      - name: scope
        value: admin
        disabled: true
`;

const MULTIPART_YML = `info:
  name: Upload
  type: http
  seq: 1
http:
  method: post
  url: https://example.test/upload
  body:
    type: multipart-form
    data:
      - name: caption
        value: hello
        type: text
`;

const JSON_YML = `info:
  name: Json
  type: http
  seq: 1
http:
  method: post
  url: https://example.test/json
  body:
    type: json
    data: '{"a":1}'
`;

describe('loadRequest keeps the body payload of a .yml request', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'bruno-yml-body-'));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function load(name: string, source: string) {
    const filePath = join(dir, name);
    await fs.writeFile(filePath, source, 'utf-8');
    return createRequestBuilder().loadRequest(filePath);
  }

  it('keeps a graphql query and variables', async () => {
    const bru = await load('gql.yml', GRAPHQL_YML);

    expect(bru.body?.type).toBe('graphql');
    expect(bru.body?.graphql?.query).toBe(QUERY);
    expect(bru.body?.graphql?.variables).toBe('{"id":1}');
  });

  it('keeps form-urlencoded parts', async () => {
    const bru = await load('form.yml', FORM_URLENCODED_YML);

    expect(bru.body?.type).toBe('form-urlencoded');
    // `type: 'text'` is not a form-urlencoded field — the parser normalises every
    // array body through its multipart part mapper, so it comes along. Asserted as
    // it actually is rather than as it ought to be; the payload is what this
    // change is about.
    expect(bru.body?.formUrlEncoded).toEqual([
      { name: 'grant_type', value: 'password', type: 'text' },
      { name: 'scope', value: 'admin', type: 'text', enabled: false },
    ]);
  });

  it('keeps multipart parts', async () => {
    const bru = await load('upload.yml', MULTIPART_YML);

    expect(bru.body?.type).toBe('multipart-form');
    expect(bru.body?.formData).toEqual([{ name: 'caption', value: 'hello', type: 'text' }]);
  });

  it('still keeps a plain payload string', async () => {
    // The string case was the one that already worked; it has to keep working.
    const bru = await load('json.yml', JSON_YML);

    expect(bru.body?.type).toBe('json');
    expect(bru.body?.content).toBe('{"a":1}');
  });

  it('keeps a declared body type that carries no payload', async () => {
    // `body: { type: json }` with no data is a body whose type is set but whose
    // payload has not been written yet. The type has to survive on its own, or
    // writing the request back would silently downgrade it to no body at all.
    const bru = await load('empty.yml', `info:
  name: Empty
  type: http
  seq: 1
http:
  method: post
  url: https://example.test/empty
  body:
    type: json
`);

    expect(bru.body).toEqual({ type: 'json' });
  });

  it('does not put a form list on the graphql field, or the reverse', async () => {
    // The payload only lands on the field its type calls for, so a caller can
    // trust the field it reads rather than having to sniff the shape.
    const gql = await load('gql2.yml', GRAPHQL_YML);
    const form = await load('form2.yml', FORM_URLENCODED_YML);

    expect(gql.body?.formData).toBeUndefined();
    expect(gql.body?.formUrlEncoded).toBeUndefined();
    expect(gql.body?.content).toBeUndefined();
    expect(form.body?.graphql).toBeUndefined();
    expect(form.body?.formData).toBeUndefined();
  });
});
