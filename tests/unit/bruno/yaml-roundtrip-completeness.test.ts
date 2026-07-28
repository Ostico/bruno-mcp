/**
 * General `.yml` round-trip fidelity guard (finding D10).
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
} from './roundtrip-fingerprint';

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
    name: 'assert with a disabled assertion',
    src: `${INFO}http:
  method: GET
  url: https://api.example.test/orders
assert:
  - name: res.status
    value: eq 200
  - name: res.body.total
    value: gt 0
  - name: res.body.id
    value: neq 0
    disabled: true
`,
  },
  {
    name: 'vars: preRequest and postResponse, local and disabled',
    src: `${INFO}http:
  method: GET
  url: https://api.example.test/orders
vars:
  preRequest:
    - name: token
      value: abc
    - name: localOnly
      value: loc
      local: true
    - name: switchedOff
      value: nope
      disabled: true
  postResponse:
    - name: orderId
      value: res.body.id
    - name: staleVar
      value: res.body.old
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
  scripts:
    - type: before-request
      code: bru.setVar("x", 1);
    - type: after-response
      code: bru.setVar("y", 2);
settings:
  encodeUrl: true
  timeout: 5000
assert:
  - name: res.status
    value: eq 200
  - name: res.body.id
    value: neq 0
    disabled: true
vars:
  preRequest:
    - name: token
      value: abc
    - name: off
      value: nope
      disabled: true
  postResponse:
    - name: orderId
      value: res.body.id
docs: Everything, in one document.
`,
  },

  // ---------------------------------------------------------------------
  // Switched-off entries. These were the D13/D14 defects; the flags now
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

  it('parse → generate → parse is deeply equal', () => {
    expect(after).toEqual(before);
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
    ['YamlBody', (r) => r.http.body],
    ['YamlScript', (r) => r.runtime?.scripts?.[0]],
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

describe('.yml keeps a switched-off entry switched off (D13/D14)', () => {
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
    // The executor skips a part with enabled === false (X13). Nothing in the
    // .yml path used to set it, which is what let a disabled part be sent.
    const parts = parseYamlRequest(multipart.src).http.body?.data;

    expect(Array.isArray(parts)).toBe(true);
    expect(parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ enabled: false })]),
    );
  });
});
