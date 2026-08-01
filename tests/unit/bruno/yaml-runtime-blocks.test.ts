/**
 * The `runtime` block of a `.yml` request.
 *
 * Variables, assertions and post-response actions used to be written at the top
 * level under `vars` and `assert` — names Bruno's request grammar does not
 * contain. Outbound, every `.yml` this server wrote had its variables and
 * assertions invisible to `bru run`; inbound, a Bruno-authored request had them
 * dropped, so its declared assertions vanished and the run still reported green.
 *
 * **These tests deliberately do not use a round-trip as their oracle.** Our
 * writer and our parser agreed with each other for the whole life of the bug,
 * which is precisely why the existing suite stayed green through it — and why
 * `runtime.scripts`, the one block already in the right place, made the dialect
 * look correct wherever anyone would think to check. So the assertions below
 * pin the literal on-disk structure against upstream's
 * `bruno-filestore/src/formats/yml/{items/parseHttpRequest,common/*}.ts`, and
 * the inbound cases start from a document written the way Bruno writes one.
 */
import { generateYamlRequest } from '../../../src/bruno/yaml-generator';
import { parseYamlRequest } from '../../../src/bruno/yaml-parser';
import { parse as yamlParse } from 'yaml';

const INFO = `info:
  name: Orders
  seq: 1
`;

const HTTP = `http:
  method: GET
  url: https://api.example.test/orders
`;

/** Read a request in, write it back out, and look at the bytes. */
const emit = (src: string): Record<string, any> =>
  yamlParse(generateYamlRequest(parseYamlRequest(src)));

describe('the three blocks are written where Bruno reads them', () => {
  const authored = `${INFO}${HTTP}runtime:
  variables:
    - name: token
      value: abc
  assertions:
    - expression: res.status
      operator: eq
      value: "200"
  actions:
    - type: set-variable
      phase: after-response
      selector:
        expression: res.body.id
        method: jsonq
      variable:
        name: orderId
        scope: runtime
`;

  it('puts variables, assertions and actions inside runtime', () => {
    const doc = emit(authored);

    expect(Object.keys(doc.runtime)).toEqual(['variables', 'assertions', 'actions']);
  });

  it('writes nothing at the top level under our own old names', () => {
    const doc = emit(authored);

    // `toBeUndefined` would also pass on a key present with an undefined value,
    // which is a key as far as a YAML reader is concerned.
    expect('vars' in doc).toBe(false);
    expect('assert' in doc).toBe(false);
  });

  it('leaves a request with none of the three without a runtime block', () => {
    const doc = emit(`${INFO}${HTTP}`);

    expect('runtime' in doc).toBe(false);
  });
});

describe('assertions carry the operator as its own field', () => {
  const withAssert = (value: string) =>
    emit(`${INFO}${HTTP}runtime:
  assertions:
    - expression: res.status
      operator: ${value.split(' ')[0]}
${value.split(' ').length > 1 ? `      value: "${value.split(' ').slice(1).join(' ')}"\n` : ''}`);

  it('splits Bruno’s packed "operator value" string in two', () => {
    expect(withAssert('eq 200').runtime.assertions[0]).toEqual({
      expression: 'res.status',
      operator: 'eq',
      value: '200',
    });
  });

  it('omits the value key entirely for a unary operator', () => {
    const assertion = withAssert('isEmpty').runtime.assertions[0];

    expect(assertion).toEqual({ expression: 'res.status', operator: 'isEmpty' });
    // A present-but-undefined `value` is a different document.
    expect('value' in assertion).toBe(false);
  });

  it('treats an unrecognised first word as a value compared with eq', () => {
    // A bare `assert: { "res.status": 200 }` is legal Bruno, and normalising it
    // to `eq 200` is what upstream does too.
    const parsed = parseYamlRequest(`${INFO}${HTTP}runtime:
  assertions:
    - expression: res.status
      value: "200 ok"
`);

    expect(parsed.assert).toEqual([{ name: 'res.status', value: 'eq 200 ok' }]);
  });

  it('normalises a bare value on the way out, giving it the eq operator', () => {
    // Reaches the writer through a legacy top-level `assert`, which is where an
    // operator-less value actually comes from.
    const doc = emit(`${INFO}${HTTP}assert:
  - name: res.status
    value: "200"
`);

    expect(doc.runtime.assertions[0]).toEqual({
      expression: 'res.status',
      operator: 'eq',
      value: '200',
    });
  });

  it('keeps an empty value as an empty value, not as a bare operator', () => {
    // The empty string is a value, so the key stays — only a unary operator
    // drops it. Getting this wrong turns `eq ""` into `eq`.
    const doc = emit(`${INFO}${HTTP}assert:
  - name: res.body.note
    value: ""
`);

    expect(doc.runtime.assertions[0]).toEqual({
      expression: 'res.body.note',
      operator: 'eq',
      value: '',
    });
  });

  it('keeps a disabled assertion disabled, on disk and back', () => {
    const src = `${INFO}${HTTP}runtime:
  assertions:
    - expression: res.body.id
      operator: neq
      value: "0"
      disabled: true
`;

    expect(emit(src).runtime.assertions[0].disabled).toBe(true);
    expect(parseYamlRequest(src).assert).toEqual([
      { name: 'res.body.id', value: 'neq 0', disabled: true },
    ]);
  });
});

