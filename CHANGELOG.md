# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> **The next published release must be `2.0.0`.** The public API lost three
> exports after `1.2.3` (see *Removed* below), and `run_collection`'s input and
> output shapes both changed (see *Breaking changes* below). That is a breaking
> change under semver, so it cannot ship as a patch or minor no matter how small
> the diff that follows it.

### Breaking changes

- **Execution groups replace the folder as the unit of execution.** A run is now
  an ordered list of *groups*; a group owns its request list, its environment,
  its variables, its `parallel` flag, one variable store and one cookie jar.
  Nothing crosses a group boundary in either direction, at any `parallel`
  setting. The directory a request happens to sit in no longer decides any of
  this. See `docs/superpowers/specs/2026-08-02-execution-groups-design.md`.

- **`run_collection` lost `requestPath` and `folder`; use `requests`.** Both were
  singular — one file, or one directory — and both are now one ordered
  `requests` array whose entries are files or directories. Order is the
  caller's, and duplicates are honoured: naming the same request twice runs it
  twice. Migration is mechanical: `requestPath: "auth/login.bru"` becomes
  `requests: ["auth/login.bru"]`.

- **`run_collection` gained `groups` and `maxConcurrency`.** Pass `groups`
  instead of `requests` when one call needs more than one identity or
  configuration — the same five requests as alice and as bob, or against staging
  and against production, in one call and without leakage. Passing both
  `requests` and `groups` is rejected rather than resolved by a precedence rule.
  `maxConcurrency` caps requests in flight across the whole run; omit it and one
  is derived from this machine's cores and memory, `0` lifts it entirely.

- **A named request that will not parse fails its group, not the call.** It used
  to throw out of `run_collection`, so a syntax error in one file meant every
  other group reported nothing at all — including the ones that would have
  passed. The group that named the file now reports `error`, runs nothing and
  counts as one failure; the rest of the run proceeds. The same applies to a
  named file that is not a request at all.

- **An empty `requests` list means nothing, not everything.** Omitting
  `requests` — at the run level or on a group — still runs the whole collection,
  which is how one collection runs under two identities. Supplying `requests:
  []` now runs no requests and warns, where before it ran the entire collection.
  A caller that filters a selection down to nothing was getting the widest
  possible run at the moment it asked for the narrowest.

- **Results are group-shaped: there is no top-level `results` array.** Each entry
  of `groups[]` carries its own `summary`, `results`, `capturedVariableNames`,
  `capturedVariables` and `warnings`; the top-level `summary` covers the run.
  This holds in the no-groups case too, where the run is one group — so a caller
  reading `result.results` reads `undefined`, and must read `result.groups[0]
  .results`. A group that crashed outright reports `error` and counts as one
  failure in the run summary, because a group that ran no requests contributes
  nothing to the per-request tally and would otherwise leave the run reading
  green.

- **`seq` no longer constrains execution.** It is the default ordering and the
  reporting order only. Two requests in one parallel group genuinely run at the
  same time whatever their `seq` says, and may contend on the store they share.

- **Silent behaviour change, worth reading twice.** A caller passing
  `parallel: true` today gets folder isolation: `bru.setVar` in one folder is
  invisible to another. After upgrading, `parallel: true` with no `groups` runs
  the whole selection as **one** group with **one** store and **one** cookie jar,
  so those requests now share state. Nothing errors and nothing warns — the run
  simply means something different. To keep the old isolation, name the folders
  as separate groups. This is the one change here that a passing test suite will
  not catch for you.

- **Node 22 or newer is required** (`engines.node` moved from `>=18.0.0` to
  `>=22.0.0`). Node 20 reached end of life in April 2026 and CI already tests
  only 22.x and 24.x, so the floor now says what was already true.

### Added

- **`create_request` and `modify_request` can author `assert`, `vars` and path
  parameters.** These three features were already applied at run time but had no
  field on any tool, so the execution engine was unreachable from the MCP surface:
  an agent could not write an assertion at all, and a `:id` segment had no way to
  get a value. This is the mirror of the *parsed, persisted, never applied* class
  the previous releases closed — same broken data path, opposite end.

  - `assert` — a list of `{ name, value, disabled? }`, where `name` is the
    left-hand expression and `value` is an operator plus operand (`eq 200`,
    `between 200, 299`, `isNumber`). Evaluated after the post-response script, so
    unlike a bare `expect()` in a script it needs no `test()` wrapper to report.
  - `vars` — `{ preRequest?, postResponse? }`. The halves stay asymmetric,
    matching Bruno: pre-request values are raw text folded into interpolation
    before the request is built, post-response values are JS expressions
    evaluated against the response.
  - `pathParams` — a record mirroring `query`, written as `params:path`. The two
    are replaced independently, so setting one never discards the other.

  Both formats are covered, and the switched-off flag keeps its per-format
  spelling on disk (`.bru` `enabled`, `.yml` `disabled`) while the tool surface
  exposes only `disabled`, absent meaning active.

