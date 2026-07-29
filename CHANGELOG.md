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

These features are still parsed, persisted and round-tripped without being
applied at execution time. None is newly broken; they are recorded here so they
are not mistaken for working:

- **`assert` blocks are never evaluated**, in either format. A run reports zero
  assertions rather than checking the ones the collection declares.
- **`vars:pre-request` and `vars:post-response` are never applied.**

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
