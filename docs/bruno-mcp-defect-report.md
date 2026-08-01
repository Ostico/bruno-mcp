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

### H2 — No cookie jar, so no session can be exercised without hand-rolled relaying. CONFIRMED. FIXED.

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

**Resolution.** `run_collection` takes `cookieJar`, defaulting to **on**. That default is upstream's, not a
preference: Bruno's CLI exposes the inverse flag `--disable-cookies`, off unless given, so cookies relay by
default there too.

Implemented on `tough-cookie`, the same library upstream uses, so host/path/expiry matching is not
reimplemented here. Semantics copied deliberately from `bruno-cli/src/runner/run-single-request.js`:
`Cookie.parse(..., { loose: true })` and `setCookieSync(..., { ignoreError: true })` so a malformed cookie is
skipped rather than failing the run; jar cookies merged over a `Cookie` header the request wrote itself, with
the jar winning a same-name clash and the caller's own header name preserved; cookies stored from 4XX/5XX
responses too, since a failed login still sets the cookie the next request needs.

> **Superseded on the clash, and only on the clash.** The same-name precedence quoted above was accurate when
> H2 landed and is no longer the behaviour: **M11** flipped it, so a `Cookie` header the request wrote itself
> now wins that clash and the jar only adds names the request did not set. Everything else in this section still
> holds — loose parsing, `ignoreError`, the preserved header name, 4XX/5XX storage. See M11's resolution note
> for the argument, since the flip is a deliberate divergence from upstream rather than a correction to it.

**Where it goes beyond copying upstream, and why:**

- **Scope.** Upstream keeps a module-level singleton jar, which is right for a CLI process that exits after one
  run. This server is long-lived and runs unrelated collections, so a process-wide jar would send one
  collection's session cookie to whatever host a later run happened to match. The jar is created per run, and
  per *folder* in a parallel run — the same isolation the `VariableStore` already has, for the same reason.
- **Redirects.** Our executor follows redirects itself, so the jar is applied per hop, *after* the existing
  cross-origin credential strip. Applying it only to the initial request would have missed the
  login-then-redirect flow, which is most of what H2 is about; applying it before the strip would have undone
  the strip. A hop to another origin gets that origin's cookies, or none.
- **`Secure` gating** is left to the library. Upstream passes an explicit `{ secure }` option to
  `getCookiesSync`, but tough-cookie v6 removed it and derives this from the URL: sent over https, withheld
  over http, allowed to `http://localhost`. Verified by test rather than assumed, since a silently-ignored
  option looks identical to a working one.