describe('post-response variables are set-variable actions', () => {
  const src = (scope: string) => `${INFO}${HTTP}runtime:
  actions:
    - type: set-variable
      phase: after-response
      selector:
        expression: res.body.id
        method: jsonq
      variable:
        name: orderId
        scope: ${scope}
`;

  it('writes the selector and the jsonq method upstream expects', () => {
    expect(emit(src('runtime')).runtime.actions[0]).toEqual({
      type: 'set-variable',
      phase: 'after-response',
      selector: { expression: 'res.body.id', method: 'jsonq' },
      variable: { name: 'orderId', scope: 'runtime' },
    });
  });

  it('reads the selector expression back as the variable’s value', () => {
    expect(parseYamlRequest(src('runtime')).vars?.postResponse).toEqual([
      { name: 'orderId', value: 'res.body.id' },
    ]);
  });

  it('maps a request-scoped action to local, and back', () => {
    // Upstream's own reader hardcodes `local: false` and ignores the scope it
    // just wrote, so this is a deliberate divergence: matching that bug would
    // drop the flag on every file we read, including the ones we wrote.
    expect(parseYamlRequest(src('request')).vars?.postResponse).toEqual([
      { name: 'orderId', value: 'res.body.id', local: true },
    ]);
    expect(emit(src('request')).runtime.actions[0].variable.scope).toBe('request');
  });

  it('ignores an action that is not a set-variable, rather than mistranslating it', () => {
    // The action carries a usable `variable.name` on purpose. Without one it is
    // dropped by the name check at the end regardless of its type, so the test
    // passes with the type filter deleted — which is exactly what a mutation
    // run caught.
    const parsed = parseYamlRequest(`${INFO}${HTTP}runtime:
  actions:
    - type: something-else
      phase: after-response
      selector:
        expression: res.body.id
        method: jsonq
      variable:
        name: orderId
        scope: runtime
`);

    expect(parsed.vars).toBeUndefined();
  });

  it('ignores a set-variable in another phase', () => {
    const parsed = parseYamlRequest(`${INFO}${HTTP}runtime:
  actions:
    - type: set-variable
      phase: before-request
      selector:
        expression: res.body.id
        method: jsonq
      variable:
        name: orderId
`);

    expect(parsed.vars).toBeUndefined();
  });
});

describe('a Bruno-authored request is no longer read as empty', () => {
  it('reads declared assertions that used to be dropped entirely', () => {
    // The headline defect: before this, `assert` came back empty for a request
    // that declared two assertions, and the run reported green having checked
    // nothing.
    const parsed = parseYamlRequest(`${INFO}${HTTP}runtime:
  assertions:
    - expression: res.status
      operator: eq
      value: "200"
    - expression: res.body.total
      operator: gt
      value: "0"
`);

    expect(parsed.assert).toEqual([
      { name: 'res.status', value: 'eq 200' },
      { name: 'res.body.total', value: 'gt 0' },
    ]);
  });

  it('keeps a runtime block that carries variables but no scripts', () => {
    // The runtime parser used to return undefined unless `scripts` was a
    // non-empty array, which would have thrown the whole block away — and a
    // request declaring variables and no script is an ordinary request.
    const parsed = parseYamlRequest(`${INFO}${HTTP}runtime:
  variables:
    - name: token
      value: abc
`);

    expect(parsed.vars?.preRequest).toEqual([{ name: 'token', value: 'abc' }]);
  });
});

