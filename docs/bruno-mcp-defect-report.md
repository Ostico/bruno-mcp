# bruno-mcp defect register

**Status:** living document. This is the single list of known open defects.
**Pinned at:** `main@4df3f16`. Every line number below was read at that commit — **re-verify before acting**, files move.
**Last verified:** 2026-07-30.

**Supersedes and replaces** `adversarial-review-2026-07-29.md` (findings pinned at `main@75b28ad`, most since
fixed) and the standalone field-audit defect report it was merged from. Both files were removed once their
open findings, their corrections and their reusable lessons had been folded in here; the review remains in git
history if the full original text is ever wanted. `blind-discoverability-test.md` is methodology, not findings, and is
unaffected.

## Provenance

Two independent sources, merged and de-duplicated:

- **Field audit** — building a real authentication suite against a live application through the MCP surface.
  Items were reproduced against a running server or traced through source to the `fetch()` call. This source
  found the highest-severity items, because it exercised the tool the way a user does.
- **Adversarial code review** — five parallel read-only reviewers over all of `src/` at `main@75b28ad`,
  one lens each (TOCTOU, security, parse fidelity, DRY/KISS, execution semantics). ~56 candidates, ~25
  re-verified by hand.

Where the two disagreed, the disagreement is recorded rather than silently resolved. Two of the field audit's
claims needed correcting against current code; see the notes under H3 and L3.

## Legend

