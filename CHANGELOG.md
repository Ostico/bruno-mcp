# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> **The next published release must be `2.0.0`.** The public API lost three
> exports after `1.2.3` (see *Removed* below). That is a breaking change under
> semver, so it cannot ship as a patch or minor no matter how small the diff
> that follows it.

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

### Known gaps

One feature is still parsed, persisted and round-tripped without being applied at
execution time. It is not newly broken; it is recorded here so it is not mistaken
for working:

- **`vars:pre-request` and `vars:post-response` are never applied.**

Two limitations of declared assertions specifically, both recorded rather than
left to be discovered:

- **A bare variable name as the left-hand side is a `ReferenceError`, not
  `undefined`.** Bruno spreads env/collection/runtime variables into the
  expression scope, so `someVar: isUndefined` passes there; here it fails. Only
  the `{{var}}` form and `bru.getVar("name")` resolve. Seeding arbitrary variable
  names as context globals would risk shadowing `res`, `bru` and `expect`, so the
  fix belongs in a per-expression scope rather than the shared context.
- **No tool can author an `assert` block.** `create_request` and `modify_request`
  expose no `assert` field, so evaluation reaches only collections written by
  hand or by Bruno itself. An agent building a collection through this server
  still has to use `test()` blocks in a post-response script.

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