describe('typed variable values', () => {
  it('reads a typed value as its data, recording the type', () => {
    // `String({type, data})` produced the literal "[object Object]" and put it
    // on the wire.
    const parsed = parseYamlRequest(`${INFO}${HTTP}runtime:
  variables:
    - name: count
      value:
        type: number
        data: "100"
`);

    expect(parsed.vars?.preRequest).toEqual([
      { name: 'count', value: '100', dataType: 'number' },
    ]);
  });

  it('writes a typed value back as a typed value, not as a string', () => {
    const src = `${INFO}${HTTP}runtime:
  variables:
    - name: count
      value:
        type: number
        data: "100"
`;

    expect(emit(src).runtime.variables[0].value).toEqual({ type: 'number', data: '100' });
  });

  it('does not wrap an ordinary variable in a typed value', () => {
    const doc = emit(`${INFO}${HTTP}runtime:
  variables:
    - name: token
      value: abc
`);

    expect(doc.runtime.variables[0].value).toBe('abc');
  });

  it('treats an explicit string type as the default and stops recording it', () => {
    const parsed = parseYamlRequest(`${INFO}${HTTP}runtime:
  variables:
    - name: token
      value:
        type: string
        data: abc
`);

    expect(parsed.vars?.preRequest).toEqual([{ name: 'token', value: 'abc' }]);
  });

  it('renders a plain object value as JSON rather than [object Object]', () => {
    const parsed = parseYamlRequest(`${INFO}${HTTP}runtime:
  variables:
    - name: payload
      value:
        a: 1
`);

    expect(parsed.vars?.preRequest?.[0].value).toBe('{\n  "a": 1\n}');
  });
});

describe('local on a pre-request variable', () => {
  it('survives, though upstream’s own shape has nowhere to put it', () => {
    // `.bru` supports `local` on pre-request vars (the `@name` prefix), so
    // dropping it here would make `.yml` lossy against `.bru` and lose the flag
    // on any bru-to-yaml conversion.
    const src = `${INFO}${HTTP}runtime:
  variables:
    - name: scoped
      value: v
      local: true
`;

    expect(emit(src).runtime.variables[0].local).toBe(true);
    expect(parseYamlRequest(src).vars?.preRequest).toEqual([
      { name: 'scoped', value: 'v', local: true },
    ]);
  });
});

describe('files this server wrote before the keys were fixed', () => {
  const legacy = `${INFO}${HTTP}assert:
  - name: res.status
    value: eq 200
vars:
  preRequest:
    - name: token
      value: abc
  postResponse:
    - name: orderId
      value: res.body.id
`;

  it('still loads them, so nothing already on disk stops being readable', () => {
    const parsed = parseYamlRequest(legacy);

    expect(parsed.assert).toEqual([{ name: 'res.status', value: 'eq 200' }]);
    expect(parsed.vars).toEqual({
      preRequest: [{ name: 'token', value: 'abc' }],
      postResponse: [{ name: 'orderId', value: 'res.body.id' }],
    });
  });

  it('migrates them into runtime on the next write', () => {
    const doc = emit(legacy);

    expect(doc.runtime.variables).toHaveLength(1);
    expect(doc.runtime.assertions).toHaveLength(1);
    expect(doc.runtime.actions).toHaveLength(1);
    expect('vars' in doc).toBe(false);
    expect('assert' in doc).toBe(false);
  });

  it('prefers upstream’s keys when a document somehow carries both', () => {
    const both = `${INFO}${HTTP}runtime:
  variables:
    - name: fromRuntime
      value: correct
  assertions:
    - expression: res.status
      operator: eq
      value: "201"
assert:
  - name: res.status
    value: eq 200
vars:
  preRequest:
    - name: fromTopLevel
      value: stale
`;
    const parsed = parseYamlRequest(both);

    expect(parsed.vars?.preRequest).toEqual([{ name: 'fromRuntime', value: 'correct' }]);
    expect(parsed.assert).toEqual([{ name: 'res.status', value: 'eq 201' }]);
  });
});