- **CONFIRMED** — reproduced, or traced through source at the pinned commit.
- **SUSPECTED** — read but not exercised.
- Severity is user impact, not effort. A silent wrong result outranks a crash.
- Severity and work order are **separate axes**. The H/M/L labels are stable identifiers — cite them, do not
  renumber them. What to do next is [Order of work](#order-of-work) at the end, which ranks by how much each
  defect blocks an agent. The two lists deliberately disagree.

---

## Open — High

### H1 — a `.yml` body whose `data` is not a string is silently dropped. CONFIRMED. FIXED.

Two separately-reported symptoms, one root cause. The executor's body chain
(`request-executor.ts:392-435`) is, in order:

1. multipart → `FormData`
2. `typeof body?.data === 'string'` → send verbatim, and set the implied content-type from
   `BODY_TYPE_CONTENT_TYPES[body.type]` (`:397-398`)
3. `body?.type === 'form-urlencoded' && Array.isArray(body.data)` → proper `URLSearchParams` encode
4. `body?.type === 'graphql' && !Array.isArray(body.data)` → JSON envelope

**There is no final `else`.** Any `data` that is an object and is neither a graphql body nor a
form-urlencoded array matches nothing, `options.body` is never assigned, and **the request goes out with no
body at all** — no error, no warning. Two known ways in:

- **`form-urlencoded` authored with `formData`.** `request.ts:892-900` (create) and `:555-561` (modify) build
  the YAML body as `isMultipartBodyType(type) ? toMultipartData(formData) : input.body.content`.
  `isMultipartBodyType` (`request.ts:43`) matches only `form-data` / `multipart-form`, so `form-urlencoded`
  takes the else and writes `data: undefined`.
- **`type: json` with a YAML mapping** rather than a JSON string. Reaches no branch. (Previously this
  stringified to a literal `[object Object]` on the wire; the `String()` catch-all is gone, so it is now a
  silent drop instead — quieter, and worse.)

The normaliser that fixes the first case, `toFormUrlEncodedEntries` (`request.ts:143-161`), accepts *both*
shapes and is correct — but at the pinned commit it still has exactly **one** call site, `request.ts:190`,
inside `yamlBodyToBruBody`, i.e. the `.bru` path only. Routing the `.yml` path through it moves
form-urlencoded into branch 3. The `json` case needs a real fallback branch, not a `String()` cast.

Failure mode is the worst this tool has. The file looks right, the run reports a clean 2xx/4xx, and the body
was never sent. Any assertion on "the endpoint rejects bad input" passes for the wrong reason.

> **Partial correction to the field audit.** It also reported that authoring with `content: "a=1&b=2"` sends
> an empty body, citing the executor iterating `{name, value}` pairs at `:407-409`. That mechanism does not
> hold: `:407-409` is inside branch 3, which a string never reaches. A string `data` hits branch 2 and is sent
> verbatim *with* the correct implied content-type. The audit did reproduce a live rejection, so something on
> that path is still wrong — but **re-reproduce before fixing it**, because the cited cause is unreachable.
> The `formData` case above is confirmed by reading and is sufficient on its own to justify the fix.

**Fix both ends together.** The read path has a mirror-image defect: `parseYamlRequest` routes *every* array
body through the multipart part mapper, stamping `type: 'text'` onto form-urlencoded parts, which Bruno does
not do. Fixing only the write path leaves a file that round-trips through us but diverges from Bruno. Route
`toFormUrlEncodedEntries`, add the missing fallback branch, fix the parser, and fix L2, in one change.

> **What measurement actually found, before the fix was written.** Probing `buildFetchOptions` directly (it
> is exported, so the wire-level body needs no mocked fetch) moved three of this item's claims:
>
> - The `content: "a=1&b=2"` symptom **reproduces, but for a different reason than either the audit or the
>   correction above gave**: the string went out verbatim and correct, with *no* `Content-Type`, because
>   `BODY_TYPE_CONTENT_TYPES` had no `form-urlencoded` entry. A form post with no content type is rejected by
>   every server that parses one. Fixed by adding the entry, not by touching the body chain.
> - The `type: json` **mapping case was already closed** by `parseBodyData`, which serialises a YAML mapping
>   under `type: json` to a JSON string and throws on anything else. It is not reachable through the parser.
>   The fallback branch is still warranted — a caller that builds the request itself can reach it — but it
>   guards a narrower hole than this entry claimed.
> - **A defect this entry never listed:** the plain-string branch sat *above* the graphql branch, so a graphql
>   query authored through this tool (stored as bare query text, unlike Bruno's `{query, variables}` mapping)
>   went on the wire as naked query text with no JSON envelope. Every graphql server rejects that. Fixed in
>   the same change by moving the graphql branch above the string branch and teaching it both stored shapes.
>
> The `formData` case was confirmed by reading and is what the entry describes.

**Fixed** by: routing both list-shaped body types through a shared `toYamlBody` builder in `request.ts` (the
create and modify paths had built the body inline and identically, which is how one defect existed twice);
adding the form-urlencoded read branch to `yaml-parser.ts`; reordering the executor's body chain and adding
the fallback branch, which **warns rather than throws** — `buildFetchOptions`'s first call site sits outside
`executeSingleRequest`'s try block, so a throw would abort an entire sequential run. Guarded by
`tests/unit/bruno/yml-body-fidelity.test.ts`, including a byte-exact round-trip of a Bruno-written file.

### H2 — No cookie jar, so no session can be exercised without hand-rolled relaying. CONFIRMED.

`Set-Cookie` is captured per response into `MockResponseData.setCookies` (`response-wrapper.ts:194-195, 221`)
and then never used: `executeSingleRequest` reads only `scriptResult.variables`
(`request-executor.ts:975-1033`), and each hop builds a fresh dispatcher with no shared cookie state
(`:835-859`). Nothing writes cookies into the outgoing headers of a later request.

Consequence: every session-based flow — login, anything CSRF-protected, anything behind a session — requires
each request to parse `set-cookie` in an `after-response` script, park it in a variable, and the next request
to send it as an explicit `Cookie` header. That was six hand-written relays to test one login. Users testing a
browser-facing application will all write the same boilerplate, and most will first conclude the tool is
broken, because the symptom is a 403 with no explanation.

A `cookieJar: true` option on `run_collection`, defaulting to on for a folder run, removes an entire class of
user confusion. Couples to L1 — expose `res.getSetCookies()` in the same change.

### H3 — Runtime variables cannot be injected into a run. CONFIRMED.

`run_collection` (`tools/run-tools.ts:18-26`) accepts `collectionPath`, `requestPath`, `collectionRoot`,
`environment`, `parallel`, `includeResponseBody`, `maxResponseBodyBytes` — and no way to pass variables in.
Verified at the pinned commit: `variables` does not appear in the tool's input schema.

So any value a run needs must be persisted into an environment file first, inside the collection's own git
repository. For a credential, that means committing it.

> **Correction to the field audit.** The audit attributed half of this to `set_environment_variable` with
> `secret: true` "discarding the value", framing it as a bug. It is not one. **Neither Bruno format stores a
> secret's value** — `.bru` writes `vars:secret [ NAME ]`, `.yml` writes `secret: true` with no `value` key.
> Storing the value would be the defect. The tool description was corrected to say the name is recorded but
> the value is not stored (`environment-tools.ts:181-182`), so the surface is now honest.
>
> This makes the `variables` input the *only* fix, not a nicety: there is no correct place on disk for a
> secret, by design, so there must be an in-memory path. A `variables` input on `run_collection`, applied over
> the environment for that run only, closes it.

---

## Open — Medium

### M1 — Parse failures are counted, never identified. CONFIRMED.

`discoverRequests` (`request-executor.ts:110-142`) wraps each file in `try { … } catch { parseErrors++ }`.
The run result carries `parseErrors: <n>` and nothing else — not the path, not the message.

A collection with one malformed file reports `parseErrors: 1` and silently runs a subset. The user can only
learn which file by bisecting. Attach `{file, message}` per failure.

This is the same shape as the zero-tests-reports-PASS gate that was closed earlier: an aggregate number that
cannot distinguish "nothing was wrong" from "something was skipped".

### M2 — Execution order is a flat global `seq` sort; folders do not scope it. CONFIRMED, contradicts the tool description.

`discoverRequests` recursively collects every `.yml`/`.bru` under the path, then applies **one global**
`Array.sort` on `yaml.info.seq` (`request-executor.ts:135-139`), with a missing `seq` becoming
`Number.MAX_SAFE_INTEGER`. No folder-level ordering exists: `folder.bru` is excluded from being read as a
request (`metadata-files.ts:21`) and its `meta.seq` — which is how Bruno orders folders — is never parsed.

But `run_collection`'s own description claims "Requests within each folder still run sequentially by seq
order", implying folder-scoped sequencing. Two requests numbered `seq: 1` in different folders are interleaved
by readdir enumeration order, which is not stable across filesystems. A whole-collection run over a
many-folder collection therefore has no predictable order — which matters precisely because there is no
cookie jar (H2) and state must flow between requests in order.

Either implement folder-scoped ordering (and parse `folder.bru` `meta.seq`, which needs M3) or correct the
description. Shipping a description that overstates the guarantee is the worse half of this defect.

### M3 — Collection-level and folder-level settings are silently ignored. CONFIRMED.

`collection.ts` contains no handling of headers, auth, scripts or vars, and `request-executor.ts` never
imports it. `metadata-files.ts` treats `collection.bru` / `folder.bru` purely as things to *exclude* from
request discovery (`:15`, `:21`); their contents are never read. Verified: no read of either file anywhere in
`src/`.

Bruno supports collection- and folder-level headers, auth, scripts and vars, and real collections lean on them
heavily — a collection-wide `Authorization` or `Content-Type` is the normal way to write one. Here they vanish
without a word. Only auth is partially acknowledged, via the `auth: inherit` warning
(`request-executor.ts:507-512`). Headers, scripts and vars get no warning at all.

This is the prerequisite that would make `auth: inherit` actually *resolvable* instead of warn-and-skip, and
it is what M2 needs for folder ordering.

> **Correction to the adversarial review.** That review claimed collection-level unknown-key passthrough
> "closes four criticals at once", including "silently unauthenticating every `auth: inherit` request". Three
> of the four do not hold, and the premise is false:
> - `auth: inherit` is never resolved at all — the executor pushes an explicit warning and sends no
>   credential. Honest, not silent.
> - Collection-level auth is not modelled anywhere, so there is nothing to lose on round-trip.
>   `BrunoCollection` (`types.ts:89-96`) carries only version/name/type/ignore and two inert script fields.
> - The lossy round-trip in `updateCollection` (`collection.ts:132-177`) has **no MCP tool entry point** —
>   only tests call it.
>
> Do not implement passthrough on the "four criticals" premise. The real work is *reading* the root files,
> which is additive, not a round-trip fix.

Minimum viable step, if the full read is too large: warn per request when a collection/folder root file exists
and declares something that is being dropped.

### M4 — Generated YAML does not match Bruno's writer. CONFIRMED, but not as originally described. FIXED.

The observation was right: all six `yamlStringify` call sites in `yaml-generator.ts` passed `{ indent: 2 }`
and nothing else, `lineWidth` appeared **zero** times in `src/`, and the library therefore defaulted to
`lineWidth: 80` and folded style (`code: >-`) for multi-line strings.

**The severity was wrong.** The claim above — that folding joins a `//` comment with the statement below it
and silently comments the statement out — does not reproduce. Measured against the `yaml` library directly
and end-to-end through this server's own generator and parser, on eight script shapes (short lines, a long
comment, long code, indented lines, trailing whitespace, blank lines, CRLF, tabs): every one round-tripped
byte-identical. Folded style encodes each source newline as a blank line in the block, and any conforming
parser restores it. The blank lines in the emitted `>-` block are the encoding, not an accident of the
scripts happening to be paragraph-separated.

What is real, and what the fix delivers:

- **Byte-fidelity.** Bruno's writer (`bruno-filestore/src/formats/yml/utils.ts`) uses
  `{ lineWidth: 0, indent: 2, minContentWidth: 0, defaultStringType: 'PLAIN' }` and a post-pass inserting a
  blank line before each top-level block key. Ours used none of it, so every file we wrote differed from the
  file Bruno writes for the same request, and Bruno rewrites it on first save.
- **Hand-edit hazard.** In a folded block the blank lines are load-bearing. A human tidying them out of a
  `>-` script joins the lines — and *then* the `//` comment does swallow the statement beneath it. Literal
  style removes the trap rather than relying on nobody touching the file.

Fixed by routing all six call sites through one helper that mirrors Bruno's options and blank-line pass.
`defaultStringType: 'PLAIN'` is what selects `|-` over `>-`; the original note that `lineWidth: 0` alone
would not do it is correct.

### M5 — No tool to read a request or an environment. CONFIRMED. *(User-reported)*

The surface is `list_collections`, `list_requests`, `run_collection`, `create_request`, `modify_request`,
`delete_request`, `create_environment`, `update_environment`, `set_environment_variable`,
`remove_environment_variable`, `get_collection_stats` — list, run and write, but never get.

To learn a collection's conventions, or to check what `create_request` actually wrote, the client must fall
back to shell (`cat`) or a raw file read, which defeats the point of the MCP boundary. It also makes
`modify_request` unsafe to use: current state cannot be inspected before patching it. This omission is what
made H1 hard to notice — the only way to see the bad `data:` scalar is to leave the tool.

Two tools: `read_request(filePath)` and `read_environment(collectionPath, name)`, returning the parsed
structure rather than raw text, so the `.bru` / `.yml` difference stays hidden.

Three traps when implementing:
- A read tool is the first place the `.bru` / `.yml` parse asymmetries become user-visible. The readers
  currently drop oauth2/digest config and settings blocks; a read tool makes those omissions look like data
  loss. Decide whether to surface them as `unsupported` rather than omit them.
- Secret env vars are name-only in both formats (see H3). The tool must not imply it is returning a value that
  was never stored.
- The writer lowercases request filenames — `create_request({name: 'Bodied'})` writes `bodied.bru`. The tool
  must accept the path the writer returned, not a rebuilt one. A rebuilt path passes on macOS and `ENOENT`s on
  Linux CI.

### M6 — `get_collection_stats` withholds every environment value. CONFIRMED.

Environment *names* are listed, values withheld by design. Combined with M5 there is no in-protocol way to
confirm what a variable holds — discovering which host a `url` variable pointed at required reading the
environment file off disk.

Withholding secrets is reasonable; withholding every value is not. Return non-secret values, or add a
`revealValues` flag. Best folded into `read_environment` (M5) rather than solved twice.

### M7 — Request-level unknown-key passthrough. CONFIRMED.

Both generators rebuild the document from scratch with no unknown-key passthrough, so any unmodelled key is
**deleted** on read-modify-write, not ignored. The environment-level case was closed; the request level was
not. A request authored in Bruno with a feature we do not model loses it the first time `modify_request`
touches it.

---

## Open — Low

### L1 — `setCookies` is captured but never exposed under a name. CONFIRMED.

`response-wrapper.ts:194-195, 221` populates `setCookies`, but nothing in `sandbox-worker.ts` exposes it —
verified, `getSetCookies` has zero occurrences there. It is reachable only incidentally as
`res.getHeader("set-cookie")`, which returns the joined header and has to be regex-parsed. Given H2, this is
the one field a user in that situation actually wants. Either expose it or drop it.

### L2 — Orphaned docblock in `request.ts:97-108`. CONFIRMED. FIXED.

The comment describing the `form-urlencoded` normalisation — including "Handing it the raw `content` string
wrote no block at all, so an authored body was silently dropped and the request went out empty" — sits
immediately above a *different* function's docblock (`yamlBodyToBruBody`, `:109-119`). The prose documents a
fix that the `.yml` path never received (H1). Anyone reading the file top-down concludes the bug is fixed.
It is not. Fix with H1.

**Fixed** with H1: the docblock was deleted and rewritten above the function it actually describes.

### L3 — Auth types advertised but not applied. CONFIRMED, handled honestly.

`UNAPPLIED_AUTH_TYPES` is `['oauth2', 'digest']` (`request-executor.ts:474`); those emit an explicit
"auth type X is not applied automatically" warning. The warning is honest, so this is a schema-versus-reality
mismatch rather than a silent failure.

> **Correction to the field audit.** That audit listed `api-key` as unimplemented and flagged the
> `api-key` / `apikey` spelling split as a Bruno-incompatibility. Both are now closed: api-key is applied,
> and the `.yml` write vocabulary was corrected to Bruno's `apikey` with `placement` / `query`. The MCP-facing
> union keeps `api-key` as the accepted input spelling; the on-disk spelling is Bruno's.

What remains under this heading:
- oauth2 and digest are still parsed and persisted but never applied. Their *config* is additionally dropped
  by the readers — a partial block may be worse than none, so decide before implementing.
- The third auth enum, at `request-tools.ts:355` (`create_crud_requests`), lists neither `digest` nor
  `inherit`, so it disagrees with the other two enums. Pure drift; cheap to fix.

### L4 — `seq` is omitted when `sequence` is not passed. CONFIRMED.

`create_request` without `sequence` writes no `seq` at all, which the sort treats as `MAX_SAFE_INTEGER` (M2)
and silently places last. Defaulting to "one past the current maximum in the folder" matches what a user means
by "add a request".

### L5 — Allowlisted hostnames bypass private-address protection by name. CONFIRMED, by design, document it.

The SSRF allowlist is matched on the hostname string, so an allowlisted name that resolves to a loopback or
private address is permitted. That is the correct behaviour for a local development host and is what makes
local testing possible at all.

The caveat deserves saying out loud in the operator documentation: **allowlisting a name disables the
loopback / private-range checks for that name permanently, including if DNS later points it somewhere else.**
Allowlist entries are hostnames, not pinned addresses. Note also that any `*` wildcard in an allowlist entry
is silently ignored rather than expanded.

### L6 — `.yaml` is not recognised as a request extension. CONFIRMED.

Bruno accepts `.yaml`; we recognise only `.yml` and `.bru`. A collection using `.yaml` is enumerated as empty.

### L7 — Environment authoring gaps. CONFIRMED.

- `create_environment` cannot author a secret at all.
- `generateBruEnvironment` writes `secret: false` unconditionally; the real fix is in `format-factory.ts`.
- `dataType` and `disabled` on environment variables are parsed and persisted but unwired.

### L8 — `.bru` generator catch-all crashes on a well-typed file body. CONFIRMED.

The `.bru` generator's body chain is presence-based, not type-based (graphql → formUrlEncoded → file →
`content` catch-all at ~`bru-parser.ts:467`). The catch-all `json.body = { [mode]: content }` is still live and
throws `items.filter is not a function` for any caller passing a well-typed `BruBody {type: 'file', content}`.
Upstream expects `body.file` to be an **array** of `{filePath, contentType?, selected?}`.

