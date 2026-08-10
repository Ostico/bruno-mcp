/**
 * General `.yml` round-trip fidelity guard.
 *
 * The `.yml` twin of `bru-roundtrip-completeness.test.ts`, and it needs one
 * extra layer that the `.bru` side gets for free.
 *
 * Comparing the parsed model before and after a round-trip cannot see a field
 * the *parser* dropped: if `parseYamlRequest` never reads a key, the model is
 * identical on both sides and the property holds vacuously while the file on
 * disk quietly loses data. So the primary assertion here compares the **source
 * document** — `yaml.parse(src)` against `yaml.parse(generate(parse(src)))` —
 * using a neutral reader that has no idea what this codebase models. Anything
 * in the file that does not come back out is reported by path.
 *
 * Adding coverage is one entry in `FIXTURES`.
 */

import { parse as yamlParse } from 'yaml';
import { parseYamlRequest } from '../../../src/bruno/yaml-parser';
import { generateYamlRequest } from '../../../src/bruno/yaml-generator';
import type { YamlRequest } from '../../../src/bruno/types';
import {
  declaredInterfaceKeys,
  lostFields,
  lostKeys,
  readTypesSource,
} from './roundtrip-fingerprint.helper';

interface YamlFixture {
  name: string;
  src: string;
  /**
   * Set when the round-trip is known to lose data that was in the source file.
   * The source-document assertions become `it.failing`, so fixing the cause
   * turns this suite red and forces the waiver to be removed.
   */
  knownSourceLoss?: string;
}

const INFO = `info:
  name: Fixture
  type: http
  seq: 7
`;

