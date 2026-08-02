# Execution Groups — design

**Date:** 2026-08-02
**Status:** approved, not implemented
**Supersedes:** defect-report item **M10** ("no shared-state concurrency, so a credential race cannot be exercised")
**Target release:** 2.0.0 (breaking)

---

## 1. Problem

`run_collection` today derives everything about execution from directory layout:

- Subset selection is **singular**: one `requestPath` (a file or a subdirectory) or one `folder`. There is no way
  to name an arbitrary set of requests, and no way to name them in an order of your choosing.
- `parallel: true` fans out **folders**, running requests inside each folder serially by `seq`.
- Each parallel folder is isolated — its own `VariableStore`, its own cookie jar (`request-executor.ts:1041`,
  `:1058`) — specifically so concurrent tasks cannot race on `setVar`.
- One `environment` and one set of `variables` apply to the whole run.

Three consequences, which together are the reason for this redesign:

**A credential race cannot be reproduced.** This is M10 as filed. Because every parallel folder gets its own
store and jar, two concurrent requests can never contend over one token. The reporter wanted to exercise a
token-renewal race and had to leave the tool to do it.

**The isolation boundary is an accident of layout.** A folder is a place files live. Using it as the unit of
concurrency, of variable scope, and of session scope means the only way to change any of those is to move files
on disk.

**The same requests cannot be run twice under different inputs.** Running five requests as `alice` and the same
five as `bob`, concurrently and without leakage, is not expressible. Neither is running them against `dev` and
`staging` in one call — a limitation Bruno's own UI has, but which nothing in our execution path requires.

## 2. The model

Three concepts replace folder-shaped execution.

### Run

An ordered list of **groups**, plus a run-level `parallel` flag that fans them out. Run-level `environment` and
`variables` act as defaults that groups may override.

### Group

**The unit of isolation and the unit of configuration.** A group has:

- an ordered list of request references,
- its own `environment`,
- its own `variables`,
- its own `parallel` flag, controlling whether its requests run concurrently,
- an optional `name`.

A group owns exactly one `VariableStore` and one cookie jar for its lifetime. **Nothing crosses a group
boundary** — not variables, not cookies, not captured values. That is what makes alice and bob safe in one call,
and what makes `dev` and `staging` in one call possible.

Within a group, requests share that store and jar. This is deliberate: the login-then-use chain is the reason a
group exists rather than being a bag of unrelated requests.

### Request reference

A path relative to the collection root, extension included (`auth/login.bru`, `users/list.yml`). A directory
expands to the requests beneath it in `seq` order. **Duplicates are allowed everywhere** — repeated within one
group's list, and repeated across groups.

### `seq` is demoted

`seq` is the *default ordering* used when expanding a directory or running an ungrouped collection, and it is
*reporting* order. **It is never an execution constraint.** A group with `parallel: true` runs its requests
concurrently regardless of what `seq` says.

This is not a new liberty. `seq` was already not an execution constraint at folder granularity: parallel mode
feeds every folder to `Promise.allSettled` at once and keeps folder `seq` only so that reporting order does not
change depending on the `parallel` flag (`request-executor.ts`, the `sortedFolders` comment at ~1026). The
redesign extends an existing precedent to requests rather than inventing one.