Not reachable from the current tool surface — the authoring path populates the structured field and bypasses
the catch-all — but it is a live trap for the next caller.

### L9 — graphql body with no query falls back to `''`. SUSPECTED.

Decide whether an empty query should be an error rather than an empty string sent to the server.

### L10 — a `.yml` graphql request is written under `http:`, not in its own `graphql:` block. CONFIRMED.

Found while fixing H1, and deliberately left out of that change so the body-chain fix stayed one thing.

Upstream writes a graphql request into a top-level `graphql:` block, not `http:`, and that block carries its
own `headers`, `params` and `auth` alongside `body: { query, variables }` — verified by reading
`packages/bruno-filestore/src/formats/yml/items/stringifyGraphQLRequest.ts` in
`/Volumes/Projects/tools/working_dir/bruno-tool`, where the function ends `ocRequest.graphql = graphql`. This
tool writes the whole request under `http:` and puts the query in `http.body` with `type: graphql`, the same
place it puts every other body.

Both halves of this codebase agree with each other, so such a request round-trips here and executes correctly
— the envelope fix under H1 makes sure of that. What it does not do is match what Bruno writes, so a request
authored here and opened in Bruno is not the file Bruno would have produced.

Same class as M4: byte-parity with upstream, read from the source rather than inferred. Scope is larger than
"move the body": it is a second top-level request block with its own field set, so it needs a writer change,
a reader that accepts both placements (every graphql `.yml` this tool has already written uses `http:`), and
a round-trip test against a Bruno-authored file. `info.type: graphql` is already written correctly and is
what a reader should switch on.

