# bruno-mcp defect register

**Status:** living document. The single list of known **open** defects.
**Last verified:** 2026-08-04, against `main@5c69c4e` (v2.0.0). Line numbers were read there — **re-verify
before acting**, files move.

Everything filed here between 2026-07-29 and 2026-08-02 — six High, eleven Medium, twenty Low — is now closed.
The closed entries carried a great deal of investigation detail; that text lives in git history (`git log -p --
docs/bruno-mcp-defect-report.md`; the last full version is at `main@903533d`) rather than in this file, so the
register stays a queue instead of an archive.

It supersedes `adversarial-review-2026-07-29.md` and the field-audit report it was merged from; both are in git
history. `blind-discoverability-test.md` is methodology, not findings.

---

## Open

Nothing. The queue is empty as of 2026-08-04; M9, the last entry, closed with the decision recorded below.

---

## Closed since the last revision, for orientation

**M9 (second half)** — a created request carries no `settings`, so it silently follows redirects. This one was
a product decision, not a coding task, and the decision taken on 2026-08-04 was: **behave exactly as Bruno
behaves, per dialect.** The two dialects are not made to agree with each other, because upstream's own writers
do not agree — each is mirrored on its own terms.

- `.yml` writes the block unconditionally and fully resolved (`encodeUrl`, `timeout`, `followRedirects`,
  `maxRedirects`), because `bruno-filestore`'s `stringifyHttpRequest.ts` does — so a request created here is
  byte-comparable to one the app created, and the defaults are visible in the file rather than implied.
- `.bru` writes the block only when the model carries one, because `jsonToBru.js` is a passthrough — 248 of the
  275 `.bru` files in upstream's own test collection carry no settings block at all.
- The runtime default moved from 10 hops to Bruno's 5, with a negative value replaced by 5, matching
  `bruno-cli/src/runner/run-single-request.js`. Upstream's third rule — zero the cap when redirects are not
  followed — was already expressed by the `followRedirects &&` guard on the follow loop.

This does not undo the incident that opened the entry: a reset flow lost its `Set-Cookie` because the 302 was
followed, and Bruno follows it too. What is different now is that the default is authorable (PR #100), visible
in the `.yml` file, and capped where Bruno caps it. Choosing not to follow is the caller's call to make per
request, not a default this server invents. Interacted with L15, which was withdrawn — authoring `settings` no
longer turns URL encoding on.

The entries below stayed marked unfinished after the work that finished them, which made the queue read longer
than it was:


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
- **L17** — comments in a JSON body or in graphql variables were sent verbatim, so a body Bruno's editor
  permits reached the wire with the annotations in it and the server rejected a collection that runs clean
  under `bru run`. Both payloads upstream decomments are stripped now (`prepare-request.js:369` and `:447`),
  at the same point in the sequence: before variable substitution, so a variable value containing `//` keeps
  it. The graphql half also gained upstream's named failure — `Failed to parse GraphQL variables`
  (`run-single-request.js:362-367`) — replacing a raw-string fallback a test had pinned as deliberate; that
  pin was only safe to remove once comments came out first, or a commented-but-valid block sent today would
  have started failing. The dependency question this entry was open on was settled in favour of
  `jsonc-parser`: MIT, no dependencies of its own, and no JavaScript parser, where upstream's `decomment`
  reaches the same answer through `esprima`. Beyond parity, an unparseable JSON body is now named in a
  warning instead of being diagnosed from a bare 400 — suppressed when a variable did not resolve, since that
  already has a warning and is invalid JSON by definition.

  Not to be confused with upstream's `escapeJSONStrings`, which is not a gap here. It escapes only the output
  of mock data functions (`{{$randomFullName}}`), not ordinary variable values — `prepareMockObj` in
  `bruno-common/src/interpolate/index.ts:48-62` passes plain values through untouched. We have no mock
  functions, so a variable value holding a quote corrupts a JSON body upstream exactly as it does here.

- **Graphql envelope bytes** — found while reading `prepare-request.js` for L17, never reported. Upstream
  builds the envelope as `{ query: get(request,'body.graphql.query'), variables: decomment(get(request,
  'body.graphql.variables') || '{}') }` (`prepare-request.js:443-447`). Two differences, both fixed. `variables`
  is always on the wire there, because the `||` substitutes `{}` for anything falsy — we omitted the key, and
  an authored-but-empty block was reported as unparseable rather than sent as `{}`. And a `.bru` file declaring
  `body: graphql` with no `body:graphql` block sends `{"variables":{}}` with `application/json`, because
  `bruno-cli/src/utils/bru.js:121-122` takes the mode off the http block whatever the content blocks hold; we
  read the type only when a content block existed, so that request went out with no body and no content type,
  and a rewrite dropped the `body:` line from the http block as well. The `.yml` dialect never reaches that
  case — its reader flattens an absent query to `''` first (`parseGraphQLRequest.ts:33`), so a `.yml` graphql
  request always carries a `query` key. That asymmetry is Bruno's, and is now reproduced rather than smoothed
  over.

The 2.0.0 release (PR #121) closed the execution-model findings — M2, M10, L13, L14 — and the review of that
work closed six more found in the implementation itself. See CHANGELOG.md.