### Removed

- **BREAKING:** `BruGenerator`, `generateBruFile`, and `createBasicBruFile` are
  no longer exported. They lived in `src/bruno/generator.ts`, re-exported from
  the package root via `export * from './bruno/generator.js'`, and were removed
  along with that module.

  The module was unreachable from every code path in the package: nothing inside
  the MCP server called it, and it measured 0% coverage once the coverage
  configuration was fixed to see files that no test imports. `.bru` generation
  in the server itself goes through `bru-parser.ts`, which is unaffected.

  These exports were removed *during* the `1.2.3` line rather than at a major
  boundary, so a consumer importing any of them breaks on upgrade with no
  warning. There is no drop-in replacement; the module had no callers to
  migrate. If you depended on it, pin `1.2.3` and open an issue describing the
  use case.

- **BREAKING:** the `BruQuery` type and the `BruFile.query` field are gone.
  Nothing read them: the `.bru` parser never populated the field and the `.bru`
  writer never serialized it, so the only code that assigned it was silently
  discarding data (see *Fixed*). Query parameters live on `BruFile.params` as
  `BruParam` entries, which round-trip and are applied.

### Fixed

- **`form-urlencoded` bodies survive both writing and rewriting.** Bruno spells
  this type two ways on purpose: the BLOCK is kebab-case
  (`body:form-urlencoded {`) while the MODE in the method block is camelCase
  (`body: formUrlEncoded`). The generator already restored that camelCase for
  multipart and simply never did it here, and the authoring path never built the
  entries at all.

  - **Rewriting an existing request downgraded the mode to `form-urlencoded`,**
    which Bruno does not recognise. The block survived, so the file still looked
    correct while the body stopped being sent. Any `modify_request` on a
    form-urlencoded request did this to it.
  - **`create_request` dropped the body entirely.** Upstream reads
    `body.formUrlEncoded` as an array of `{name, value, enabled}`; the builder
    handed it the raw `content` string, so no block was written and the request
    went out as an empty POST. Both shapes are now accepted — explicit entries via
    `formData`, or an encoded string via `content`, parsed with `URLSearchParams`
    so percent-escapes and `+` resolve as they would on the wire.

  A round-trip fixture had the kebab spelling too, which is why the existing
  completeness guard could not see either defect: it described this server's own
  output rather than a file Bruno would write. Corrected, with the multipart
  entry alongside it left as the reference — those two are the only body types
  whose mode differs from their block name.

- **The `.bru` files this server writes are now files Bruno can read.** Four
  defects, all of them invisible to a parse-then-compare test because our own
  parser is tolerant of our own malformed output. Each was found by reading the
  bytes on disk and checking them against upstream's source.

  - **`seq: undefined` was written into `meta`** whenever no sequence was given —
    the common case. The guard was there (`seq: ... : undefined`) but upstream's
    serializer walks the KEYS of `meta` and writes `${key}: ${value}` for each,
    so a key holding `undefined` becomes that literal text. Worse, the truthy
    string then suppressed Bruno's own `if (!meta.seq) meta.seq = 1` default. The
    key is now omitted, and an absent seq reads back as `1` the way Bruno intends.
  - **The method block said `auth: api-key`.** Bruno's token is `apikey`, matching
    its `auth:apikey` block, so the block we correctly emitted was ignored and no
    auth was applied. `api-key` remains the name on the tool surface, which is
    only ours.
  - **`placement` was never written.** We stored `in`, which upstream's serializer
    does not read, so the field came out empty. It is now written with Bruno's
    vocabulary (`header` / `queryparams`). The old `in` spelling is still accepted
    as tool input and translated.
  - **`placement` was never read**, and a request authored in Bruno reached the
    executor as mode `apikey`, missed the `api-key`-only branch, and **lost its
    key and value entirely** — the request went out with no credential while
    warning "api-key auth has no key name" about a file that plainly had one.

  Note there is no file-side back-compat to preserve for `in`: upstream's parser
  keeps a block's known keys and discards the rest, so that field never survived
  a read even for us. Files written with it were already resolving as `header`.