---

## Engineering debt — separate PR

**Tests are neither linted nor type-checked.** `npm run lint` is `eslint src/ --ext .ts` — `src` only — and
`tsconfig` excludes `tests/`, with `ts-jest` diagnostics off. Consequences:

- 223 ESLint errors in `tests/`, dominated by `@typescript-eslint/ban-types` (the `Function` type in test
  harnesses).
- A separately-recorded 237 type errors across 77 files, likely an overlapping population.
- **A type-only fix has no test that can go red.** This is the load-bearing half: it silently weakens the
  red-before-green step for any change that is purely about types.

Large, mechanical and noisy. Keep it off feature PRs.

---

## Needs a decision — not defects until someone chooses

1. **`options?.scriptRunner ?? TestRunner`** — should the in-process runner stay the **default**? `TestRunner`
   is public API. The MCP path is saved only by `process.send`'s JSON codec; any other embedder gets the
   weaker isolation by default and will not know it.
2. **`env-loader.ts` binds a secret variable to `''`** — so a request templated on a secret sends an empty
   string rather than reporting the variable unresolved. This matches Bruno's contract, so it may be correct.
   Decide; do not assume.

---

## Deliberately not doing

Recorded so they are not rediscovered as findings:

- **oauth2 / digest full config round-trip** — a partially-populated auth block may be worse than none.
  Gated on the L3 decision.