Host isolation is pinned by tests at both the jar and the wire level, and both survive mutation testing — the
plausible bug (forgetting to thread the hop's URL) turns four tests red.

### H3 — Runtime variables cannot be injected into a run. CONFIRMED. FIXED.

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

**Resolution.** `run_collection` takes `variables: {name: value}`, applied over the environment for that run.
It works with no `environment` at all, which is the case that matters for a secret.

**The layer was taken from upstream, not chosen.** Bruno's CLI spells this `--env-var name=value` and writes
the value into `envVars` *after* the environment file is read (`bruno-cli/src/commands/run.js`), so it sits at
the environment layer. That means an injected value beats the environment file, and a request-level
`vars:pre-request` or a `bru.setVar` still beats the injected value — upstream's chain is
`collection < env < folder < request < oauth2 < runtime < process.env`. Both directions are tested.

Numbers and booleans are coerced (`{{port}}` as `8080` is the natural way to write it). A name no
`{{placeholder}}` could ever reference — empty, brace-bearing, or space-padded — is **rejected**, not dropped:
an override that is accepted and then silently never applied is this register's most common defect shape.

**Nothing reaches disk, and that needed no guard.** Upstream keeps a separate `envVarOverrides` map so its
persistence layer can tell an injected value from a deliberate script write and avoid writing the former
back. There is no equivalent hazard here: the sandbox exposes no `bru.setEnvVar`, and `VariableStore` is not
persisted between runs, so no write-back path exists. A test asserts a run carrying an injected secret issues
no `writeFile`, `appendFile`, `rename` or `mkdir`.

One thing this does *not* do: a value that resolves into a URL or header is reported in the run result under
the existing redaction rules (`redactUrl`, `stripCredentialHeaders`), which recognise userinfo and known
credential names. An injected secret substituted into an unrecognised query-parameter name would appear in the
result. That is pre-existing behaviour, identical for environment-file values, and is not made worse here —
but it is the reason to prefer a header or a recognised parameter name.

### H4 — `.yml` request vars and assertions are written under keys Bruno never reads. CONFIRMED. FIXED. *(Found while checking L11's premise)*

Upstream's `.yml` `runtime` block is `{ variables, scripts, assertions, actions }` —
`stringifyHttpRequest.ts:83,90,97,105` writes those four, and `parseHttpRequest.ts` reads exactly
`info`, `http`, `runtime`, `docs`, `settings` and `examples`. There is **no top-level `vars` and no
top-level `assert`** anywhere in it.

Ours writes `doc.runtime = { scripts }` (`yaml-generator.ts:193`) and then puts the other two blocks
at the top level: `doc.vars = { preRequest, postResponse }` (`:221`) and `doc.assert` (`:205`). The
parser is symmetric — `doc.vars` at `yaml-parser.ts:354`, `doc.runtime` at `:339` — and neither end
mentions `variables`, `actions` or `assertions`. So the mapping is:

| ours | upstream |
| --- | --- |
| `vars.preRequest` | `runtime.variables` |
| `vars.postResponse` | `runtime.actions` |
| top-level `assert` | `runtime.assertions` |
| `runtime.scripts` | `runtime.scripts` — **matches** |

**`runtime.scripts` matching is why this was invisible.** Scripts round-trip, so the dialect looks
right where anyone would check first, and our own files round-trip perfectly because the writer and
the parser share the same wrong key. Every test passes because both ends agree with each other
rather than with Bruno — the same trap as the mocked-serializer environments and the
read-the-bytes-not-the-round-trip lesson, in a third shape. Any test for the fix has to assert
against upstream's parser or against literal bytes, not against our own round-trip.

**H-level, on the register's own rule.** A Bruno-authored `.yml` request carrying
`runtime.assertions` runs here with **zero declared assertions and reports green** — the same class
as H1, and the same class as the empty-directory pass L14 turned up: a result that reads greener than
reality and cannot be diagnosed from inside. Pre-request vars vanish in the same direction, and in
the outbound direction every `.yml` request this server has ever written has vars and assertions that
`bru run` cannot see.

**It also corrects L11's premise, so fix this first.** L11 says the YAML dialect writes a typed
variable as `value: {type, data}`. It does not: `toYamlVar` (`yaml-generator.ts:142`) writes
`value: v.value`, already coerced to a string by the parser, so we never produce that shape. It can
only arrive from an externally-authored file — which we read under the wrong key anyway, so L11 is
currently unreachable and its fix cannot be exercised until the keys are right.

**Upstream already has the helper L11 needs**, and it should be mirrored rather than reinvented:
`yml/common/datatype.ts` exports `isTypedValue` (non-null non-array object with `type` and `data`),
`fromOpenCollectionTypedValue` (validates the type, defaults to `string`, parses `data` by type) and
`serializeVariableValue`, which renders a plain object as `JSON.stringify(value, null, 2)` rather
than `String()`. Note `YamlVar` has no `dataType` field, so preserving a non-string type needs one
added.

**Migration is the open question, not the mapping.** Reading both shapes is unambiguously right.
Writing the upstream shape means `.yml` files this server previously wrote stop being read by it
unless the read side keeps accepting the old keys — which it should, and which is cheap. Whether to
also *rewrite* an old file on modify is the only judgement call here.

> **FIXED.** The mapping lives in `yaml-runtime-blocks.ts`, mirrored from
> `bruno-filestore/src/formats/yml/common/*` rather than reimplemented. In-memory shapes are
> unchanged, so nothing downstream of the parser needed to know. The operator table turned out to
> already exist in `assert-operators.ts`, and was verified identical to upstream's list *and* in the
> same order, so no second copy was added.
>
> **Migration went the cheap way, as predicted:** the old top-level keys are still read, upstream's
> win when a document carries both, and the next write moves them. So nothing already on disk stops
> loading, and no separate rewrite step was needed.
>
> **Two deliberate divergences from upstream, both because upstream loses data.** `local` is
> recovered from an action's `variable.scope` — upstream writes that scope and then hardcodes
> `local: false` when reading it back, so matching it would drop the flag on every file, including
> ours. And `local` is carried on a pre-request variable, which upstream's `Variable` shape cannot
> hold: `.bru` supports it there (`bruToJson.js` `varsreq`, the `@name` prefix), so omitting it would
> make `.yml` lossy against `.bru` and lose the flag on any `bru-to-yaml` conversion.
>
> **L11 is fixed as a consequence**, not separately — see the note under it.
>
> One extra confirmation found while fixing: `BLOCK_KEYS` in `yaml-generator.ts`, the blank-line list
> copied from Bruno's own writer, never contained `vars` or `assert`. The evidence that those keys do
> not exist in the format was already in the file that wrote them.
>
> **Tests deliberately do not use a round-trip as their oracle** (`yaml-runtime-blocks.test.ts`, 25
> cases). The writer and the parser agreed with each other for the whole life of this bug, which is
> why the suite stayed green through it, so the assertions pin the literal on-disk structure and the
> inbound cases start from documents shaped the way Bruno writes them. All 17 mutations were caught —
> one only after a fix: the "not a `set-variable`" case originally omitted `variable.name`, so the
> trailing name check dropped the action regardless of its type and the test passed with the type
> filter deleted.

---

## Open — Medium

### M1 — Parse failures are counted, never identified. CONFIRMED. FIXED.

`discoverRequests` (`request-executor.ts:110-142`) wraps each file in `try { … } catch { parseErrors++ }`.
The run result carries `parseErrors: <n>` and nothing else — not the path, not the message.

A collection with one malformed file reports `parseErrors: 1` and silently runs a subset. The user can only
learn which file by bisecting. Attach `{file, message}` per failure.

This is the same shape as the zero-tests-reports-PASS gate that was closed earlier: an aggregate number that
cannot distinguish "nothing was wrong" from "something was skipped".

**Resolution.** The run result now carries `parseFailures: [{file, message}]`, and `parseErrors` is derived
from its length rather than tallied beside it, so the count and the detail cannot drift. `file` is the same
path shape `results[]` reports, so it can be handed straight to `read_request`.

Two things worth knowing about the reported message. It is the **first line only**: our own guards throw
single-line messages, and the one multi-line source is the `yaml` package's code frame, which echoes the
offending source line back — the reason and its line/column are already in the first line, and copying file
content into a run result is how a literal credential in a request body ends up somewhere nobody expected it.
It is capped at 300 characters, with the truncation marked rather than silent.

The **single-request** path was the same defect with a different shape and is fixed too: `requestPath`
pointing at an unparseable file throws (correctly — there is no partial run to report), but the parser names
the reason and not the file, and the caller's own argument does not appear in what it gets back. It now
throws `Failed to parse <path>: <reason>`.

`describeParseFailure` lives in `src/bruno/parse-failure.ts` rather than in the executor because
`request-executor.ts` sits on the repo-wide max-lines ceiling — adding this inline broke the lint gate.

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

**Description half addressed.** `run_collection` now states the real rule: one global `seq` sort across
everything the run covers, folders not scoping it, ties ordered by filesystem enumeration and therefore not
stable — with the advice to use distinct `seq` values or run a folder at a time when order matters.

One correction to this finding: the sentence it quotes, "Requests within each folder still run sequentially by
seq order", is on the `parallel` option and is **accurate for that mode** — the parallel path groups by folder
and walks each folder's requests in order. What was undocumented is the *default* sequential mode's flat
global sort. The real ordering fix still needs M3.

### M3 — Collection-level and folder-level settings are silently ignored. CONFIRMED. PARTLY FIXED.

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

**Resolution, in two halves — read what a root declares, apply the two things collections lean on.**

Root files are now read, in both dialects: `collection.bru` / `folder.bru` via upstream's own
`collectionBruToJson` (a *separate grammar* from the request parser — a root file's bare `auth { mode: … }`
block makes `bruToJsonV2` throw), and `opencollection.yml` / `collection.yml` / `folder.yml`, which share the
`request:` section shape a folder file has.

**Applied:**

- **Headers**, collection root first, then each folder from the collection down to the request's own directory,
  then the request. Upstream fills a `Map` in that order, so the nearest definition wins. A name the request
  sets itself removes the root's entry rather than overwriting it, because this executor's header assembly
  comma-joins duplicates — combining them would send `Bearer collection-token, Bearer request-token`.
  Matched case-insensitively, which upstream does not do (it keys on the name as written, so `authorization`
  from a collection and `Authorization` from a request both go out). Header names are case-insensitive per
  HTTP, so that pairing is exactly the doubled-credential case worth diverging over.
- **`auth: inherit`**, from the nearest root that defines auth — the warn-and-skip is gone. It still warns when
  *no* root defines any, since inheriting from nothing sends no credential and that must not read as a request
  deliberately left unauthenticated. Both dialects spell root auth `{ mode, [mode]: … }`, not the request's
  `{ type, … }`, so one shared normalisation handles both — established by test after the YAML root came back
  with `mode`.

**Read and reported as NOT applied:** root-level vars, scripts and tests. Each is named per request
("collection.bru declares a pre-request script, which is not applied to requests yet"), ahead of the warnings
it explains — an unresolved `{{collection_var}}` now arrives with the note saying why. This is the finding's
minimum viable step, kept for the parts the read does not yet act on, so nothing is silently dropped any more.

**Why root vars stop here.** They need the typed-value shape the YAML dialect uses
(`value: {type: number, data: "100"}`), and `parseYamlVarList` renders that as `String(value)` —
`"[object Object]"` — for *request-level* vars too. That is one defect at request level and root level both,
and half-fixing it inside the root loader would leave the two paths disagreeing. Filed as **L11**.

A root file that will not parse degrades rather than failing the run: no settings, and a note saying so.
Header precedence and nearest-root-wins are both mutation tested.

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

### M5 — No tool to read a request or an environment. CONFIRMED. FIXED.  *(User-reported)*

**Closure was never recorded here.** `read_request` and `read_environment` shipped in PR #85; this heading
and Tier-1 item 1 still read as open until 2026-07-31. Marking the heading is how closure is recorded — see
the M4 convention note at the top. The description below is the original finding.

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

**RESOLVED via M5, not in `get_collection_stats`.** `read_environment` returns every variable with its value
plus its `disabled` and `secret` flags, which is the "folded into M5" option this finding preferred.
`get_collection_stats` still returns variable names only, and its description says so — that split is now
deliberate: a stats call over a whole collection is not where a caller should be handed every value.
Secrets remain name-only there and in `read_environment`, because no format stores a secret's value to
return.

### M7 — Request-level unknown-key passthrough. CONFIRMED. FIXED.

Both generators rebuild the document from scratch with no unknown-key passthrough, so any unmodelled key is
**deleted** on read-modify-write, not ignored. The environment-level case was closed; the request level was
not. A request authored in Bruno with a feature we do not model loses it the first time `modify_request`
touches it.

**FIXED.** The environment side's `extra` bag generalised into `src/bruno/extra-keys.ts` and applied per level
— the document, `info`, `http`, `runtime`, `settings`, and each header and param entry — because a key's
position is part of its meaning: a `description` on a header is not a top-level `description`. Measured before
the fix, a single Bruno-authored `.yml` lost seven distinct classes of key on one rewrite, `examples` among
them. Four notes worth keeping:

- **The skip list is load-bearing, not defensive.** A carried key must lose to the typed model, or the stale
  value read off the file being replaced overwrites the update the caller just asked for. Two tests pin it,
  and dropping the check kills them.
- **`parseRuntime` no longer returns undefined for a script-less `runtime` block.** It used to, which left a
  block carrying only unmodelled keys with nowhere on the model to live.
- **Carried blocks are spliced in ahead of `docs`**, which is where Bruno's own key order puts `examples`.
- **The `.bru` dialect is bounded by upstream's grammar, and the bounds are asserted rather than hidden.**
  Unmodelled keys inside a dictionary block (`meta`) are kept. An unknown *top-level* block cannot be:
  `jsonToBruV2` drops it, as it would for Bruno itself. An unknown key inside `settings` cannot be either —
  `bruToJsonV2` discards it at parse time, so it never reaches this code (that same read also injects
  `timeout: 0`, which is where the `.bru` writer's phantom timeout comes from — upstream's, not ours). Both
  are asserted, so a grammar upgrade that fixes either fails a test here instead of passing unnoticed.
  See **L16** for the third `.bru` case, which had to be excluded deliberately.

### M8 — a script cannot wait: no `bru.sleep`, and top-level `await` is a SyntaxError. CONFIRMED. FIXED. *(User-reported)*

Reported from the field on 2026-08-01, and the report is a good record of how the three symptoms present in
sequence. An agent reached for upstream's `bru.sleep(ms)` and got `TypeError: bru.sleep is not a function`; it
fell back to `await new Promise(r => setTimeout(r, ms))` and got a SyntaxError on the `await`; it settled on a
synchronous busy-wait, which worked, at the cost of a pinned core and the same timeout budget it was trying to
wait out.

All three are one root cause. Scripts were compiled as a bare `vm.Script` and evaluated synchronously
(`sandbox-worker.ts:513` and `:710`), so `await` at the top level could not parse; and the sandbox exposed no
timers, so a promise-based wait had nothing that could ever resolve it — the fallback would have hung rather
than waited if the wrapper had been async.

Upstream has all of it: `(async function(){ ... })()` around every script
(`bruno-js/src/utils/sandbox.js:12-18`), `setTimeout`/`setInterval` among its safe globals
(`sandbox/node-vm/constants.js:29-30`), and `bru.sleep` as a promise over a real timer (`bruno-js/src/bru.js:416`).

**Why it could not be copied directly**, which is the part worth keeping: a host `setTimeout` on the sandbox
would hand script a host-realm function whose `.constructor` is the host `Function` — the exact escape
`SANDBOX_BRU_LIB` exists to prevent — and awaiting a host timer would break `microtaskMode: 'afterEvaluate'`,
whose whole point is that the microtask drain happens inside `runInContext` and stays under the V8 interrupt.
A continuation resumed by a host timer would enqueue onto a queue nothing drains.

**Fixed** with a virtual clock defined inside the sandbox realm (`sandbox-clock.ts`). Script schedules onto an
in-context queue; the worker pumps it — read what is due, sleep that long on the host with `Atomics.wait`,
then fire the due timers from inside a `runInContext` call so the callbacks and the drain that follows both
stay interruptible. Nothing but JSON crosses the realm boundary. Blocking the worker is safe here because
`runInWorker` forks one child per job, and the parent's deadline with its SIGTERM/SIGKILL escalation still
bounds it from outside.

Three deliberate divergences from Node's semantics, each tested: the clock advances by real elapsed time, so a
sleep spends the script's timeout budget and `bru.sleep(10000)` under the default 5000ms reports a timeout
rather than waiting; an uncleared `setInterval` does not hold a finished script open; and a throw inside a
timer callback is reported as the script's error instead of vanishing, since no promise rejects for it.

The wrapper opens on the same line as the script's first line, so stack line numbers still point at the lines
the author wrote — upstream instead carries a `NODEVM_SCRIPT_WRAPPER_OFFSET` to subtract afterwards.

### M9 — request `settings` can be read but never written, and no request is created with one. CONFIRMED. FIXED (first half). *(User-reported)*

Reported 2026-08-01 from a session that went through the MCP for everything else — create, modify, delete,
read, run — and had to hand-edit YAML for exactly this.

`read_request` returns `settings` (its own description advertises it). Nothing writes it: `settings` appears in
`request-tools.ts` **only inside tool descriptions**, never as a schema field on `create_request` or
`modify_request`, and `grep settings src/bruno/request.ts` returns **zero hits** — the writer has no concept of
the block at all. So `timeout`, `followRedirects`, `maxRedirects` and `encodeUrl` are inspectable and
unauthorable, which is the worst shape for an agent: it can see the field it cannot change.

**The second half is the expensive one.** A created request carries no `settings` block, so every one of them
inherits defaults, and the default is `followRedirects = yaml.settings?.followRedirects !== false`
(`request-executor.ts:830`) — absent settings means **follow**. The reporter's cost: a reset flow whose session
cookie rides on the 302, so with redirects followed the `Set-Cookie` was lost and the next call returned 500.
It presented as the endpoint issuing no session at all.

**M-level, not L**, because a wrong default that cannot be overridden through the protocol produces a wrong
result the agent cannot diagnose from inside — the register's own severity rule.

Fixing it is two things, and the second is the one that matters: accept `settings` on create and modify, and
decide what a created request should carry. Emitting Bruno's own defaults explicitly is not obviously right —
Bruno omits the block too — but silently inheriting `followRedirects: true` is what caused this.

> **First half done in PR #100; the second half is still open and is a product decision.** `settings` is now
> accepted on `create_request` and `modify_request` and written in both dialects. The block spells the same in
> both — a `settings { }` dictionary in `.bru`, a top-level `settings:` mapping in `.yml`, four camelCase keys,
> identical types — so there is no per-dialect translation, unlike auth or script types. Merging is per field
> (an absent field leaves the stored value alone), following `varsToBruVarSets` rather than `assert`, which
> replaces its whole block: settings are four unrelated switches, not a list meaningful only as a whole.
> `undefined` is tested explicitly, because `followRedirects: false` and `maxRedirects: 0` are the values worth
> writing and both are falsy.
>
> One premise in the paragraph above was wrong and is worth correcting: the *generators* already emitted the
> block (`bru-parser.ts:509`, `yaml-generator.ts:198`), added for round-trip preservation. Only the input path
> was missing, so this was a smaller change than the finding implies.
>
> **A second defect was found by the test this required, and fixed with it.** Of the two `runScript` call sites,
> only one passed a `timeout`: `request-executor.ts:673` did, and `:988` — post-response and tests — did not, so
> the file contained exactly one `5000` where it needed two. `settings.timeout` therefore reached
> only the *pre-request* script — the other two stayed pinned to the runner's internal 5000ms. Tests are the
> slot most likely to wait on something, so raising the setting appeared to do nothing at all. That is the half
> of item 8b that made the cap look immovable.
>
> **Still open:** a created request carries no `settings` block, so it still inherits `followRedirects: true` —
> exactly the default that cost the reporter a session cookie. Emitting explicit defaults on create is a wider
> decision than this change, and it now has a workaround the reporter did not have (set it on create). It also
> interacts with **L15**, filed out of this work.

### M10 — no shared-state concurrency, so a credential race cannot be exercised. CONFIRMED. *(User-reported)*

`run_collection`'s `parallel` runs **folders** concurrently (`Promise.allSettled`, `request-executor.ts:1111`),
serial within each. But parallel folders are isolated on purpose: each gets its own `VariableStore` — the code
says why, *"concurrent folder tasks never share a mutable store (which would reintroduce a setVar/getVar
race)"* — and the cookie jar is scoped per folder when parallel. So two concurrent requests can never contend
over one token, and the reporter had to fall back to `curl` for a token-renewal race.