- **`assert` blocks are now evaluated.** They were parsed by both formats and
  written back faithfully, and never checked. A run reported **zero assertions and
  looked green** while every declared check was ignored — the worst shape a test
  failure can take, because nothing signals that nothing was verified. The
  sandbox's own warning text already described the symptom.

  Each assertion is evaluated in the same isolated context as the post-response
  script, where `res` and `bru` already exist, and reports one result of its own.
  Semantics follow Bruno's assertion runtime rather than a fresh interpretation of
  what the fields ought to mean:

  - The `value` field parses as `<operator> <operand>` across 28 operators, 12 of
    them unary. An unrecognised first token means the operator is `eq` and the
    whole string is the operand, which is what makes a bare `200` work.
  - `isTruthy` and `isFalsy` compare strictly against `true` and `false`. The
    names suggest truthiness; upstream does not implement it that way, and matching
    upstream matters more than matching the name.
  - `isJson` asks whether the value already **is** an object or array. A JSON
    *string* is deliberately not json.
  - The operand is coerced before comparison: `true`/`false`/`null`/`undefined`
    become those values, a quoted operand becomes its raw inner text, a numeric
    operand becomes a number — except past `Number.MAX_SAFE_INTEGER`, where the
    string is kept because the number would be altered — and anything else stays
    the text it already is, so a bare word is a string rather than an error.
    Upstream reaches that last case by evaluating the operand as a template
    literal; the sandbox has code generation disabled, so it returns the text
    directly instead. The two agree for every operand without a `${...}`
    placeholder.
  - `empty` throws for a value with no notion of emptiness (`null`, `undefined`, a
    number, a boolean) rather than answering "not empty", because the throw is
    what makes `isNotEmpty` fail on a missing field instead of passing.
  - `between` splits its bounds on commas only. `between [200, 299]` is a failure,
    not a range: upstream strips brackets for `in`/`notIn` alone, so the bounds
    arrive as `[200` and `299]` and fail there too. Extra bounds are ignored
    rather than rejected, because upstream takes the first two and drops the rest.
  - A `{{var}}` operand is resolved against the same merged variable map the URL
    is built from, so `eq {{expectedStatus}}` compares against the value. The
    operand alone is interpolated, and only after the operator has been parsed
    off: resolving the whole `value` first would let a variable's own text be read
    as the operator, so a bare `{{v}}` holding `eq 200` stays an equality check
    against the *string* `eq 200`, as upstream has it. An unresolved placeholder
    is left as written, which is what makes a missing variable visible.

  The post-response script runs **before** the assertions, as in Bruno, so an
  assertion can observe a variable the script set. The script gets its own error
  boundary, so a script that does not even parse no longer discards every declared
  assertion — upstream records a script-error entry and runs the assertions too.

  One consequence worth stating for anyone auditing an untrusted collection: a
  request with an `assert` block and no `script:` block now executes JS from the
  file where before it executed none. The trust boundary is unchanged — an
  assertion's left-hand side is arbitrary JS at exactly the post-response script's
  privilege — but "no `script:` blocks, so nothing runs" is no longer true.

  Three hardening fixes came out of reviewing that surface:

  - A left-hand side is compiled on its own before it is spliced, so it must
    genuinely be one expression. The wrapper's parentheses were never a boundary:
    an expression ending in `);` closed the call, and a trailing comment or a
    rebalancing function expression absorbed the tail. This also fixes a plain
    authoring case that used to fail — `res.status // why`.
  - `__results` is serialised to JSON inside the sandbox and parsed outside, like
    the variable store already was. It is a writable global, so sandboxed code
    could leave getters on it that then ran on the host stack after the vm call
    returned, with the timeout no longer applying.
  - A timeout is corroborated against the clock rather than recognised from its
    message text, which a collection can reproduce. Trusting the text let one
    assertion discard every result already recorded and everything still to run.

  Assertions the author switched off are neither evaluated nor reported. The two
  formats spell that flag with opposite polarity (`enabled` vs `disabled`), and
  here the cost of getting it wrong is higher than for parameters: it would run
  precisely the checks that were turned off and report their failures as the
  request's.

  A malformed assertion fails only itself. Each one is evaluated independently, so
  a bad expression cannot abort the remaining assertions or the post-response
  script.

  Most importantly, the sandbox is now invoked when a request declares assertions
  **but has no post-response script**. It was previously entered only when a script
  existed, so that case could not have worked however correct the evaluation was.