- **`body: file` authoring** — the upload surface is gated by `confineUploadPath`. This is our deliberate
  containment, *not* an upstream limitation; an earlier note claiming otherwise was wrong.
- **`tls` / `proxy` settings** — operator-gated per host by design.

---

## Verified working — do not spend time here

Checked directly, several because they had been recorded as broken. That record was wrong or has been
overtaken.

- **Query params reach the wire.** Proved end to end: credentials sent *only* as query params, empty body,
  application returned 200 (`applyParams`, `request-executor.ts:264-267`).
- **Declared `assert` blocks are evaluated and reported.** A declared `res.status eq 200` appeared in run
  output as a passing test alongside scripted ones. The `droppedAssertions` guard (`:1022-1026`) exists
  specifically to prevent silent drops.
- **`vars:pre-request` / `vars:post-response` are implemented**, via `applyPreRequestVars`
  (`request-vars.ts:40`) and `postResponseVars` threaded through `sandbox-host.ts:354` and
  `sandbox-worker.ts:610-617`.
- **`bruFileToYamlRequest` no longer drops features** — params, assertions, vars, settings and auth are all
  forwarded, including the `apikey` spelling.
- **Request headers are applied**, through pre-request mutation and per redirect hop
  (`:269-307, 337, 823, 874-878, 947`).