**Upstream cannot settle this one.** Bruno has no concurrency anywhere: `grep -rn "parallel|concurrency|concurrent"`
over `bruno-cli/src` returns nothing, and its runner is a `for (const resolvedPath of resolvedPaths)` loop with
`await runSingleRequest` inside (`commands/run.js:642`, `:700`, `:728`); the only match anywhere in the desktop
packages is `bruno-electron/src/utils/git.js`. Folder parallelism is **this server's own extension**, so a
shared-state mode would be inventing semantics Bruno never had to define — what `bru.setVar` means under a
race, whether a jar shared across folders leaks a session between them, what a `seq` implies when two folders
interleave.

Cheapest honest shape: an opt-in shared-state mode on `run_collection`, explicitly non-Bruno and documented as
such, with per-folder isolation staying the default.

### M11 — the cookie jar overrides a `Cookie` header the request set itself. CONFIRMED. FIXED. *(User-reported)*

Reported as "the jar replays stored cookies alongside explicit Cookie headers", and the mechanism is sharper
than that: `mergeCookieHeader` (`cookie-jar.ts:63`) lets **the jar win on a same-named cookie**, by design —
*"a value the server just set is fresher than one written into the request by hand."* Upstream's order, and
defensible for a login flow.

It is the wrong order for a multi-credential test. A request that writes `Cookie: session=A` to assert what
credential A can see has that value **replaced** by whatever session the jar last stored, so the assertion
passes against the wrong identity. The reporter had two assertions pass for the wrong reason before catching
it. The failure direction is the worst available: a contaminated run reads greener than reality.

