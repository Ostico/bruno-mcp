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

- Duplicate request headers are no longer silently dropped. A collection that
  authored the same header name more than once — two `Accept` values, two
  `Cookie` pairs, an `X-Forwarded-For` chain — sent only the last value. Both
  the `.bru` translation and the outgoing-request path collapsed repeats.

  Values are now combined the way the transport does: with `, ` in general
  (RFC 9110 §5.3) and `; ` for `Cookie` (RFC 6265 §5.4). Header names are
  matched case-insensitively while the first occurrence's casing is preserved
  on the wire. Headers explicitly disabled in the collection are still not sent.

## [1.2.3]

Released before this changelog was introduced. See the git history for
per-commit detail.
