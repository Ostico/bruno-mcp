# Adversarial code review — 2026-07-29

> **SUPERSEDED — historical record, not the working list.**
>
> Open findings from this review have been merged into **[`bruno-mcp-defect-report.md`](./bruno-mcp-defect-report.md)**,
> which is the single living defect register. Most items here are fixed; several were later **refuted** against
> the code (notably the collection-level "four criticals" claim, which rests on a false premise — see M3 in the
> register). Do not plan work from this document.
>
> It is kept because the refutations are the useful part: §9 records what this review got *wrong* and why,
> which is worth more than re-deriving those dead ends.

**Scope:** whole codebase (`src/`), not a single diff.
**Pinned at:** `main@75b28ad`. Every line number below was read at that commit — **re-verify before acting**, the file will have moved.
**Method:** five parallel read-only reviewers, one lens each, each with its own file slice. Every reviewer was given a prior of guilt ("a reviewer who returns *looks fine* has FAILED"), required to quote `file:line` plus a concrete failure scenario, and required to return a non-empty TRIED-BUT-SOUND list (an empty one means they did not actually try).
**Status of this document:** findings only. No code was changed on this branch (0 files vs `origin/main`).

Roughly 56 candidate findings came back. About 25 were re-verified by hand, two of those by executing the built code. Two reviewers refuted each other productively; one refuted me. Refuted items are recorded in [§9](#9-refuted-and-re-scoped) rather than deleted, because the refutations are the useful part.

---

## Contents

- [1. The four root causes](#1-the-four-root-causes)
- [2. Two fix-ordering traps](#2-two-fix-ordering-traps)
- [3. Security — verified by execution](#3-security--verified-by-execution)
- [4. Correctness / data loss](#4-correctness--data-loss)
- [5. Concurrency and TOCTOU](#5-concurrency-and-toctou)
- [6. Inert features — parsed, persisted, never applied](#6-inert-features--parsed-persisted-never-applied)
- [7. DRY / YAGNI / KISS](#7-dry--yagni--kiss)
- [8. Process findings](#8-process-findings)
- [9. Refuted and re-scoped](#9-refuted-and-re-scoped)
- [10. Recommended fix order](#10-recommended-fix-order)

---

## 1. The four root causes

Most individual findings are symptoms of four causes. Fixing a cause closes several findings at once; fixing symptoms one at a time is what produced several of the defects listed here.

### C1 — `.yml` was written from inference, and `.yml` is the default

The `.bru` path is byte-clean against `@usebruno/lang`. The `.yml` path was written by reasoning about what Bruno *probably* does, without reading `bruno-filestore`'s YAML formats. `.yml` is the **default** format, so the least-verified generator is the one most users hit.

Source of truth, not to be inferred:
- `/Volumes/Projects/tools/working_dir/bruno-tool/packages/bruno-filestore/src/formats/yml/`
- `node_modules/@usebruno/lang` (`v2/src/jsonToBru.js`, `bruToJson.js`)

### C2 — No unknown-key passthrough

Both generators rebuild the document from scratch out of the typed model. Any key Bruno writes that we do not model is **deleted** on read-modify-write. One `modify_request` or `update_environment` silently destroys it.

This single property is the cause behind four separate criticals. A passthrough fix — retain the parsed raw document, merge modelled keys over it — closes all four and every future instance of the same class.

### C3 — Lock asymmetry

Sibling read-modify-write methods disagree about locking, and the sibling that *does* lock hides the one that does not. Grep pattern for the class: a private `fooLocked` with no `foo` wrapper, or a public RMW method with no `Locked` sibling.

| Method | Locks? |
|---|---|
| `environment.ts:216` `mergeEnvironment` | **no** — and no `mergeEnvironmentLocked` exists (grep count 0) |
| three sibling env RMW methods | yes |
| `request.ts:369/:372` `updateRequest` | yes |
| `request.ts:271/:282` `createRequest` | **no** — unlocked twin |
| `request-tools.ts:309` `unlink(args.filePath)` | **no** — zero `withPathLock` in the file |

### C4 — Permissive defaults that lie

An unrecognised value falls through to a plausible default instead of erroring, so the caller cannot tell success from silent substitution.

- `yaml-parser.ts:221` — `type: String(s.type ?? 'after-response')`. Any missing or unrecognised script type becomes `after-response`.
- `response-wrapper.ts:204-212` — a JSON parse failure keeps the raw text with no signal to the script:
  ```ts
  let body: unknown = rawText;
  const contentType = headers['content-type'];
  if (isJsonContentType(contentType)) {
    try { body = JSON.parse(rawText); } catch { /* Keep raw text if JSON parse fails */ }
  }
  ```
  A script doing `res.body.items.length` gets `undefined` on a truncated response, not an error.
- `request-executor.ts:1279-1286` — see [§4.1](#41-zero-registered-tests-reports-pass); the most consequential instance.

---

## 2. Two fix-ordering traps

Two of these findings get **worse** if fixed the obvious way. Both are cases where a defect spans two ends of a data path and fixing one end produces a confident-looking false green.

### T1 — The `.yml` `tests` slot

**The defect.** Bruno's `.yml` dialect has **three** script slots. Verified upstream at `bruno-filestore/src/formats/yml/common/scripts.ts:22-27`, which emits `type: 'tests'` as a first-class entry, and `:58-60`, which reads it back into Bruno's own `tests` block:

```ts
  if (request?.tests?.trim().length) {
    ocScripts.push({ type: 'tests', code: request.tests.trim() });
  }
```

We collapse it. `format-factory.ts:104-108`:

```ts
const YAML_SCRIPT_MAP: Record<GenericScriptType, string> = {
  'pre-request': 'before-request',
  'post-response': 'after-response',
  tests: 'after-response',        // :107 — collapse
};
```

So a test script authored on a `.yml` collection lands in Bruno's **`script.res`**, not its `tests` block, and `remove_script` cannot distinguish the two afterwards. The comments asserting this is correct — `format-factory.ts:59-61` ("Bruno's .yml dialect has no separate `tests` slot") and `:102-103` ("This is per-spec") — are **false**; see [§8.3](#83-a-false-premise-documented-to-callers).

**The trap.** Scripts do currently execute on both formats, by two different mechanisms:

- `.bru` — `BRU_SCRIPT_MAP` (`:110-114`) writes a real `tests:` block, and `request-executor.ts:115` folds `bru.tests.exec` into an `after-response` script at conversion time.
- `.yml` — the collapse above means the runtime only ever sees `after-response`.

The executor's script getters filter exactly two literals, `'before-request'` and `'after-response'`; `grep "type === 'tests'"` in `src/` returns **0**. So the `.yml` read path has **no equivalent of the `:115` fold**. A write-side-only fix — start emitting a real `tests:` slot for `.yml` — produces a file whose tests are **never executed**, and because zero registered tests reports PASS ([§4.1](#41-zero-registered-tests-reports-pass)), the run comes back green.

The write map and the `.yml`-side fold must land in the same change. Full scope: `YAML_SCRIPT_MAP`, `yaml-generator.ts:218,:255` (which currently **reject** `tests`), the two executor getters, and the ~5 prose tool descriptions asserting the single-slot premise.

### T2 — The `secret` environment flag

Four components disagree, and the comment claims the bug is already fixed:

- `bru-parser.ts:604-609` — comment documents the secret regression **as already fixed**.
- `bru-parser.ts:615` — generator writes `secret: v.secret === true`. Correct.
- parser reads the flag back. Correct.
- **no writer ever records it.** `environment.ts:228` (`mergeEnvironment`) and `:449` (`setEnvironmentVariableLocked`) both rebuild the entry from two fields:
  ```ts
  const entry: EnvVariable = { name: key, value };
  // Preserve the disabled flag of an existing variable being overridden.
  if (prev?.disabled === true) entry.disabled = true;
  ```

Two user-visible consequences: authoring a secret variable through the tools writes a **non-secret** variable to disk, and a read-modify-write on an existing secret variable **demotes it to plaintext**. Fixing only the authoring path leaves the demotion; fixing only the demotion leaves secrets unauthorable. Both ends, one change.

`removeEnvironmentVariableLocked:490` is the correct pattern in the same file — it uses `filter` and preserves each surviving object intact.

---

## 3. Security — verified by execution

I built the project and probed the real exported `validateUrl`. These are observed results, not readings.

### 3.1 IPv6 transitional-address SSRF bypass — critical

`url-validator.ts` `checkIPv6` un-embeds an IPv4 address only when `groups[0..4] === 0 && (groups[5] === 0xffff || groups[5] === 0)`. Every other transitional encoding of the same IPv4 address is not un-embedded, so the IPv4 private/link-local blocklist never sees it.

**ALLOWED (should be blocked):**

| URL | Encoding | Decodes to |
|---|---|---|
| `http://[64:ff9b::a9fe:a9fe]/` | NAT64 (RFC 6052) | `169.254.169.254` — cloud metadata |
| `http://[64:ff9b::7f00:1]/` | NAT64 | `127.0.0.1` |
| `http://[2002:a9fe:a9fe::]/` | 6to4 (RFC 3056) | `169.254.169.254` |
| `http://[::ffff:0:a9fe:a9fe]/` | SIIT (RFC 2765) | `169.254.169.254` |
| `http://0.0.0.1/` | `0.0.0.0/8` | localhost on Linux |
| `http://240.0.0.1/` | class E, `240.0.0.0/4` | reserved |
| `http://192.88.99.1/` | 6to4 relay anycast | reserved |

**Correctly blocked:** `[::ffff:a9fe:a9fe]`, `169.254.169.254`, `127.0.0.1`.

Remediation: un-embed *before* classifying — handle `64:ff9b::/96`, `2002::/16`, `::ffff:0:0/96`, and add `0.0.0.0/8`, `240.0.0.0/4`, `192.88.99.0/24` to the IPv4 blocklist.

### 3.2 IP literals skip both DNS resolution and pinning

For a literal-IP URL, `net` never consults the custom `lookup`. So both DNS-rebinding defenses are inert on that path: no resolution, therefore no pinning. This matters for the previous finding — a tightly scoped allowlist does **not** mitigate §3.1, because the literal never reaches the allowlist check either.

### 3.3 The allowlist is host-based, not resolved-IP-based

`url-validator.ts:569` reads `process.env.BRUNO_SSRF_ALLOWLIST`; `getAllowlist` (`:557-572`) parses it **once** and caches at module scope. `resetAllowlistCache` (`:563`) exists for tests only; `grep -rn "SIGHUP\|reload" src/` returns nothing, so there is **no runtime reload path** — a change to the variable takes effect only when the server process is respawned.

Behavioural consequence, by design but worth stating: an allowlisted hostname that resolves into `10/8` passes, while the same address given as a bare IP is blocked. The allowlist is a statement of trust about a *name*, not about where that name points.

Two related invariants already established for this feature and worth keeping: a `*` wildcard entry is silently ignored, and the remediation message emits a **count** of allowlist entries only — it never echoes the entries themselves.

### 3.4 `AbortSignal.timeout` constructed outside the `try` — high

`request-executor.ts`:

```ts
904    const timeout = yaml.settings?.timeout ?? 30000;
907      fetchOpts.signal = AbortSignal.timeout(timeout);   // the try begins at :955
```

`timeout` comes from a user-authored file and is not validated. Verified Node behaviour:

| Value | Result |
|---|---|
| `2 ** 31` | `TimeoutOverflowWarning` — duration silently set to **1 ms**; every request fails as a timeout |
| `1.5`, `5e9`, `Infinity` | `ERR_OUT_OF_RANGE` **thrown**, outside the `try`, so it escapes unwrapped |

Remediation: validate to a positive integer within range at parse time, and move construction inside the `try`.

### 3.5 Live object crosses the sandbox realm boundary — high

The contrast within one file is the proof. `sandbox-worker.ts`:

```ts
432      const mutations = vm.runInContext('__reqMutations', context, {...}) as RequestMutations;   // LIVE guest object
494      const rawResults = JSON.parse(vm.runInContext('__resultsJson()', context, {...}) as string);  // serialized in-context
```

Line 494 is right: serialize inside the guest, cross the boundary as a string. Line 432 hands the host a live reference whose prototype chain and property getters belong to the guest realm — guest code can install getters or pollute prototypes that then execute during host property access. Remediation: mirror `__resultsJson()` with a `__reqMutationsJson()`.

### 3.6 In-process runner is the default

`request-executor.ts:1156` — `options?.scriptRunner ?? TestRunner`. The isolated sandbox is opt-in; the default path evaluates collection scripts in the host process. Whether that is the intended default is a product decision, but it should be a stated one.

---

## 4. Correctness / data loss

### 4.1 Zero registered tests reports PASS — critical (masking defect)

`request-executor.ts:1279-1286`:

```ts
const failed = results.filter(r => r.error !== undefined || r.tests.some(t => t.status === 'fail')).length;
...
    passed: results.length - failed,     // zero tests == all passed
```

A run in which no test ever registered is indistinguishable from a run in which everything passed. This is the finding that makes every dropped-script and inert-feature bug below **invisible** — the suite goes green whether the scripts ran or not. `types.ts:717` already documents the intent that "zero assertions does not read as an unqualified pass," so the symptom was known; the cause was not fixed.

Fix this first among the correctness items, or you cannot trust the verification of any other fix.

### 4.2 `modify_request({headers})` is a no-op on `.bru` — critical

`request.ts:889-891` — the `if (updates.headers)` guard at `:889`, and at `:890`:

```ts
updated.headers = { ...updated.headers, ...updates.headers };
```

This writes the record-shaped branch. But the generator prefers the list:

- `bru-parser.ts:363` — generator prefers `headersList`, commented "Source of truth when present."
- `bru-parser.ts:178` — parser sets `headersList` for **any** file with ≥1 header.

So for any `.bru` that already has a header — i.e. essentially all of them — a header modification produces a **byte-identical file** and reports success.

### 4.3 `modify_request` drops three of four body types — critical (regression in PR #75)

`request.ts:912-921` — the `if (updates.body)` block at `:912` replaces the body wholesale with `{type, content}`, and the only type-specific branch is the `form-urlencoded` case at `:919`. `git log` confirms `:919` is `2ef833c`, i.e. **PR #75, my own change**. `formData`, `graphql` and `file` are dropped.

This is the DRY cost the reviewer was pointing at: I fixed one body branch and left three siblings. The fix is a single shared `toBruBody()` converter, **not** a fourth special case.

### 4.4 `.yml` JSON body serialises to `[object Object]` — significant

`yaml-parser.ts`:

```ts
95     if (Array.isArray(obj.data))   // the ONLY special case
115    data = String(obj.data)
```

A YAML mapping under `type: json` is not an array, so it falls to `String(obj.data)` and goes on the wire as the literal `[object Object]`.

(This item was wrongly downgraded mid-review and then restored — see [§9](#9-refuted-and-re-scoped).)

### 4.5 Header names are neither substituted nor tracked — significant

`request-executor.ts`:

```ts
489      trackUnresolved(h.value);                                              // name never tracked
500      appendHeader(headers, headerKeys, h.name, substitute(h.value, vars));  // name never substituted
```

A header authored as `{{tokenHeader}}: abc` goes on the wire with a literal `{{tokenHeader}}` as its name, and the unresolved-variable report does not mention it.

### 4.6 Query-placed API-key credential is never redacted — significant

`request-executor.ts:705`:

```ts
if (auth.in === 'query') { return { key, value }; }   // returns BEFORE authHeaderNames.push
```

The early return skips credential registration, so a query-placed API key is not redacted from logs or evidence. Related: `:521` appends query parameters by string concatenation —

```ts
url += (url.includes('?') ? '&' : '?') + `${encodeURIComponent(...)}=${...}`;
```

— rather than `URL.searchParams.set`, which misbehaves on URLs with a fragment and on duplicate keys.

### 4.7 API-key placement read asymmetrically — significant

`request.ts:791-795` (yaml path) reads only `config.in`; `placement` appears **0×** on that path. But `request.ts:148` `toBruApiKeyPlacement` does `config.placement ?? config.in`. The two formats disagree about which key names a placement.

### 4.8 Auth types advertised but not implemented

The `AuthType` union advertises `'api-key' | 'oauth2' | 'digest'`; only `bearer` and `basic` execute. Bruno spells it `apikey`, one word. `oauth2` and `digest` configuration is additionally **dropped on write** (see the open-fidelity queue). The executor is honest at runtime — unhandled types warn explicitly at `request-executor.ts:663`, and `inherit` warns that collection auth inheritance is unsupported at `:613` — but the type surface promises more than the executor delivers.

### 4.9 `followRedirects: false` is unauthorable on `.bru`

`readRequestSettings` keeps only `encodeUrl` and `timeout`. Any other setting Bruno supports is discarded — an instance of C2 with a concrete user-visible consequence.

---

## 5. Concurrency and TOCTOU

### 5.1 Semaphore leak permanently wedges all script execution — critical

`sandbox-host.ts`:

```ts
165    await acquireSlot();
167    return new Promise<SandboxJobResult>(resolve => {   // NO try/catch anywhere
171      const child: ChildProcess = fork(workerPath, [WORKER_ARGV_SENTINEL], {
206        releaseSlot();     // only inside finish(), only reachable from child listeners
252      child.send(toSendableJob(job), (error: Error | null) => {
```

`releaseSlot()` is reachable only from a child-process listener. A **synchronous** throw from `fork()` (e.g. EMFILE, missing worker path) or from `child.send()` escapes the promise executor with the slot still held. The semaphore cap is 8 and module-scoped, so eight such throws pin the pool permanently: every subsequent script run awaits `acquireSlot()` **forever**, with no timeout armed because the timeout is set up after acquisition.

Remediation: wrap the body in `try/catch` and release on the synchronous path; consider a bounded wait on `acquireSlot()`.

### 5.2 `update_environment` has no lock — high

`environment.ts:216` `mergeEnvironment` is the **sole** implementation of the `update_environment` tool (`environment-tools.ts:103`) and takes no `withPathLock`. No `mergeEnvironmentLocked` sibling exists (grep count 0) while three sibling RMW methods in the same class do lock. Two concurrent `update_environment` calls on the same file lose one writer's changes entirely.

### 5.3 `createRequest` is the unlocked twin of `updateRequest` — high

`request.ts:271/:282` versus `:369/:372`. Concurrent creates against the same path race; the loser's file is overwritten.

### 5.4 Unlocked `unlink` — significant

`src/tools/request-tools.ts:309` — `await unlink(args.filePath)`, in a file with **zero** `withPathLock` calls. Delete racing a concurrent read-modify-write resurrects the file with stale content, or fails the RMW mid-write.

---

## 6. Inert features — parsed, persisted, never applied

A distinct class: declared in the type schema, populated by **both** parsers, faithfully written back by **both** generators, and completely ignored at execution time. Round-trip tests pass. The wire is wrong.

| Feature | Parsed at | Applied at |
|---|---|---|
| **params** (query + path) | `bru-parser.ts:202`, `yaml-parser.ts:149` | **nowhere** — nothing appends a query string or substitutes `:name` |
| **assertions** | `types.ts:525` (`YamlRequest.assert`), `types.ts:277` (`BruFile.assertions`) | **nowhere** — absent from `request-executor.ts` and `sandbox-host.ts` |
| **varSets** (`vars:pre-request` / `vars:post-response`) | `bru-parser.ts` | **nowhere** — referenced only in `types.ts` and the parser |

Written back at `bru-parser.ts:465` and `yaml-generator.ts:97`; authored at `request.ts:519`, where `create_request` stores the tool's `query` input. The executor's only `searchParams` uses are credential redaction and form-body encoding.

**End-to-end, user-reachable:** an agent calls `create_request` with query params, the `.bru` on disk looks correct, `run_collection` sends the request **without them**, a `params:path` `:id` goes out literally as `":id"` — and the run reports PASS because zero tests registered ([§4.1](#41-zero-registered-tests-reports-pass)).

Additionally, `bruFileToYamlRequest` forwards only `method`, `url`, `headers`, `body`, `auth` (plus `meta`→`info`, `scripts`→`runtime`, `docs`). It **drops** `params`, `assertions`, `varSets` and `settings`.

---

## 7. DRY / YAGNI / KISS

### 7.1 Dead code that is also a trap

`environment.ts:251/:282` — `updateEnvironment` is dead, **destructive**, and its name matches the `update_environment` tool while the actual implementation is `mergeEnvironment`. The next maintainer wiring the tool to the obvious-looking method ships data loss. Delete it.

### 7.2 Other dead code

- `format-factory.ts` `createReader` — 1 reference in `src/`, dead.
- `format-detector.ts` `clearFormatCache` — 2 hits in `src/`: its own definition (`:23`) and a comment (`:29`) telling tests to call it. Zero production callers.

### 7.3 Duplication with divergence

- Four body-type conversions duplicated instead of one `toBruBody()` — the direct cause of [§4.3](#43-modify_request-drops-three-of-four-body-types--critical-regression-in-pr-75).
- The two executor script getters duplicate a one-literal filter, which is why a third slot type cannot exist ([§T1](#t1--the-yml-tests-slot)).
- One goal, two mechanisms, in two places: `.bru` reconciles its `tests` block at **read** time (`request-executor.ts:115` folds `bru.tests.exec` into `after-response`), `.yml` reconciles at **write** time (`format-factory.ts:107` collapses the type). Only the read-time mechanism generalises, and the write-time one destroys information. Unify on the read-time fold.

### 7.4 Size cap

`src/bruno/request-executor.ts` is **1294 lines** against a repo-wide `max-lines: 1300`. Any fix touching it must extract first — there are 6 lines of headroom.

---

## 8. Process findings

These are about how the defects survived, and matter more than any single item above.

### 8.1 Three tests encode the bug, not the contract

Three separate tests/fixtures assert current behaviour rather than Bruno's actual format — including one named **`yaml-roundtrip-completeness`** that asserts invented key names. A green suite is therefore **not evidence** of `.yml` fidelity. The only admissible evidence is upstream's parser reading our output.

Corollary: our parser tolerates our own malformed output, so a round-trip test proves nothing about fidelity. Read the bytes.

### 8.2 A false premise propagated into review inputs

I had recorded that `body:file` was "blocked upstream." That is **false** — `@usebruno/lang@0.36.0` `v2/src/jsonToBru.js` has three `body.file` references and `bruToJson.js` carries the grammar. Worse, I supplied that false premise to all five reviewers as a do-not-report exclusion, where it could have suppressed genuine findings. Memory corrected.

Lesson: an exclusion list handed to reviewers is an amplifier for any wrong premise in it. Exclusions need the same evidence standard as findings.

### 8.3 A false premise documented to callers

"Bruno's `.yml` has no separate `tests` slot" is stated to callers in roughly five places, including two comments that assert it as settled fact:

- `format-factory.ts:59-61` — "Bruno's .yml dialect has no separate `tests` slot"
- `format-factory.ts:102-103` — "This is per-spec"

Both are false: upstream `bruno-filestore/src/formats/yml/common/scripts.ts:22-27` emits `type: 'tests'` and `:58-60` reads it back. The comments do not merely fail to flag the defect — they instruct the next reader **not to investigate it**, and a "per-spec" claim with no citation is exactly the shape of the wrong premise in [§8.2](#82-a-false-premise-propagated-into-review-inputs). Any comment asserting an upstream constraint should carry the `file:line` it was read from.

### 8.4 Fix the class while the function is open

[§4.3](#43-modify_request-drops-three-of-four-body-types--critical-regression-in-pr-75) is a defect in my own recent work: PR #75 fixed one body branch and left three siblings three lines away. The rule this earns: when a defective function is open, fix the **class**; never let a noticed gap become a later "discovery."

---

## 9. Refuted and re-scoped

Recorded because the reasoning is reusable.

**Re-scoped, not dropped — the `.yml` JSON body item ([§4.4](#44-yml-json-body-serialises-to-object-object--significant)).** One reviewer argued the graphql case away correctly: upstream `bruno-filestore/src/formats/yml/common/body.ts:128` returns `undefined` for graphql —

```js
    case 'graphql':
      // GraphQL body is handled separately in GraphQL request stringify
      return undefined;
```

— so graphql genuinely is not a `.yml` `http.body` type. I then drew the wrong conclusion and downgraded the whole finding. Another reviewer showed `Array.isArray` is the *only* special case, so `type: json` with a YAML mapping still reaches `String(obj.data)`. Restored to significant.

**A mis-cited corroboration of my own.** I offered upstream's `JSON.parse(request.data.variables)` as support for that item. That line lives in Bruno's **runner**, not its `.yml` filestore, so it says nothing about on-disk shape. Citing the wrong layer is the same error as [§8.1](#81-three-tests-encode-the-bug-not-the-contract) — audit at the layer that matters (the wire, or the file), not the convenient one.

**Corrected while writing this document — the `tests` slot.** The first draft of [§T1](#t1--the-yml-tests-slot) claimed `format-factory.ts:107` and `:113` were an asymmetric *write map vs read map* pair, and that `.yml` tests therefore do not run today. Both wrong: `:104` and `:110` are the **yaml** and **bru** maps — per-format, not per-direction — and `request-executor.ts:115` folds `.bru`'s `tests` block into `after-response`, so scripts execute on both formats. What survives is a **fidelity** defect (`tests` lands in Bruno's `script.res`, not its `tests` block) plus the fix-ordering trap, which is unchanged. Same failure mode as [§9](#9-refuted-and-re-scoped)'s other entries: a plausible reading of two adjacent constants, not verified against the code that consumes them.

**Auth is not in the inert-feature class.** Tempting to group with [§6](#6-inert-features--parsed-persisted-never-applied), but it does not belong: unhandled auth types warn explicitly (`request-executor.ts:663`) and `inherit` warns about unsupported collection inheritance (`:613`). Auth is honest about its limits. Its problem is a type surface that over-promises ([§4.8](#48-auth-types-advertised-but-not-implemented)), which is a different defect.

---

## 10. Recommended fix order

Ordered so that each step is verifiable when it lands, and so no step creates a false green.

1. **Zero-tests-is-PASS** ([§4.1](#41-zero-registered-tests-reports-pass)). First, unconditionally. Until a run with no registered tests fails loudly, no other fix here can be verified.
2. **Secrets, both ends together** ([§T2](#t2--the-secret-environment-flag)). Highest user-visible severity: plaintext on disk. Follow `removeEnvironmentVariableLocked`'s preserve-the-object pattern.
3. **Auth silently absent** ([§4.6](#46-query-placed-api-key-credential-is-never-redacted--significant), [§4.7](#47-api-key-placement-read-asymmetrically--significant)). Credentials that are neither applied nor redacted.
4. **Unknown-key passthrough** ([§C2](#c2--no-unknown-key-passthrough)). Closes four criticals and every future member of the class. Do this before adding any further modelled keys.
5. **The `.yml` `tests` slot, with the read-side fold, in one change** ([§T1](#t1--the-yml-tests-slot)). Never write-side alone. Lower urgency than the above — scripts do execute today — but do not defer it past step 4, because the passthrough work touches the same generator.
6. **Headers no-op on `.bru`** ([§4.2](#42-modify_requestheaders-is-a-no-op-on-bru--critical)) and **body-type loss** ([§4.3](#43-modify_request-drops-three-of-four-body-types--critical-regression-in-pr-75)) via one shared converter.
7. **SSRF un-embedding and the missing IPv4 ranges** ([§3.1](#31-ipv6-transitional-address-ssrf-bypass--critical)). Self-contained; testable in isolation.
8. **Timeout validation** ([§3.4](#34-abortsignaltimeout-constructed-outside-the-try--high)) and the **semaphore leak** ([§5.1](#51-semaphore-leak-permanently-wedges-all-script-execution--critical)).
9. **Locks** ([§C3](#c3--lock-asymmetry)). Last because they are mechanical and low-risk once the RMW bodies above have stopped changing.
10. **Inert features** ([§6](#6-inert-features--parsed-persisted-never-applied)). Largest scope; needs its own plan. Requires step 1 to be verifiable at all.

Before starting any of these: extract from `request-executor.ts` ([§7.4](#74-size-cap)) — 6 lines of headroom under the cap.