- **`bru.setVar` → `{{var}}` works across requests** in a serial run, substituting into URL, query, header
  names *and* values, auth fields and every body shape. One `VariableStore` per run (`:1217-1220`);
  `parallel: true` deliberately gives each folder its own (`:1171`).
- **Redirect handling is careful** — SSRF re-validated per hop, method downgraded on 301/302/303, credentials
  stripped cross-origin (`authorization`, `cookie` and `proxy-authorization` all included,
  `request-redaction.ts:89`), with a DNS-pinned dispatcher per hop.
- **Secret redaction in reported output works** — a password sent as a query param came back as
  `password=REDACTED` in the result URL.
- **The `.bru` write path is byte-clean** — 8 body modes, 10 auth modes, all flag polarity round-trip
  identical through upstream. Nearly every remaining fidelity defect is in `.yml`, which is the *default*
  format. Read `bruno-filestore/src/formats/yml/` before touching it; that path was originally written from
  inference rather than from Bruno's source, and that is the root cause of most of this list.
- **The assert engine matches upstream** — all 28 operators and 12 unary matchers follow upstream's chain,
  `guardChain` throws on unknown matchers, the assertion-template wrapper escape is blocked, and script
  vacuity is handled honestly (a never-settling promise FAILs).

---

## Recently closed

