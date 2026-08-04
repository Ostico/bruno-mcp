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

### L16 — `.bru` `tags` cannot survive a rewrite

Upstream's reader and writer disagree on the shape. `meta { tags: smoke }` is read by `bruToJsonV2` as the
**string** `'smoke'` and written back by `jsonToBruV2` as a **list**, which iterates whatever it is handed — so
a string comes back one character per line:

```
tags: [
    s
    m
    o
    k
    e
]
```

Verified against the installed `@usebruno/lang` with both a single tag and with `tags: smoke, fast`. A
genuinely unknown key (`reviewedBy: qa`) round-trips verbatim, which isolates this to `tags` rather than to
unknown keys in general.

**Not our defect, and currently contained.** It bites only because M7 started carrying unmodelled `meta` keys,
so `tags` is excluded from the `.bru` carry list on purpose, with a test pinning the exclusion and the reason.
Before M7 the server dropped `tags` silently; carrying it would have replaced a silent drop with a corrupted
file, which is worse. `.yml` is unaffected — that document is serialized whole.

The real fix is to model `tags` on both sides: parse the comma-separated string into a list, write a list
back. That also removes the exclusion. Small, but it is a model change needing its own round-trip fixtures,
and `.yml` needs the same field for parity. Worth reporting upstream.

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

The 2.0.0 release (PR #121) closed the execution-model findings — M2, M10, L13, L14 — and the review of that
work closed six more found in the implementation itself. See CHANGELOG.md.
