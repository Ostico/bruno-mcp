/**
 * .yml round-trip fidelity.
 *
 * The `.yml` writer already emitted `params`, but the reader never parsed them,
 * so every query and path parameter died on a read-modify-write. Assertions and
 * vars were not modelled at all and vanished the same way.
 */

import { parseYamlRequest } from '../../../src/bruno/yaml-parser';
import { generateYamlRequest } from '../../../src/bruno/yaml-generator';
import { parse as yamlParse } from 'yaml';

const FULL_REQUEST = `info:
  name: Get Orders
  type: http
  seq: 3
http:
  method: GET
  url: https://api.test/orders/:orderId
  params:
    - name: page
      value: "1"
      type: query
    - name: debug
      value: "true"
      type: query
      disabled: true
    - name: orderId
      value: "42"
      type: path
  headers:
    - name: Accept
      value: application/json
  body:
    type: json
    data: '{"a":1}'
runtime:
  variables:
    - name: token
      value: abc
  scripts:
    - type: pre-request
      code: bru.setVar("x", 1);
  assertions:
    - expression: res.status
      operator: eq
      value: "200"
    - expression: res.body.id
      operator: neq
      value: "0"
      disabled: true
  actions:
    - type: set-variable
      phase: after-response
      selector:
        expression: res.body.id
        method: jsonq
      variable:
        name: orderId
        scope: runtime
settings:
  encodeUrl: true
docs: Some documentation here.
`;

const roundTrip = (src: string) => generateYamlRequest(parseYamlRequest(src));

/** Every leaf path in a parsed YAML document. */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [prefix];
  if (Array.isArray(value)) return value.flatMap((v) => leafPaths(v, `${prefix}[]`));
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    leafPaths(v, prefix ? `${prefix}.${k}` : k),
  );
}

const pathsOf = (src: string) => Array.from(new Set(leafPaths(yamlParse(src)))).sort();

describe('.yml round-trip preserves the whole document', () => {
  it('loses no field from a request that uses every feature', () => {
    const before = pathsOf(FULL_REQUEST);
    const after = pathsOf(roundTrip(FULL_REQUEST));

    expect(before.filter((p) => !after.includes(p))).toEqual([]);
  });

  it('is stable across a second round-trip', () => {
    const once = roundTrip(FULL_REQUEST);

    expect(parseYamlRequest(roundTrip(once))).toEqual(parseYamlRequest(once));
  });
});

describe('.yml round-trip preserves params', () => {
  it('parses query and path params instead of dropping them', () => {
    const parsed = parseYamlRequest(FULL_REQUEST);

    expect(parsed.http.params).toEqual([
      { name: 'page', value: '1', type: 'query' },
      { name: 'debug', value: 'true', type: 'query', disabled: true },
      { name: 'orderId', value: '42', type: 'path' },
    ]);
  });

  it('writes them back, disabled flag included', () => {
    const out = yamlParse(roundTrip(FULL_REQUEST));

    expect(out.http.params).toEqual([
      { name: 'page', value: '1', type: 'query' },
      { name: 'debug', value: 'true', type: 'query', disabled: true },
      { name: 'orderId', value: '42', type: 'path' },
    ]);
  });
});

describe('.yml round-trip preserves assertions', () => {
  it('keeps assertions with their disabled state', () => {
    const parsed = parseYamlRequest(FULL_REQUEST);

    expect(parsed.assert).toEqual([
      { name: 'res.status', value: 'eq 200' },
      { name: 'res.body.id', value: 'neq 0', disabled: true },
    ]);
    // Re-parsed rather than read off the raw document, because the on-disk
    // shape is upstream's — `expression` plus a separate `operator`, under
    // `runtime`. The byte-level shape is pinned in yaml-runtime-blocks.test.ts.
    expect(parseYamlRequest(roundTrip(FULL_REQUEST)).assert).toEqual([
      { name: 'res.status', value: 'eq 200' },
      { name: 'res.body.id', value: 'neq 0', disabled: true },
    ]);
    expect(yamlParse(roundTrip(FULL_REQUEST)).assert).toBeUndefined();
  });
});

describe('.yml round-trip preserves vars', () => {
  it('keeps pre-request and post-response vars', () => {
    const parsed = parseYamlRequest(FULL_REQUEST);

    expect(parsed.vars).toEqual({
      preRequest: [{ name: 'token', value: 'abc' }],
      postResponse: [{ name: 'orderId', value: 'res.body.id' }],
    });
    expect(parseYamlRequest(roundTrip(FULL_REQUEST)).vars).toEqual({
      preRequest: [{ name: 'token', value: 'abc' }],
      postResponse: [{ name: 'orderId', value: 'res.body.id' }],
    });
    // Not at the top level, where Bruno would never look for them.
    expect(yamlParse(roundTrip(FULL_REQUEST)).vars).toBeUndefined();
  });
});

describe('.yml round-trip leaves a minimal request alone', () => {
  const MINIMAL = `info:
  name: Ping
  type: http
  seq: 1
http:
  method: GET
  url: https://api.test/ping
`;

  it('adds no empty sections for features the request does not use', () => {
    const out = yamlParse(roundTrip(MINIMAL));

    expect(out.assert).toBeUndefined();
    expect(out.vars).toBeUndefined();
    expect(out.http.params).toBeUndefined();
  });

  it('ignores malformed entries rather than emitting junk', () => {
    const messy = `info:
  name: Messy
  type: http
  seq: 1
http:
  method: GET
  url: https://api.test/x
  params: "not-a-list"
assert: 42
vars:
  preRequest:
    - value: nameless
`;
    const parsed = parseYamlRequest(messy);

    expect(parsed.http.params).toBeUndefined();
    expect(parsed.assert).toBeUndefined();
    expect(parsed.vars).toBeUndefined();
  });
});
