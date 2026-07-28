/**
 * General `.bru` round-trip fidelity guard (finding D10).
 *
 * `bru-roundtrip-fidelity.test.ts` pins down the specific fields that findings
 * D5/D6 restored. This suite is the *general* property those targeted tests
 * cannot express: for any document, parse → generate → parse must lose nothing,
 * and the failure must name what was lost.
 *
 * Three layers, deliberately:
 *
 *  1. the parsed model must survive a round-trip unchanged — catches a writer
 *     that quietly drops a field the model already carries;
 *  2. `@usebruno/lang`'s own reader output must survive a round-trip unchanged —
 *     catches a *grammar* block this codebase never modelled at all, which
 *     layer 1 is blind to because the model never held the data in the first
 *     place;
 *  3. every key declared on `BruFile` must be exercised by some fixture —
 *     catches the next field somebody adds and forgets to write back.
 *
 * Adding coverage is one entry in `FIXTURES`.
 */

import { bruToJsonV2 } from '@usebruno/lang';
import { parseBruRequest, generateBruRequest } from '../../../src/bruno/bru-parser';
import type { BruFile } from '../../../src/bruno/types';
import {
  bruBlockHeaders,
  declaredInterfaceKeys,
  lostFields,
  lostKeys,
  readTypesSource,
} from './roundtrip-fingerprint';

interface BruFixture {
  /** Fixture name, used as the describe title. */
  name: string;
  /** A complete `.bru` document. */
  src: string;
  /**
   * Set when the fixture is known to lose *position* (never data) on a
   * round-trip. The order assertions become `it.failing`, so the day the cause
   * is fixed this suite goes red and the waiver has to be removed.
   */
  knownOrderDefect?: string;
}

const META = `meta {
  name: Fixture
  type: http
  seq: 7
}
`;

/**
 * Every fixture below places any disabled (`~`) entry LAST inside its block.
 * That is not cosmetic: `jsonToBruV2` re-emits a block as "all enabled entries,
 * then all disabled entries", so a disabled entry written in the middle of a
 * block comes back at the end of it. The `knownOrderDefect` fixtures at the
 * bottom of this table pin that behaviour down; everything else keeps disabled
 * entries where the writer would have put them anyway, so the order assertions
 * stay meaningful for the enabled entries and duplicates around them.
 */
