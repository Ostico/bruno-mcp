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

### Fixed

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