- The sandbox's `expect()` now supports the matchers ordinary chai usage expects:
  numeric comparisons under every common spelling (`above`/`gt`/`greaterThan` and
  the other three), `oneOf`, `match`, `startWith`, `endWith`, `within`, `json`, and
  the negations of each. Previously a post-response script written with
  `expect(x).to.match(/re/)` or `.to.be.within(1, 5)` failed as an unsupported
  matcher, even though the assertion was perfectly ordinary.

  Two details are deliberate. A comparison against a non-number throws rather than
  answering false, because JavaScript answers false for every ordering against a
  non-number and under negation that would read as a pass. And `match` uses
  `String.search` rather than `RegExp.test`, since a caller-supplied `/re/g`
  carries `lastIndex` between calls and the same assertion would otherwise pass and
  then fail.

  The guard that throws on an unrecognised matcher is unchanged: it is what keeps a
  typo from becoming a silent pass.

- `settings.encodeUrl` is now honoured, and URL encoding matches Bruno.

  The setting was parsed and preserved by both formats and read by nothing, while
  parameter values were percent-encoded unconditionally. Both halves of that were
  wrong, and the second is the one that mattered: this server was sending
  different bytes than Bruno for the same collection. A collection runner that
  quietly rewrites the request misreports what the collection does, and anyone
  debugging against the Bruno UI is chasing a difference introduced here.

  The transform is now a deliberate port of Bruno's, applied where Bruno applies
  it — over the whole finished URL, after interpolation, after path parameters,
  and after a pre-request script has had its chance to rewrite the URL:

  - Scheme and authority are preserved verbatim, including userinfo, port and
    bracketed IPv6 literals. A scheme is prepended first when absent, or the colon
    in a `host:port` authority would be encoded as path data.
  - Path segments encode idempotently (decode, then re-encode), so an
    already-encoded path is not encoded twice.
  - The query side is content blind and **intentionally double-encodes**:
    `?q=%20` becomes `?q=%2520`. That is upstream's documented contract — it lets
    a pre-encoded redirect URL survive a server-side decode pass.
  - `#` is data, not a fragment delimiter, and becomes `%23`. To send a literal
    fragment, turn the setting off, which preserves the URL byte for byte.
  - A parameter with no name is dropped; `?flag` stays valueless and distinct
    from `?flag=`.

  The default is two-valued, which is easy to get wrong in either direction: with
  **no** `settings` block the URL is sent **raw**, but a `settings` block that
  does not mention `encodeUrl` defaults it to **on**. Bruno writes
  `encodeUrl: true` explicitly when it saves a request, so anything its UI has
  touched arrives with the flag set.

  Consequently, parameter values are no longer percent-encoded on their own.
  **A value containing `&`, `=`, `?` or `/` changes the structure of the request,
  not just its content** — `q={{v}}` with `v` set to `a&b=c` sends two query
  parameters. This is upstream behaviour rather than a new weakness: Bruno splits
  query pairs on the raw string too, so its transform normalizes and does not
  sanitize. What is guaranteed is narrower and now tested: substitution only ever
  happens after the authority, so **no parameter value can change the target
  host**, and the SSRF check still runs on the final URL. A URL containing a
  newline is encoded (`%0A`) rather than passed through.

- Path parameters now also substitute inside OData-style segments —
  `/Customers(:id)`, `/Orders(Key1=:a,Key2=:b)`. Bruno recognises these in
  addition to a whole `:segment`, and only the latter was handled. A `:name`
  appearing in a query value is correctly left alone: upstream substitutes into
  the path and reattaches the raw query string.

- Query parameters given to `create_request` and `modify_request` are now written
  to the file. Three separate holes, all silent:

  - `create_request` on a **`.bru`** collection stored the pairs on a `BruFile.query`
    field that the `.bru` writer never serialized. The request landed on disk with
    no parameters at all — the caller got `success: true` and a file missing the
    data it had just supplied. The `.yml` path wrote them correctly, so the same
    call lost data in one format and not the other.
  - `modify_request` ignored its `query` input in **both** formats. It is part of
    the advertised tool schema, it was threaded all the way to the update
    function, and that function never read it. The call reported success and
    changed nothing.

  Query parameters replace the previous ones, the way `headers` already do. Path
  parameters are preserved across such an edit: the `query` input never names
  one, so discarding them would be collateral damage from an unrelated change.

  This was the writing half of the defect fixed above. Applying parameters at
  send time only helps a file that declares them, and for `.bru` collections
  created through the MCP tools, none did.

