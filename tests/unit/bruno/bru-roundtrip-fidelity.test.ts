/**
 * .bru round-trip fidelity (findings D5 / D6).
 *
 * Reading a request and writing it back must not silently drop parts of the
 * user's file. Editing one header through the MCP server used to delete the
 * request's params, assertions, settings, vars and every oauth2 additional
 * parameter, because BruFile could not represent them.
 *
 * Each test names the block it protects, so a regression says what it broke.
 */

import { parseBruRequest, generateBruRequest } from '../../../src/bruno/bru-parser';

const FULL_REQUEST = `meta {
  name: Get Orders
  type: http
  seq: 3
}

get {
  url: https://api.test/orders/:orderId
  body: json
  auth: oauth2
}

params:query {
  page: 1
  ~debug: true
}

params:path {
  orderId: 42
}

headers {
  Accept: application/json
}

auth:oauth2 {
  grant_type: authorization_code
  access_token_url: https://api.test/token
  client_id: abc
  client_secret: shh
}

auth:oauth2:additional_params:auth_req:headers {
  auth-header: hv
}

auth:oauth2:additional_params:auth_req:queryparams {
  auth-q: qv
}

auth:oauth2:additional_params:access_token_req:headers {
  token-header: thv
}

auth:oauth2:additional_params:access_token_req:queryparams {
  token-q: tqv
}

auth:oauth2:additional_params:access_token_req:body {
  token-b: tbv
}

auth:oauth2:additional_params:refresh_token_req:headers {
  refresh-header: rhv
}

auth:oauth2:additional_params:refresh_token_req:queryparams {
  refresh-q: rqv
}

auth:oauth2:additional_params:refresh_token_req:body {
  refresh-b: rbv
}

body:json {
  {"a":1}
}

assert {
  res.status: eq 200
  ~res.body.id: neq 0
}

vars:pre-request {
  token: abc
}

vars:post-response {
  orderId: res.body.id
}

script:pre-request {
  bru.setVar("x", 1);
}

tests {
  test("ok", function() {});
}

settings {
  encodeUrl: true
}

docs {
  Some documentation here.
}
`;

/** Every block header present in a .bru document, deduped and sorted. */
function blocksOf(source: string): string[] {
  const found = source.match(/^[a-z][a-z0-9:_-]*\s*\{/gim) ?? [];
  return Array.from(new Set(found.map((b) => b.replace(/\s*\{$/, '').trim()))).sort();
}

const roundTrip = (source: string) => generateBruRequest(parseBruRequest(source));

describe('.bru round-trip preserves the whole document', () => {
  it('loses no block from a request that uses every feature', () => {
    const before = blocksOf(FULL_REQUEST);
    const after = blocksOf(roundTrip(FULL_REQUEST));

    expect(before.filter((b) => !after.includes(b))).toEqual([]);
  });

  it('is stable: a second round-trip changes nothing further', () => {
    const once = roundTrip(FULL_REQUEST);
    const twice = roundTrip(once);

    expect(blocksOf(twice)).toEqual(blocksOf(once));
    expect(parseBruRequest(twice)).toEqual(parseBruRequest(once));
  });
});

describe('.bru round-trip preserves query and path params (D5)', () => {
  it('keeps both param types with their values', () => {
    const out = roundTrip(FULL_REQUEST);

    expect(out).toContain('params:query');
    expect(out).toContain('page: 1');
    expect(out).toContain('params:path');
    expect(out).toContain('orderId: 42');
  });

  it('keeps a disabled param disabled rather than silently re-arming it', () => {
    const parsed = parseBruRequest(FULL_REQUEST);
    const debug = parsed.params?.find((p) => p.name === 'debug');

    expect(debug).toMatchObject({ value: 'true', enabled: false, type: 'query' });
    expect(roundTrip(FULL_REQUEST)).toContain('~debug: true');
  });
});

describe('.bru round-trip preserves assertions (D5)', () => {
  it('keeps assertions with their enabled state', () => {
    const parsed = parseBruRequest(FULL_REQUEST);

    expect(parsed.assertions).toEqual([
      { name: 'res.status', value: 'eq 200', enabled: true },
      { name: 'res.body.id', value: 'neq 0', enabled: false },
    ]);

    const out = roundTrip(FULL_REQUEST);
    expect(out).toContain('res.status: eq 200');
    expect(out).toContain('~res.body.id: neq 0');
  });
});

describe('.bru round-trip preserves request settings (D5)', () => {
  it('keeps the settings block', () => {
    const parsed = parseBruRequest(FULL_REQUEST);

    expect(parsed.settings).toMatchObject({ encodeUrl: true });
    expect(roundTrip(FULL_REQUEST)).toContain('encodeUrl: true');
  });
});

describe('.bru round-trip preserves vars (D5)', () => {
  it('keeps pre-request and post-response vars', () => {
    const parsed = parseBruRequest(FULL_REQUEST);

    expect(parsed.varSets?.req).toEqual([
      expect.objectContaining({ name: 'token', value: 'abc', enabled: true }),
    ]);
    expect(parsed.varSets?.res).toEqual([
      expect.objectContaining({ name: 'orderId', value: 'res.body.id', enabled: true }),
    ]);

    const out = roundTrip(FULL_REQUEST);
    expect(out).toContain('vars:pre-request');
    expect(out).toContain('vars:post-response');
  });
});

describe('.bru round-trip preserves oauth2 additional parameters (D6)', () => {
  // The grammar allows eight: auth_req takes headers and queryparams, while
  // access_token_req and refresh_token_req each also take body.
  const EXPECTED_BLOCKS = [
    'auth:oauth2:additional_params:auth_req:headers',
    'auth:oauth2:additional_params:auth_req:queryparams',
    'auth:oauth2:additional_params:access_token_req:headers',
    'auth:oauth2:additional_params:access_token_req:queryparams',
    'auth:oauth2:additional_params:access_token_req:body',
    'auth:oauth2:additional_params:refresh_token_req:headers',
    'auth:oauth2:additional_params:refresh_token_req:queryparams',
    'auth:oauth2:additional_params:refresh_token_req:body',
  ];

  it.each(EXPECTED_BLOCKS)('keeps %s', (block) => {
    expect(blocksOf(roundTrip(FULL_REQUEST))).toContain(block);
  });

  it('keeps each parameter’s name and value', () => {
    const out = roundTrip(FULL_REQUEST);

    expect(out).toContain('auth-header: hv');
    expect(out).toContain('auth-q: qv');
    expect(out).toContain('token-header: thv');
    expect(out).toContain('token-q: tqv');
    expect(out).toContain('token-b: tbv');
    expect(out).toContain('refresh-header: rhv');
    expect(out).toContain('refresh-q: rqv');
    expect(out).toContain('refresh-b: rbv');
  });
});

describe('.bru round-trip leaves a minimal request alone', () => {
  const MINIMAL = `meta {
  name: Ping
  type: http
  seq: 1
}

get {
  url: https://api.test/ping
  body: none
  auth: none
}
`;

  it('adds no empty blocks for features the request does not use', () => {
    const out = roundTrip(MINIMAL);

    expect(out).not.toContain('params');
    expect(out).not.toContain('assert');
    expect(out).not.toContain('settings');
    expect(out).not.toContain('vars');
    expect(out).not.toContain('additional_params');
  });
});
