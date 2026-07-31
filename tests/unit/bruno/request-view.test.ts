/**
 * The read-back view, built from what the real parsers produce.
 *
 * The point of the view is that a caller cannot tell which format the request
 * came from, so the two format suites below assert against the same expected
 * object wherever the request is expressible in both. A field that only one
 * format can carry is tested in that format's suite alone.
 */

import { parseBruRequest } from '../../../src/bruno/bru-parser';
import { parseYamlRequest } from '../../../src/bruno/yaml-parser';
import { toRequestView, toEnvironmentView } from '../../../src/bruno/request-view';
import type { EnvFile } from '../../../src/bruno/types';

const BRU_PATH = '/c/req.bru';
const YML_PATH = '/c/req.yml';

function viewBru(source: string) {
  return toRequestView(parseBruRequest(source), 'bru', BRU_PATH);
}

function viewYaml(source: string) {
  return toRequestView(parseYamlRequest(source), 'yaml', YML_PATH);
}

describe('toRequestView — .bru', () => {
  const FULL = `meta {
  name: Create User
  type: http
  seq: 3
}

post {
  url: https://api.example.com/users/:id
  body: json
  auth: bearer
}

params:query {
  page: 2
  ~verbose: true
}

params:path {
  id: 42
}

headers {
  Content-Type: application/json
  ~X-Debug: on
}

auth:bearer {
  token: abc123
}

body:json {
  {"name":"ada"}
}

script:pre-request {
  const t = 1;
}

script:post-response {
  bru.setVar('id', res.body.id);
}

tests {
  test("ok", function() {});
}

assert {
  res.status: eq 201
  ~res.body.id: isDefined
}

vars:pre-request {
  base: https://api.example.com
}

vars:post-response {
  newId: res.body.id
}

settings {
  encodeUrl: true
}

docs {
  Creates a user.
}
`;

  it('reports identity, method and url', () => {
    const view = viewBru(FULL);
    expect(view.filePath).toBe(BRU_PATH);
    expect(view.format).toBe('bru');
    expect(view.name).toBe('Create User');
    expect(view.type).toBe('http');
    expect(view.seq).toBe(3);
    expect(view.method).toBe('POST');
    expect(view.url).toBe('https://api.example.com/users/:id');
  });

  it('keeps a disabled header disabled instead of reporting it as active', () => {
    expect(viewBru(FULL).headers).toEqual([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-Debug', value: 'on', disabled: true },
    ]);
  });

  it('splits query and path params', () => {
    const { params } = viewBru(FULL);
    expect(params.query).toEqual([
      { name: 'page', value: '2' },
      { name: 'verbose', value: 'true', disabled: true },
    ]);
    expect(params.path).toEqual([{ name: 'id', value: '42' }]);
  });

  it('returns the body under the write tools’ field names', () => {
    expect(viewBru(FULL).body).toEqual({ type: 'json', content: '{"name":"ada"}' });
  });

  it('returns the auth mode with only that mode’s config', () => {
    expect(viewBru(FULL).auth).toEqual({ mode: 'bearer', config: { token: 'abc123' } });
  });

  it('joins each script back into one string', () => {
    const { scripts } = viewBru(FULL);
    expect(scripts['pre-request']).toBe('const t = 1;');
    expect(scripts['post-response']).toBe("bru.setVar('id', res.body.id);");
    expect(scripts.tests).toBe('test("ok", function() {});');
  });

  it('returns assertions and both var sets', () => {
    const view = viewBru(FULL);
    expect(view.assert).toEqual([
      { name: 'res.status', value: 'eq 201' },
      { name: 'res.body.id', value: 'isDefined', disabled: true },
    ]);
    expect(view.vars.preRequest).toEqual([
      { name: 'base', value: 'https://api.example.com' },
    ]);
    expect(view.vars.postResponse).toEqual([
      { name: 'newId', value: 'res.body.id' },
    ]);
  });

  it('returns settings and docs', () => {
    const view = viewBru(FULL);
    expect(view.settings).toMatchObject({ encodeUrl: true });
    expect(view.docs).toContain('Creates a user.');
  });

  const MINIMAL = `meta {
  name: Ping
  type: http
}

get {
  url: https://api.example.com/ping
  body: none
  auth: none
}
`;

  it('omits body, auth and docs when the request has none', () => {
    const view = viewBru(MINIMAL);
    expect(view.body).toBeUndefined();
    expect(view.auth).toBeUndefined();
    expect(view.docs).toBeUndefined();
  });

  it('still reports the empty collections, so absent and empty do not blur', () => {
    const view = viewBru(MINIMAL);
    expect(view.headers).toEqual([]);
    expect(view.params).toEqual({ query: [], path: [] });
    expect(view.assert).toEqual([]);
    expect(view.vars).toEqual({ preRequest: [], postResponse: [] });
    expect(view.scripts).toEqual({});
    expect(view.notes).toEqual([]);
  });

  it('reports form-urlencoded pairs rather than a serialized string', () => {
    const view = viewBru(`meta {
  name: Form
  type: http
}

post {
  url: https://api.example.com/f
  body: form-urlencoded
  auth: none
}

body:form-urlencoded {
  a: 1
  ~b: 2
}
`);
    expect(view.body).toEqual({
      type: 'form-urlencoded',
      formUrlEncoded: [
        { name: 'a', value: '1' },
        { name: 'b', value: '2', disabled: true },
      ],
    });
  });

  it('reports multipart parts with their kind and content type', () => {
    const view = viewBru(`meta {
  name: Upload
  type: http
}

post {
  url: https://api.example.com/u
  body: multipartForm
  auth: none
}

body:multipart-form {
  note: hello
  meta: {"a":1} @contentType(application/json)
}
`);
    expect(view.body?.formData).toEqual([
      { name: 'note', value: 'hello', type: 'text' },
      { name: 'meta', value: '{"a":1}', type: 'text', contentType: 'application/json' },
    ]);
  });

  it('reports a file body', () => {
    const view = viewBru(`meta {
  name: FileBody
  type: http
}

post {
  url: https://api.example.com/f
  body: file
  auth: none
}

body:file {
  file: @file(./payload.json) @contentType(application/json)
}
`);
    expect(view.body?.type).toBe('file');
    expect(view.body?.file?.[0].filePath).toBe('./payload.json');
  });

  it('reports a graphql body as query and variables', () => {
    const view = viewBru(`meta {
  name: GQL
  type: graphql
}

post {
  url: https://api.example.com/graphql
  body: graphql
  auth: none
}

body:graphql {
  { me { id } }
}

body:graphql:vars {
  {"a":1}
}
`);
    expect(view.type).toBe('graphql');
    expect(view.body?.graphql?.query).toContain('me');
    expect(view.body?.graphql?.variables).toContain('"a"');
  });

  it('warns that an oauth2 block is stored but never sent', () => {
    const view = viewBru(`meta {
  name: OAuth
  type: http
}

get {
  url: https://api.example.com/o
  body: none
  auth: oauth2
}

auth:oauth2 {
  grant_type: client_credentials
  client_id: id
}
`);
    expect(view.auth?.mode).toBe('oauth2');
    expect(view.notes).toHaveLength(1);
    expect(view.notes[0]).toContain('not applied at run time');
  });

  it('warns that inherited auth is not resolved', () => {
    const view = viewBru(`meta {
  name: Inherited
  type: http
}

get {
  url: https://api.example.com/i
  body: none
  auth: inherit
}
`);
    expect(view.auth).toEqual({ mode: 'inherit', config: undefined });
    expect(view.notes[0]).toContain('not resolved at run time');
  });
});