- Per-request `settings` authored in a `.bru` file now take effect. The executor
  reads the timeout, redirect policy, TLS options and proxy off the request's
  settings, and the `.bru`-to-executor translation did not forward them — so a
  `.bru` request's `settings { timeout: … }` was parsed, written back faithfully,
  and then ignored, leaving every such request on the 30s default. The `.yml`
  path honoured the same field, so the two formats disagreed.

- Query and path parameters are now actually sent. They were declared in both
  request formats, populated by both parsers and written back faithfully by both
  generators — and **nothing ever applied them to the outgoing request**. A
  `params:query` entry never reached the query string, and a `params:path` entry
  left `:id` in the URL verbatim.

  This was reachable end to end through the MCP surface: `create_request` stores
  its `query` input, the file on disk looks correct, a round-trip preserves it,
  and `run_collection` sent the request without it.

  Parameters are applied before the URL is validated, so the URL that is checked
  is the one that is sent. Values are substituted raw and encoding is left to
  `settings.encodeUrl` (see above), matching Bruno. A `:name` with no matching
  parameter is deliberately left standing: wrong but visible, rather than quietly
  pointing elsewhere.

  Note for the `.bru` path: the two formats spell the switched-off flag with
  opposite polarity (`enabled` vs `disabled`), so forwarding without inverting
  would have sent exactly the parameters the author turned off.

- **`.include`/`.contain` subset-checks an object**, as chai does, instead of
  refusing any target that is not an array or string. Verified against chai
  directly rather than inferred. Unreachable from the declared `contains`
  operator — its operand is always a coerced primitive, which chai rejects for an
  object target, so an object left-hand side still fails there exactly as it does
  upstream — but a hand-written script reaches it.
- **`length 0` no longer fails on an empty string.** The length was read behind a
  truthiness test, and `""` is falsy while still having a length.
- **`to.not.have.<unknown>` fails loudly.** It was the one chain object left
  unguarded, so an unknown matcher after it read `undefined` and reported a pass.
  No declared operator reaches it; a script can.
- **A zero-argument matcher that is a method rather than a getter now throws.**
  That is the one seam the unknown-matcher guard cannot cover: the property
  exists, so reading it asserts nothing and would report a pass. No operator hits
  it today; this keeps that true for the next one added.

- **`vars:pre-request` and `vars:post-response` are now applied.** The last member
  of the same class: both parsers read them, both generators wrote them back, and
  nothing at execution time ever looked at them. `bruFileToYamlRequest` dropped
  them too, so the `.bru` side would have stayed inert even after the executor
  learned to apply them — both ends needed fixing.

  The two halves are asymmetric, and matching that matters more than making them
  consistent:

  - `vars:pre-request` values are **raw text**, not expressions. They join the
    interpolation map between the environment and the runtime store — upstream's
    precedence is collection < env < folder < **request** < oauth2 < runtime <
    `process.env` — so a request var overrides the environment and anything
    `bru.setVar` wrote still overrides it. Each value is itself substituted
    against the variables established so far, in declaration order, so
    `{{version}}/widgets` resolves if `version` was declared earlier.
  - `vars:post-response` values **are** JS expressions, evaluated against the
    response and stored with `bru.setVar`. They run before the post-response
    script and before the declared assertions, which is upstream's order and is
    what lets both read them. A var whose expression throws is reported as a
    warning rather than a test result — its outcome is a variable, not a check,
    and inventing a failing assertion for it would inflate the reported count.

  Third occurrence of the opposite-polarity trap: `.bru` carries `enabled`,
  `.yml` carries `disabled`. Getting it wrong here is quieter than for an
  assertion — a wrongly applied variable leaves no trace in the report at all.

### Known gaps

Nothing in the request schema is parsed, persisted and round-tripped without being
applied any more — `vars:pre-request` / `vars:post-response` were the last of that
class and are now applied (see above).

One limitation of declared assertions specifically, recorded rather than left to
be discovered:

- **A bare variable name as the left-hand side is a `ReferenceError`, not
  `undefined`.** Bruno spreads env/collection/runtime variables into the
  expression scope, so `someVar: isUndefined` passes there; here it fails. Only
  the `{{var}}` form and `bru.getVar("name")` resolve. Seeding arbitrary variable
  names as context globals would risk shadowing `res`, `bru` and `expect`, so the
  fix belongs in a per-expression scope rather than the shared context.