const FIXTURES: BruFixture[] = [
  {
    name: 'minimal request',
    src: `${META}
get {
  url: https://api.example.test/ping
  body: none
  auth: none
}
`,
  },
  {
    name: 'params: query and path, duplicates and a disabled entry',
    src: `${META}
get {
  url: https://api.example.test/orders/:orderId
  body: none
  auth: none
}

params:query {
  page: 1
  page: 2
  filter: open
  ~debug: true
}

params:path {
  orderId: 42
}
`,
  },
  {
    name: 'assert with a disabled assertion',
    src: `${META}
get {
  url: https://api.example.test/orders
  body: none
  auth: none
}

assert {
  res.status: eq 200
  res.body.total: gt 0
  ~res.body.id: neq 0
}
`,
  },
  {
    name: 'settings',
    src: `${META}
get {
  url: https://api.example.test/slow
  body: none
  auth: none
}

settings {
  encodeUrl: true
  timeout: 5000
}
`,
  },
  {
    name: 'vars: pre-request and post-response, local and disabled',
    src: `${META}
get {
  url: https://api.example.test/orders
  body: none
  auth: none
}

vars:pre-request {
  token: abc
  @localOnly: loc
  ~switchedOff: nope
}

vars:post-response {
  orderId: res.body.id
  ~staleVar: res.body.old
}
`,
  },
  {
    name: 'headers: duplicate names and a disabled entry',
    src: `${META}
get {
  url: https://api.example.test/orders
  body: none
  auth: none
}

headers {
  Accept: application/json
  X-Repeated: first
  X-Repeated: second
  ~X-Switched-Off: nope
}
`,
  },
  {
    name: 'oauth2 with all eight additional_params blocks',
    src: `${META}
get {
  url: https://api.example.test/orders
  body: none
  auth: oauth2
}

auth:oauth2 {
  grant_type: authorization_code
  callback_url: https://app.example.test/callback
  authorization_url: https://api.example.test/authorize
  access_token_url: https://api.example.test/token
  refresh_token_url: https://api.example.test/refresh
  client_id: client-id
  client_secret: client-secret
  scope: read write
  state: state-value
  pkce: true
  credentials_placement: body
  credentials_id: credentials-id
  token_placement: header
  token_header_prefix: Bearer
  auto_fetch_token: true
  auto_refresh_token: false
}

auth:oauth2:additional_params:auth_req:headers {
  auth-req-header: a1
  ~auth-req-header-off: a2
}

auth:oauth2:additional_params:auth_req:queryparams {
  auth-req-query: a3
}

auth:oauth2:additional_params:access_token_req:headers {
  token-req-header: t1
}

auth:oauth2:additional_params:access_token_req:queryparams {
  token-req-query: t2
}

auth:oauth2:additional_params:access_token_req:body {
  token-req-body: t3
}

auth:oauth2:additional_params:refresh_token_req:headers {
  refresh-req-header: r1
}

auth:oauth2:additional_params:refresh_token_req:queryparams {
  refresh-req-query: r2
}

auth:oauth2:additional_params:refresh_token_req:body {
  refresh-req-body: r3
}
`,
  },
  {
    name: 'body:json',
    src: `${META}
post {
  url: https://api.example.test/orders
  body: json
  auth: none
}

body:json {
  {
    "sku": "abc",
    "qty": 2
  }
}
`,
  },
  {
    name: 'body:text',
    src: `${META}
post {
  url: https://api.example.test/notes
  body: text
  auth: none
}

body:text {
  plain text payload
}
`,
  },
  {
    name: 'body:xml',
    src: `${META}
post {
  url: https://api.example.test/soap
  body: xml
  auth: none
}

body:xml {
  <order><sku>abc</sku></order>
}
`,
  },
  {
    name: 'body:sparql',
    src: `${META}
post {
  url: https://api.example.test/sparql
  body: sparql
  auth: none
}

body:sparql {
  SELECT ?s WHERE { ?s ?p ?o }
}
`,
  },
  {
    name: 'body:graphql with variables',
    src: `${META}
post {
  url: https://api.example.test/graphql
  body: graphql
  auth: none
}

body:graphql {
  query Hero($id: ID!) { hero(id: $id) { name } }
}

body:graphql:vars {
  {
    "id": "1"
  }
}
`,
  },
  {
    name: 'body:form-urlencoded with a disabled field',
    src: `${META}
post {
  url: https://api.example.test/login
  body: form-urlencoded
  auth: none
}

body:form-urlencoded {
  username: alice
  password: secret
  ~remember: yes
}
`,
  },
  {
    name: 'body:multipart-form with text, file and a disabled field',
    src: `${META}
post {
  url: https://api.example.test/upload
  body: multipartForm
  auth: none
}

body:multipart-form {
  caption: a caption
  avatar: @file(avatar.png) @contentType(image/png)
  ~note: skipped
}
`,
  },
  {
    name: 'body:file with contentType and a deselected part',
    src: `${META}
post {
  url: https://api.example.test/raw
  body: file
  auth: none
}

body:file {
  file: @file(payload.json) @contentType(application/json)
  ~file: @file(unused.txt) @contentType(text/plain)
}
`,
  },
  {
    name: 'docs, scripts and tests',
    src: `${META}
get {
  url: https://api.example.test/orders
  body: none
  auth: none
}

script:pre-request {
  bru.setVar("start", Date.now());
  console.log("before");
}

script:post-response {
  bru.setVar("elapsed", Date.now());
}

tests {
  test("responds 200", function () {
    expect(res.getStatus()).to.equal(200);
  });
}

docs {
  # Orders

  Multi-line documentation that must survive intact.
}
`,
  },
  {
    name: 'every feature at once',
    src: `${META}
post {
  url: https://api.example.test/orders/:orderId
  body: json
  auth: bearer
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
  ~X-Off: nope
}

auth:bearer {
  token: {{authToken}}
}

body:json {
  {"sku":"abc"}
}

vars:pre-request {
  token: abc
  ~off: nope
}

vars:post-response {
  orderId: res.body.id
}

assert {
  res.status: eq 200
  ~res.body.id: neq 0
}

script:pre-request {
  bru.setVar("x", 1);
}

script:post-response {
  bru.setVar("y", 2);
}

tests {
  test("ok", function () { expect(1).to.equal(1); });
}

settings {
  encodeUrl: true
}

docs {
  Everything, in one document.
}
`,
  },

  // ---------------------------------------------------------------------
  // Fixtures below document a real, unfixed defect. See the report in
  // `describe('known defect …')` at the bottom of this file.
  // ---------------------------------------------------------------------
  {
    name: 'params with a disabled entry in the middle',
    knownOrderDefect: 'jsonToBruV2 re-emits disabled entries at the end of their block',
    src: `${META}
get {
  url: https://api.example.test/orders
  body: none
  auth: none
}

params:query {
  first: 1
  ~middle: 2
  last: 3
}
`,
  },
  {
    name: 'headers with a disabled entry in the middle',
    knownOrderDefect: 'jsonToBruV2 re-emits disabled entries at the end of their block',
    src: `${META}
get {
  url: https://api.example.test/orders
  body: none
  auth: none
}

headers {
  X-First: 1
  ~X-Middle: 2
  X-Last: 3
}
`,
  },
  {
    name: 'vars with a disabled entry in the middle',
    knownOrderDefect: 'jsonToBruV2 re-emits disabled entries at the end of their block',
    src: `${META}
get {
  url: https://api.example.test/orders
  body: none
  auth: none
}

vars:pre-request {
  first: 1
  ~middle: 2
  last: 3
}
`,
  },
];