const FIXTURES: YamlFixture[] = [
  {
    name: 'minimal request',
    src: `${INFO}http:
  method: GET
  url: https://api.example.test/ping
`,
  },
  {
    // Every level that can carry a key this model does not name. Bruno's grammar
    // has `description` and `examples` today and will grow more; rebuilding the
    // document from the model on each write deleted them, so they belong in this
    // table. `tags` was the info-level example until the model named it — it
    // stays here to exercise the modelled field, with `description`, which
    // `stringifyHttpRequest.ts:40` writes and this model still does not name,
    // taking over as the unmodelled one.
    name: 'keys the model does not name, at every level that can carry one',
    src: `info:
  name: Fixture
  type: http
  seq: 7
  tags:
    - smoke
  description: what this fixture is for

http:
  method: GET
  url: https://api.example.test/orders
  headers:
    - name: Accept
      value: application/json
      description: negotiated by the caller
  params:
    - name: q
      value: "1"
      type: query
      description: free-text search
  retryPolicy: none

runtime:
  hooks:
    - name: audit

settings:
  encodeUrl: true
  customSetting: 42

examples:
  - name: happy path
    status: 200
`,
  },
  {
    name: 'params: query and path, duplicates and a disabled entry',
    src: `${INFO}http:
  method: GET
  url: https://api.example.test/orders/:orderId
  params:
    - name: page
      value: "1"
      type: query
    - name: page
      value: "2"
      type: query
    - name: debug
      value: "true"
      type: query
      disabled: true
    - name: orderId
      value: "42"
      type: path
`,
  },
  {
    name: 'headers, including duplicates',
    src: `${INFO}http:
  method: GET
  url: https://api.example.test/orders
  headers:
    - name: Accept
      value: application/json
    - name: X-Repeated
      value: first
    - name: X-Repeated
      value: second
`,
  },
  {
    name: 'runtime.assertions, including a disabled one',
    src: `${INFO}http:
  method: GET
  url: https://api.example.test/orders
runtime:
  assertions:
    - expression: res.status
      operator: eq
      value: "200"
    - expression: res.body.total
      operator: gt
      value: "0"
    - expression: res.body.id
      operator: neq
      value: "0"
      disabled: true
`,
  },
  {
    name: 'runtime.variables and runtime.actions, local and disabled',
    src: `${INFO}http:
  method: GET
  url: https://api.example.test/orders
runtime:
  variables:
    - name: token
      value: abc
    - name: localOnly
      value: loc
      local: true
    - name: switchedOff
      value: nope
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
    - type: set-variable
      phase: after-response
      selector:
        expression: res.body.old
        method: jsonq
      variable:
        name: staleVar
        scope: request
      disabled: true
`,
  },
  {
    name: 'settings, including tls and proxy',
    src: `${INFO}http:
  method: GET
  url: https://api.example.test/slow
settings:
  encodeUrl: true
  timeout: 5000
  followRedirects: false
  maxRedirects: 3
  proxy: http://proxy.example.test:8080
  tls:
    rejectUnauthorized: false
    ca: ca.pem
    cert: cert.pem
    key: key.pem
`,
  },
  {
    // The parser used to take `timeout` only as a number, and a modelled key
    // never reaches the passthrough bag — so the word was deleted on the next
    // write and the request came back with no timeout at all. Both dialects
    // accept it: `bruToJsonV2` reads the same word out of a `.bru` block.
    name: 'settings: an authored timeout of inherit',
    src: `${INFO}http:
  method: GET
  url: https://api.example.test/slow
settings:
  timeout: inherit
`,
  },
  {
    // The `tls` block needs a bag of its own. It is a modelled settings key, so a
    // field inside it that the model does not name reaches neither the tls
    // fields nor the settings bag; a block made only of such fields parsed to
    // `undefined` and took the whole key with it.
    name: 'settings: tls fields the model does not name',
    src: `${INFO}http:
  method: GET
  url: https://api.example.test/slow
settings:
  tls:
    enabled: true
    pfx: bundle.p12
    passphrase: hunter2
`,
  },
  {
    name: 'settings: tls mixing named and unnamed fields',
    src: `${INFO}http:
  method: GET
  url: https://api.example.test/slow
settings:
  tls:
    rejectUnauthorized: false
    ca: ca.pem
    enabled: true
`,
  },
  {
    name: 'auth: object form',
    src: `${INFO}http:
  method: GET
  url: https://api.example.test/orders
  auth:
    type: bearer
    token: "{{authToken}}"
`,
  },
  {
    name: 'auth: inherit',
    src: `${INFO}http:
  method: GET
  url: https://api.example.test/orders
  auth: inherit
`,
  },
  {
    name: 'body: json',
    src: `${INFO}http:
  method: POST
  url: https://api.example.test/orders
  body:
    type: json
    data: '{"sku":"abc","qty":2}'
`,
  },
  {
    name: 'body: text',
    src: `${INFO}http:
  method: POST
  url: https://api.example.test/notes
  body:
    type: text
    data: plain text payload
`,
  },
  {
    name: 'body: xml',
    src: `${INFO}http:
  method: POST
  url: https://api.example.test/soap
  body:
    type: xml
    data: <order><sku>abc</sku></order>
`,
  },
  {
    name: 'body: form-urlencoded',
    src: `${INFO}http:
  method: POST
  url: https://api.example.test/login
  body:
    type: form-urlencoded
    data: username=alice&password=secret
`,
  },
  {
    name: 'body: multipart-form with text and file parts',
    src: `${INFO}http:
  method: POST
  url: https://api.example.test/upload
  body:
    type: multipart-form
    data:
      - name: caption
        value: a caption
        type: text
      - name: avatar
        value:
          - /srv/uploads/avatar.png
        type: file
        contentType: image/png
`,
  },
  {
    name: 'runtime scripts (the key is `code`, not `content`)',
    src: `${INFO}http:
  method: GET
  url: https://api.example.test/orders
runtime:
  scripts:
    - type: before-request
      code: bru.setVar("start", Date.now());
    - type: after-response
      code: |-
        test("responds 200", function () {
          expect(res.getStatus()).to.equal(200);
        });
`,
  },
  {
    name: 'docs',
    src: `${INFO}http:
  method: GET
  url: https://api.example.test/orders
docs: |-
  # Orders

  Multi-line documentation that must survive intact.
`,
  },
  {
    name: 'every feature at once',
    src: `${INFO}http:
  method: POST
  url: https://api.example.test/orders/:orderId
  headers:
    - name: Accept
      value: application/json
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
  body:
    type: json
    data: '{"sku":"abc"}'
  auth:
    type: bearer
    token: "{{authToken}}"
runtime:
  variables:
    - name: token
      value: abc
    - name: switchedOff
      value: nope
      disabled: true
  scripts:
    - type: before-request
      code: bru.setVar("x", 1);
    - type: after-response
      code: bru.setVar("y", 2);
  assertions:
    - expression: res.status
      operator: eq
      value: "200"
    - expression: res.body.total
      operator: gt
      value: "0"
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
  timeout: 5000
docs: Everything, in one document.
`,
  },

  // ---------------------------------------------------------------------
  // Switched-off entries. These were the dropped-flag defects; the flags now
  // survive, so these fixtures are held to the full round-trip property.
  // ---------------------------------------------------------------------
  {
    name: 'header switched off with `disabled: true`',
    src: `${INFO}http:
  method: GET
  url: https://api.example.test/orders
  headers:
    - name: Accept
      value: application/json
    - name: X-Switched-Off
      value: nope
      disabled: true
`,
  },
  {
    name: 'multipart part switched off with `disabled: true`',
    src: `${INFO}http:
  method: POST
  url: https://api.example.test/upload
  body:
    type: multipart-form
    data:
      - name: caption
        value: a caption
        type: text
      - name: skipped
        value: nope
        type: text
        disabled: true
`,
  },
  {
    // A gRPC request carries its target in its own block and has no `http`
    // section at all. Every key of the block is present so the coverage guard
    // has something to measure for each one, `protoFilePath` included — that key
    // is renamed to `protoPath` on the model and has to come back under its
    // on-disk name or Bruno stops finding the service definition.
    name: 'grpc request with every block key',
    src: `info:
  name: Fixture
  type: grpc
  seq: 7
grpc:
  url: grpc://localhost:50051
  method: /pkg.Svc/Method
  protoFilePath: ./svc.proto
  methodType: unary
  auth:
    type: bearer
    token: live-token
  metadata:
    - name: authorization
      value: Bearer x
      disabled: true
  message:
    - title: first
      message: '{"id":1}'
  reflection: true
`,
  },
  {
    // WebSocket is deliberately not gRPC with renamed fields: credentials are
    // ordinary `headers`, and only its messages carry `type` and `selected`. A
    // variant nests its payload as `message: {type, data}` where gRPC uses a
    // bare string, so this fixture is what proves the two are read differently.
    name: 'websocket request with a selected typed message',
    src: `info:
  name: Fixture
  type: websocket
  seq: 7
websocket:
  url: ws://localhost:8080
  auth:
    type: basic
    username: u
    password: p
  headers:
    - name: x-tenant-key
      value: sekret
      disabled: true
  message:
    - title: hello
      selected: false
      message:
        type: binary
        data: cGF5
  subprotocols:
    - graphql-ws
`,
  },
];