(The second limitation recorded here — that no tool could author an `assert`
block — is fixed above.)

Auth is not in this category — unapplied types warn explicitly, and
`auth: inherit` reports that collection-level inheritance is unsupported.
`bearer`, `basic` and `api-key` are implemented (`api-key` accepts Bruno's own
one-word `apikey` spelling and honours both header and query placement); only
`oauth2` and `digest` are declared without an implementation, and both warn.

- JSON, XML and SPARQL request bodies are no longer sent labelled as plain text.
  A `Content-Type` is now derived from the body type: `application/json`,
  `application/xml`, `application/sparql-query`.

  The Fetch standard labels *any* string body `text/plain;charset=UTF-8`, and
  nothing set a `Content-Type`, so a JSON payload went out announced as plain
  text. That is worse than sending no type at all — a server handed an explicit
  but wrong type has no reason to sniff the content, so `express.json()` leaves
  `req.body` empty and Spring answers 415. Bruno derives the header at send
  time, so collections authored in the Bruno GUI carry no explicit
  `Content-Type` of their own and were affected by default.

  A `Content-Type` set by the collection always wins, matched case-insensitively
  (RFC 9110 §5.1). `text` bodies are deliberately left to the Fetch default,
  which is already the correct type and additionally declares the charset.

- `form-urlencoded` and `graphql` request bodies authored in a `.bru` file are no
  longer silently dropped. Running such a request sent it with **no body at
  all** — no error and no warning, just whatever the server made of an empty
  payload. Only the textual body types (`json`, `text`, `xml`, `sparql`) and
  `multipart-form` survived the translation into the executor's shape.

  The cause was a type that misdescribed its own data. Bruno spells the body type
  in camelCase inside the `http` block (`body: formUrlEncoded`) while naming the
  body block in kebab-case (`body:form-urlencoded {`). Only `multipartForm` was
  normalized, so `body.type` also carried raw values like `formUrlEncoded` —
  values the declared `BodyType` union does not contain. Because the field
  claimed to be a `BodyType`, nothing flagged the mismatch, and the translation
  only ever looked for a string body or a multipart array. Both of these bodies
  are parsed into their own fields, matched neither, and fell through.

  The camelCase spellings are now normalized at the parse boundary so the
  declared type is true, and `sparql` — a real Bruno body type that was also
  flowing through unlisted — has been added to the union.

  A `Content-Type` is now derived from the body type for these two bodies
  (`application/x-www-form-urlencoded` and `application/json`), since neither is
  usable without one. A `Content-Type` set explicitly by the collection is never
  overwritten.

  Form pairs and the GraphQL envelope are built *after* variable substitution.
  The reverse order is a correctness trap: a `{{var}}` whose value contains `&`
  or `=` would splice extra fields into an encoded form body, and one containing
  `"` would break a stringified JSON envelope.

  `body:file` remains unsent: `@usebruno/lang` 0.36.0 has no such block, so one
  parses as ordinary name/value pairs and the file path is never populated.

- Duplicate request headers are no longer silently dropped. A collection that
  authored the same header name more than once — two `Accept` values, two
  `Cookie` pairs, an `X-Forwarded-For` chain — sent only the last value. Both
  the `.bru` translation and the outgoing-request path collapsed repeats.

  Values are now combined the way the transport does: with `, ` in general
  (RFC 9110 §5.3) and `; ` for `Cookie` (RFC 6265 §5.4). Header names are
  matched case-insensitively while the first occurrence's casing is preserved
  on the wire. Headers explicitly disabled in the collection are still not sent.

### Added

- A warning when a request repeats a header that HTTP defines as single-valued
  (`Content-Type`, `Authorization`, `Host`, and similar).

  Combining is only semantics-preserving for fields defined as a comma-separated
  list; RFC 9110 §5.2 does not permit a sender to repeat a singleton field at
  all, and joining two `Content-Type` values with a comma yields a value the
  origin will usually reject. `fetch` cannot emit two field lines for one header
  name, so the combine stands — the warning exists so that an authoring mistake
  is reported rather than silently turned into an invalid request.

  The warning names the header and never its value. `Cookie` is excluded: it is
  legitimately repeated and is already joined correctly.

## [1.2.3]

Released before this changelog was introduced. See the git history for
per-commit detail.