const roundTrip = (src: string): string => generateBruRequest(parseBruRequest(src));

describe.each(FIXTURES)('.bru round-trip: $name', (fixture: BruFixture) => {
  const src = fixture.src;
  const out = roundTrip(src);
  const before = parseBruRequest(src);
  const after = parseBruRequest(out);
  const rawBefore = bruToJsonV2(src) as Record<string, unknown>;
  const rawAfter = bruToJsonV2(out) as Record<string, unknown>;

  // An ordered comparison is only meaningful where order is actually kept; the
  // waived fixtures still get the positionless comparison, which proves the
  // data itself is intact even though it moved.
  const orderIt = fixture.knownOrderDefect ? it.failing : it;

  it('emits every block header the source had', () => {
    const emitted = new Set(bruBlockHeaders(out));
    const missing = bruBlockHeaders(src).filter((block) => !emitted.has(block));

    expect(missing).toEqual([]);
  });

  it('drops no top-level key of the parsed model', () => {
    expect(lostKeys(before, after)).toEqual([]);
  });

  it("drops no top-level key of @usebruno/lang's reader output", () => {
    expect(lostKeys(rawBefore, rawAfter)).toEqual([]);
  });

  it('drops no field of the parsed model', () => {
    expect(lostFields(before, after, false)).toEqual([]);
  });

  it("drops no field of @usebruno/lang's reader output", () => {
    expect(lostFields(rawBefore, rawAfter, false)).toEqual([]);
  });

  orderIt('preserves the order of every field in the parsed model', () => {
    expect(lostFields(before, after, true)).toEqual([]);
  });

  orderIt("preserves the order of every field in @usebruno/lang's reader output", () => {
    expect(lostFields(rawBefore, rawAfter, true)).toEqual([]);
  });

  orderIt('parse → generate → parse is deeply equal', () => {
    expect(after).toEqual(before);
  });

  it('is idempotent from the second generate onwards', () => {
    expect(parseBruRequest(roundTrip(out))).toEqual(after);
  });
});

describe('.bru fixture table covers the whole model', () => {
  /**
   * `BruFile` keys no fixture can produce, with the reason. A key may only be
   * waived here after checking that nothing populates it — if a future change
   * starts writing one of these, delete the entry and add a fixture.
   */
  const UNREACHABLE: Record<string, string> = {
    query:
      'legacy flat query map: parseBruRequest never populates it (params/BruParam superseded it in D5)',
    vars: 'legacy flat vars map: parseBruRequest populates varSets instead (D5)',
  };

  const exercised = new Set(
    FIXTURES.flatMap((fixture) => Object.keys(parseBruRequest(fixture.src) as BruFile)),
  );

  it('exercises every key declared on BruFile', () => {
    const declared = declaredInterfaceKeys(readTypesSource(), 'BruFile');
    const uncovered = declared.filter(
      (key) => !exercised.has(key) && !(key in UNREACHABLE),
    );

    // A new BruFile field with no fixture lands here by name. Add a fixture that
    // produces it — that is what makes the writer's handling of it get tested.
    expect(uncovered).toEqual([]);
  });

  it('has no stale waiver in UNREACHABLE', () => {
    const declared = new Set(declaredInterfaceKeys(readTypesSource(), 'BruFile'));
    const stale = Object.keys(UNREACHABLE).filter(
      (key) => !declared.has(key) || exercised.has(key),
    );

    expect(stale).toEqual([]);
  });
});