Line references in this document are against `main` at the time of writing (2026-08-02, after PR #117) and are
navigation aids, not contracts.

### The folder

Survives only as a filesystem fact and as a convenient way to name many requests at once (a directory reference).
It is no longer an isolation boundary, an ordering boundary, or a concurrency boundary.

### Defaults

Omitting `groups` yields a **single implicit group** over the whole collection, or over the top-level selection
if one is given. It inherits the run-level `parallel`, `environment`, and `variables`.

So `{collectionPath}` behaves as today. `{collectionPath, parallel: true}` now means *all requests concurrently,
sharing one store and one jar* — the central breaking change.

## 3. Tool surface

```ts
run_collection({
  collectionPath: string,

  // Run-level defaults, inherited by any group that does not override them.
  environment?: string,
  variables?: Record<string, string | number | boolean>,

  // Ordered selection when no groups are given. Files or directories,
  // relative to the collection root. Omit to run the whole collection.
  requests?: string[],

  // Explicit groups. Supplying both `requests` and `groups` is a validation
  // error, not a silent precedence rule — a caller who passes both has two
  // different intentions in mind and deserves to be told which one we dropped.
  groups?: Array<{
    name?: string,
    requests: string[],
    environment?: string,
    variables?: Record<string, string | number | boolean>,
    parallel?: boolean,      // default false — requests in this group run in listed order
  }>,

  parallel?: boolean,        // default false — fans out groups; inherited by the implicit group
  maxConcurrency?: number,   // default: derived (§5). 0 = unbounded, at the caller's risk.

  // Unchanged.
  collectionRoot?: string,
  includeResponseBody?: boolean,
  maxResponseBodyBytes?: number,
  captureVariables?: string[],
  cookieJar?: boolean,
})
```

**Removed:** `requestPath` and `folder`. Both are singular and both fold into `requests` — a file path, or a
directory path, is a valid entry in the list.

### Variable precedence

Unchanged in shape, one link longer:

```
group environment file
  < run-level `variables`
  < group `variables`
  < request `vars:pre-request`
  < bru.setVar during the run
```

A group's `environment` fully replaces the run-level one; environment values are not merged across the two.
`variables` **are** merged, with the group's entries winning — so a run-level default like `baseUrl` survives
while the group overrides only `user`.

## 4. Isolation

Two settings exist because two are enough:

- **Shared within a group** — the default and the common case. The chain works.
- **Fully isolated per request** — expressible without a new mode: *put each request in its own group*. One
  request, one store, one jar, nothing shared with anything.

An `isolation: 'request'` flag was considered and rejected as redundant. The group already is the isolation
primitive; a second mechanism expressing the same thing at a different granularity would be two ways to say one
thing, and would have to define what captures mean under it (see below) all over again.

### M10, restated

The finding dissolves into a caller choice rather than a default:

- **Want the race?** Put the contending requests in **one** group and set that group `parallel: true`. They share
  a store and a jar, and a token-renewal race is reproducible.
- **Want isolation?** Put them in **different** groups.

Nobody is handed surprise nondeterminism as a default, and the capability M10 asked for exists.

**One caveat must be documented:** a `maxConcurrency` below the number of contending requests silently serializes
the very thing being observed. If you are reproducing a race, the cap must be at least the number of racers.

## 5. Concurrency

### The cap already exists, and it caps the wrong resource for this feature

`sandbox-host.ts:53` defines `DEFAULT_MAX_CONCURRENCY = 8` — a module-scoped semaphore bounding concurrent
**forked script workers**, not HTTP requests. It is a fixed number, not derived from the machine.

The two resources are not alike:

- **Forks are expensive.** Every request carrying a pre-request or post-response script spawns a Node child
  process — tens of MB and a real scheduler slot. Cores- and RAM-bound.
- **Sockets are nearly free.** An in-flight HTTP request is IO-bound. Cores and RAM do not predict how many are
  possible; the file-descriptor limit does, and it fails loudly rather than degrading.

### Decision: one derived cap, sized by the fork constraint, applied to in-flight requests

```
maxConcurrency = max(1, floor(0.9 × min(cores × 2, memoryBudgetMB / 64)))
```

- `cores` from `os.availableParallelism()`, falling back to `os.cpus().length` on Node < 18.14.
- `cores × 2` because forks spend most of their life blocked on IO rather than computing.
- `64` MB as a conservative per-child budget.
- `0.9` as the safety margin.
- The same value is pushed into the sandbox semaphore via `setMaxConcurrency`, replacing the hardcoded 8.

One cap rather than two: it over-throttles a selection of script-free requests, but since volume testing is out
of scope (§8) that costs nothing real, and two caps would be two things to explain and tune.

### Memory budget, and two traps

**`os.freemem()` is unusable on macOS.** The kernel counts cached pages as used. Measured on the development
machine while writing this spec: `freemem` **2252 MB** against `totalmem` **65536 MB**. Sizing off `freemem`
there derives a cap of 1. Use `totalmem()`.

**`os.totalmem()` lies inside a container.** Docker with `--memory=512m` still reports the host's RAM, so the
derived cap would be one the cgroup promptly OOM-kills. Read `/sys/fs/cgroup/memory.max` (cgroup v2) and
`/sys/fs/cgroup/memory/memory.limit_in_bytes` (v1) when present, and take the smaller of that and `totalmem()`.
Treat the sentinel `max` and implausibly large v1 values as absent.

### File descriptors: checked, then deliberately not used

Node exposes the limit natively, with no subprocess:

```js
process.report.getReport().userLimits.open_files   // { soft: 1048576, hard: 'unlimited' }
```

That measurement is from the development machine. At ~1M soft, no run this design can produce will approach it,
so **there is no fd-derived cap**. Shelling out to `lsof` or `ulimit` was considered and rejected: `lsof -p` costs
hundreds of milliseconds per call and adds a subprocess surface to a codebase that deliberately gates shell and
path access, `execSync('ulimit -n')` reports the *shell's* limit rather than this process's, and
`process._getActiveHandles()` is internal, undocumented, and counts handles rather than descriptors.

Instead: if `EMFILE` ever surfaces, catch it and name the soft limit from `userLimits` in the error message, so
diagnosis is immediate. Error-time honesty over startup fortune-telling.

### `maxConcurrency: 0`

Unbounded, at the caller's risk. It must lift the **sandbox semaphore too** — otherwise "unbounded" still queues
at the fork cap and the flag is a lie.

## 6. Results

The result shape becomes group-shaped. **Always nested, including the single implicit group** — conditional
flattening would force every caller to branch on whether they passed `groups`.

```ts
interface CollectionRunResult {
  summary: CollectionRunSummary;        // aggregate across all groups
  groups: GroupRunResult[];             // in run order
  parseErrors?: number;
  parseFailures?: ParseFailure[];       // discovery-level, run-scoped
  warnings?: string[];                  // run-scoped only
}

interface GroupRunResult {
  name?: string;                        // as supplied
  index: number;                        // position in the run, always present
  summary: CollectionRunSummary;
  results: RequestExecutionResult[];    // in listed order, regardless of parallel
  missingRequests?: string[];           // references that resolved to nothing
  capturedVariableNames?: string[];
  capturedVariables?: Record<string, string>;
  warnings?: string[];
  error?: string;                       // the group itself failed (§7)
}
```

The flat top-level `results` array is **removed**. This is part of the 2.0.0 break.

### Captures become well-defined

Per group, `capturedVariableNames` and `capturedVariables` mean exactly what they say: group A's `token` is
alice's, group B's is bob's. There is no ambiguity to resolve, and the existing first-folder-wins-plus-warning
reconciliation in `captured-variables.ts` is **retired** along with the warning text that asserts folders do not
share variables.

One honest consequence: under full per-request isolation (one request per group), captures are per-group and
therefore per-request. They remain well-defined, but a caller running fifty isolated groups gets fifty
single-entry capture maps, which is correct and probably not useful. Documented, not prevented.

## 7. Error handling

- **A group that throws does not stop the run.** Groups are gathered with `Promise.allSettled`, as folders are
  today. A rejected group reports `error` and contributes its requests-not-run to the aggregate summary.
- **An unresolvable request reference** is a group-level `missingRequests` entry, not a thrown error — the same
  reasoning as `parseFailures`: a caller that cannot see *which* subset ran cannot bisect.
- **Parse failures during directory expansion** stay run-scoped in `parseFailures`.
- **An empty group** (references resolving to nothing) is a warning and a zero-request group, not a silent pass.
- **`EMFILE`** is caught and re-raised with the soft limit named (§5).

## 8. Out of scope

- **Volume / load testing.** Considered under the working name "artillery attack" and dropped. Running one
  request N times concurrently would demand latency and throughput statistics, percentile reporting, and a
  ramp-up — none of which exist here, and all of which would dwarf this work. Duplicates in a group's list make
  small-scale repetition *possible*; that is not the same as supporting it, and the tool description should not
  imply otherwise.
- **Declared inter-request dependencies.** A request saying "I need `{{token}}` first" is a different feature
  from a caller declaring an order. Groups plus ordering cover the need without inferring intent from `seq`.
- **A setup/teardown phase.** A group that runs before all others is expressible today by running two calls, or
  by putting the setup requests at the head of each group's list. Not worth a phase concept yet.

## 9. Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Keep folders as the implicit grouping when `groups` is omitted | Preserves the folder-as-boundary accident this design removes, and leaves two concurrency models coexisting forever. Backward compatibility is not worth the incoherence. |
| Legacy-preserving `parallel` (old semantics unless `groups` given) | Same objection; the tool description would have to explain both models. |
| Rename `parallel`, deprecate the old one | Same coexistence cost, plus a deprecation to eventually remove. |
| Per-request isolation as its own flag | Redundant — one request per group says it exactly, with no second set of capture semantics to define. |
| Run-wide sharing as the default, groups layered on top | Contradicts group-owned stores; a group would need to opt *out* of a shared store, which is backwards. |
| Separate caps for forks and sockets | Two knobs to explain and tune, for a distinction that only matters under volume testing, which is out of scope. |
| Per-group concurrency budget | Total in-flight becomes unbounded in the number of groups; moves the footgun rather than removing it. |
| fd-derived cap via `lsof` / `ulimit` | Slow, adds a subprocess surface, and reports the wrong process's limit. The measured soft limit (~1M) makes any fd cap moot. |

## 10. Implementation notes

**`request-executor.ts` is at 1178 lines against a 1300 `max-lines` ceiling.** This work cannot land inside it.
Extract, at minimum:

- `run-plan.ts` — resolving `requests`/`groups` into an ordered list of groups of absolute paths: directory
  expansion, `seq` ordering, duplicate preservation, missing-reference collection. Pure, trivially testable, no
  IO beyond directory listing.
- `concurrency.ts` — cap derivation (cores, memory budget, cgroup detection) and the run-wide semaphore. Pure
  apart from the `os` and cgroup reads, which should be injectable so the derivation is testable without a
  container.

The executor keeps orchestration only: build groups, acquire slots, run, gather.

**`concurrency.ts` is independently shippable.** Deriving the cap from the machine and pushing it into the
sandbox semaphore has nothing to do with groups — it replaces a hardcoded 8 that is wrong on every machine today.
It can land first, non-breaking, on 1.x, which shrinks the 2.0.0 change to selection, grouping, and the result
shape. The rest of this design cannot be usefully split: grouping without the result reshape has nowhere to
report to.

**Already compatible, no change needed:** `rootLoader.forRequest(req.filePath)` is keyed by path rather than by
folder grouping, so a request pulled out of its folder into an arbitrary group still receives its correct
collection- and folder-level script chain. The root-scripts work paid for this in advance.

## 11. Testing

- **Isolation is the headline property and needs adversarial tests**, not incidental ones. A group setting a
  cookie and a variable, run concurrently with a group that reads both, asserting the reader sees neither.
  Both orderings, both `parallel` settings.
- **Cross-environment groups**: the same request in two groups on two environments, asserting each resolved its
  own `{{baseUrl}}`.
- **The race is now reproducible, so test it**: two requests in one parallel group contending on one `setVar`,
  asserting the run completes and reports both outcomes as legitimate rather than erroring.
- **Reporting order is deterministic** even when execution is not — assert results come back in listed order
  under `parallel: true`, across repeated runs.
- **Cap derivation** with injected `os` values: a 1-core/512MB machine floors at 1; a cgroup limit below
  `totalmem` wins; `maxConcurrency: 0` lifts the sandbox semaphore as well.
- **`seq` is not an execution constraint**: a parallel group whose listed order contradicts `seq` must still
  *report* in listed order. Assert the reporting order directly; do not assert an execution order, since there
  is deliberately none to assert. Where a test depends on discovery order, force the wrong `readdir` order rather
  than trusting the filesystem to produce it — a prior test in this repo passed with its tie-break deleted
  because macOS `readdir` was already sorted.
- **Both-inputs rejection**: `requests` and `groups` together produce a validation error naming both.
- **Duplicates**: the same path twice in one group produces two independent results.

## 12. Migration (2.0.0)

| Before | After |
|---|---|
| `requestPath: "auth/login.bru"` | `requests: ["auth/login.bru"]` |
| `requestPath: "auth"` | `requests: ["auth"]` |
| `folder: "Auth"` | `requests: ["Auth"]` |
| `parallel: true` — folders concurrent, isolated, requests serial within each | `groups: [...]` with `parallel: true` to keep isolation; bare `parallel: true` now runs **all** requests concurrently sharing one store |
| `result.results[]` | `result.groups[].results[]` |
| `result.capturedVariables` | `result.groups[].capturedVariables` |

The silent-behavior-change risk is concentrated in one place: a caller who passes `parallel: true` today and
relies on folder isolation gets shared state after upgrading. The changelog must name it explicitly, and the
tool description must state that `parallel` shares state unless groups say otherwise.