describe('toRequestView — .yml', () => {
  const FULL = `info:
  name: Create User
  type: http
  seq: 3
http:
  method: POST
  url: https://api.example.com/users/:id
  headers:
    - name: Content-Type
      value: application/json
    - name: X-Debug
      value: "on"
      disabled: true
  params:
    - name: page
      value: "2"
    - name: verbose
      value: "true"
      disabled: true
    - name: id
      value: "42"
      type: path
  body:
    type: json
    data: '{"name":"ada"}'
  auth:
    type: bearer
    token: abc123
runtime:
  scripts:
    - type: before-request
      code: const t = 1;
    - type: after-response
      code: bru.setVar('id', res.body.id);
    - type: tests
      code: test("ok", function() {});
assert:
  - name: res.status
    value: eq 201
  - name: res.body.id
    value: isDefined
    disabled: true
vars:
  preRequest:
    - name: base
      value: https://api.example.com
  postResponse:
    - name: newId
      value: res.body.id
settings:
  encodeUrl: true
docs: Creates a user.
`;

  it('reports identity, method and url', () => {
    const view = viewYaml(FULL);
    expect(view.filePath).toBe(YML_PATH);
    expect(view.format).toBe('yaml');
    expect(view.name).toBe('Create User');
    expect(view.type).toBe('http');
    expect(view.seq).toBe(3);
    expect(view.method).toBe('POST');
    expect(view.url).toBe('https://api.example.com/users/:id');
  });

  it('keeps a disabled header disabled', () => {
    expect(viewYaml(FULL).headers).toEqual([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-Debug', value: 'on', disabled: true },
    ]);
  });

  it('treats a param with no type as a query param', () => {
    const { params } = viewYaml(FULL);
    expect(params.query).toEqual([
      { name: 'page', value: '2' },
      { name: 'verbose', value: 'true', disabled: true },
    ]);
    expect(params.path).toEqual([{ name: 'id', value: '42' }]);
  });

  it('reports the body under the same field names as .bru', () => {
    expect(viewYaml(FULL).body).toEqual({ type: 'json', content: '{"name":"ada"}' });
  });

  it('splits the auth type off from its config', () => {
    expect(viewYaml(FULL).auth).toEqual({ mode: 'bearer', config: { token: 'abc123' } });
  });

  it('renames the runtime slots to the MCP-surface script names', () => {
    const { scripts } = viewYaml(FULL);
    expect(scripts['pre-request']).toBe('const t = 1;');
    expect(scripts['post-response']).toBe("bru.setVar('id', res.body.id);");
    expect(scripts.tests).toBe('test("ok", function() {});');
  });

  it('returns assertions, var sets, settings and docs', () => {
    const view = viewYaml(FULL);
    expect(view.assert).toEqual([
      { name: 'res.status', value: 'eq 201' },
      { name: 'res.body.id', value: 'isDefined', disabled: true },
    ]);
    expect(view.vars.preRequest).toEqual([
      { name: 'base', value: 'https://api.example.com' },
    ]);
    expect(view.vars.postResponse).toEqual([{ name: 'newId', value: 'res.body.id' }]);
    expect(view.settings).toEqual({ encodeUrl: true });
    expect(view.docs).toBe('Creates a user.');
  });

  it('produces the same view a .bru of the same request produces', () => {
    const fromYaml = viewYaml(FULL);
    const fromBru = toRequestView(
      parseBruRequest(`meta {
  name: Create User
  type: http
  seq: 3
}

post {
  url: https://api.example.com/users/:id
  body: json
  auth: bearer
}

params:query {
  page: 2
  ~verbose: true
}

params:path {
  id: 42
}

headers {
  Content-Type: application/json
  ~X-Debug: on
}

auth:bearer {
  token: abc123
}

body:json {
  {"name":"ada"}
}
`),
      'bru',
      YML_PATH,
    );

    expect(fromBru.headers).toEqual(fromYaml.headers);
    expect(fromBru.params).toEqual(fromYaml.params);
    expect(fromBru.body).toEqual(fromYaml.body);
    expect(fromBru.auth).toEqual(fromYaml.auth);
    expect(fromBru.name).toEqual(fromYaml.name);
    expect(fromBru.seq).toEqual(fromYaml.seq);
  });

  const MINIMAL = `info:
  name: Ping
  type: http
http:
  method: GET
  url: https://api.example.com/ping
`;

  it('omits what is absent and keeps the empty collections', () => {
    const view = viewYaml(MINIMAL);
    expect(view.body).toBeUndefined();
    expect(view.auth).toBeUndefined();
    expect(view.settings).toBeUndefined();
    expect(view.docs).toBeUndefined();
    expect(view.seq).toBeUndefined();
    expect(view.headers).toEqual([]);
    expect(view.params).toEqual({ query: [], path: [] });
    expect(view.scripts).toEqual({});
    expect(view.notes).toEqual([]);
  });

  it('reports form-urlencoded pairs, not a serialized string', () => {
    const view = viewYaml(`info:
  name: Form
  type: http
http:
  method: POST
  url: https://api.example.com/f
  body:
    type: form-urlencoded
    data:
      - name: a
        value: "1"
      - name: b
        value: "2"
        disabled: true
`);
    expect(view.body?.type).toBe('form-urlencoded');
    expect(view.body?.formUrlEncoded).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2', disabled: true },
    ]);
  });

  it('reports multipart parts as formData', () => {
    const view = viewYaml(`info:
  name: Multi
  type: http
http:
  method: POST
  url: https://api.example.com/m
  body:
    type: multipart-form
    data:
      - name: file
        value: ./a.txt
        type: file
`);
    expect(view.body?.formData).toEqual([
      { name: 'file', value: './a.txt', type: 'file' },
    ]);
  });

  it('reports a graphql envelope', () => {
    const view = viewYaml(`info:
  name: GQL
  type: graphql
http:
  method: POST
  url: https://api.example.com/graphql
  body:
    type: graphql
    data:
      query: "{ me { id } }"
      variables: '{"a":1}'
`);
    expect(view.body?.graphql).toEqual({ query: '{ me { id } }', variables: '{"a":1}' });
  });

  it('reports a bare "inherit" auth string as a mode with no config', () => {
    const view = viewYaml(`info:
  name: Inherited
  type: http
http:
  method: GET
  url: https://api.example.com/i
  auth: inherit
`);
    expect(view.auth).toEqual({ mode: 'inherit', config: undefined });
    expect(view.notes[0]).toContain('not resolved at run time');
  });

  it('warns that a digest block is stored but never sent', () => {
    const view = viewYaml(`info:
  name: Digest
  type: http
http:
  method: GET
  url: https://api.example.com/d
  auth:
    type: digest
    username: u
    password: p
`);
    expect(view.auth).toEqual({ mode: 'digest', config: { username: 'u', password: 'p' } });
    expect(view.notes[0]).toContain('not applied at run time');
  });

  it('reports no config for an auth block that carries only its type', () => {
    const view = viewYaml(`info:
  name: Bare
  type: http
http:
  method: GET
  url: https://api.example.com/b
  auth:
    type: bearer
`);
    expect(view.auth).toEqual({ mode: 'bearer', config: undefined });
    expect(view.notes).toEqual([]);
  });

  it('ignores a runtime slot it does not recognise', () => {
    const view = viewYaml(`info:
  name: Odd
  type: http
http:
  method: GET
  url: https://api.example.com/o
runtime:
  scripts:
    - type: some-future-slot
      code: noop();
`);
    expect(view.scripts).toEqual({});
  });
});