describe('.bru completeness guard actually detects loss', () => {
  // Guarding the guard: if these ever stop reporting, the assertions above are
  // vacuous and every suite in this file is worthless.
  const src = FIXTURES.find((f) => f.name === 'every feature at once')!.src;
  const model = parseBruRequest(src);

  it('names a dropped top-level key', () => {
    const mutilated = { ...model, assertions: undefined };

    expect(lostKeys(model, mutilated)).toEqual(['assertions']);
  });

  it('names a dropped nested field, with its path', () => {
    const mutilated = JSON.parse(JSON.stringify(model)) as BruFile;
    delete mutilated.docs;

    expect(lostFields(model, mutilated, false)).toEqual([
      'docs = "Everything, in one document."',
    ]);
  });

  it('names a re-armed disabled entry', () => {
    const mutilated = JSON.parse(JSON.stringify(model)) as BruFile;
    mutilated.params = mutilated.params!.map((p) => ({ ...p, enabled: true }));

    expect(lostFields(model, mutilated, false)).toEqual(
      expect.arrayContaining([expect.stringContaining('"enabled":false')]),
    );
  });

  it('names a re-ordered entry only under the ordered comparison', () => {
    const mutilated = JSON.parse(JSON.stringify(model)) as BruFile;
    mutilated.headersList = [...mutilated.headersList!].reverse();

    expect(lostFields(model, mutilated, false)).toEqual([]);
    expect(lostFields(model, mutilated, true)).not.toEqual([]);
  });
});

describe('known defect: a disabled entry is relocated to the end of its block', () => {
  /**
   * NOT FIXED, and out of scope for a tests-only change.
   *
   * `jsonToBruV2` writes every ordered block as "all enabled entries, then all
   * disabled entries". A `.bru` file whose author put a `~`-disabled entry in
   * the middle of `headers`, `params`, `vars`, `assert`,
   * `body:form-urlencoded`, `body:multipart-form` or `body:file` gets it moved
   * to the bottom of that block by any read-modify-write, even one that touched
   * nothing else. Names, values and the disabled flag all survive; only the
   * position is lost.
   */
  const BLOCKS: Array<[string, string, string]> = [
    ['headers', 'none', 'headers {\n  A: 1\n  ~B: 2\n  C: 3\n}'],
    ['params:query', 'none', 'params:query {\n  a: 1\n  ~b: 2\n  c: 3\n}'],
    ['vars:pre-request', 'none', 'vars:pre-request {\n  a: 1\n  ~b: 2\n  c: 3\n}'],
    ['assert', 'none', 'assert {\n  a: eq 1\n  ~b: eq 2\n  c: eq 3\n}'],
    [
      'body:form-urlencoded',
      'form-urlencoded',
      'body:form-urlencoded {\n  a: 1\n  ~b: 2\n  c: 3\n}',
    ],
    [
      'body:multipart-form',
      'multipartForm',
      'body:multipart-form {\n  a: 1\n  ~b: 2\n  c: 3\n}',
    ],
    [
      'body:file',
      'file',
      'body:file {\n  file: @file(a.json)\n  ~file: @file(b.txt)\n  file: @file(c.xml)\n}',
    ],
  ];

  const document = (bodyType: string, block: string): string => `${META}
post {
  url: https://api.example.test/x
  body: ${bodyType}
  auth: none
}

${block}
`;

  it.each(BLOCKS)('keeps the data of a disabled %s entry', (_block, bodyType, block) => {
    const src = document(bodyType, block);
    const before = parseBruRequest(src);

    expect(lostFields(before, parseBruRequest(roundTrip(src)), false)).toEqual([]);
  });

  it.failing.each(BLOCKS)('keeps the POSITION of a disabled %s entry', (_b, bodyType, block) => {
    const src = document(bodyType, block);
    const before = parseBruRequest(src);

    expect(lostFields(before, parseBruRequest(roundTrip(src)), true)).toEqual([]);
  });
});