const roundTrip = (src: string): string => generateYamlRequest(parseYamlRequest(src));

describe.each(FIXTURES)('.yml round-trip: $name', (fixture: YamlFixture) => {
  const src = fixture.src;
  const out = roundTrip(src);
  const before = parseYamlRequest(src);
  const after = parseYamlRequest(out);
  const docBefore = yamlParse(src) as Record<string, unknown>;
  const docAfter = yamlParse(out) as Record<string, unknown>;

  // The model-level property holds vacuously for anything the parser never
  // read, so only the source-document comparison is waived for known losses.
  const sourceIt = fixture.knownSourceLoss ? it.failing : it;

  // Not waived even for the known losses: those drop a nested flag, not a whole
  // section, so this assertion must keep holding for them too.
  it('drops no top-level key of the source document', () => {
    expect(lostKeys(docBefore, docAfter)).toEqual([]);
  });

  sourceIt('drops no field of the source document', () => {
    expect(lostFields(docBefore, docAfter, false)).toEqual([]);
  });

  sourceIt('preserves the order of every field in the source document', () => {
    expect(lostFields(docBefore, docAfter, true)).toEqual([]);
  });

  it('drops no top-level key of the parsed model', () => {
    expect(lostKeys(before, after)).toEqual([]);
  });

  it('drops no field of the parsed model, order included', () => {
    expect(lostFields(before, after, true)).toEqual([]);
  });

  it('parse → generate → parse is deeply equal, apart from the settings block', () => {
    // The `.yml` writer always states all four settings, as upstream's does, so
    // a source with no block (or a partial one) gains the missing keys on its
    // first write. Everything else must still survive untouched, and the block
    // itself is asserted below rather than waived.
    const { settings: afterSettings, ...afterRest } = after;
    const { settings: beforeSettings, ...beforeRest } = before;

    expect(afterRest).toEqual(beforeRest);
    // Nothing the source declared may be lost in the normalisation.
    for (const [key, value] of Object.entries(beforeSettings ?? {})) {
      if (value !== undefined) expect(afterSettings).toHaveProperty(key, value);
    }
  });

  // Which keys a write states depends on the kind, because upstream's three
  // `.yml` writers disagree. The HTTP four describe redirect-following and URL
  // encoding, which neither transport does, and upstream's own gRPC and
  // WebSocket readers never look at them.
  it('states the settings its kind has after a write, whatever the source had', () => {
    if (after.grpc) {
      // Upstream's `stringifyGrpcRequest` writes no settings block. This writer
      // keeps one the source authored, because `settings.tls` gates the
      // transport, but it invents nothing.
      expect(after.settings).toEqual(before.settings);
      return;
    }

    if (after.websocket) {
      expect(after.settings).toEqual(
        expect.objectContaining({ timeout: expect.anything() }),
      );
      // Checked by value, not by `toHaveProperty`: the parser builds the block
      // with every modelled key present, so an absent setting is a key holding
      // `undefined` rather than a missing one.
      expect(after.settings?.encodeUrl).toBeUndefined();
      expect(after.settings?.followRedirects).toBeUndefined();
      expect(after.settings?.maxRedirects).toBeUndefined();
      return;
    }

    expect(after.settings).toEqual(
      expect.objectContaining({
        encodeUrl: expect.any(Boolean),
        timeout: expect.anything(),
        followRedirects: expect.any(Boolean),
        maxRedirects: expect.any(Number),
      }),
    );
  });

  it('is idempotent from the second generate onwards', () => {
    expect(parseYamlRequest(roundTrip(out))).toEqual(after);
  });
});

