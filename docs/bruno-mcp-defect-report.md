# bruno-mcp defect register

**Status:** living document. The single list of known **open** defects.
**Last verified:** 2026-08-03, against `main@903533d` (v2.0.0). Line numbers were read there — **re-verify
before acting**, files move.

Everything filed here between 2026-07-29 and 2026-08-02 — six High, eleven Medium, twenty Low — is closed
except the two below. The closed entries carried a great deal of investigation detail; that text lives in git
history (`git log -p -- docs/bruno-mcp-defect-report.md`; the last full version is at `main@903533d`) rather
than in this file, so the register stays a queue instead of an archive.

It supersedes `adversarial-review-2026-07-29.md` and the field-audit report it was merged from; both are in git
history. `blind-discoverability-test.md` is methodology, not findings.

---

## Open

### L17 — comments in a JSON body or in graphql variables are sent verbatim. CONFIRMED. *(Filed 2026-08-04)*

Upstream strips comments from two payloads before sending them, with `decomment`:

- `prepare-request.js:369` — the whole JSON body, wrapped in a try/catch that falls back to the raw text.
- `prepare-request.js:447` — the graphql `variables` block, before it is parsed.

Nothing in `src/` does. A JSON body written as `{ "a": 1 // note` + newline + `}` reaches the wire with the
comment still in it and the server rejects it, where the same collection under `bru run` succeeds. Bruno's
editor permits those comments, so this is a body a caller can arrive with rather than one they have to
construct.

The graphql half has a second effect. Upstream decomments `variables` and then *throws*
`Failed to parse GraphQL variables` when the result does not parse (`run-single-request.js:362-367`); we send
the unparsed text as a string instead, which a test currently pins as deliberate. Both halves have to move
together: adding the named failure without decommenting first would start failing a commented-but-valid
variables block that is sent today.

**Open on one question, which is a maintainer call rather than a coding one.** Exact parity means the
`decomment` package, which pulls `esprima` — two runtime dependencies added to a tree that currently has six,
for a function only ever called on JSON. The alternative is a small string-aware scanner of our own, which
needs no dependency and is testable against the cases that matter (`//` inside a string value, a `http://`
URL), but is a reimplementation rather than the same code upstream runs.

Not to be confused with what upstream's `escapeJSONStrings` does. That option escapes only the output of mock
data functions (`{{$randomFullName}}`), not ordinary variable values — `prepareMockObj` in
`bruno-common/src/interpolate/index.ts:48-62` passes plain values through untouched. We have no mock functions,
so there is no escaping gap: a variable value holding a quote corrupts a JSON body upstream exactly as it does
here.

---

### M9 (second half) — a created request carries no `settings`, so it silently follows redirects

**A product decision, not a coding task.** The first half shipped in PR #100: `settings` is accepted on
`create_request` and `modify_request` and written in both dialects, merged per field.

What remains: a request created through this server writes no `settings` block at all, and absent settings
means follow — `followRedirects = yaml.settings?.followRedirects !== false` (`request-executor.ts:700`). That
default is what the original report cost. A reset flow whose session cookie rode on a 302 lost the
`Set-Cookie` when the redirect was followed, and the next call returned 500. It presented as the endpoint
issuing no session at all.

The decision: should a created request carry Bruno's defaults **explicitly**? Emitting them is not obviously
right — Bruno omits the block too, and writing it changes what a round-trip produces for every request this
server creates. But silently inheriting `followRedirects: true` is what caused the incident.

Severity M rather than L, because a wrong default that cannot be seen from inside a run produces a wrong
result the agent cannot diagnose. There is now a workaround the reporter did not have: set `settings` at
create time.

Interacts with L15, which was withdrawn — authoring `settings` no longer turns URL encoding on.

---

## Closed since the last revision, for orientation

Two entries stayed marked unfinished after the work that finished them, which made the queue read longer than
it was:

- **M3** — collection- and folder-level settings ignored. Root files are read now, and the leftover (root
  scripts declared but not run) closed with L12. The phrase "not applied to requests yet" survives only in a
  `script-merge.ts` comment describing the old behaviour.
- **M6** — `get_collection_stats` withholds every environment value. Resolved by M5: `read_environment`
  returns values, and stats deliberately lists names only. That split is documented in the README.
- **L9** — a graphql body with no query. The premise held: an empty or absent query reached the wire as
  `{"query":""}` by four routes, including a `{{placeholder}}` resolving to nothing. Split by layer, because
  the two ends have opposite obligations. The run path warns and still sends: upstream reads
  `body.graphql.query` with no check, so refusing would make a collection behave differently here than under
  `bru run`, and the server's rejection is the honest answer — it just does not say which request was
  incomplete, which the warning now does. The author path refuses: writing a request that cannot run and
  reporting success is the shape a caller cannot diagnose, and no parity argument covers it because Bruno's
  own GUI cannot produce it.

- **L16** — `tags` could not survive a rewrite. Modelled now in both formats as what upstream says it is: a
  list of strings or absent, normalized with `Array.isArray(tags) ? tags : []` exactly as
  `bruno-cli/src/utils/bru.js:80` and `bruno-filestore`'s `parseApp.ts:22` do, written only when non-empty.
  Three separate losses: `.bru` dropped every list because the key was excluded to avoid `jsonToBruV2` spelling
  a string one character per line, `.yml` carried it only as an opaque `info.extra` entry, and the
  `.bru`-to-`.yml` conversion had no field to put it in. The single-line `tags: smoke` is still dropped, now on
  purpose — upstream's runner reads any non-list as no tags, so promoting it would change which requests a
  `--tags` run selects. That also corrects what this entry used to propose: splitting on commas would have
  invented a format appearing nowhere upstream. `read_request` reports tags; authoring them is not part of it.

The 2.0.0 release (PR #121) closed the execution-model findings — M2, M10, L13, L14 — and the review of that
work closed six more found in the implementation itself. See CHANGELOG.md.