describe('toEnvironmentView', () => {
  it('returns non-secret values and withholds nothing else', () => {
    const envFile: EnvFile = {
      name: 'dev',
      variables: [
        { name: 'host', value: 'https://api.example.com' },
        { name: 'retries', value: 3 },
        { name: 'legacy', value: 'x', disabled: true },
      ],
    };
    const view = toEnvironmentView(envFile, '/c', 'dev');
    expect(view.collectionPath).toBe('/c');
    expect(view.name).toBe('dev');
    expect(view.variables).toEqual([
      { name: 'host', value: 'https://api.example.com' },
      { name: 'retries', value: 3 },
      { name: 'legacy', value: 'x', disabled: true },
    ]);
    expect(view.notes).toEqual([]);
  });

  it('returns a secret by name only and says why there is no value', () => {
    const view = toEnvironmentView(
      { variables: [{ name: 'API_KEY', secret: true }] },
      '/c',
      'dev',
    );
    expect(view.variables).toEqual([{ name: 'API_KEY', secret: true }]);
    expect(view.notes).toHaveLength(1);
    expect(view.notes[0]).toContain('never the value');
  });

  it('does not report a value even if one somehow sits on a secret', () => {
    const view = toEnvironmentView(
      { variables: [{ name: 'API_KEY', secret: true, value: 'leaked' }] },
      '/c',
      'dev',
    );
    expect(view.variables[0]).toEqual({ name: 'API_KEY', secret: true });
    expect(JSON.stringify(view)).not.toContain('leaked');
  });

  it('carries the unmodelled top-level keys through', () => {
    const view = toEnvironmentView({ variables: [], extra: { color: 'blue' } }, '/c', 'dev');
    expect(view.extra).toEqual({ color: 'blue' });
  });

  it('omits extra when the file has no unmodelled keys', () => {
    const view = toEnvironmentView({ variables: [], extra: {} }, '/c', 'dev');
    expect(view.extra).toBeUndefined();
  });

  it('returns an empty variable list for an environment with none', () => {
    expect(toEnvironmentView({}, '/c', 'dev').variables).toEqual([]);
  });
});