For orientation only — full detail is in the superseded review and in the PRs.

- Zero registered tests reporting as an unqualified PASS.
- Environment secret values written in plaintext, both ends, both formats.
- Environment unknown-key passthrough, and the missing `mergeEnvironment` lock.
- IPv6 transitional SSRF bypasses (NAT64, 6to4, RFC 2765) plus three missing IPv4 ranges.
- Sandbox semaphore leak, and a live sandbox object crossing the realm boundary.
- api-key `queryparams` placement, query-param redaction, header-name substitution.
- `modify_request({headers})` on both formats; `.bru` graphql and file bodies; `.yml` graphql body parse.
- `followRedirects` / `maxRedirects`; the `.yml` `tests` slot **with** its read-side fold.
- Assert operand interpolation ordering (was interpolating before the list/range split and the regex-delimiter
  strip; upstream does both after, per element).
- Bruno's own metadata files being enumerated as runnable requests.
- `inherit` treated as an auth mode rather than as absent auth.
- The body payload being dropped when loading a `.yml` request.
- Lock asymmetry on all five unlocked create/delete write paths — `createRequest`, `createEnvironment`,
  `deleteEnvironment`, `createCollection`, and the `delete_request` unlink.

---

## Reading notes — dead ends already walked

Carried over from the superseded review's refutation section. Each of these is a wrong reading that looked
right, recorded so it is not re-derived.

- **Audit at the layer that matters, not the convenient one.** Upstream's `JSON.parse(request.data.variables)`
  was once offered as evidence about `.yml` on-disk shape. That line lives in Bruno's **runner**, not its
  filestore, so it says nothing about the file format. Check the wire, or check the file — not the layer that
  happens to be open. The same error produced H1's unreachable `:407-409` citation.
- **`format-factory.ts`'s two script maps are per-format, not per-direction.** The maps around `:104` and
  `:110` are the **yaml** and **bru** maps. Reading them as an asymmetric write-map/read-map pair leads to the
  conclusion that `.yml` tests never execute, which is false — `request-executor.ts:115` folds `.bru`'s
  `tests` block into `after-response`, and scripts run on both formats. Two adjacent constants are not a
  before/after pair just because they look like one.
- **Auth is not an inert feature.** Tempting to group with the parsed-persisted-never-applied class, but it
  does not belong: unapplied auth types warn explicitly, and `inherit` warns about unsupported inheritance.
  Auth is honest about its limits. Its problem is a type surface that over-promises (L3), which is a different
  defect with a different fix.
- **Fixing one end of a data path is not a fix.** Recurring across this list: the write side and the read side
  are separate code, and closing one silently leaves the hole open. See H1, M4, and the note under M5. A test
  that passes because our own parser tolerates our own malformed output proves nothing — read the bytes.

## Order of work

**Ordered by how much each defect blocks an agent, not by severity.** The two rankings disagree, and this one
wins. The primary consumer of this server is an agent reading tool schemas, and the defects that hurt it most
are the ones it cannot see: output silently corrupted, or a failure it has no way to diagnose. A missing
feature an agent can detect is less costly than a wrong result it cannot.

Severity labels on the findings above are unchanged and still mean user impact. Use them to judge a single
defect; use this list to decide what to do next.

### Tier 1 — agent blockers

What an agent needs and does not have. Direct field feedback first.