`cookieJar` defaults to `true`, so this is on unless refused.

Two candidate fixes, and the choice is a real one: flip the precedence so an explicitly-written cookie wins
(diverges from upstream, but the explicit value is the author's stated intent), or leave the jar alone for any
request that writes its own `Cookie` header. Either way it needs saying in the tool description, which
currently promises only that the jar is per-run and host-matched.

**Resolution.** The first candidate, at cookie-name granularity rather than per request. `mergeCookieHeader`
now keeps the **request's** value for a name the request wrote itself, still **adds** a name only the jar
knows, and leaves a request carrying no `Cookie` header on its existing untouched path. Emission order is
unchanged — the map is still seeded from the authored header, so authored names keep their positions and
jar-only names are appended after them. Only which value wins changed, not the bytes' layout.

The second candidate — leave the jar out of any request that writes its own `Cookie` header — was rejected
because it is too blunt in the direction that costs a run: a request pinning one credential and *also* needing
the CSRF token the jar holds would silently lose the token, which is H2's original symptom returning under a
new cause.

**Divergence from upstream, stated rather than absorbed.** Bruno's CLI builds
`{ ...parseCookies(existingCookieString), ...parseCookies(cookieString) }`
(`bruno-cli/src/runner/run-single-request.js:465-500`) — the jar spread last, so the jar wins. Freshness is the
right tie-breaker for every name nobody authored, and the jar still owns those. Where the two disagree about a
name, author intent is both the better guess at what the run is meant to test and the only one of the two a
reader can see in the collection: a jar value came from a response several requests ago and appears nowhere in
the files. Argued in the `mergeCookieHeader` docblock, in the enumerated divergence list at the top of
`cookie-jar.ts` (which said "one" and now says two), and in the `cookieJar` tool description and README entry.

**A warning was added, and the argument for it.** A request whose authored value displaced a stored one names
the cookie — never its value — in that request's `warnings`, collected in a `Set` across redirect hops so a
chain that re-applies the jar per hop reports one fact once. The reason is that this fix creates a mirror bug:
an author who *wanted* the fresh server value and does not realise a hand-written header now outranks it hits
the same silent-wrong-answer class as M11, pointing the other way, and the warning is its only signal. It is
also the only place a reader learns the run diverged from what `bru run` would have sent on the same files.

The objection considered was noise, specifically incoherence with `SINGLE_VALUE_HEADERS`
(`request-headers.ts`), which excludes `cookie` from duplicate-header detection *on purpose* because repeating
it is normal authoring. That exclusion is about repeated **field lines in one file** — a style choice with no
behavioural consequence, since `appendHeader` joins them per RFC 6265 §5.4 and the wire bytes are correct
either way. This warning is about a **precedence decision between two sources**, one of which is invisible in
the collection. Different fact, so both rules stand unchanged. It cannot fire on an ordinary login flow, which
authors no `Cookie` header at all and so never reaches the merge — pinned by a test asserting empty `warnings`
for every request in exactly that run. The narrowest case that *does* warn is a hand-rolled `set-cookie` relay,
which is the boilerplate H2 exists to remove, so naming it is the point rather than the cost.

Two existing tests had pinned the *old* order — one at the unit level, one end-to-end — so the wrong precedence
was deliberate and defended at both levels rather than merely untested; both now assert the opposite. Mutation
tested: reverting the precedence turns six tests red, removing the warning collection turns four red while
every precedence test stays green, and a third mutant (removing the per-hop de-duplication) initially
**survived**, because asserting "one warning entry" cannot see a name repeated *inside* one warning string.
That test now asserts the name appears exactly once in the message.

### Field report 2026-08-01 — the claims that were checked and NOT filed

Thirteen items came in from one session. Nine are filed above or already had entries; these four did not survive
the check, and they are recorded because re-reporting them costs more than reading this.

- **"The SSRF filter rejects raw private IPs, but a hostname mapped to loopback in `/etc/hosts` passes."**
  **Not a gap.** `url-validator.ts` does a DNS pre-flight (`node:dns/promises` `lookup`, under its own timeout
  budget) and refuses a name that resolves into a reserved range. What let the reporter's hostname through was
  their own `BRUNO_SSRF_ALLOWLIST` — the documented, by-design bypass under **L5**. The filter behaved as
  specified.
- **"A bare top-level `expect()` records nothing and the request looks green with zero assertions."** Half
  right, and the half that matters is wrong. `tests: []` is accurate, but `detectUnreportedAssertions`
  (`sandbox-diagnostics.ts:107`) emits a warning naming the count and, when nothing was recorded, states it
  outright: *"This run therefore reports zero assertions even though the request itself succeeded."* The real
  residue is a design question, not a defect: it warns rather than fails.
- **"Parse errors are skipped, not failed, and the summary still looks healthy."** Reported and documented.
  `parseErrors` is in the run summary (`request-executor.ts:1203`), each file is named with its reason in
  `parseFailures` (**M1**), and `run_collection`'s own description spells out that a run over a whole collection
  can be a subset. Same residue as above: skipping is deliberate.
- **"Request filenames are lowercased on write, so the returned path must be reused."** True, and already
  documented on the tool surface. Behaviour, not defect.

**One correction to an existing entry.** **M2**'s heading still says *"CONTRADICTS the tool description"*. That
is now stale: `run-tools.ts:19` documents the global `seq` sort explicitly, including that two requests numbered
`seq 1` in different folders are ordered by filesystem enumeration. The defect stands; the contradiction does
not.

---

## Open — Low

### L13 — no return channel for a value a run captured. CONFIRMED. *(User-reported)*

H3 solved the inbound direction — `run_collection` accepts `variables`. There is no outbound one: nothing on
the run result carries what a script set with `bru.setVar`. The reporter's workaround was to embed the token in
a dynamic `test()` description, which works and means **credentials land in run output as test names** — the
one place they are certain to be logged and echoed back.

Worth deciding alongside redaction: the values most worth returning are exactly the ones most worth not
printing.

### L14 — `folder` is not a parameter, and passing it runs the whole collection. CONFIRMED. FIXED. *(User-reported)*

The filter is `requestPath`, which takes either a request file or a subdirectory. An agent that reaches for the
obvious name gets a silent whole-collection run instead of an error, because an unknown key is dropped rather
than rejected. Either accept `folder` as an alias or reject unknown keys; the current behaviour is the only one
that cannot be noticed.

> **Done in PR #99, by the alias route rather than the rejection route.** Rejecting unknown keys is not
> available per-tool: every `registerTool` call passes a Zod *raw shape*, so stripping unknown keys is the
> behaviour of the whole surface, not of this tool. `resolveRunTarget` (`src/tools/run-target.ts`) accepts
> `folder` as an alias of `requestPath`, rejects passing both as ambiguous rather than silently preferring one,
> and refuses a `folder` that names a file with a message pointing at `requestPath`.
>
> **Two further defects turned up while fixing it, both fixed in the same PR.** First, relative paths were
> resolved against the *server process's* cwd — `path.resolve(inputPath)` with a single argument
> (`tool-path.ts:34`) — so `folder: "Auth"` meant something different depending on where the MCP client
> happened to launch the server, and the caller had no way to know. They now anchor to `collectionPath`, and the
> ENOENT message states that rule rather than leaving it to be inferred. Second, a run aimed at a directory
> containing no requests reported a clean pass: `warnIfNothingToRun` (`request-discovery.ts`) now warns on both
> the named-directory and whole-collection paths, ending "Zero requests is not a pass." A warning rather than a
> throw, deliberately — the directory exists, so this is a misaimed subset, not a bad path.

### L15 — authoring any `settings` field silently turns URL encoding on. CONFIRMED. *(Filed out of M9)*

`shouldEncodeUrl` has a two-valued default (`url-encoder.ts:156-158`): with no `settings` block it returns
`false`, and with a block that does not mention `encodeUrl` it returns `settings.encodeUrl ?? true`. So the
presence of the block, not the presence of the field, decides. Authoring `{ timeout: 20000 }` on a request that
previously had no block therefore flips URL encoding from off to on as a side effect, and the caller asked about
timeouts.

Only reachable now that M9 made the block authorable. It is upstream's behaviour — Bruno's own GUI always writes
`encodeUrl` explicitly, so a Bruno-authored request never sits in the ambiguous state, and ours always did.
Stated in the tool's field description rather than compensated, because compensating means writing a default the
caller did not ask for, which is the same open decision as M9's second half. Take the two together.

### L16 — `.bru` `tags` cannot survive a rewrite: upstream's reader and writer disagree on its shape. CONFIRMED. *(Found while fixing M7)*

`meta { tags: smoke }` is read by `bruToJsonV2` as the **string** `'smoke'`, and written back by
`jsonToBruV2` as a **list**, which iterates whatever it is handed. A string iterates one character at a time,
so the round-trip through upstream's own grammar produces:

```
tags: [
    s
    m
    o
    k
    e
]
```

Verified against the installed `@usebruno/lang` with both a single tag and `tags: smoke, fast` — the reader
returns the raw string in each case, and a genuinely unknown key (`reviewedBy: qa`) round-trips verbatim,
which is what isolates this to `tags` rather than to unknown keys in general.

It is upstream's defect, not ours, and it bites here only because **M7 started carrying unmodelled `meta`
keys.** Before M7 this server silently dropped `tags`; carrying it would have replaced a silent drop with a
corrupted file, which is worse. So `tags` is excluded from the `.bru` carry list on purpose, with a test that
pins the exclusion and the reason. `.yml` is unaffected — that document is serialized whole.

The real fix is to model `tags` on both sides (parse the comma-separated string into a list, write a list
back), which also removes the exclusion. Small, but it is a model change with its own round-trip fixtures
rather than part of a passthrough, and `.yml` needs the same field for parity. Worth reporting upstream too.

### L1 — `setCookies` is captured but never exposed under a name. CONFIRMED. FIXED.

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

### L4 — `seq` is omitted when `sequence` is not passed. CONFIRMED. FIXED.

`create_request` without `sequence` writes no `seq` at all, which the sort treats as `MAX_SAFE_INTEGER` (M2)
and silently places last. Defaulting to "one past the current maximum in the folder" matches what a user means
by "add a request".

**Fixed** in `request-sequence.ts`: `nextRequestSequence` reads the target folder's request files, skips
metadata files and anything that will not parse, and returns the highest `seq` plus one — 1 in an empty folder,
since Bruno's sequences are 1-based. Numbering is per-folder, and an explicit `sequence` is still written as
given.

**Deliberately not upstream's formula.** Bruno assigns `items.length + 1` when it creates a request. That is
the same number in any collection Bruno itself wrote, because it keeps sequences dense and rewrites them on
reorder — but in a collection with gaps it returns a `seq` an existing request already holds, and two requests
with one `seq` sort against each other arbitrarily. That is the defect being closed, so this takes the maximum
instead.

Not atomic against a concurrent create of a *different* file in the same folder: the write lock is keyed on the
new file's own path, so two such creates can choose the same `seq`. Same collision upstream allows, and no
worse than the missing `seq` it replaces; a folder-level lock would have to nest inside the non-reentrant path
lock.

### L5 — Allowlisted hostnames bypass private-address protection by name. CONFIRMED, by design, document it. FIXED.

The SSRF allowlist is matched on the hostname string, so an allowlisted name that resolves to a loopback or
private address is permitted. That is the correct behaviour for a local development host and is what makes
local testing possible at all.

The caveat deserves saying out loud in the operator documentation: **allowlisting a name disables the
loopback / private-range checks for that name permanently, including if DNS later points it somewhere else.**
Allowlist entries are hostnames, not pinned addresses. Note also that any `*` wildcard in an allowlist entry
is silently ignored rather than expanded.

### L6 — `.yaml` is not recognised as a request extension. CONFIRMED, PREMISE CORRECTED. FIXED.

The symptom was right: we recognised only `.yml` and `.bru`, so a collection using `.yaml` enumerated as
empty — no requests, no error, nothing to act on.

**"Bruno accepts `.yaml`" was too strong.** Read at `/Volumes/Projects/tools/working_dir/bruno-tool`, upstream
disagrees with itself:

| Bruno component | Accepts `.yaml`? | Evidence |
|---|---|---|
| Desktop app collection watcher | No | `bruno-electron/src/app/collection-watcher.js` — zero `.yaml` mentions |
| Desktop app request loader | No | `bruno-electron/src/ipc/collection.js:1334` — `ext === '.bru' \|\| ext === '.yml'` |
| `bru run` CLI | No | `bruno-cli/src/commands/run.js:374` — `ext === '.yml'`; `hasBruExtension` is `['bru']` |
| OpenAPI sync's collection walk | **Yes** | `bruno-electron/src/ipc/openapi-sync.js:1136` — `.bru`/`.yml`/`.yaml`, same excluded dirs and metadata prefixes as our walk |

So a `.yaml` request is a real artefact a Bruno-adjacent tool can leave behind, and is at the same time
invisible to Bruno's own app and runner. Neither "ignore it" nor "run it silently" is right: ignoring it is the
reported defect, and running it silently means a green run of a request that does not exist as far as `bru run`
is concerned.

**Fixed both halves.** `request-extensions.ts` is the single predicate for "is this a request file", now
covering `.bru`/`.yml`/`.yaml` across request discovery, `list_requests`, `get_collection_stats`, the
read/modify/delete tool gates and the executor. `.yaml` counts as the YAML dialect, so it satisfies a YAML
collection's format check and is rejected by a `.bru` collection exactly as `.yml` would be. And
`run_collection` now returns a run-level `warnings` entry naming every `.yaml` file it read, telling the caller
to rename it.

Two boundaries held on purpose:

- **Environments are untouched.** No upstream site treats a `.yaml` file in `environments/` as an environment,
  and env discovery is a separate predicate. `.yaml` env files stay unrecognised.
- **Matching stays case-sensitive** in the collection walks, as it was at every call site replaced and as it is
  in Bruno's watcher. Making it case-insensitive would newly enumerate `Collection.YML` as a request, because
  the metadata-basename check beside it is case-sensitive too. The tool-argument gates keep the
  `.toLowerCase()` they always had.
- **Nothing writes `.yaml`.** `create_request` still writes `.yml` for a YAML collection and `.bru` for a
  legacy one.

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

### L11 — a typed variable value renders as `[object Object]`. CONFIRMED. FIXED.

The YAML dialect writes a non-string variable as `value: {type: number, data: "100"}` (see upstream's
`bruno-tests/yml-collection`). `parseYamlVarList` (`yaml-parser.ts:271-273`) does `String(v.value)`, which
turns that into the literal `"[object Object]"` — so `{{coll_num}}` substitutes to that string and goes on the
wire.

Affects request-level `vars` and the collection/folder root vars M3 now reads, which is why M3 reports root
vars as unapplied instead of applying them through a parser that would mangle a typed value. Fix once, in the
var parser, and root vars can then use it. Filed 2026-07-31 while implementing M3.

> **Premise partly wrong, and it makes this unreachable — do H4 first.** "The YAML dialect writes a non-string
> variable as `value: {type, data}`" is true of *upstream's* dialect, not ours: `toYamlVar`
> (`yaml-generator.ts:142`) writes `value: v.value`, already coerced to a string, so this server never produces
> the shape. It can only arrive from an externally-authored file — and per **H4** we read request vars from
> `doc.vars` while upstream writes them to `runtime.variables`, so such a file's vars do not reach this parser
> at all. The `String(v.value)` call is still wrong and still worth fixing, but it cannot be exercised until the
> keys are right. Upstream's `yml/common/datatype.ts` already has `isTypedValue`,
> `fromOpenCollectionTypedValue` and `serializeVariableValue` — mirror those rather than writing new coercion.
> Found 2026-08-01 while checking this finding's premise.
>
> **FIXED with H4, in the same change**, because reading `runtime.variables` reaches a typed value
> immediately and fixing the keys without this would have put `"[object Object]"` on the wire on the
> first Bruno-authored collection. A typed value is read as its `data` with the type recorded in a new
> `YamlVar.dataType`, and written back as a typed value rather than silently retyped to a string; a
> plain object value becomes pretty-printed JSON, as upstream's `serializeVariableValue` does. An
> explicit `type: string` is treated as the default and not recorded, also as upstream. Root vars still
> need **L12** before they are applied, but the parser they were waiting on is no longer the blocker.

### L12 — collection- and folder-level scripts and tests are read but not run. CONFIRMED.

M3 reads `script:pre-request`, `script:post-response` and `tests` from the root files and reports them per
request as not applied. Running them needs decisions the read did not: where a root script sits relative to a
request's own (upstream runs collection, then folder, then request), and whether a root `tests` block
contributes assertions to every request's result. Filed 2026-07-31 while implementing M3.

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

1. ~~**M5 + M6** — `read_request` and `read_environment`. Reported twice by users. The agent must leave the MCP
   boundary and `cat` files to see what it just wrote. This is also the meta-blocker: H1 survived precisely
   because there was no in-protocol way to look at the generated `data:` scalar. Fixing this makes every
   remaining defect on this list *visible* to whoever hits it, so it goes first even though H1 is more
   severe.~~ **Done** in PR #85 — struck 2026-07-31, having stayed unmarked here for a week after landing.
   M6 was answered inside `read_environment`, not in `get_collection_stats`; see the note under M6.
2. ~~**M4** — match Bruno's writer options and its blank-line pass. Ranked here on the strength of a
   corruption claim that did not survive measurement: folded style round-trips losslessly, so no script was
   ever silently commented out. It kept the slot only because it is the cheapest fix on the list; on its
   real merits — byte-fidelity with Bruno, and removing a hand-edit trap — it belongs below M1.~~ **Done** —
   the heading has said `FIXED.` since it landed; only this list entry was left unstruck.
3. ~~**H1 + L2** — the missing `else` in the body chain, the `.yml` `toFormUrlEncodedEntries` routing, and the
   read-path mirror, in one change. The run reports a clean 2xx/4xx and the body was never sent, so
   assertions pass for the wrong reason. Fix the orphaned docblock while in the file — it actively hides
   this.~~ **Done.** Measurement moved three of H1's claims and turned up one defect it never listed — see
   the note under H1. Filed L10 out of it.
4. ~~**M1** — name the file and the reason in `parseErrors`. A bare count is a dead end for an autonomous
   agent: it cannot bisect, so it cannot recover. Cheap.~~ **Done.** Cheap as predicted; the single-request
   path turned out to have the same defect in a different shape and was fixed with it. See the resolution
   note under M1.
5. ~~**H2 + L1** — an opt-in cookie jar, exposing `getSetCookies()` alongside. Without it, every session-based
   flow needs the same hand-rolled `set-cookie` relay, and the symptom of getting it wrong is an unexplained
   403. Larger, but it is the difference between "can test a login" and "can test a login if you already know
   the internals".~~ **Done.** On by default rather than opt-in, which is upstream's posture
   (`--disable-cookies`). Built on `tough-cookie`, per run and per parallel folder, applied per redirect hop
   after the cross-origin strip — see the resolution note under H2.
6. ~~**M2 (description half, now)** — the tool description promises folder-scoped `seq` ordering that does not
   exist. An agent planning around a false guarantee is worse off than one told the limit. Correct the wording
   in whichever PR is open; the real ordering fix needs 7.~~ **Description half done.** The quoted sentence was
   accurate for the mode it describes; the flat global sort in the default mode was the undocumented part, and
   is now stated. The ordering fix itself still needs 7.
7. ~~**M3** — read the collection and folder root files. A collection-wide `Authorization` or `Content-Type` is
   the normal way to write a collection, and here it vanishes without a word, so the agent duplicates it per
   request or gets 401s it cannot explain. Unblocks M2's real fix and makes `auth: inherit` resolvable. Start
   with warn-on-dropped-settings if the full read is too large for one change.~~ **Read done; headers and
   `auth: inherit` applied.** Root vars/scripts/tests are read and reported per request rather than dropped —
   the warn-on-dropped-settings step, kept for what is not applied yet. Root vars were blocked on **L11**,
   now fixed with H4, so they wait only on **L12** along with root scripts. See the resolution note under M3.
8. ~~**L4 + L6** — `seq` defaulting to "one past the folder maximum", and recognising `.yaml`. Papercuts, one
   PR. A Bruno collection using `.yaml` currently enumerates as empty.~~ Both fixed. L6's premise needed
   correcting first: upstream accepts `.yaml` in exactly one place and nowhere that mounts or runs a
   collection, so reading it comes with a run-level warning rather than silent acceptance. See L6.
8a. ~~**M8** — scripts cannot wait. Direct field feedback, and it ranks here rather than in Tier 3 for the
    reason this tier exists: an agent writing a polling or rate-limited flow hits it on its first attempt, and
    the only workaround it can find on its own is a busy-wait that burns the very budget it is waiting out.
    Placed above L11 because L11 needs a typed variable to be reachable at all, while this is reached by any
    script that waits.~~ **Done.** A virtual in-context clock rather than upstream's host timers, for the
    realm-boundary and microtask reasons under M8.
8b. **M9** — accept `settings` on `create_request` / `modify_request`, and decide what a created request
    carries. **Top of the queue**, on the reporter's ranking and on this list's own rule: an agent can *see*
    `settings` through `read_request` and cannot change it, and the default it silently inherits —
    `followRedirects: true` — cost a session cookie on a 302 and presented as the endpoint issuing no session.
    It is also the blocker behind the script-timeout cap: 5000ms is liftable only through `settings.timeout`,
    and a script that exceeds it fails the whole request with `status: 0`, `tests: []` rather than warning. Two
    findings, one schema change. **Accepting it is done** in PR #100, and the timeout cap turned out to be
    partly a second defect rather than only a missing schema: `settings.timeout` was reaching the pre-request
    script alone. **What a created request carries is still open**, together with **L15** which the same change
    made reachable — one product decision covering both, and the only part of this item left.
8c. ~~**M11** — stop the cookie jar overwriting a `Cookie` header the request wrote itself, or leave the jar out
    of any request that writes one. Ranked here rather than lower because of its direction: it makes a
    contaminated run read **greener** than reality, and two of the reporter's assertions passed against the
    wrong identity before they noticed. Cheap next to M9, and it needs the tool description updated with
    whichever precedence wins.~~ **Done.** The precedence was flipped rather than the jar bypassed, at cookie-name
    granularity: an authored name keeps its value, a jar-only name is still added, so pinning one credential no
    longer costs the CSRF token the jar holds. A deliberate divergence from upstream, argued in the code and in
    the tool description and README as this list required. Cheap as predicted; the surprise was that two existing
    tests had *pinned* the old order, so it was defended rather than merely untested. See the resolution note
    under M11.
8d. **M10** — an opt-in shared-state concurrency mode. Larger, and the only item here with no upstream answer to
    copy: Bruno has no concurrency at all, so folder parallelism is already ours and shared state means defining
    semantics upstream never had to. Do it after M9 and M11, and expect it to be a design discussion rather
    than a patch.
8e. **L13** — a return channel for captured values. Cheap and agent-visible, but it needs a redaction decision
    taken at the same time, since the values worth returning are the ones worth not printing. That decision is
    why it is still here; **L14**, which shared this slot, was split off and is done (PR #99, by the alias
    route — per-tool rejection of unknown keys is not available, since the whole surface strips them). Two
    defects found underneath it are fixed with it: relative paths anchored to the server's cwd, and an
    empty-directory run reporting a clean pass.

### Tier 2 — security

Thin, and that is accurate rather than an oversight: the substantive work already landed — IPv6 transitional
SSRF bypasses and three missing IPv4 ranges, query-param credential redaction, the sandbox semaphore leak, the
realm-boundary escape, and plaintext environment secrets. What remains is one documentation gap and two
posture decisions.

8f. ~~**H4** — put `.yml` vars and assertions under the keys Bruno actually reads. **Now the top of this tier**,
    ahead of everything left in it: a Bruno-authored request's declared assertions are dropped entirely and the
    run reports green, which is the one outcome this list ranks above all others. Read both shapes, write
    upstream's, keep accepting the old keys so files this server already wrote still load. It also blocks
    **L11** — that finding's premise is wrong in a way that makes its fix unreachable until the keys are
    right, so do not start there. Mirror upstream's `datatype.ts` helpers rather than writing new coercion,
    and assert against upstream's parser or literal bytes: our own round-trip agrees with itself and will
    stay green through the bug.~~ **Done, with L11 folded in** — it could not be exercised separately. The
    mapping was three structural translations rather than three renames; both divergences from upstream exist
    because upstream loses data. See the resolution note under H4.
9. ~~**H3** — a `variables` input on `run_collection`. Also a tier-1 blocker by impact; listed here because the
   driver is security. Any value a run needs must currently be persisted into the collection's own git
   repository, and there is no correct on-disk place for a secret **by design**, so an in-memory path is the
   only fix. Verify the variable resolves at the wire *and* appears in no written file.~~ **Done.** Both
   checks are tested. Promoted above item 5 because leaving a valueless secret unbound (item 12) removed the
   last way, however wrong, to supply one — see the resolution note under H3.
10. ~~**L5** — document the allowlist caveat. Allowlisting a hostname disables the loopback and private-range
    checks for that name permanently, including if DNS later moves it. Correct behaviour, but an operator has
    to be told. Ride along with any PR.~~ **Done**, and marked `FIXED.` on the finding itself; the strike here
    was missed at the time.
11. **Decision** — should the in-process runner stay the default for `options?.scriptRunner ?? TestRunner`?
    **FIXED.** Resolved as no: the default is now `forkingScriptRunner`, so omitting the option gets the
    process boundary and the in-process runner is reachable only by naming it. Retained rather than deleted,
    because the unit lane cannot fork — the forking runner needs `dist/bruno/sandbox-worker.js`, which only
    the integration lane's `globalSetup` builds — so unit tests that execute a script pass `TestRunner`
    explicitly. A test asserts the default routes away from in-process execution, and it goes red if the
    default regresses.
12. **Decision** — is `env-loader.ts` binding a secret to `''` a bug or the contract?
    **FIXED.** Resolved as a bug, in the value chosen rather than in the absence. Empty string is a *resolved*
    value: `substitute` expanded `{{token}}` to nothing and put `Authorization: Bearer ` on the wire, while
    `findUnresolvedPlaceholders` — which applies the same `undefined` test — reported nothing wrong, so the run
    failed on a 401 with no diagnostic. A secret with no value on disk is now left unbound, which keeps the
    placeholder literal and names it in the run's unresolved-variable warnings. A secret that does carry a
    value is still bound to it. Does not remove the need for **H3** (item 9): leaving the name unbound makes
    the gap visible, it does not give an operator any way to supply the value.

### Tier 3 — the rest

13. ~~**M7** — request-level unknown-key passthrough.~~ **Done.** `extra-keys.ts` carries unmodelled keys per
     level on both dialects. Measured first: one Bruno-authored `.yml` lost seven classes of key per rewrite.
     Turned up **L16** on the way — carrying `.bru` `meta` keys exposed a reader/writer disagreement upstream
     has on `tags`, so that one key is excluded rather than corrupted.
13c. **L16** — model `.bru` `tags` on both sides so it stops being an exclusion. Also needs the same field on
     `.yml` for parity, and is worth reporting upstream.
13a. ~~**L11** — a typed variable value (`{type, data}`) renders as `[object Object]`. Blocks M3's root vars, and
     already wrong for request-level vars. Cheap, and it unlocks the next slice of M3.~~ **Done with H4**, which
     it turned out to depend on: its premise was wrong (we never wrote that shape ourselves) and its fix was
     unreachable until the variables were being read from the key Bruno writes them to. M3's root vars now wait
     only on L12.
13b. **L12** — run collection/folder scripts and tests. Needs the ordering decision upstream already makes
     (collection, then folder, then request).
14. **L7** — environment authoring: secrets, and the unwired `dataType` / `disabled`.
15. **L3** — the third auth enum at `request-tools.ts:355`. Pure drift.
16. **L8** — the `.bru` file-body catch-all. Unreachable from the tool surface today; a live trap for the
    next caller.
17. **L9 + L10** — the two graphql items, together: decide whether a body with no query should error, and
    move the request into the top-level `graphql:` block upstream writes. Same file, same round-trip test.
18. **Test lint and typecheck debt**, in its own PR. The load-bearing part is not the error count — it is that
    `tests/` is neither linted nor type-checked, so **a type-only fix has no test that can go red**.