describe('.yml fixture table covers the whole model', () => {
  const presentKeys = (value: unknown): string[] =>
    value && typeof value === 'object'
      ? Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .map(([k]) => k)
      : [];

  const parsed = FIXTURES.map((fixture) => parseYamlRequest(fixture.src));
  const types = readTypesSource();

  const exercised = (pick: (request: YamlRequest) => unknown): Set<string> =>
    new Set(parsed.flatMap((request) => presentKeys(pick(request))));

  const CASES: Array<[string, (request: YamlRequest) => unknown]> = [
    ['YamlRequest', (r) => r],
    ['YamlInfo', (r) => r.info],
    ['YamlHttp', (r) => r.http],
    ['YamlSettings', (r) => r.settings],
    ['TlsSettings', (r) => r.settings?.tls],
    ['YamlVars', (r) => r.vars],
    // Optional now: a gRPC or WebSocket request has no `http` block, so this
    // would throw on those fixtures rather than reporting a coverage gap.
    ['YamlBody', (r) => r.http?.body],
    ['YamlScript', (r) => r.runtime?.scripts?.[0]],
    ['YamlGrpc', (r) => r.grpc],
    ['YamlWebsocket', (r) => r.websocket],
    ['YamlRequestMessage', (r) => r.websocket?.messages?.[0]],
  ];

  // A newly-modelled field with no fixture lands here by name. Add a fixture
  // that produces it — that is what makes the writer's handling of it tested.
  it.each(CASES)('exercises every key declared on %s', (name, pick) => {
    const covered = exercised(pick);
    const uncovered = declaredInterfaceKeys(types, name).filter((key) => !covered.has(key));

    expect(uncovered).toEqual([]);
  });
});

describe('.yml completeness guard actually detects loss', () => {
  // Guarding the guard: if these ever stop reporting, every assertion above is
  // vacuous.
  const src = FIXTURES.find((f) => f.name === 'every feature at once')!.src;
  const doc = yamlParse(src) as Record<string, unknown>;

  it('names a dropped top-level key', () => {
    const { docs: _dropped, ...mutilated } = doc;

    expect(lostKeys(doc, mutilated)).toEqual(['docs']);
  });

  it('names a dropped nested field, with its path', () => {
    const mutilated = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    delete (mutilated.settings as Record<string, unknown>).timeout;

    expect(lostFields(doc, mutilated, false)).toEqual(['settings.timeout = 5000']);
  });

  it('names a re-armed disabled entry', () => {
    const mutilated = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    const http = mutilated.http as { params: Array<Record<string, unknown>> };
    http.params = http.params.map(({ disabled: _dropped, ...rest }) => rest);

    expect(lostFields(doc, mutilated, false)).toEqual(
      expect.arrayContaining([expect.stringContaining('"disabled":true')]),
    );
  });
});

describe('.yml keeps a switched-off entry switched off', () => {
  // Both of these used to lose the flag at parse time and hand the entry back
  // enabled. For a header that meant a credential the author had deliberately
  // disabled was sent on the next run, so these are regression guards, not
  // fidelity nits.

  const header = FIXTURES.find((f) => f.name === 'header switched off with `disabled: true`')!;
  const multipart = FIXTURES.find(
    (f) => f.name === 'multipart part switched off with `disabled: true`',
  )!;

  it('keeps the disabled flag on a header', () => {
    const before = yamlParse(header.src) as Record<string, unknown>;
    const after = yamlParse(roundTrip(header.src)) as Record<string, unknown>;

    expect(lostFields(before, after)).toEqual([]);
    expect(parseYamlRequest(header.src).http.headers).toEqual(
      expect.arrayContaining([expect.objectContaining({ disabled: true })]),
    );
  });

  it('keeps the disabled flag on a multipart part', () => {
    const before = yamlParse(multipart.src) as Record<string, unknown>;
    const after = yamlParse(roundTrip(multipart.src)) as Record<string, unknown>;

    expect(lostFields(before, after)).toEqual([]);
  });

  it('models a disabled part as enabled: false, which the executor already skips', () => {
    // The executor skips a part with enabled === false. Nothing in the
    // .yml path used to set it, which is what let a disabled part be sent.
    const parts = parseYamlRequest(multipart.src).http.body?.data;

    expect(Array.isArray(parts)).toBe(true);
    expect(parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ enabled: false })]),
    );
  });
});