1. **M5 + M6** — `read_request` and `read_environment`. Reported twice by users. The agent must leave the MCP
   boundary and `cat` files to see what it just wrote. This is also the meta-blocker: H1 survived precisely
   because there was no in-protocol way to look at the generated `data:` scalar. Fixing this makes every
   remaining defect on this list *visible* to whoever hits it, so it goes first even though H1 is more severe.
2. **M4** — match Bruno's writer options and its blank-line pass. Ranked here on the strength of a
   corruption claim that did not survive measurement: folded style round-trips losslessly, so no script was
   ever silently commented out. It kept the slot only because it is the cheapest fix on the list; on its
   real merits — byte-fidelity with Bruno, and removing a hand-edit trap — it belongs below M1.
3. ~~**H1 + L2** — the missing `else` in the body chain, the `.yml` `toFormUrlEncodedEntries` routing, and the
   read-path mirror, in one change. The run reports a clean 2xx/4xx and the body was never sent, so
   assertions pass for the wrong reason. Fix the orphaned docblock while in the file — it actively hides
   this.~~ **Done.** Measurement moved three of H1's claims and turned up one defect it never listed — see
   the note under H1. Filed L10 out of it.
4. **M1** — name the file and the reason in `parseErrors`. A bare count is a dead end for an autonomous
   agent: it cannot bisect, so it cannot recover. Cheap.
5. **H2 + L1** — an opt-in cookie jar, exposing `getSetCookies()` alongside. Without it, every session-based
   flow needs the same hand-rolled `set-cookie` relay, and the symptom of getting it wrong is an unexplained
   403. Larger, but it is the difference between "can test a login" and "can test a login if you already know
   the internals".
6. **M2 (description half, now)** — the tool description promises folder-scoped `seq` ordering that does not
   exist. An agent planning around a false guarantee is worse off than one told the limit. Correct the wording
   in whichever PR is open; the real ordering fix needs 7.
7. **M3** — read the collection and folder root files. A collection-wide `Authorization` or `Content-Type` is
   the normal way to write a collection, and here it vanishes without a word, so the agent duplicates it per
   request or gets 401s it cannot explain. Unblocks M2's real fix and makes `auth: inherit` resolvable. Start
   with warn-on-dropped-settings if the full read is too large for one change.
8. **L4 + L6** — `seq` defaulting to "one past the folder maximum", and recognising `.yaml`. Papercuts, one
   PR. A Bruno collection using `.yaml` currently enumerates as empty.

### Tier 2 — security

Thin, and that is accurate rather than an oversight: the substantive work already landed — IPv6 transitional
SSRF bypasses and three missing IPv4 ranges, query-param credential redaction, the sandbox semaphore leak, the
realm-boundary escape, and plaintext environment secrets. What remains is one documentation gap and two
posture decisions.

9. **H3** — a `variables` input on `run_collection`. Also a tier-1 blocker by impact; listed here because the
   driver is security. Any value a run needs must currently be persisted into the collection's own git
   repository, and there is no correct on-disk place for a secret **by design**, so an in-memory path is the
   only fix. Verify the variable resolves at the wire *and* appears in no written file.
10. **L5** — document the allowlist caveat. Allowlisting a hostname disables the loopback and private-range
    checks for that name permanently, including if DNS later moves it. Correct behaviour, but an operator has
    to be told. Ride along with any PR.
11. **Decision** — should the in-process runner stay the default for `options?.scriptRunner ?? TestRunner`?
12. **Decision** — is `env-loader.ts` binding a secret to `''` a bug or the contract?

### Tier 3 — the rest

13. **M7** — request-level unknown-key passthrough.
14. **L7** — environment authoring: secrets, and the unwired `dataType` / `disabled`.
15. **L3** — the third auth enum at `request-tools.ts:355`. Pure drift.
16. **L8** — the `.bru` file-body catch-all. Unreachable from the tool surface today; a live trap for the
    next caller.
17. **L9 + L10** — the two graphql items, together: decide whether a body with no query should error, and
    move the request into the top-level `graphql:` block upstream writes. Same file, same round-trip test.
18. **Test lint and typecheck debt**, in its own PR. The load-bearing part is not the error count — it is that
    `tests/` is neither linted nor type-checked, so **a type-only fix has no test that can go red**.
