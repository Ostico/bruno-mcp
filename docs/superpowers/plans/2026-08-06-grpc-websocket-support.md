# gRPC and WebSocket Support Implementation Plan

> **For agentic workers:** this plan is executed inline with a checkpoint after every task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop silently destroying gRPC and WebSocket requests that Bruno's own app writes into
collections this server edits, then run those requests headlessly — unary gRPC as a request, and
WebSocket as a bounded recorded session.

**Architecture:** Two independently mergeable pull requests. PR 1 closes a live data-loss defect and
adds no dependencies and no network surface. PR 2 adds the two transports behind lazy imports. The
split is not cosmetic: five of the eight defects an adversarial review found are execution-side only,
and bundling them would hold a live defect behind a certificate-verification argument.

Both dialects funnel into one run model. `request-discovery.ts:209` reads
`bruFileToYamlRequest(parseBruRequest(content))` for `.bru` and `parseYamlRequest(content)` for
`.yml`, so `YamlRequest` **is** the run model. Normalisation therefore happens once, at the two
parse boundaries, and every task downstream of them sees a single shape per request kind.

**Tech Stack:** TypeScript, Node 22/24, jest (ts-jest, CommonJS transform), tsup ESM build,
`@usebruno/lang` for `.bru`, our own YAML reader/writer for `.yml`. PR 2 adds `@grpc/grpc-js`,
`@grpc/proto-loader`, `ws` and `@types/ws`.

## Provenance

This plan supersedes `.omc/plans/grpc-websocket-support.md`, which an adversarial review
(three blind lenses plus a synthesis judge, 2026-08-06) returned **NO-GO** on, with eight critical
defects — six of which needed new or re-scoped tasks rather than edits. That file is untracked and
`.gitignore:1` (`.*`) excludes `.omc/`, so this document is the durable one. The review's findings
are recorded in memory as `grpc-ws-plan-red-team-nogo`.

Every critical is tracked here by its review identifier so nothing is quietly dropped:

| ID | Defect | Where it is fixed |
|---|---|---|
| C1 | The laziness gate cannot fail | PR2-T10 |
| C2 | Dialect divergence is a whole-schema translation | PR1-T4 |
| C3 | `.bru` preservation broken at three points | PR1-T3, PR1-T4 |
| C4 | Two TLS-capable protocols, no certificate-verification story | PR2-T1, PR2-T8, PR2-T9 |
| C5 | Proto confinement unimplementable and far too wide | PR2-T4 |
| C6 | Dependency matrix inverted — Wave 1 cannot close | PR1-T1 |
| C7 | `status` has no legal value for gRPC | PR2-T3 |
| C8 | WebSocket transcript is an uncapped unredacted credential channel | PR2-T5, PR2-T9 |

## Global Constraints

- Build with **npm**, never yarn. `yarn.lock` is stale and a yarn-installed tree makes `tsc` run out
  of memory. CI is `npm ci`.
- No `Co-Authored-By` trailers in commit messages.
- Never push to `main`, never force-push, never merge. The user merges personally.
- `tsconfig.json` **excludes `tests/`**, so tests are not type-checked. A type-only change has no
  test that can go red; it needs a behavioural assertion or it is unverified.
- A broken build drops whole jest suites silently. The green signal is the **suite count**, not
  "0 failures". Record the count in PR1-T0 and compare against it at every verification wave.
- Test-Guard enforces **95% diff coverage on changed `src/` lines**. Dead branches fail it per file.
  Do not write a `catch` for a condition that cannot occur.
- Five CI gates must pass: `test 22.x`, `test 24.x`, `build`, `Test adequacy gate`, `Test-Guard`.
- `.eslintrc.json` sets `max-lines` to **1300** with `skipBlankLines: false, skipComments: false`.
  Comments may not be deleted to buy headroom. **Two files are near the ceiling, not one** — the
  first version of this plan tracked only the executor and `types.ts` broke first:

  | file | at plan time | headroom |
  |---|---|---|
  | `src/bruno/types.ts` | 1281 | 19 |
  | `src/bruno/request-executor.ts` | 1277 | 23 |

  So **new interfaces do not go in `types.ts`.** `GrpcResultDetail` and the WebSocket transcript
  types live in `src/bruno/transport-results.ts` for exactly this reason, and the `YamlGrpc`,
  `YamlWebsocket`, `BruGrpc` and `BruWs` shapes PR1-T2 and PR1-T3 introduce must go in their own
  module too — adding four interfaces to `types.ts` would break the ceiling again. Re-measure with
  `wc -l` before adding to either file.
- Any newly added gate requires a **red-proof**: break the thing it guards, watch the gate fail,
  restore. A gate never observed failing is not a gate.
- Every acceptance criterion must be checkable by an agent with no human in the loop.

## Decisions taken, so no implementer has to choose

1. **The normalisation target is `YamlRequest`,** carrying new optional modelled fields `grpc?` and
   `websocket?`. Not the `extra` bag: `extra` is a passthrough for blocks we do not understand, and
   we now understand these. `extra` keeps carrying everything else.
2. **`status` stays required on `RequestExecutionResult` and keeps `0` reserved for refusals on
   every kind.** gRPC's own code goes in `grpc.code`. A gRPC OK (code 0) is distinguishable from an
   SSRF refusal because the refusal has no `grpc` object. This avoids a breaking output-contract
   change. (C7)
3. **Collection-supplied TLS material may never weaken verification for `grpcs`/`wss`.** Both
   transports route through the same exported `gateTls` the HTTP path uses, keyed on host. A
   credential-construction failure **refuses with a named reason** — it never falls back to
   `createInsecure()` or `rejectUnauthorized: false`, which is where upstream's client goes. (C4)
4. **Proto loading is confined to the collection directory only,** with `fs.realpathSync` on the
   entry file and on every resolved import. `confineUploadPath` is **not** reused: it allows the
   entire home directory and `/tmp`. (C5)
5. **WebSocket outbound payload recording is opt-in.** The default records direction, byte length and
   a monotonic offset — not content — because outbound messages are recorded after `{{var}}`
   interpolation and would otherwise write every secret into a transcript that is surfaced by
   default. (C8)
6. **The engine.io keepalive auto-reply is opt-in, not opt-out,** and only fires after an engine.io
   OPEN frame has actually been observed. As opt-out it contradicted the plan's own
   "no socket.io framing" boundary and injected unrequested frames into any protocol that sends `2`.
7. **`grpc.enable_http_proxy: 0` is set unconditionally,** diverging from upstream deliberately:
   grpc-js honours ambient `http_proxy` while undici's global `fetch` does not, so leaving it enabled
   would silently void SSRF pinning. `grpc.default_authority` is set to the original authority
   whenever a validated address is substituted for the hostname.
8. **No streaming, no reflection, no proxy support, no held-open sessions, no socket.io or MQTT
   block, no `create_request` type parameter.** Deferred scope is documented, not implemented.

## Out of scope, deliberately

- gRPC streaming of any kind (server, client, bidirectional), and server reflection.
- Proxy support for either new transport.
- Sessions held open across tool calls, and any handle returned to the caller.
- A `socketio` or `mqtt` block in either dialect. socket.io is reachable as a plain `ws` request and
  that workaround gets documented in PR1-T9 instead.
- Authoring gRPC or WebSocket requests via `create_request`. Reading, preserving, running: yes.
  Creating from scratch: not in these two PRs.

## Success criteria

1. A collection containing gRPC or WebSocket requests survives `modify_request` on **any** request
   in it with its target, metadata and messages intact, in both dialects. **(PR 1)**
2. `read_request` on a gRPC or WebSocket request returns its kind, target and shape rather than a
   parse error or a silently empty view. **(PR 1)**
3. No tool call ever throws on one of these files. Unsupported operations refuse with a named
   reason. **(PR 1)**
4. `run_collection` executes a unary gRPC request and returns its response message, status code,
   details and trailers, in both dialects. **(PR 2)**
5. `run_collection` records a bounded WebSocket session and returns a transcript with an explicit
   stop reason, in both dialects. **(PR 2)**
6. An HTTP-only run loads neither `@grpc/grpc-js` nor `ws`, proven by a gate that has been observed
   failing. **(PR 2)**

---

# PR 1 — Fidelity

No new dependencies. No network surface.

## The two dialects are in different states today — this shapes the whole PR

Measured, and the previous version of this plan got it wrong by claiming a live loss "in both
dialects":

- **`.bru` is losing data right now.** `bru-parser.ts:85-97` synthesizes an `http` block
  unconditionally, so a gRPC file parses "successfully", the `grpc`/`metadata`/`body:grpc` blocks are
  dropped on the floor, and `jsonToBruV2` cannot re-emit what the model never held. A `modify_request`
  destroys the request. There is **no `PARSE_ERROR` today** for `.bru`; the request runs as an
  empty-URL GET and fails SSRF validation with `status: 0`.
- **`.yml` is losing nothing.** `parseYamlRequest` throws at `yaml-parser.ts:436` before anything is
  written, and `extra`-based passthrough already round-trips the blocks generically for files that do
  parse. The failure is loud and safe.

Two consequences the tasks must respect:

1. **The live defect is `.bru`-only.** Say so in the PR body. Claiming both dialects overstates it and
   a reviewer who checks will not trust the rest.
2. **For `.yml` this work can only *reduce* fidelity** — we are replacing a lossless generic
   passthrough with hand-written models. That is worth doing only because the models are what PR 2
   executes from, and it means every dropped field is a regression rather than a missed improvement.
   This is why PR1-T3's field list is measured rather than sketched, and why PR1-T2 must not remove the
   passthrough before the writer exists.

**Merge unit:** all of PR 1 is one merge. Tasks commit individually, but interim states are unsafe in
two distinct ways — `.yml` files that begin parsing before their writer and tool guards exist
(PR1-T2 → PR1-T5), and `.bru`/`.yml` files that reach consumers still shaped for HTTP
(PR1-T1 → PR1-T7). PR1-T5 and PR1-T7 are what make the branch safe, and both are in this PR for that
reason. The PR body must say "do not merge before the final verification wave passes".

### PR1-T0: Baseline evidence

**Files:**
- Create: `evidence/pr1-task-0-baseline.txt` (gitignored; `.gitignore:69` covers `evidence/`)

**Interfaces:**
- Produces: the suite count and clean-tree state every later verification wave compares against.

- [ ] **Step 1: Record the baseline**

```bash
npx tsc --noEmit 2>&1 | tail -5
npx eslint src/ --ext .ts 2>&1 | tail -5
npx jest 2>&1 | tail -15
npm run build 2>&1 | tail -5
npx eslint src/ --ext .ts --rule '{"max-lines":["error",{"max":1300,"skipBlankLines":false,"skipComments":false}]}' 2>&1 | tail -3
wc -l src/bruno/request-executor.ts src/bruno/types.ts
```

- [ ] **Step 2: Write the numbers down**

Capture into `evidence/pr1-task-0-baseline.txt`: the **suite count** ("Test Suites: N passed, N
total") verbatim, the test count, tsc/eslint output, and the two line counts. A later wave reporting
fewer suites than this file has a broken build, not a green run.

**Acceptance Criteria:**
- [ ] The file records an explicit suite count, not just "0 failures".
- [ ] `tsc`, `eslint`, `jest` and `build` all pass on the untouched tree.

**QA Scenarios:**
```
Scenario: Baseline is real
  Tool: bash
  Steps: Read evidence/pr1-task-0-baseline.txt
  Expected: Contains a line matching "Test Suites:" with a total count
  Evidence: evidence/pr1-task-0-baseline.txt
```

**Commit:** NO — evidence is gitignored.

---

### PR1-T1: Model relaxation, landing first (C6)

The old plan put this in Wave 2 while three Wave-1 tasks needed it, so Wave 1 could not close. It
lands first here and everything else depends on it.

**This task is large and cannot be split.** Making `http` optional forces a compile error at every
unguarded dereference, and `tsconfig.json:8` sets `"strict": true`. Measured with
`grep -rc '\.http\.' src/bruno/<file>`:

| file | `.http.` sites |
|---|---|
| `request.ts` | 32 |
| `yaml-generator.ts` | 16 |
| `request-executor.ts` | 12 |
| `request-view.ts` | 11 |
| `bru-parser.ts` | 6 |
| `bru-to-yaml.ts` | 3 |
| `collection-stats.ts` | 2 |
| `auth-digest.ts` | 1 |
| **total** | **83** |

Plus sites that grep misses and `tsc` will not: optional-chained reads, the construction sites in
`bru-parser.ts:85-97`, and one **type-level** reference at `request-executor.ts:85`
(`function isMultipartBody(body: YamlRequest['http']['body'])`) which is a hard compile error rather
than a narrowing warning. Re-run the grep before starting; if the numbers have moved, the plan is
stale and says so.

The criterion "tsc clean" is only satisfiable if this task owns all of them, so it does — later tasks
refine *behaviour* in these files, but the compile fix lands here.

**Files:**
- Modify: `src/bruno/types.ts` — `BruMeta.type` (`:134-136`), `BruFile.http` (`:368-370`),
  `YamlInfo.type` (`:657-659`), `YamlRequest.http` (`:801-803`)
- Modify: `src/bruno/request.ts` — **32 sites**: `:126,127,128,129,133,135,140,141,144,145`
  (`loadRequest` `.yml` narrowing), `:195,196,198,201,205,209,212,213,218,219` (`updateRequestLocked`),
  `:568,575,580,585,586,609,626` (create path), `:721,725,757,765,768` (`applyUpdates`)
- Modify: `src/bruno/yaml-generator.ts` — **17 sites**, including `:213` (`request.http.body`),
  **`:235`** (`request.http.headers.map`) and **`:244`** (`request.http.params`), which both run
  *before* the branch at `:258-282`
- Modify: `src/bruno/bru-parser.ts` — **13 sites**, including the cast at `:73` and the unconditional
  `http` synthesis at `:85-97`
- Modify: `src/bruno/request-executor.ts` — **12 sites**: `:85` (**type-level**:
  `function isMultipartBody(body: YamlRequest['http']['body'])` — a hard compile error, not a
  narrowing warning), `:128,129,133,159,180,181,219,240,245,514,1193,1194`
- Modify: `src/bruno/request-view.ts` — **11 sites**: `:187,194,203,204` (BruFile),
  `:255,272,287,288,289,291,292` (YamlRequest)
- Modify: `src/bruno/bru-to-yaml.ts` — `:131,132,136`
- Modify: `src/bruno/collection-stats.ts` — `:171,177`
- Modify: `src/bruno/auth-digest.ts` — `:52`
- Modify: `src/bruno/yaml-parser.ts` — `:436`
- Test: `tests/unit/bruno/request-kind-model.test.ts`

**Interfaces:**
- Produces: `RequestKind = 'http' | 'graphql' | 'grpc' | 'ws'`, the dialect token maps, and
  `http?` on both models — every consumer compiling against it.
- Consumes: nothing.

**What to do:** Introduce one internal kind union, keep the dialect tokens at the edges, make `http`
optional, and guard all 92 dereferences.

Three traps, each measured:

1. **`YamlInfo.type` is `'http' | 'graphql' | 'folder'` and `YamlInfo` is shared by `YamlRequest`
   (`:802`) *and* `YamlFolder` (`:822`).** `folder` is not a request kind, so `RequestKind` must not
   absorb it. Keep `YamlInfo.type` as `RequestKind | 'folder'` — the existing union is a *different
   set*, not a narrower one, and dropping `folder` breaks every `folder.yml`.
2. **`bru-parser.ts:85-97` synthesizes `http` unconditionally** — `method` from
   `toHttpMethod(undefined)`, `url: json.http?.url ?? ''`. Two consequences: a `.bru` gRPC request
   today runs as an empty-URL GET and fails SSRF validation with `status: 0` (so **`.bru` has no
   `PARSE_ERROR` to regress from** — see the framing note below), and if the synthesis survives, a
   `.bru` gRPC file carries both `http` and `grpc`, which PR1-T6 would then refuse. **Remove the
   synthesis for non-http kinds here.**
3. **`collection-stats.ts:171,177` sits inside `try { … } catch { continue; }`** (`:167-183`), so it
   will not throw — it will **silently drop every gRPC/WebSocket request from the stats**. Guarding it
   for tsc is not enough; count them.

**Must NOT do:** Do not synthesize a placeholder `http` block. Do not use a non-null assertion to
silence tsc — it compiles clean, preserves the bug, and no test can notice because `tsconfig.json`
excludes `tests/`. Do not let `RequestKind` contain `folder`. Do not leave `collection-stats.ts`
merely compiling.

- [ ] **Step 1: Write the failing test**

```typescript
import { parseBruRequest } from '../../../src/bruno/bru-parser';
import { generateYamlRequest } from '../../../src/bruno/yaml-generator';

describe('request kind model', () => {
  it('keeps the .bru ws token as the ws kind, not http', () => {
    const parsed = parseBruRequest('meta {\n  name: Socket\n  type: ws\n  seq: 1\n}\n\nws {\n  url: ws://localhost:8080\n}\n');
    expect(parsed.meta.type).toBe('ws');
  });

  it('does not fabricate an http block for a non-http kind', () => {
    const generated = generateYamlRequest({
      info: { name: 'Streamer', type: 'grpc', seq: 1 },
    } as never);
    expect(generated).not.toContain('http:');
    expect(generated).toContain('name: Streamer');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest tests/unit/bruno/request-kind-model.test.ts`
Expected: first test FAILS with received `"http"` (the cast at `bru-parser.ts:73` flattens it);
second test FAILS with a `TypeError` reading `body` of undefined at `yaml-generator.ts:213`.

- [ ] **Step 3: Add the kind union and token maps**

In `src/bruno/types.ts`, above `BruMeta`:

```typescript
/**
 * The four request kinds this server understands, in one internal vocabulary.
 *
 * The two on-disk dialects disagree on the token for the same kind — `.bru`
 * writes `ws`, `.yml` writes `websocket` — so the token stays at the parse and
 * generate boundaries and everything in between speaks this union.
 */
export type RequestKind = 'http' | 'graphql' | 'grpc' | 'ws';

/** `.bru` `meta.type` tokens, which are the kind names themselves. */
export const BRU_TYPE_TOKENS: Record<string, RequestKind> = {
  http: 'http',
  graphql: 'graphql',
  grpc: 'grpc',
  ws: 'ws',
};

/** `.yml` `info.type` tokens, which spell WebSocket out. */
export const YAML_TYPE_TOKENS: Record<string, RequestKind> = {
  http: 'http',
  graphql: 'graphql',
  grpc: 'grpc',
  websocket: 'ws',
};

/** The `.yml` token for a kind, for the writer. */
export const YAML_TOKEN_FOR_KIND: Record<RequestKind, string> = {
  http: 'http',
  graphql: 'graphql',
  grpc: 'grpc',
  ws: 'websocket',
};
```

- [ ] **Step 4: Widen the two type fields and make `http` optional**

`BruMeta.type` becomes `RequestKind`. `YamlInfo.type` becomes `RequestKind | undefined` where it is
currently the narrower union. `BruFile.http` and `YamlRequest.http` become `http?:`, each with a
comment saying a non-http kind carries its target in its own block instead.

- [ ] **Step 5: Guard the generator — all three dereference points, not one**

At `yaml-generator.ts:213`, `isGraphqlRequest(request.info.type, request.http?.body)`. Then guard
**`:235`** (`request.http.headers.map`) and **`:244`** (`request.http.params`), both of which run
*before* the branch at `:258-282` — guarding only `:213` and `:258-282` leaves two TypeErrors standing.
Replace the unconditional `doc.http = http` else-branch with a three-way: graphql, http, or neither,
where "neither" writes no target block and leaves the kind's own block to PR1-T5.

- [ ] **Step 6: Fix the parser cast and remove the synthesis**

`bru-parser.ts:73` becomes a lookup through `BRU_TYPE_TOKENS`. An **unrecognised** token is *not*
silently degraded to http — it is reported as malformed, which is what PR1-T6 requires; degrading it
here and refusing it there would be a direct contradiction inside one merge unit. Then remove the
unconditional `http` synthesis at `:85-97` for non-http kinds.

- [ ] **Step 7: Count, do not merely compile, in `collection-stats.ts`**

`:167-183` swallows errors with `catch { continue; }`, so a gRPC request would vanish from the stats
rather than throw. Make the new kinds counted.

- [ ] **Step 8: Run the tests**

Run: `npx jest && npx tsc --noEmit`
Expected: PASS, tsc clean, suite count at or above PR1-T0's.

- [ ] **Step 9: Prove no non-null assertion crept in**

The narrow `http!` grep from the previous version of this plan was itself vacuous — it misses
`request.http!.body`, `req.http!` and `yamlReq.http!`. Use, and note `-E`:

```bash
git diff -U0 -- src/ | grep -nE '^\+.*\.http!' || echo "clean"
git diff -U0 -- src/ | grep -nE '^\+.*istanbul ignore' || echo "clean"
```
Expected: `clean` twice.

**Acceptance Criteria:**
- [ ] `parseBruRequest` on a `type: ws` file yields `meta.type === 'ws'`.
- [ ] A `.bru` gRPC file no longer carries a synthesized `http` block.
- [ ] `generateYamlRequest` on a kind with no `http` emits no `http:` key and does not throw — asserted
      via a **real parse**, not an `as never` cast, because `tsconfig.json` excludes `tests/` so a cast
      is never type-checked and the test would assert nothing.
- [ ] An unrecognised type token is reported as malformed (consistent with PR1-T6).
- [ ] `folder.yml` still parses — `YamlInfo.type` retains `folder`.
- [ ] `get_collection_stats` counts a gRPC and a WebSocket request rather than dropping them.
- [ ] Neither `grep -nE` in Step 9 matches.
- [ ] `npx tsc --noEmit` clean; suite count at or above PR1-T0.

**QA Scenarios:**
```
Scenario: Token asymmetry survives a round trip through the kind union
  Tool: bash
  Steps: Map 'ws' via BRU_TYPE_TOKENS and 'websocket' via YAML_TYPE_TOKENS; assert both are 'ws';
         map 'ws' back via YAML_TOKEN_FOR_KIND
  Expected: 'websocket'
  Evidence: evidence/pr1-task-1-tokens.txt

Scenario: Folders did not become collateral damage
  Tool: bash
  Steps: Parse an existing folder.yml fixture
  Expected: Parses; info.type is 'folder'
  Evidence: evidence/pr1-task-1-folder.txt

Scenario: The stats no longer hide the new kinds
  Tool: mcp__bruno-mcp__get_collection_stats
  Steps: Stats on a collection holding one HTTP, one gRPC and one WebSocket request
  Expected: Three counted, broken down by kind
  Evidence: evidence/pr1-task-1-stats.txt
```

**Commit:** YES | `refactor(model): one request-kind union, optional http block` |
Files: `src/bruno/types.ts`, `src/bruno/yaml-generator.ts`, `src/bruno/bru-parser.ts`,
`tests/unit/bruno/request-kind-model.test.ts`

---

## The dialect mapping table

**Measured** by round-tripping through the installed `@usebruno/lang` v2 and reading
`@usebruno/filestore`'s own readers — not inferred. Two earlier versions of this plan were rejected
because they asserted these shapes instead of measuring them, so treat every row as ground truth and
re-measure before changing one.

**The two kinds are not symmetric.** WebSocket carries its credentials in the ordinary `headers`
block; only gRPC has a `metadata` block. Only WebSocket messages carry a `type`.

| Concept | `.bru` | `.yml` |
|---|---|---|
| kind token | `meta.type: grpc` / `ws` | `info.type: grpc` / `websocket` |
| top-level keys present | grpc: `meta, grpc, metadata, body`<br>ws: `meta, ws, headers, body` | `info` plus `grpc` / `websocket` |
| target | `grpc.url` / `ws.url` | `grpc.url` / `websocket.url` |
| gRPC method | `grpc.method` | `grpc.method` |
| proto path | `grpc.protoPath` | `grpc.protoFilePath` — normalised to `protoPath`, exactly as `filestore/src/formats/yml/items/parseGrpcRequest.ts:46` does |
| method type | `grpc.methodType` (grpc only) | `grpc.methodType` |
| body-mode string | `grpc.body: grpc` / `ws.body: ws` — **a real field, must be carried** | not present |
| auth | `grpc.auth` / `ws.auth` — a **bare string** | an **object**; normalise to the mode string |
| credentials block | grpc: top-level `metadata[]`<br>ws: top-level **`headers[]`** | nested `grpc.metadata` / `websocket.headers` |
| `enabled` on those | **carried**, and `~name:` means `enabled: false` | `disabled` — opposite polarity |
| messages | `body.grpc[]` = `{name, content}`<br>`body.ws[]` = `{name, content, type}` | `grpc.message` (**singular**), variants `{title, message}`;<br>`websocket.message` with variants carrying `selected` |
| `selected` | **does not exist** | **only** on `.yml` websocket variants |

Five measured properties of the `.bru` layer that every task below must respect:

1. **`body:grpc` and `body:ws` are DICTIONARY blocks, not text blocks.** A fixture written as
   `body:grpc {\n  {"id":1}\n}` parses to `[{name: "", content: ""}]` — **content silently
   destroyed, no throw.** The real shape is `name:` / `content:` pairs. Any test asserting message
   content against the first form can never pass.
2. **Message count is the wrong metric.** `jsonToBru.js:617` writes `content || '{}'`, so two
   messages whose content was destroyed still round-trip as two blocks holding `{}`. Assert message
   **content**, never only the count.
3. **Repeated blocks concatenate** — `bruToJson.js` merges with a concat-arrays customiser, so two
   `body:grpc` blocks genuinely yield two entries.
4. **The whole block is gated on a truthy `url`** (`jsonToBru.js:62`, `:97`). An empty target drops
   the entire block while the sibling `metadata`/`headers` block survives — a half-authored request
   loses its target and keeps its credential. PR1-T5 refuses that write.
5. **The writer never returns the bytes it was given.** A correctly shaped fixture is *not*
   byte-identical after a round trip: single-line `content: {"id":1}` comes back wrapped in `'''`
   multiline delimiters, and `body:ws` keys are reordered to `name, type, content`. Block key order
   is also fixed (`grpc { url, method, body, protoPath, auth, methodType }`, `ws { url, body, auth }`).
   **Byte-identity is therefore not a usable criterion for these kinds at all** — not even against a
   Bruno-written fixture, unless that fixture already uses the triple-quote form. Every criterion in
   this plan asserts semantic key presence and message content instead.

Dropping `enabled` would silently **re-arm a disabled credential header** on the next write; dropping
`type` would send a binary WebSocket message as text. Both are carried.

---

### PR1-T2: `.yml` parse — stop refusing, start modelling

**Files:**
- Modify: `src/bruno/yaml-parser.ts:435-451` (the block-presence dispatch and the throw)
- Modify: `src/bruno/types.ts` (add `YamlGrpc` and `YamlWebsocket`, and the `grpc?` / `websocket?`
  fields on `YamlRequest`)
- Modify: `src/bruno/extra-keys.ts` (`YAML_REQUEST_KEYS` gains `grpc` and `websocket`, so they stop
  being swept into `extra` now that they are modelled)
- Test: `tests/unit/bruno/yaml-parser-grpc-ws.test.ts`

**Interfaces:**
- Consumes: `RequestKind`, `YAML_TYPE_TOKENS` from PR1-T1.
- Produces: `YamlRequest.grpc?: YamlGrpc` and `YamlRequest.websocket?: YamlWebsocket`, normalised —
  `protoFilePath` is read from disk but stored as `protoPath`, matching what
  `@usebruno/filestore/src/formats/yml/items/parseGrpcRequest.ts:46` does.

**What to do:** `yaml-parser.ts:435-451` currently keys entirely on block presence and throws
`'Missing required "http" section in request (or "graphql" for a graphql request)'` when neither is
found. Extend the dispatch to the `grpc` and `websocket` blocks, parsing each into its modelled
shape. Read `info.type` as well as block presence, and make the two **mutually consistent** —
see PR1-T6, which owns the mismatch rule.

**Must NOT do:** Do not leave `grpc`/`websocket` in the `extra` bag once they are modelled — they
would then be written twice, once from the model and once spread back from `extra`. Do not
invent fields the dialect does not have. Do not accept a document that has both a kind token and a
contradicting block; that is PR1-T6's refusal, and this task must not silently prefer one.

- [ ] **Step 1: Write the failing test**

```typescript
import { parseYamlRequest } from '../../../src/bruno/yaml-parser';

const GRPC = `info:
  name: Streamer
  type: grpc
  seq: 1
grpc:
  url: grpc://localhost:50051
  method: /pkg.Svc/Method
  protoFilePath: ./svc.proto
  metadata:
    - name: authorization
      value: Bearer x
`;

describe('parseYamlRequest for the new kinds', () => {
  it('parses a grpc request and normalises protoFilePath to protoPath', () => {
    const parsed = parseYamlRequest(GRPC);
    expect(parsed.info.type).toBe('grpc');
    expect(parsed.grpc?.url).toBe('grpc://localhost:50051');
    expect(parsed.grpc?.protoPath).toBe('./svc.proto');
    expect(parsed.grpc?.metadata).toEqual([{ name: 'authorization', value: 'Bearer x' }]);
  });

  it('does not also leave grpc in the extra passthrough bag', () => {
    expect((parseYamlRequest(GRPC).extra ?? {})).not.toHaveProperty('grpc');
  });

  it('parses a websocket request under the websocket token', () => {
    const parsed = parseYamlRequest('info:\n  name: Socket\n  type: websocket\n  seq: 1\nwebsocket:\n  url: ws://localhost:8080\n');
    expect(parsed.info.type).toBe('ws');
    expect(parsed.websocket?.url).toBe('ws://localhost:8080');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest tests/unit/bruno/yaml-parser-grpc-ws.test.ts`
Expected: all three FAIL — the first two with the thrown `Missing required "http" section`, the third
the same.

- [ ] **Step 3: Add the two modelled shapes to `types.ts`**

```typescript
/**
 * A gRPC request's own target block.
 *
 * `protoPath` is this model's name for it in both dialects; `.yml` spells the
 * key `protoFilePath` on disk and the parser normalises it, exactly as
 * upstream's own reader does.
 */
export interface YamlGrpc {
  url: string;
  method?: string;
  protoPath?: string;
  methodType?: string;
  /** A bare mode string in `.bru`, an object in `.yml`; normalised to the mode. */
  auth?: string;
  metadata?: YamlNameValue[];
  /** One entry per message. Unary refuses more than one selected message. */
  messages?: YamlRequestMessage[];
}
```

`YamlWebsocket` is the same minus `method`, `protoPath` and `methodType`, with `headers` in place of
`metadata`. `YamlRequestMessage` carries `{ name?: string; content?: string; selected?: boolean }`
so the `selected` flag PR2 needs is captured now rather than retrofitted.

- [ ] **Step 4: Extend the parser dispatch**

Add `grpc` and `websocket` branches beside the existing `http`/`graphql` ones. Each maps its block
through the table above. Keep the throw as the final fallback for a document with no recognised
target block at all — that case is still a genuine `PARSE_ERROR`.

- [ ] **Step 5: Do NOT remove the passthrough yet — it moves to PR1-T5**

The obvious move here is to add `'grpc'` and `'websocket'` to `YAML_REQUEST_KEYS` in `extra-keys.ts`
so `collectExtraKeys` stops sweeping them into `extra`. **Do not do it in this task.** That list is
what currently makes `.yml` round-trip these blocks losslessly, re-emitted by `withCarriedBlocks`
(`yaml-generator.ts:352`, `:367-384`). Removing it here — before PR1-T5 adds the writer — means every
commit in between regenerates a `.yml` gRPC file **with its block deleted**: a data-loss window this
PR would have opened itself, in the one dialect that has no loss today.

So in this task the blocks are read into the model **and** left in `extra`, which is redundant but
safe. PR1-T5 removes the redundancy in the same commit that adds the writer.

Add a test asserting the redundancy is deliberate, so nobody "tidies" it early:

```typescript
it('still carries grpc in extra until the writer exists (removed in PR1-T5)', () => {
  const parsed = parseYamlRequest(GRPC);
  expect(parsed.grpc?.url).toBe('grpc://localhost:50051');
  expect(parsed.extra).toHaveProperty('grpc'); // deliberate: see PR1-T5
});
```

- [ ] **Step 6: Run the tests**

Run: `npx jest tests/unit/bruno/yaml-parser-grpc-ws.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

**Acceptance Criteria:**
- [ ] A `.yml` gRPC request parses with `grpc.url`, `grpc.method` and `grpc.metadata` present.
- [ ] `protoFilePath` on disk arrives as `protoPath` on the model.
- [ ] A `.yml` WebSocket request under the `websocket` token yields kind `ws`.
- [ ] Both blocks are **still** present in `extra` as well, deliberately, with a test saying so —
      the passthrough is not removed until PR1-T5 adds the writer that replaces it.
- [ ] A document with no target block at all still throws `PARSE_ERROR`.
- [ ] A `.yml` websocket variant preserves `selected: false`. (gRPC has no `selected` in either
      dialect — do not assert one.)
- [ ] `.yml` websocket messages are read from **`websocket.message`** (singular, with variants), not a
      `messages` array, and `.yml` gRPC from `grpc.message`.

**QA Scenarios:**
```
Scenario: Every .yml block key in the mapping table survives a parse
  Tool: bash
  Steps: Parse a .yml grpc fixture carrying url, method, protoFilePath, methodType, auth, metadata,
         message; assert each landed on the model under its normalised name
  Expected: All seven present, protoFilePath renamed to protoPath
  Evidence: evidence/pr1-task-2-yml-keys.txt

Scenario: A document with neither http nor a kind block still fails loudly
  Tool: bash
  Steps: parseYamlRequest on a document with only an info block
  Expected: throws with code PARSE_ERROR
  Evidence: evidence/pr1-task-2-no-block.txt
```

**Commit:** YES | `feat(yml): parse grpc and websocket requests instead of refusing them` |
Files: `src/bruno/yaml-parser.ts`, `src/bruno/types.ts`, `src/bruno/extra-keys.ts`,
`tests/unit/bruno/yaml-parser-grpc-ws.test.ts`

---

### PR1-T3: `.bru` parse — capture the blocks *and* the messages (C3a, C3c)

The review found this broken at two points the old plan did not own: `BruFile` has **no** `extra`
field at all (the old plan's citation `types.ts:811-818` is inside `YamlRequest`, the wrong model),
and the message payload is nested at `body.grpc`, which the body dispatch discards entirely.

**Files:**
- Modify: `src/bruno/types.ts:368-399` (`BruFile` gains `extra?`, `grpc?`, `ws?`, `metadata?`)
- Modify: `src/bruno/bru-parser.ts:60-130` (capture the blocks), `:130-171` (capture `body.grpc`)
- Test: `tests/unit/bruno/bru-parser-grpc-ws.test.ts`

**Interfaces:**
- Consumes: `RequestKind`, `BRU_TYPE_TOKENS` from PR1-T1.
- Produces: `BruFile.grpc`, `BruFile.ws`, `BruFile.metadata`, `BruFile.extra`, and messages on
  `BruFile.grpc.messages` / `BruFile.ws.messages`.

**What to do:** Add the three modelled blocks to `BruFile` plus an `extra` bag for genuinely unknown
top-level keys. In `parseBruRequest`, read `json.grpc`, `json.ws` and `json.metadata`. Separately, in
the body dispatch at `:136-167`, recognise `json.body.grpc` and `json.body.ws` — both **arrays**,
concatenated across repeated blocks — and route them to the kind's `messages` instead of letting them
fall through every branch to be dropped.

**Must NOT do:** Do not put the modelled blocks in `extra`. Do not restrict `extra` to an
open-ended sweep: enumerate the re-emittable top-level keys against `bruToJson.js`'s own set, because
`jsonToBruV2` **drops** unrecognised top-level blocks outright, so a bag that collects them would
advertise preservation it cannot deliver. Warn on a key that cannot be re-emitted rather than
silently carrying it.

- [ ] **Step 1: Write the failing test**

```typescript
import { parseBruRequest } from '../../../src/bruno/bru-parser';

// `body:grpc` is a DICTIONARY block: `name:` / `content:` pairs. Written as a bare
// text block it parses to [{name:'', content:''}] with the content silently
// destroyed and no error, so this fixture shape is load-bearing.
const GRPC = `meta {
  name: Streamer
  type: grpc
  seq: 1
}

grpc {
  url: grpc://localhost:50051
  method: /pkg.Svc/Method
  body: grpc
  protoPath: ./svc.proto
  methodType: unary
}

metadata {
  authorization: Bearer live
  ~x-disabled: nope
}

body:grpc {
  name: message 1
  content: {"id":1}
}
`;

describe('parseBruRequest for the new kinds', () => {
  it('captures the grpc block including the body-mode string', () => {
    const parsed = parseBruRequest(GRPC);
    expect(parsed.grpc?.url).toBe('grpc://localhost:50051');
    expect(parsed.grpc?.protoPath).toBe('./svc.proto');
    expect(parsed.grpc?.methodType).toBe('unary');
    expect(parsed.grpc?.body).toBe('grpc');
  });

  it('keeps the enabled flag, so a disabled credential stays disabled', () => {
    expect(parseBruRequest(GRPC).metadata).toEqual([
      { name: 'authorization', value: 'Bearer live', enabled: true },
      { name: 'x-disabled', value: 'nope', enabled: false },
    ]);
  });

  it('captures message CONTENT, not just a count', () => {
    const messages = parseBruRequest(GRPC).grpc?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0].name).toBe('message 1');
    expect(messages[0].content).toContain('"id":1');
  });

  it('captures a ws message type, which a text-only model would lose', () => {
    const ws = parseBruRequest('meta {\n  name: S\n  type: ws\n  seq: 1\n}\n\nws {\n  url: ws://h:1\n  body: ws\n}\n\nheaders {\n  authorization: Bearer live\n}\n\nbody:ws {\n  name: hello\n  content: {"a":1}\n  type: text\n}\n');
    expect(ws.ws?.messages?.[0].type).toBe('text');
    expect(ws.headersList?.[0].name).toBe('authorization');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest tests/unit/bruno/bru-parser-grpc-ws.test.ts`
Expected: all three FAIL — the first two because the fields do not exist on the type, the third
because `body.grpc` falls through `multipartForm`/`graphql`/`formUrlEncoded`/`file`/`content` and is
dropped. This third failure is the data loss, reproduced.

- [ ] **Step 3: Extend `BruFile`**

```typescript
  /**
   * Top-level blocks this model does not name, carried through a write.
   *
   * `jsonToBruV2` destructures a fixed top-level set and drops anything else,
   * so this bag is restricted to keys it can actually re-emit. After the blocks
   * below are modelled, the only unmodelled member of that set is `examples`.
   */
  extra?: Record<string, unknown>;
  /** Present for kind `grpc`; carries the target the http block would hold. */
  grpc?: BruGrpc;
  /** Present for kind `ws`. WebSocket headers live in `headersList`, not here. */
  ws?: BruWs;
  /** gRPC only. WebSocket uses the ordinary `headers` block instead. */
  metadata?: BruHeader[];
```

- [ ] **Step 4: Capture the blocks and the messages**

Read `json.grpc`, `json.ws` and `json.metadata`. **WebSocket headers are already handled** — they
arrive in the ordinary `headers` block and land in `BruFile.headersList`, so do not add a second path
for them. In the body dispatch, add `grpc` and `ws` as recognised modes whose payload is an array:
map gRPC entries to `{ name, content }` and WebSocket entries to `{ name, content, type }`. There is
no `selected` in this dialect — do not invent one.

- [ ] **Step 5: Pin the `extra` allowlist**

Enumerate the re-emittable top-level set from `jsonToBruV2`'s own destructure rather than guessing:
`{meta, http, grpc, ws, params, headers, metadata, auth, body, script, tests, vars, assertions,
settings, docs, examples}`. Everything modelled is excluded from the bag; the only member left for
`extra` is `examples`. A key outside the set warns rather than being carried, because carrying it
would promise preservation the writer cannot deliver.

- [ ] **Step 6: Run the tests**

Run: `npx jest tests/unit/bruno/bru-parser-grpc-ws.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

**Acceptance Criteria:**
- [ ] `BruFile` has an `extra` field restricted to the enumerated re-emittable set.
- [ ] A `.bru` gRPC file's `grpc` block, `metadata` block and `body:grpc` messages are all present,
      **including the `body: grpc` mode string and `methodType`**.
- [ ] A `.bru` WebSocket file's `ws` block and messages are present, **including each message's
      `type`**, and its headers arrive in `headersList` rather than a duplicate path.
- [ ] **Message content is asserted, not the count.** Two `body:grpc` blocks yield two messages whose
      contents are distinct and in file order. Count alone is unfalsifiable here: `jsonToBru.js:617`
      writes `content || '{}'`, so two content-destroyed messages still round-trip as two blocks.
- [ ] `enabled: false` survives on a `~`-prefixed metadata entry, so a disabled credential header is
      not re-armed.
- [ ] A top-level key outside the enumerated set warns and is not placed in `extra`.

**QA Scenarios:**
```
Scenario: Message content survives, which is what count could not prove
  Tool: bash
  Steps: Parse a .bru grpc file with two name/content body:grpc blocks
  Expected: Two messages; contents '{"id":1}' and '{"id":2}' distinct and ordered
  Evidence: evidence/pr1-task-3-message-content.txt

Scenario: The bare-text fixture form is rejected as a test, not accepted as data
  Tool: bash
  Steps: Parse `body:grpc {\n  {"id":1}\n}` and inspect the result
  Expected: [{name:'', content:''}] — documented in a test comment as the reason the fixture shape
            is name/content, so a future author cannot reintroduce the silent-loss form
  Evidence: evidence/pr1-task-3-dict-block-proof.txt

Scenario: A disabled credential stays disabled
  Tool: bash
  Steps: Parse a metadata block containing `~authorization: Bearer live`
  Expected: enabled false
  Evidence: evidence/pr1-task-3-enabled-polarity.txt
```

**Commit:** YES | `fix(bru): capture grpc, ws, metadata blocks and their messages` |
Files: `src/bruno/types.ts`, `src/bruno/bru-parser.ts`,
`tests/unit/bruno/bru-parser-grpc-ws.test.ts`

---

### PR1-T4: Propagate into the run model (C2, C3b)

`request-discovery.ts:209` funnels `.bru` through `bruFileToYamlRequest`, so anything that function
does not carry is invisible to every consumer downstream — which is why capturing the blocks in
PR1-T3 is necessary but not sufficient. This task is where the mapping table becomes code.

**Files:**
- Modify: `src/bruno/bru-to-yaml.ts:33-160` (`bruFileToYamlRequest`)
- Test: `tests/unit/bruno/bru-to-yaml-grpc-ws.test.ts`

**Interfaces:**
- Consumes: `BruFile.grpc` / `.ws` / `.metadata` / `.extra` from PR1-T3; `YamlGrpc` /
  `YamlWebsocket` from PR1-T2; the token maps from PR1-T1.
- Produces: a `YamlRequest` carrying `grpc?` / `websocket?` identically regardless of which dialect
  it came from. **This is the contract every PR 2 task builds on.**

**What to do:** Map `BruFile.grpc` to `YamlRequest.grpc`, `BruFile.ws` to `YamlRequest.websocket`,
and `BruFile.metadata` to `YamlRequest.grpc.metadata` — note the shape change, from a separate
top-level block to a nested field. Carry `BruFile.extra` through. Translate the kind token via the
maps rather than string literals.

Mind the polarity conventions this file already documents at `:45-59` and `:61-62`: a `BruHeader`
carries `enabled`, a `YamlParam` carries `disabled`. Messages have the same trap with `selected` —
decide it once here and comment it, because a message the author switched off must not be sent.

**Must NOT do:** Do not let the `.bru` bare-string auth reach a consumer expecting the `.yml` object
shape, or the reverse. Normalise to the mode string, which is what `applyAuth` compares against by
identity at `auth-apply.ts:58` — an object-shaped `{type:'inherit'}` falls through its switch to
`default:` and warns while sending nothing, which is the silent-inertness class this project has
already been bitten by. Do not synthesize an `http` block for the new kinds.

- [ ] **Step 1: Write the failing test**

```typescript
import { parseBruRequest } from '../../../src/bruno/bru-parser';
import { bruFileToYamlRequest } from '../../../src/bruno/bru-to-yaml';
import { parseYamlRequest } from '../../../src/bruno/yaml-parser';

// Both fixtures use each dialect's real shape: name/content dictionary pairs in
// `.bru`, a singular `message` in `.yml`. The `enabled` flag is asserted because
// dropping it re-arms a disabled credential header on the next write.
const BRU = `meta {\n  name: Streamer\n  type: grpc\n  seq: 1\n}\n\ngrpc {\n  url: grpc://localhost:50051\n  method: /pkg.Svc/Method\n  body: grpc\n  protoPath: ./svc.proto\n}\n\nmetadata {\n  authorization: Bearer live\n  ~x-disabled: nope\n}\n\nbody:grpc {\n  name: message 1\n  content: {"id":1}\n}\n`;

const YML = `info:\n  name: Streamer\n  type: grpc\n  seq: 1\ngrpc:\n  url: grpc://localhost:50051\n  method: /pkg.Svc/Method\n  protoFilePath: ./svc.proto\n  metadata:\n    - name: authorization\n      value: Bearer live\n    - name: x-disabled\n      value: nope\n      disabled: true\n  message: '{"id":1}'\n`;

describe('both dialects reach one run model', () => {
  it('carries the grpc block, its metadata and its message content through the funnel', () => {
    const model = bruFileToYamlRequest(parseBruRequest(BRU));
    expect(model.grpc?.url).toBe('grpc://localhost:50051');
    expect(model.grpc?.protoPath).toBe('./svc.proto');
    expect(model.grpc?.messages?.[0].content).toContain('"id":1');
  });

  it('preserves the disabled flag across the polarity flip', () => {
    const model = bruFileToYamlRequest(parseBruRequest(BRU));
    // `.bru` says enabled:true/false; the yaml model says disabled:true/absent.
    expect(model.grpc?.metadata).toEqual([
      { name: 'authorization', value: 'Bearer live' },
      { name: 'x-disabled', value: 'nope', disabled: true },
    ]);
  });

  it('agrees with the .yml path on every field in the mapping table', () => {
    const fromBru = bruFileToYamlRequest(parseBruRequest(BRU));
    const fromYml = parseYamlRequest(YML);
    expect(fromBru.grpc?.url).toBe(fromYml.grpc?.url);
    expect(fromBru.grpc?.protoPath).toBe(fromYml.grpc?.protoPath);
    expect(fromBru.grpc?.metadata).toEqual(fromYml.grpc?.metadata);
    expect(fromBru.grpc?.messages?.[0].content).toBe(fromYml.grpc?.messages?.[0].content);
    expect(fromBru.info.type).toBe(fromYml.info.type);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest tests/unit/bruno/bru-to-yaml-grpc-ws.test.ts`
Expected: both FAIL — `model.grpc` is `undefined`, because the funnel drops it.

- [ ] **Step 3: Implement the mapping**

Follow the table. Comment the two shape changes — the top-level `metadata` block becoming nested, and
the auth normalisation — with the reason, because a later reader looking only at one dialect cannot
otherwise tell the rename is deliberate.

- [ ] **Step 4: Run the tests**

Run: `npx jest tests/unit/bruno/bru-to-yaml-grpc-ws.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

**Acceptance Criteria:**
- [ ] A `.bru` gRPC request's target, proto path, metadata and message **content** are all present on
      the run model.
- [ ] **The two dialects agree field-by-field on the shared field set** — target, method, `protoPath`,
      `methodType`, metadata (including the disabled flag) and message content. This is what makes
      every PR 2 acceptance criterion dialect-agnostic.
      **Not a whole-object deep-equal:** `grpc.body` / `ws.body` (the mode string) exists only in
      `.bru`, so an object-level comparison can never pass. Compare the shared set explicitly.
- [ ] A `.bru` WebSocket request's target and messages are present as `websocket`, with each message's
      `type` preserved, and its headers arriving from `headersList`.
- [ ] Auth arrives as a mode string from both dialects, never as an object from one of them — the
      value `applyAuth` compares by identity at `auth-apply.ts:58`.
- [ ] The `enabled`/`disabled` polarity flip is applied deliberately and commented, so a disabled
      credential header is neither dropped nor re-armed.
- [ ] `selected` is carried **only** where a dialect actually has it — `.yml` websocket variants.
      Neither dialect gives gRPC a `selected`, so nothing downstream may require one for gRPC.
- [ ] `extra` survives the funnel.

**QA Scenarios:**
```
Scenario: Dialect parity, field by field
  Tool: bash
  Steps: Build equivalent .bru and .yml gRPC fixtures; run both through their parse path; deep-equal
         the resulting grpc objects
  Expected: Equal, including metadata and message content
  Evidence: evidence/pr1-task-4-dialect-parity.txt

Scenario: Auth normalisation defeats the inherit-by-identity trap
  Tool: bash
  Steps: Give the .yml fixture `auth: {type: inherit}` and the .bru fixture `auth: inherit`; compare
         the normalised value each produces
  Expected: Both the string 'inherit', which is what auth-apply.ts:58 compares against
  Evidence: evidence/pr1-task-4-auth-normalised.txt
```

**Commit:** YES | `fix(bru): carry grpc and websocket blocks into the run model` |
Files: `src/bruno/bru-to-yaml.ts`, `tests/unit/bruno/bru-to-yaml-grpc-ws.test.ts`

---

### PR1-T5: Write both dialects back without destroying anything

**Files:**
- Modify: `src/bruno/bru-parser.ts:460+` (`generateBruRequest`)
- Modify: `src/bruno/yaml-generator.ts` (emit the new blocks; `withCarriedBlocks` insertion order)
- Test: `tests/unit/bruno/round-trip-grpc-ws.test.ts`,
  `tests/unit/bruno/write-refusal-empty-target.test.ts`

**Interfaces:**
- Consumes: everything PR1-T2, PR1-T3 and PR1-T4 produce.
- Produces: a writer that round-trips both kinds in both dialects, and a named refusal for the one
  case that cannot be written without loss.

**What to do:** Emit the `grpc` / `ws` / `metadata` blocks in `.bru` and the `grpc` / `websocket`
blocks in `.yml`. Stop fabricating an empty `GET` http block for a non-http kind — `jsonToBru.js:42`
already emits the http block only `if (http?.method)`, so passing no method through is enough on the
`.bru` side.

Then handle the destructive case explicitly. `jsonToBru.js:62` and `:97` gate the whole block on a
truthy `url`, so a request whose target is empty — **the most common authoring state, a URL not yet
filled in** — loses its entire block including credentials, while the separate `metadata` block
survives. Do not perform that write: refuse it with a named error saying the target is empty and the
write would drop the block.

**Must NOT do:** Do not assert byte-identity anywhere in this task. Measured: even a correctly shaped,
correctly ordered fixture does not come back unchanged — the writer rewrites single-line `content:`
into `'''` multiline form and reorders `body:ws` keys to `name, type, content`, on top of the fixed
block key orders (`grpc { url, method, body, protoPath, auth, methodType }`, `ws { url, body, auth }`).
Assert by re-parsing and comparing the model. This is the project's own recorded trap — "read the
bytes, not the round-trip" — and the previous two versions of this plan both fell into it by assuming a
Bruno-written fixture would be safe. It is not.

- [ ] **Step 1: Write the failing tests**

```typescript
import { parseBruRequest, generateBruRequest } from '../../../src/bruno/bru-parser';

describe('round trip for the new kinds', () => {
  it('does not fabricate an http block for a grpc request', () => {
    const src = 'meta {\n  name: Streamer\n  type: grpc\n  seq: 1\n}\n\ngrpc {\n  url: grpc://localhost:50051\n  method: /pkg.Svc/Method\n}\n';
    const out = generateBruRequest(parseBruRequest(src));
    expect(out).not.toContain('get {');
    expect(out).not.toContain('http {');
    expect(out).toContain('grpc {');
    expect(out).toContain('grpc://localhost:50051');
  });

  // Content, not count. `jsonToBru.js:617` writes `content || '{}'`, so two
  // content-destroyed messages still round-trip as two blocks — a count
  // assertion passes on total data loss.
  it('keeps message CONTENT across a round trip', () => {
    const src = 'meta {\n  name: S\n  type: grpc\n  seq: 1\n}\n\ngrpc {\n  url: grpc://h:1\n}\n\nbody:grpc {\n  name: m1\n  content: {"a":1}\n}\n\nbody:grpc {\n  name: m2\n  content: {"b":2}\n}\n';
    const reparsed = parseBruRequest(generateBruRequest(parseBruRequest(src)));
    const messages = reparsed.grpc?.messages ?? [];
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain('"a":1');
    expect(messages[1].content).toContain('"b":2');
    expect(messages.map((m) => m.name)).toEqual(['m1', 'm2']);
  });

  it('keeps a disabled metadata entry disabled across a round trip', () => {
    const src = 'meta {\n  name: S\n  type: grpc\n  seq: 1\n}\n\ngrpc {\n  url: grpc://h:1\n}\n\nmetadata {\n  ~authorization: Bearer live\n}\n';
    const out = generateBruRequest(parseBruRequest(src));
    expect(out).toContain('~authorization');
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx jest tests/unit/bruno/round-trip-grpc-ws.test.ts`
Expected: FAIL — a `get {` block appears, `grpc {` does not, message blocks are gone, and the third
test does not throw but silently drops the block.

- [ ] **Step 3: Emit the blocks in both writers**

`.bru`: pass the modelled blocks through to `jsonToBruV2`. `.yml`: emit `grpc:` / `websocket:` and
place them where upstream's stringifier does — `info, grpc, runtime, docs`. `withCarriedBlocks`
currently splices carried blocks ahead of `docs` or appends at the end, which puts a Bruno-written
file's keys in a different order after a round trip, so give the new blocks an explicit insertion
position rather than relying on that.

- [ ] **Step 4: Add the empty-target refusal, and decide where it surfaces**

`generateBruRequest` raises a `BrunoError` naming the request and stating the target is empty, before
any bytes are produced. **`updateRequestLocked` catches it and returns a refusal result** — Success
Criterion 3 says no tool call throws, so the throw must not escape the tool boundary. The generator
throwing is an internal contract; `modify_request` returning a named refusal is the external one.
State both in the test names so the distinction is not lost.

- [ ] **Step 5: Remove the `.yml` passthrough redundancy — now, in this commit**

Add `'grpc'` and `'websocket'` to `YAML_REQUEST_KEYS` in `extra-keys.ts` and delete the deliberate
redundancy PR1-T2 left in place. Doing it here means no commit ever exists in which a `.yml` file
parses these blocks into the model while nothing can write them back.

- [ ] **Step 6: Run the tests**

Run: `npx jest tests/unit/bruno/round-trip-grpc-ws.test.ts tests/unit/bruno/write-refusal-empty-target.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

**Acceptance Criteria:**
- [ ] A `.bru` gRPC request round-trips with its `grpc` block, `metadata` (including the `~` disabled
      prefix), every message's **content and name**, and no fabricated `get`/`http` block.
- [ ] A `.bru` WebSocket request round-trips with its `ws` block, its `headers`, and each message's
      `type`.
- [ ] The `.yml` side round-trips both kinds, with `protoPath` written back as `protoFilePath`.
- [ ] **Message content and order** are asserted across the round trip in both dialects. Count alone
      is not an acceptable assertion anywhere in this task.
- [ ] `generateBruRequest` on an empty target throws `BrunoError`; `modify_request` on the same request
      **returns a named refusal and does not throw**; the file is byte-unchanged (sha256).
- [ ] After this commit, `parseYamlRequest` no longer leaves `grpc`/`websocket` in `extra`, and the
      PR1-T2 test asserting the redundancy is updated in the same commit.
- [ ] **No byte-identity criterion.** Measured: the writer does not return the bytes it was given for
      these kinds — single-line `content:` comes back wrapped in `'''` delimiters and `body:ws` keys are
      reordered to `name, type, content`. A round trip is asserted by re-parsing and comparing the
      **model**, never by comparing bytes.

**QA Scenarios:**
```
Scenario: The live defect, reproduced then fixed
  Tool: bash
  Steps: Take a .bru gRPC request; run it through parse then generate; diff against the original
  Expected: Target, metadata and messages all present; before this task they were absent
  Evidence: evidence/pr1-task-5-round-trip.txt

Scenario: An empty target refuses rather than deleting credentials
  Tool: bash
  Steps: parse+generate a grpc file with an empty url and a metadata block carrying a bearer token
  Expected: throws naming the empty target; no output written; the token is not silently orphaned
  Evidence: evidence/pr1-task-5-empty-target.txt
```

**Commit:** YES | `fix(write): round-trip grpc and websocket requests in both dialects` |
Files: `src/bruno/bru-parser.ts`, `src/bruno/yaml-generator.ts`, `tests/unit/bruno/*`

---

### PR1-T6: Kind and payload must agree

Without this, `info.type: grpc` plus an `http:` block is accepted, so `read_request` describes a
request by one signal while the executor dispatches on another — a collection can present as a
confined internal gRPC call and execute as arbitrary HTTP. Our own writer can now produce that shape,
which is what makes it worth a refusal rather than a warning.

**Files:**
- Modify: `src/bruno/yaml-parser.ts` (the dispatch from PR1-T2)
- Modify: `src/bruno/bru-parser.ts` (the same rule for `.bru`)
- Test: `tests/unit/bruno/kind-payload-agreement.test.ts`

**What to do:** After the target block is identified, require that it matches `info.type` /
`meta.type`. A mismatch is a `PARSE_ERROR` naming both the declared kind and the block found.
Restrict the accepted token sets to exactly `{http, graphql, grpc, websocket}` for `.yml` and
`{http, graphql, grpc, ws}` for `.bru`, so a typo'd type reports a malformed file rather than
degrading silently.

**Three exemptions, each mandatory — without them this task refuses valid files:**

1. **Folders.** `parseInfo` (`yaml-parser.ts:89`) serves both `parseYamlRequest` (`:445`) *and*
   `parseYamlFolder` (`:500`). Restricting tokens inside `parseInfo` would reject every `folder.yml`.
   Apply the token restriction at the **request** parse site, not in shared `parseInfo`, and keep
   `folder` valid for the folder path.
2. **graphql under `http:`.** `yaml-parser.ts:431-434` records that a graphql `.yml` request
   legitimately carries its payload in the `http:` block. A literal "type must match block name" check
   refuses those files and contradicts this task's own criterion that all four kinds still parse. The
   rule is: `graphql` may pair with `http` **or** `graphql`; every other kind must pair with its own
   block.
3. **`.bru` `http` synthesis must already be gone.** PR1-T1 Step 6 removes it. If it is still present,
   a `.bru` gRPC file carries both `http` and `grpc` and this check refuses every one of them. Verify
   PR1-T1 landed that step before starting here — it is a hard prerequisite, not a nicety.

**Must NOT do:** Do not prefer one signal over the other silently. Do not make this a warning — a
warning on a run is easy to miss, and this one changes which host is contacted. Do not put the token
restriction in shared `parseInfo`.

- [ ] **Step 1: Write the failing test**

```typescript
describe('kind and payload must agree', () => {
  it('refuses a grpc-typed .yml request carrying an http block', () => {
    expect(() => parseYamlRequest('info:\n  name: X\n  type: grpc\n  seq: 1\nhttp:\n  method: get\n  url: http://evil.example\n'))
      .toThrow(/declared grpc.*http/i);
  });

  it('refuses an http-typed request carrying a grpc block', () => {
    expect(() => parseYamlRequest('info:\n  name: X\n  type: http\n  seq: 1\ngrpc:\n  url: grpc://h:1\n'))
      .toThrow(/declared http.*grpc/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail** — both currently parse without complaint.

- [ ] **Step 3: Add the agreement check, then run the tests.**

**Acceptance Criteria:**
- [ ] A kind/payload mismatch throws `PARSE_ERROR` naming both sides, in both dialects.
- [ ] An unrecognised type token is reported as malformed, not degraded to a kind — consistent with
      PR1-T1 Step 6, which is where the same decision is made for the `.bru` parser.
- [ ] **`folder.yml` still parses.** The token restriction is not in shared `parseInfo`.
- [ ] **A graphql `.yml` request carrying its payload under `http:` still parses** — the documented
      legitimate pairing.
- [ ] A matching kind and payload parses for all four kinds in both dialects — eight fixtures.
- [ ] A `.bru` gRPC file is **not** refused, proving PR1-T1 removed the `http` synthesis.

**QA Scenarios:**
```
Scenario: The dispatch-divergence attack is refused
  Tool: bash
  Steps: Author a .yml request with type grpc and an http block pointing at a different host; parse it
  Expected: PARSE_ERROR naming the declared kind and the block found
  Evidence: evidence/pr1-task-6-mismatch.txt

Scenario: The three exemptions are not collateral damage
  Tool: bash
  Steps: Parse (a) an existing folder.yml, (b) a graphql .yml whose payload is under http:,
         (c) a .bru gRPC file
  Expected: All three parse; none refused
  Evidence: evidence/pr1-task-6-exemptions.txt

Scenario: All four legitimate kinds still parse
  Tool: bash
  Steps: Parse one valid fixture per kind per dialect — eight files
  Expected: All eight parse; none throws
  Evidence: evidence/pr1-task-6-no-over-refusal.txt
```

**Commit:** YES | `fix(parse): refuse a request whose kind and payload block disagree` |
Files: `src/bruno/yaml-parser.ts`, `src/bruno/bru-parser.ts`,
`tests/unit/bruno/kind-payload-agreement.test.ts`

---

### PR1-T7: Refuse at every tool boundary — the task that makes PR 1 mergeable

Two distinct throws, not one. The previous version of this task covered only the first:

1. **Run path.** Once these files parse, `executeSingleRequest` reaches `request-executor.ts:514`
   (`const method = yaml.http.method;`) and throws, plus `:128,129,133,159,180,181,219,240,245` and
   `crashedRequestResult` at `:1193-1194`. For `.yml` that turns a clean `PARSE_ERROR` into a
   `TypeError`; for `.bru` it replaces a status-0 SSRF failure with one.
2. **Write path — survives to PR 1's END state if unowned.** `request.ts:195-219`
   (`updateRequestLocked`, the `.yml` branch) has no kind guard: `:195` `yamlReq.http.method`, `:198`
   `yamlReq.http.headers`, `:201` body, `:205`/`:209` auth, `:212-213`/`:218-219` params. So
   `modify_request` with **any** of method/url/headers/body/query/pathParams on a `.yml` gRPC request
   TypeErrors. PR1-T1 makes that compile; only this task makes it *behave*. Without it, Success
   Criteria 1 and 3 both fail and verification V2/V3 cannot pass.

**Files:**
- Modify: `src/bruno/request-executor.ts` (per-kind dispatch before execution)
- Modify: `src/bruno/request.ts:195-219` (`updateRequestLocked` kind guard)
- Test: `tests/unit/bruno/execution-boundary-refusal.test.ts`,
  `tests/unit/bruno/modify-request-kind-refusal.test.ts`

**What to do:** Dispatch on kind at both boundaries.

*Run path:* `http` and `graphql` proceed unchanged. `grpc` and `ws` produce a refusal result — a named
reason, `status: 0`, exactly one failure, no `tests.total` contribution — until PR 2 replaces the
refusal with a transport.

*Write path:* an update targeting an HTTP-shaped field on a non-http kind **refuses with a named
reason** rather than touching `http`. Updates that are kind-agnostic — name, `seq`, docs, tags — still
apply, because refusing those would make these requests uneditable and reintroduce the defect from the
other side.

**Must NOT do:** Do not throw from either boundary. Do not skip a request silently — an agent reading
the result must see the refusal. Do not change the group result shape. Do not make the whole of
`modify_request` refuse for these kinds; only the HTTP-shaped fields.

- [ ] **Step 1: Write both failing tests** — a gRPC request in a run yields one failed result whose
      error names the kind and `run_collection` does not reject; and `modify_request` setting `method`
      on a `.yml` gRPC request refuses by name.
- [ ] **Step 2: Run them and watch them fail** with a `TypeError` from `request-executor.ts:514` and
      one from `request.ts:195` respectively. Record both messages — they are the proof that the
      interim state was unsafe, which is the justification for the single-merge-unit rule.
- [ ] **Step 3: Add both kind guards, then re-run.**

**Acceptance Criteria:**
- [ ] A gRPC request in a run produces one failed result naming the kind, and the run completes.
- [ ] A WebSocket request does the same.
- [ ] `tests.total` is unchanged by a refusal; failures increase by exactly one.
- [ ] `modify_request` setting any of method/url/headers/body/query/pathParams on a gRPC or WebSocket
      request refuses by name, **in both dialects**, and leaves the file byte-unchanged.
- [ ] `modify_request` setting a kind-agnostic field (name, `seq`, docs, tags) still succeeds on these
      kinds — they must remain editable.
- [ ] No tool call throws on either kind — asserted for `run_collection`, `read_request`,
      `list_requests` and `modify_request`, each with an explicit assertion that the call resolved.
      **`get_collection_stats` is excluded from the no-throw claim**: `collection-stats.ts:167-183`
      swallows everything with `catch { continue; }`, so it cannot throw regardless of what the code
      does. Its real criterion lives in PR1-T1 — that the new kinds are *counted*, not dropped.
- [ ] `request-executor.ts` stays under 1300 lines.

**QA Scenarios:**
```
Scenario: A mixed collection still runs its HTTP requests
  Tool: bash
  Steps: Run a collection holding two HTTP requests and one gRPC request
  Expected: Both HTTP requests execute; the gRPC one is one named failure; the run completes
  Evidence: evidence/pr1-task-7-mixed-run.txt

Scenario: modify_request cannot corrupt a gRPC request through the http path
  Tool: mcp__bruno-mcp__modify_request
  Steps: On a .yml and a .bru gRPC request, attempt to set method, then url, then headers
  Expected: Six named refusals, zero throws; both files byte-identical afterwards (sha256 compared)
  Evidence: evidence/pr1-task-7-modify-refusal.txt

Scenario: These requests are still editable
  Tool: mcp__bruno-mcp__modify_request
  Steps: Rename a gRPC request and change its seq
  Expected: Succeeds; target, metadata and messages unchanged
  Evidence: evidence/pr1-task-7-still-editable.txt
```

**Commit:** YES | `feat(run): refuse grpc and websocket at the execution boundary` |
Files: `src/bruno/request-executor.ts`, `tests/unit/bruno/execution-boundary-refusal.test.ts`

---

### PR1-T8: `read_request` must show the new kinds

Without this, Success Criterion 2 has no owner: after PR1-T2 a gRPC file parses, so `read_request`
stops erroring and instead returns a view with no method, no url and no gRPC information — a silently
wrong answer replacing a loud error, which is strictly worse for an agent.

**Files:**
- Modify: `src/bruno/request-view.ts:69` (`RequestView`), `:321` (`toRequestView`)
- Test: `tests/unit/bruno/request-view-grpc-ws.test.ts`

**Interfaces:**
- Consumes: the run model from PR1-T4.
- Produces: `RequestView.kind`, plus `RequestView.grpc?` and `RequestView.websocket?` summaries.

**What to do:** Add the kind to the view and a summary per new kind — target, method and proto path
for gRPC; target and message count for WebSocket. Redact nothing here that the HTTP view does not
already redact, but do route the target through the same redaction the HTTP view uses for its url, so
a `{{token}}` in userinfo is not surfaced verbatim.

**Must NOT do:** Do not attempt to fix `request.ts:117-163`'s lossy `.yml`-to-`BruFile` narrowing.
Verified safe to leave: `loadRequest` (`:113`) has exactly **one** caller, `request.ts:237`, in the
`.bru` branch, and `updateRequestLocked` parses/mutates/regenerates directly at `:189-235`. So the
narrowing is not on the `.yml` path at all.

Correcting the previous version's stated reason, which was wrong even though its conclusion held: the
narrowing does **not** cost `read_request`, because `read_request` never reaches `loadRequest`. It costs
nothing currently reachable. Leave it alone because it is unreachable for this work, not because the
view layer compensates for it.

- [ ] **Step 1: Write the failing test** asserting `read_request` on a gRPC file returns
      `kind: 'grpc'`, the target, the method and the message count.
- [ ] **Step 2: Run it and watch it fail** — the view has no such fields.
- [ ] **Step 3: Extend the view and the mapper, then run the tests.**

**Acceptance Criteria:**
- [ ] `read_request` on a gRPC file reports kind, target, method, proto path and message count.
- [ ] `read_request` on a WebSocket file reports kind, target and message count.
- [ ] Both dialects produce the same view from equivalent files.
- [ ] A credential in the target's userinfo is redacted in the view.
- [ ] An HTTP request's view is **deep-equal** to before this task. Not "byte-identical":
      `toRequestView` returns an object, not bytes, so the criterion needs a comparison that can
      actually run. Snapshot the object for three existing HTTP fixtures and compare with
      `toEqual`.

**QA Scenarios:**
```
Scenario: The silently-empty view is gone
  Tool: mcp__bruno-mcp__read_request
  Steps: read_request on a .bru gRPC request and on its .yml equivalent
  Expected: Both return kind grpc with target, method and message count; neither is empty
  Evidence: evidence/pr1-task-8-view.txt

Scenario: HTTP views did not change
  Tool: bash
  Steps: Snapshot toRequestView output for an HTTP fixture before and after
  Expected: Identical
  Evidence: evidence/pr1-task-8-http-unchanged.txt
```

**Commit:** YES | `feat(read): surface grpc and websocket requests in read_request` |
Files: `src/bruno/request-view.ts`, `tests/unit/bruno/request-view-grpc-ws.test.ts`

---

### PR1-T9: Document the deferred scope, including the socket.io workaround

**Files:**
- Create: `docs/superpowers/specs/2026-08-06-grpc-websocket-design.md`
- Modify: `README.md` (a short "what these kinds do and do not do" note)

**What to do:** Write down what is deliberately not built and why, so the next reader does not
re-derive it: streaming, reflection, proxy support for the new transports, held-open sessions,
`create_request` authoring, and any `socketio`/`mqtt` block.

For socket.io, document the **verified workaround** rather than a flat refusal. A plain `ws` request
reaches a socket.io server by hand-writing engine.io frames: connect to
`ws://host:port/socket.io/?EIO=4&transport=websocket`, receive the `0{"sid":…}` OPEN frame, send `40`
to join the default namespace, then `42["event",payload]`. Verified against socket.io 4.8.3, which
answered `42["echoed","pong:…"]`. State the limits plainly: locked to `EIO=4` because v2 and v3 frame
differently; acks and binary attachment packets are impractical by hand; it depends on PR2-T9's
keepalive reply for any recording longer than the server's `pingTimeout`; and the file stays a legal
`ws` request Bruno itself can open, which is the whole reason this beats inventing a block.

Record why no block is invented: we do not own either format, `usebruno/bruno#5887` (socket.io) and
`#6511` (MQTT) are both open upstream, and a private dialect would collide with whatever lands and
then need users migrated off it.

Also record the dependency arithmetic, since it is the reason PR 2 takes the transports directly:
`@ostico/bruno-mcp` today installs in 3.3 s / 45 MB; adding `@usebruno/requests` plus its undeclared
`qs` dependency costs 9.9 s / 179 MB, because its declared dependencies pull `@azure` (38 MB),
`@faker-js` (9.7 MB), `@aws-sdk` (8.3 MB) and `@smithy` (7.5 MB) for vault integrations we would not
use; taking `@grpc/grpc-js`, `@grpc/proto-loader` and `ws` directly costs 3.8 s / 58 MB.

**Must NOT do:** Do not describe unbuilt features as though they exist. Do not put the socket.io
recipe only in a scratch directory — the probe script lives in a job temp directory that does not
survive the session, so the recipe goes in this document in full.

- [ ] **Step 1: Write the document.**
- [ ] **Step 2: Verify every claim in it is either implemented in these two PRs or explicitly marked
      deferred.**

**Acceptance Criteria:**
- [ ] Every Out-of-scope item from this plan appears with a reason.
- [ ] The socket.io recipe is complete enough to follow without the probe script, including the
      keepalive requirement.
- [ ] The two upstream issue numbers are cited.
- [ ] No unbuilt feature is described in the present tense.

**QA Scenarios:**
```
Scenario: The recipe is self-contained
  Tool: bash
  Steps: Grep the doc for the handshake URL, the 40 frame, the 42 frame and the EIO=4 limit
  Expected: All four present
  Evidence: evidence/pr1-task-9-deferred-doc.txt
```

**Commit:** YES | `docs: record deferred transport scope and the socket.io workaround` |
Files: `docs/superpowers/specs/2026-08-06-grpc-websocket-design.md`, `README.md`

---

### PR 1 Verification Wave

- [ ] **V1. Gates.** `npx tsc --noEmit`, `npx eslint src/ --ext .ts`, `npx jest`, `npm run build` —
      all clean, and the **suite count is greater than or equal to** the number in
      `evidence/pr1-task-0-baseline.txt`. A lower count means a broken build dropped suites.
- [ ] **V2. The defect is actually closed.** Take a gRPC and a WebSocket request in each dialect,
      four files. Run `modify_request` on an unrelated field of each. Assert target, metadata/headers
      and every message survive. This is Success Criterion 1 and the reason PR 1 exists.
- [ ] **V3. Nothing throws.** `read_request`, `list_requests`, `modify_request`, `run_collection`,
      `get_collection_stats` against all four files. Twenty calls, zero throws.
- [ ] **V4. HTTP is untouched.** Full suite plus a manual `run_collection` on an existing HTTP
      collection. Compare results **field-by-field excluding `duration_ms`** — results carry timing, so
      a byte or whole-object comparison can never pass and would be a criterion that only ever fails.
- [ ] **V5. No non-null assertions and no dead branches** in the diff:
      `git diff -U0 origin/main -- src/ | grep -n '^+.*\(!\.\|! *)\|istanbul ignore\)' || echo clean`
- [ ] **V6. Scope fidelity.** No dependency added to `package.json`. No network code. No transport.
      `git diff origin/main -- package.json` is empty.
- [ ] **V7. Open the PR as a draft** with a body stating that it closes a live data-loss defect, adds
      no dependencies, and that PR 2 will add execution. Wait for all five CI gates. **Do not merge.**

---

# PR 2 — Execution

Adds `@grpc/grpc-js`, `@grpc/proto-loader`, `ws`, `@types/ws`. Carries six of the eight criticals.
Depends on PR 1 being merged, because every task below builds on the one run model PR1-T4 produces.

### PR2-T0: Dependencies, and the lock

**Files:** Modify `package.json`, `package-lock.json`

**What to do:** `npm install --save @grpc/grpc-js @grpc/proto-loader ws` and
`npm install --save-dev @types/ws`. **npm, never yarn.**

**Must NOT do:** Do not edit `package.json` without the lock. `npm ci` hard-fails with `EUSAGE` on a
manifest/lock mismatch across all three CI jobs — and a broken build drops whole suites silently, so
it can present as a suite-count drop rather than an obvious failure. Do not add
`@usebruno/requests` or `qs`.

- [ ] **Step 1: Install, then verify the lock agrees**

```bash
npm install --save @grpc/grpc-js @grpc/proto-loader ws
npm install --save-dev @types/ws
rm -rf node_modules && npm ci
npx tsc --noEmit
```

**Acceptance Criteria:**
- [ ] `rm -rf node_modules && npm ci` succeeds from a clean tree.
- [ ] `npx tsc --noEmit` is clean, with no `any` at any import site — `ws` ships no types of its own,
      which is why `@types/ws` is a hard requirement rather than a nicety.
- [ ] Install size and time are recorded and compared against the 3.8 s / 58 MB estimate.

**QA Scenarios:**
```
Scenario: CI's own install path works
  Tool: bash
  Steps: rm -rf node_modules; npm ci; echo $?
  Expected: 0
  Evidence: evidence/pr2-task-0-npm-ci.txt
```

**Commit:** YES | `build: add grpc-js, proto-loader and ws` | Files: `package.json`,
`package-lock.json`

---

### PR2-T1: Export the two trust primitives (C4)

The single root cause of C4: both `gateTls` (`fetch-dispatcher.ts:78`) and `pinnedLookup` (`:205`) are
module-private in an undici-only module, so `grpcs://` and `wss://` would bypass the
collection-TLS trust gate entirely and silently.

**Files:**
- Create: `src/bruno/transport-trust.ts`
- Modify: `src/bruno/fetch-dispatcher.ts` (import from the new module; behaviour unchanged)
- Test: `tests/unit/bruno/transport-trust.test.ts`

**Interfaces:**
- Produces: `export function gateTls(tls, host)` and `export function pinnedLookup(addresses)`,
  moved verbatim, plus `resetDispatcherTrustCache` continuing to work.

**What to do:** A pure extraction, no behaviour change. Move both functions and the trust-cache state
into one module both the HTTP dispatcher and the two new transports import.

**Must NOT do:** Do not change either function's semantics. `pinnedLookup([])` **fails closed** with a
synthetic `ENOTFOUND` by design (`fetch-dispatcher.ts:220-228`) and the HTTP caller guards with
`pinnedAddresses.length > 0` — preserve both halves, because PR2-T9 depends on that guard existing.

- [ ] **Step 1: Write the characterisation tests first** — `gateTls` denying a collection's TLS
      override for a non-allowlisted host, allowing it for an allowlisted one, and `pinnedLookup([])`
      producing `ENOTFOUND` rather than resolving.
- [ ] **Step 2: Run them against the current private functions** via a temporary re-export, confirm
      they pass, then move the code and re-run unchanged.

**Acceptance Criteria:**
- [ ] Both functions are exported and the HTTP path's behaviour is unchanged — full suite green.
- [ ] `pinnedLookup([])` yields `ENOTFOUND`, asserted directly. This is the fail-closed default the
      WebSocket transport inherits.
- [ ] `gateTls` refuses a collection-supplied TLS override for a host not in
      `BRUNO_INSECURE_TLS_HOSTS`, with a warning naming fields and never values.
- [ ] Moved lines remain covered — Test-Guard counts coverage per line regardless of caller.

**QA Scenarios:**
```
Scenario: The trust gate says no by default
  Tool: bash
  Steps: Call gateTls with rejectUnauthorized false and a host absent from BRUNO_INSECURE_TLS_HOSTS
  Expected: The override is dropped; a warning names the field, not its value
  Evidence: evidence/pr2-task-1-tls-gate.txt

Scenario: Pinning fails closed on an empty address list
  Tool: bash
  Steps: pinnedLookup([]) and invoke the callback
  Expected: ENOTFOUND, not a resolution
  Evidence: evidence/pr2-task-1-fail-closed.txt
```

**Commit:** YES | `refactor(security): extract gateTls and pinnedLookup for reuse` |
Files: `src/bruno/transport-trust.ts`, `src/bruno/fetch-dispatcher.ts`, `tests/unit/bruno/*`

---

### PR2-T2: URL validation for the new schemes, without loosening HTTP

**Files:**
- Modify: `src/bruno/url-validator.ts:144-149` (the scheme gate), `:156-161` (a now-false
  `istanbul ignore`), `:175-178`
- Modify: `src/bruno/request-redaction.ts:38` (`redactUrl`)
- Test: `tests/unit/bruno/url-validator-transports.test.ts`

**What to do:** Add an **allowed-scheme parameter defaulting to `['http', 'https']`**, so the three
existing production call sites — all HTTP (`request-executor.ts:7`, `:624`, `:756`), including the
redirect re-check — keep exactly today's narrow set and only the new transports opt into
`grpc`/`grpcs`/`ws`/`wss`. Return the **normalised validated URL** as the only string a transport may
dial; never let a transport re-parse the author's raw target.

**`ws:`/`wss:` are SPECIAL WHATWG schemes; `grpc:`/`grpcs:` are not.** The two new transports do *not*
share a parsing regime, and a single normaliser written on one premise misbehaves on the other.
Measured:

| input | hostname |
|---|---|
| `ws://10.0.0.1\@evil.com:8080` | `10.0.0.1` — already safe |
| `grpc://10.0.0.1\@evil.com:50051` | **`evil.com`** — confusion real |
| `ws://EXAMPLE.com` | `example.com` — lowercased |
| `grpc://EXAMPLE.com` | `EXAMPLE.com` — not |
| `wss://` | **THROWS** `ERR_INVALID_URL` |
| `grpcs://` | parses, hostname `''` |

So: `ws`/`wss` inherit WHATWG's normalisation (IDNA, lowercasing, IPv4 handling, backslash handling)
and need none of ours. `grpc`/`grpcs` inherit **none** of it and need all of it. Branch on scheme class
explicitly and comment why, or a later reader will "simplify" the two paths into one.

Two more parsing facts, each reproduced:

- `new URL('example.com:50051')` **succeeds**, yielding `{protocol:'example.com:', hostname:'',
  pathname:'50051'}`. Only a digit-leading authority throws. So a try-parse-then-prepend approach never
  fires for hostname targets — they reach the scheme gate and are refused with
  "Blocked scheme: example.com". Normalise **by shape** before any `new URL`.
- `checkHostname` returns null for `''`, and `dns.lookup('')` has historically resolved to loopback on
  Linux — a macOS/CI divergence this project has already been bitten by. Refuse an empty hostname
  explicitly. Note this path is reachable **only** for `grpc`/`grpcs`, since `wss://` throws first.

Then fix redaction: `types.ts:1038` requires `url` on every result and HTTP only ever stores the
redacted form (`request-executor.ts:605`, `shownUrl`). Feed the normalised target through the same
redactor so `grpcs://svc:{{token}}@host:50051` cannot land verbatim in `result.url`.

**Must NOT do:** Do not widen the default scheme set. Do not copy upstream's `addProtocolIfMissing`:
it picks plaintext on a bare `includes('localhost')` substring test, so `evil-localhost.attacker.com`
would go unencrypted carrying credentials.

- [ ] **Step 1: Write the failing tests**, one per parsing fact above plus the redaction case.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Add the scheme parameter, the shape-first normaliser and the target redactor.**
- [ ] **Step 4: Remove the `istanbul ignore` at `:156-161`** that the new tests make reachable — a
      dead-branch marker over live code fails Test-Guard per file.

**Files (the return-type change has three unlisted consumers):**
- Modify: `src/bruno/url-validator.ts` — including `UrlValidationResult` (`:136` returns
  `{valid, reason}` with **no URL**, so returning the normalised URL is a type change)
- Modify: its consumers, which the previous version of this task omitted:
  `src/bruno/fetch-dispatcher.ts:113`, `src/bruno/request-executor.ts:624`, `:756`
- Modify: `src/bruno/request-redaction.ts:38`
- Test: `tests/unit/bruno/url-validator-transports.test.ts`

**Acceptance Criteria:**
- [ ] `validateUrl` with no scheme argument still refuses `grpc://` — HTTP's gate is unchanged, and its
      three existing call sites compile without behaviour change.
- [ ] **Backslash host confusion is refused for `grpc`/`grpcs`.** Not asserted for `ws`/`wss`: the
      parser already yields the safe host there, so a refusal criterion could only pass by refusing a
      safe URL. Instead assert that `ws://10.0.0.1\@evil.com:8080` validates **and** resolves to
      `10.0.0.1`.
- [ ] A bare `host:port` target normalises and validates for all four new schemes.
- [ ] **An empty hostname is refused without a DNS lookup, asserted for `grpc`/`grpcs` only** —
      `wss://` throws in `new URL` before any check, so the criterion is unreachable there and the test
      asserts the throw is caught and reported as a named refusal.
- [ ] `ws://EXAMPLE.com` and `grpc://EXAMPLE.com` are **both** validated against a lowercased host,
      proving our normaliser supplies what WHATWG does not for the non-special schemes.
- [ ] Userinfo, `IPv4:port` and bracketed `IPv6:port` targets each have a test, per scheme class.
- [ ] The redacted target appears in results; the raw credential never does.
- [ ] Transports receive the normalised URL, asserted by the transports' own tests in T8/T9.
- [ ] The `istanbul ignore` at `url-validator.ts:156-161` is removed — widening the scheme set makes
      that branch live, and a stale ignore over live code fails Test-Guard.

**QA Scenarios:**
```
Scenario: HTTP's SSRF gate did not loosen
  Tool: bash
  Steps: validateUrl('grpc://127.0.0.1:50051') with no scheme argument
  Expected: Refused, "Blocked scheme: grpc"
  Evidence: evidence/pr2-task-2-http-unchanged.txt

Scenario: Host confusion under a non-special scheme
  Tool: bash
  Steps: Validate 'grpc://10.0.0.1\@evil.com:50051'
  Expected: Refused; the log names evil.com as the parsed host, proving the confusion was seen
  Evidence: evidence/pr2-task-2-host-confusion.txt

Scenario: A credential in the target is not echoed back
  Tool: bash
  Steps: Validate then redact 'grpcs://svc:s3cr3t@host:50051'
  Expected: The redacted form omits s3cr3t
  Evidence: evidence/pr2-task-2-redacted-target.txt
```

**Commit:** YES | `feat(security): validate grpc and ws targets without loosening http` |
Files: `src/bruno/url-validator.ts`, `src/bruno/request-redaction.ts`, `tests/unit/bruno/*`

---

### PR2-T3: Settle the result contract (C7)

`types.ts:1042` declares `status: number` **required**, and `request-executor.ts` uses `status: 0` as
the universal refusal sentinel at `:616`, `:630`, `:762`, `:844`, `:957` and `:1195` —
`run-tools.ts:21` documents "an 'SSRF blocked' error with status 0". gRPC's OK code **is** 0. So
mapping the gRPC code onto `status` makes a successful call and a security refusal identical in the
field an agent reads first.

**Files:**
- Modify: `src/bruno/types.ts:1038-1060` (add `grpc?` and `websocket?` sub-objects)
- Modify: `src/tools/run-tools.ts` (document the new fields)
- Test: `tests/unit/bruno/result-contract.test.ts`

**What to do:** Per Decision 2: `status` stays required, `0` stays reserved for refusals on **every**
kind, and the gRPC code goes in `grpc: { code, details, trailers }`. WebSocket carries
`websocket: { transcript, stopReason, truncated }`. A successful gRPC call and an SSRF refusal are
distinguishable because only the former has a `grpc` object.

**Must NOT do:** Do not make `status` optional — that is a breaking change to a published MCP output
contract, and it is not needed. Do not overload `status` with a gRPC code.

- [ ] **Step 1: Write the failing test** asserting that a synthesised gRPC OK result and a
      synthesised SSRF-refusal result are distinguishable, and that an existing HTTP consumer reading
      `.status` sees no change.
- [ ] **Step 2: Run, fail, add the fields, run again.**

**Acceptance Criteria:**
- [ ] A successful gRPC result and an SSRF-blocked gRPC result are distinguishable programmatically.
- [ ] `status` remains required and every existing HTTP result is unchanged.
- [ ] `run_collection`'s tool description documents both new sub-objects.
- [ ] The refusals PR1-T7 introduced still carry `status: 0` and no `grpc`/`websocket` object.

**QA Scenarios:**
```
Scenario: A gRPC OK is not mistaken for a refusal
  Tool: bash
  Steps: Build both result shapes; assert the discriminator
  Expected: Distinguishable without reading status alone
  Evidence: evidence/pr2-task-3-contract.txt
```

**Commit:** YES | `feat(types): carry grpc status and websocket transcript in their own fields` |
Files: `src/bruno/types.ts`, `src/tools/run-tools.ts`, `tests/unit/bruno/result-contract.test.ts`

---

### PR2-T4: A purpose-built proto boundary (C5)

**Files:**
- Create: `src/bruno/proto-path.ts`
- Test: `tests/unit/bruno/proto-path.test.ts`

**What to do:** A dedicated boundary rooted at the **collection directory only**, calling
`fs.realpathSync` on the entry path and on every resolved import, re-checking containment against the
real path each time. Drive protobufjs directly — `new protobuf.Root()` with our own `resolvePath` —
rather than delegating to proto-loader's `includeDirs`.

**Must NOT do:** Do not reuse `confineUploadPath`. `upload-path.ts:74` allows
`[root, homedir(), tmpdir(), '/tmp', ...operatorUploadDirs()]`, so it would grant a collection file
the right to read anything non-dot-prefixed under the operator's entire home directory — where
tokens and kubeconfigs live. Do not rely on `includeDirs` for confinement: proto-loader's
`resolvePath` returns absolute targets verbatim and `path.join`s relative ones, normalising `..` away
before `fs.accessSync`, so an absolute `import` inside a confined `.proto` skips it entirely. Do not
rely on lexical containment alone — `grep -rn realpath src/` currently returns nothing, which is why
the old plan's symlink acceptance criteria were unachievable.

- [ ] **Step 1: Write the failing tests** — the three escapes that matter:
      (i) a symlink **inside** the collection root pointing outside it,
      (ii) an **absolute** `import` inside a confined `.proto`,
      (iii) a `$HOME`-relative path.
      Plus the happy path: a relative import resolving inside the root.
- [ ] **Step 2: Run and watch all three escapes succeed** — that is the hole, reproduced.
- [ ] **Step 3: Implement realpath-based confinement, then re-run.**

**Acceptance Criteria:**
- [ ] A symlink inside the root pointing outside is refused, with the real path named.
- [ ] An absolute import inside a `.proto` is refused.
- [ ] A `$HOME`-relative path is refused.
- [ ] `../../../etc/passwd` is refused — the lexical case still works.
- [ ] A legitimate relative import inside the collection loads.
- [ ] The boundary is the collection directory, asserted directly; neither `homedir()` nor `/tmp` is
      in the allowed set.

**QA Scenarios:**
```
Scenario: The escape the old plan could not have caught
  Tool: bash
  Steps: Create a symlink inside the collection dir pointing at a file in $HOME; reference it as protoPath
  Expected: Refused; the error names the resolved real path
  Evidence: evidence/pr2-task-4-symlink.txt

Scenario: An absolute import cannot smuggle a read
  Tool: bash
  Steps: A confined .proto containing `import "/etc/hosts";`
  Expected: Refused before any read
  Evidence: evidence/pr2-task-4-absolute-import.txt
```

**Commit:** YES | `feat(security): confine proto loading to the collection directory` |
Files: `src/bruno/proto-path.ts`, `tests/unit/bruno/proto-path.test.ts`

---

### PR2-T5: Redaction and caps for metadata *and* transcripts (C8)

The old plan redacted gRPC metadata only. The WebSocket transcript is the bigger hole: outbound
messages are recorded **after** `{{var}}` interpolation, so every secret supplied the documented way
(`run-tools.ts:38` calls `variables` "the only correct way to supply a secret") would be written
verbatim into a transcript that `includeResponseBody` surfaces by **default** (`run-tools.ts:36`), and
the `ws:upgrade` event carries the `Authorization` header PR2-T6 adds. `ws` also defaults `maxPayload`
to 100 MB, so 50 frames is a 5 GB in-memory transcript serialised into an MCP response.

**Files:**
- Create: `src/bruno/transport-redaction.ts`
- Test: `tests/unit/bruno/transport-redaction.test.ts`

**What to do:** One module covering both. For gRPC: mask credential-bearing metadata by name. For
WebSocket: mask credential-bearing handshake headers by name, and make **outbound payload recording
opt-in** — the default records direction, byte length and offset only.

**Concrete defaults, so no implementer has to choose** (all three overridable per run, and all three
validated by PR2-T11):

| bound | default | rationale |
|---|---|---|
| per-message cap, passed to `ws` as `maxPayload` | **65536 bytes** | `ws` defaults to 100 MB, which times 50 frames is a 5 GB in-memory transcript serialised into an MCP response |
| cumulative transcript cap | **1048576 bytes** | a third stop reason alongside count and timeout |
| outbound payload recording | **off** | outbound is recorded after `{{var}}` interpolation |

**Must NOT do:** Do not reuse `maxResponseBodyBytes` implicitly — it caps a body **string**, not an
array, and reusing it silently would leave the array uncapped. Do not mask by value; mask by name, so
the log says which field was withheld without leaking a prefix of it.

- [ ] **Step 1: Write the failing test** — the decisive one: a run whose `variables` contain a secret
      produces a transcript that does **not** contain that secret's value.
- [ ] **Step 2: Run, fail, implement, re-run.**

**Acceptance Criteria:**
- [ ] A secret supplied via `variables` and interpolated into an outbound message does not appear in
      the default transcript.
- [ ] Enabling payload recording explicitly does include content — the opt-in works.
- [ ] Credential-bearing handshake headers are masked by name in the upgrade event.
- [ ] gRPC metadata is masked by name.
- [ ] An oversized frame is truncated with a named reason; the cumulative cap is a distinct third stop
      reason.
- [ ] `maxPayload` is passed explicitly, never left at the 100 MB default.

**QA Scenarios:**
```
Scenario: The secret does not reach the transcript
  Tool: bash
  Steps: Run a WebSocket request sending '{{token}}' with token set to a known sentinel; grep the result
  Expected: The sentinel is absent; the entry shows direction and byte length
  Evidence: evidence/pr2-task-5-no-secret.txt

Scenario: A flooding server cannot exhaust memory
  Tool: bash
  Steps: Local server sending frames larger than the per-message cap, past the cumulative cap
  Expected: Truncated, stop reason names the byte cap, process memory stable
  Evidence: evidence/pr2-task-5-byte-cap.txt
```

**Commit:** YES | `feat(security): redact and cap grpc metadata and websocket transcripts` |
Files: `src/bruno/transport-redaction.ts`, `tests/unit/bruno/transport-redaction.test.ts`

---

### PR2-T6: An auth disposition table, per mode (#12)

`applyAuth` has two modes that are silently inert for these transports: `auth-apply.ts:104-105`
returns a query-placed api-key for the **caller** to append to a URL, and gRPC has no query string;
`:112-117` returns `undefined` for digest because "`executeSingleRequest` answers the 401", and gRPC
has no 401. The module's own contract at `:41-45` is that a run never silently sends an
unauthenticated request while claiming the auth was configured — so these must refuse, not pass.

**Files (a return-type change with one caller, upstream of the dispatch):**
- Modify: `src/bruno/auth-apply.ts` — `applyAuth` currently returns `{key, value} | undefined`. A third
  "refused" outcome is a **return-type change**, so the signature and the type both move.
- Modify: `src/bruno/request-executor.ts:218` — the **only** call site, and it sits *upstream* of the
  per-kind dispatch PR2-T7 extracts. So PR2-T8 and PR2-T9 must call `applyAuth` themselves rather than
  inheriting the HTTP path's call; neither said so before.
- Test: `tests/unit/bruno/auth-disposition.test.ts`

**What to do:** An explicit table: mode × kind → applied, or refused with a named reason. Digest and
query-placed api-key become **explicit refusals** for gRPC and WebSocket. `inherit` resolves against
the collection as it does for HTTP — noting that `.bru` carries a bare token and `.yml` an object, both
already normalised to the mode string by PR1-T4, which is what `auth-apply.ts:58` compares by
identity.

**Must NOT do:** Do not let an unsupported mode fall through to `default:` with a warning while
sending nothing.

- [ ] **Step 1: Write the failing test** covering the full matrix — kind × dialect × mode.
- [ ] **Step 2: Run, fail, implement the table, re-run.**

**Acceptance Criteria:**
- [ ] Every auth mode has an explicit disposition for both new kinds. **Enumerate them by name in the
      test** — `none`, `inherit`, `basic`, `bearer`, `apikey` (header placement), `apikey` (query
      placement), `digest`, `oauth2`, `awsv4`, `wsse`, `ntlm` — so "every mode" is checkable rather than
      aspirational. The previous version decided only digest and query api-key and still claimed
      completeness.
- [ ] Digest and query-placed api-key refuse by name for gRPC and WebSocket: gRPC has no 401 for
      `auth-apply.ts:112-117` to answer and no query string for `:104-105` to append to.
- [ ] `oauth2` has a stated disposition. If it is refused, the reason names why; if it is applied, the
      token acquisition path is the one PR 2 already ships.
- [ ] `inherit` resolves identically from both dialects — the mode string PR1-T4 normalises to, which is
      what `auth-apply.ts:58` compares by identity.
- [ ] No mode reaches `default:` for the new kinds.
- [ ] HTTP dispositions are unchanged, and `request-executor.ts:218` still compiles against the new
      return type.

**QA Scenarios:**
```
Scenario: A digest-authed gRPC request refuses instead of going out bare
  Tool: bash
  Steps: Run a gRPC request whose auth mode is digest
  Expected: Named refusal; nothing sent
  Evidence: evidence/pr2-task-6-digest-refused.txt
```

**Commit:** YES | `feat(auth): explicit auth disposition per mode for grpc and websocket` |
Files: `src/bruno/auth-apply.ts`, `tests/unit/bruno/auth-disposition.test.ts`

---

### PR2-T7: Buy `max-lines` headroom before the transports need it (#3)

`request-executor.ts` is at **1245** lines against a **1300** ceiling with
`skipComments: false`. PR2-T8, PR2-T9 and PR2-T3's wiring all land in it. 55 lines is not enough, and
`.eslintrc.json` counts comments, so the file must be split before the transports arrive rather than
after the lint gate fails.

**The seam is `buildFetchOptions`, not a dispatch.** Measured — the file has eight functions and none
of them is a per-kind dispatch:

| line | function | size |
|---|---|---|
| 85 | `isMultipartBody` | 8 |
| 94 | **`buildFetchOptions`** | **338** |
| 432 | `resolveTimeout` | 28 |
| 460 | `capResponseBody` | 12 |
| 472 | `executeSingleRequest` | 693 |
| 1165 | `runGroupsInOrder` | 25 |
| 1190 | `crashedRequestResult` | 22 |
| 1212 | `summarise` | 33 |

It is a linear HTTP pipeline. PR1-T7's kind dispatch will be roughly 30 lines, so extracting *it*
frees nothing — and the previous version of this task demanded 195 lines out while simultaneously
forbidding "a seam that splits one decision across two files". Those two instructions were mutually
exclusive; this is the honest seam instead.

**Files:**
- Create: `src/bruno/fetch-options.ts` (`buildFetchOptions`, ~338 lines)
- Modify: `src/bruno/request-executor.ts`

**What to do:** Move `buildFetchOptions` and its private helpers into their own module. It is a
self-contained HTTP-request-shaping unit with one caller, so the seam does not split a decision. Pure
extraction, no behaviour change.

**Must NOT do:** Do not buy lines by deleting comments — the lint config counts them deliberately and
the comments carry the reasons. Do not slice `executeSingleRequest`; that *would* split one decision
across two files. Do not raise `max-lines` in `.eslintrc.json` as a shortcut — if the extraction turns
out insufficient, stop and say so rather than moving the ceiling silently.

- [ ] **Step 1: Record the line counts.** `wc -l src/bruno/request-executor.ts`
- [ ] **Step 2: Extract `buildFetchOptions`, then re-measure.** Expected: executor around 910 lines,
      new module around 340. State both numbers in the commit body so the next reader knows the budget.
- [ ] **Step 3: Full suite, unchanged.**

**Acceptance Criteria:**
- [ ] Suite count and results identical to before the extraction.
- [ ] `request-executor.ts` is at or below **950** lines, leaving at least 350 of headroom for T8, T9
      and T3's wiring.
- [ ] `src/bruno/fetch-options.ts` is itself under 1300.
- [ ] `npx eslint src/ --ext .ts` clean, `max-lines` included.
- [ ] No comment was deleted — `git diff` shows moves, not removals.
- [ ] `.eslintrc.json` is unchanged.

**QA Scenarios:**
```
Scenario: Headroom actually exists, measured not asserted
  Tool: bash
  Steps: wc -l src/bruno/request-executor.ts src/bruno/fetch-options.ts; git diff --stat .eslintrc.json
  Expected: Executor at or below 950; new module under 1300; eslintrc diff empty
  Evidence: evidence/pr2-task-7-headroom.txt
```

**Commit:** YES | `refactor(run): extract per-kind dispatch from the executor` |
Files: `src/bruno/request-dispatch.ts`, `src/bruno/request-executor.ts`

---

### PR2-T8: gRPC unary

**Files:**
- Create: `src/bruno/grpc-transport.ts`
- Modify: `src/bruno/request-dispatch.ts` (replace the gRPC refusal)
- Test: `tests/unit/bruno/grpc-transport.test.ts`,
  `tests/integration/grpc-unary.test.ts`

**Interfaces:**
- Consumes: `YamlRequest.grpc` (PR1-T4), `gateTls` + `pinnedLookup` (PR2-T1), the normalised
  validated URL (PR2-T2), the result contract (PR2-T3), the proto boundary (PR2-T4), redaction
  (PR2-T5), auth disposition (PR2-T6).
- Produces: a `RequestExecutionResult` carrying `grpc: { code, details, trailers }`.

**What to do:** Load `@grpc/grpc-js` and `@grpc/proto-loader` with a dynamic `await import()` **inside
the gRPC path only**. Load the method set through PR2-T4's boundary. Refuse any `methodType` that is
not unary, naming the streaming kind. Build the channel with:

- `grpc.enable_http_proxy: 0` **unconditionally** — Decision 7. grpc-js honours ambient `http_proxy`
  while undici's global `fetch` does not, so leaving it enabled would silently void SSRF pinning.
  Upstream sets it only alongside a proxy config; we diverge deliberately.
- `grpc.default_authority` set to the **original authority** whenever a validated address is
  substituted for the hostname. Without it, dialling the IP silently changes `:authority` and breaks
  virtual-host routing. `ssl_target_name_override` fixes only TLS name verification, not routing, and
  is set **only** when an address was actually pinned — on a `BRUNO_SSRF_ALLOWLIST` hostname hit there
  are no addresses (`url-validator.ts:184-186`), so it must be absent then.
- Credentials via `gateTls`. **Never** `createInsecure()` as a fallback.
- A **deadline** derived from `settings.timeout` via `resolveTimeout`. grpc-js has no implicit
  deadline, so a server that accepts and never answers would otherwise block the request, the group
  and the MCP call forever — the exact failure mode the bounded WebSocket recorder was designed to
  avoid, and the old plan left it open on the sibling transport.

Take the **first** message and refuse if the request carries more than one. Measured: **neither dialect
gives gRPC a `selected` flag** — `.bru` messages are `{name, content}` and `.yml` grpc variants are
`{title, message}`. `selected` exists only on `.yml` *websocket* variants, so a "more than one
*selected* message" rule would have nothing to read. Count messages, not selections.

**Must NOT do:** No streaming. No reflection. No proxy support and no reading of `http_proxy`. No
`qs`, no `@usebruno/requests`. Do not wrap the dynamic import in a `catch` for a missing module — the
dependency is declared, so that branch is unreachable and Test-Guard fails on exactly that dead code.
Do not store anything in module state keyed by anything but request identity: groups and requests run
concurrently in one process.

**Reference to read, not import:** upstream's `grpc-client.js` — `startConnection` at `:584`,
`loadMethodsFromProtoFile` at `:820`, and `#resolveProxyTarget` at `:364-394` for the proxy option
trick we deliberately do not use. Note `:343-347` catches credential-construction failure and returns
`createInsecure()` — the fallback we refuse. Verified call shape from the probe:
`{ uid, url, method: '/pkg.Svc/Method', body: { grpc: [{ name, content }] }, methodType: 'unary',
headers: {} }` — `headers` must be an **object** and is dereferenced with `Object.keys`, so an absent
one crashes.

- [ ] **Step 1: Write the failing integration test** — a local grpc-js Echo server on port 0, a unary
      call, asserting the echoed message plus code 0 and details `OK`.
- [ ] **Step 2: Run and watch it fail** with PR1-T7's refusal.
- [ ] **Step 3: Implement, then re-run.**
- [ ] **Step 4: Add the deadline test** — an accept-and-never-reply server must produce a timeout
      result, not a hang. Give the test its own timeout below jest's so a regression fails rather than
      stalling the suite.

**Acceptance Criteria:**
- [ ] A unary call returns the response message, code 0 and details `OK`, **in both dialects** — the
      dialect-parity criterion from PR1-T4 is what makes one implementation satisfy both.
- [ ] A `server-streaming` methodType is refused, naming the streaming kind.
- [ ] A request carrying two messages is refused by name. (Not "two *selected* messages" — gRPC has no
      `selected` in either dialect, so that rule would be unwritable.)
- [ ] Every constructed channel carries `grpc.enable_http_proxy: 0`.
- [ ] `default_authority` is set whenever an address is substituted; `ssl_target_name_override` is set
      only when an address was pinned and absent on the allowlist-hostname path.
- [ ] An ambient `http_proxy` cannot take effect — verified behaviourally by a local proxy recording
      **zero** CONNECTs, not only by asserting our own input.
- [ ] A failing call surfaces the gRPC status code, not a generic error.
- [ ] A server that never answers produces a deadline result within `settings.timeout`.
- [ ] A `grpcs://` host with an untrusted certificate **fails** rather than downgrading.

**QA Scenarios:**
```
Scenario: Unary happy path, both dialects
  Tool: bash
  Steps: Start a local grpc-js Echo server on port 0; run the .bru and the .yml gRPC request with
         BRUNO_SSRF_ALLOWLIST=127.0.0.1 set and restored afterwards
  Expected: Both echo the message with code 0, details OK
  Evidence: evidence/pr2-task-8-grpc-unary.txt

Scenario: Ambient proxy cannot take effect
  Tool: bash
  Steps: Start a local CONNECT-logging proxy; set http_proxy to it; run the same request
  Expected: The call reaches the server; the proxy logs zero CONNECTs
  Evidence: evidence/pr2-task-8-ambient-proxy.txt

Scenario: An unanswering server does not hang the run
  Tool: bash
  Steps: Server that accepts and never replies; settings.timeout 1500ms
  Expected: A deadline result inside ~1500ms; the group completes
  Evidence: evidence/pr2-task-8-deadline.txt

Scenario: TLS is not downgraded on demand
  Tool: bash
  Steps: grpcs:// against a server with a self-signed cert, host not in BRUNO_INSECURE_TLS_HOSTS
  Expected: Refused with a named reason; no insecure channel constructed
  Evidence: evidence/pr2-task-8-tls-no-downgrade.txt
```

**Commit:** YES | `feat(grpc): execute unary gRPC requests` |
Files: `src/bruno/grpc-transport.ts`, `src/bruno/request-dispatch.ts`, `tests/unit/bruno/*`,
`tests/integration/grpc-unary.test.ts`

---

### PR2-T9: WebSocket bounded recorded session

**Files:**
- Create: `src/bruno/ws-transport.ts`
- Modify: `src/bruno/request-dispatch.ts` (replace the WebSocket refusal)
- Test: `tests/unit/bruno/ws-transport.test.ts`, `tests/integration/ws-session.test.ts`

**What to do:** Load `ws` with a dynamic `await import()` inside the WebSocket path only. Connect,
send the scripted messages in order — filtering out any whose `selected` is false, which only `.yml`
websocket variants can express — collect until the first bound is hit, close
deterministically, return the transcript with an explicit stop reason. Record both directions with a
direction marker and a monotonic offset. Defaults: 50 messages, 5000 ms, plus PR2-T5's byte caps —
all overridable per run.

**The pinning branch is explicit, not implied.** `pinnedLookup([])` fails closed by design, and the
allowlist-hostname path returns **no** addresses. The HTTP caller guards with
`pinnedAddresses.length > 0`; this transport must do the same. Written unconditionally, as the old
plan had it, every hostname-allowlist integration test would `ENOTFOUND` — and the likely "fix" would
be deleting pinning, which is why both branches get acceptance criteria.

Keepalive, per Decision 6: reply `3` to an engine.io `2`, **opt-in**, and only after an engine.io OPEN
frame has actually been observed. Record every keepalive in the transcript.

**Must NOT do:** No held-open session across tool calls, no handle returned. No proxy agent. No
socket.io framing beyond the gated keepalive reply. Never leave a socket open on any exit path,
including a thrown error. Do not enable `followRedirects` — it defaults false, and enabling it would
move a credentialed handshake to a host that never passed `validateUrl`, with none of the
cross-origin stripping `request-redaction.ts:99` performs.

**Reference to read:** upstream's `ws-client.js`, `startConnection` around `:116`. Note
`close(requestId)` takes **one** argument — a second is interpreted as a close code. `ws` passes
options to `http.request` and honours a custom `lookup`, verified by probe.

- [ ] **Step 1: Write the failing integration tests** — count bound, timeout bound, and
      socket-closed-on-error.
- [ ] **Step 2: Run and watch them fail** with PR1-T7's refusal.
- [ ] **Step 3: Implement both pinning branches, then re-run.**

**Acceptance Criteria:**
- [ ] A connect-send-receive-close cycle returns a transcript with outbound and inbound in order,
      **in both dialects**.
- [ ] The count bound stops collection and is named as the stop reason.
- [ ] The timeout bound stops collection and is named as the stop reason.
- [ ] The byte cap from PR2-T5 is a third distinct stop reason.
- [ ] **Pinned path:** an IP allowlist entry dials the validated address.
- [ ] **Unpinned path:** a hostname allowlist entry connects successfully rather than `ENOTFOUND`.
- [ ] After every run, including a failing one, no socket remains open — asserted by the server
      observing a close.
- [ ] The transcript states its own truncation when a bound was hit.
- [ ] With the keepalive reply enabled and an engine.io OPEN frame observed, a `2` is answered with
      `3` and recorded. With it disabled, or with no OPEN frame seen, no `3` is ever sent.
- [ ] A `wss://` host with an untrusted certificate fails rather than downgrading.

**QA Scenarios:**
```
Scenario: Bounded by count
  Tool: bash
  Steps: Local server flooding 200 messages; run with the default 50 cap
  Expected: 50 recorded, stop reason names the count bound, socket closed
  Evidence: evidence/pr2-task-9-ws-count.txt

Scenario: The hostname allowlist path connects
  Tool: bash
  Steps: BRUNO_SSRF_ALLOWLIST set to a hostname resolving to loopback; run the ws request
  Expected: Connects and records; no ENOTFOUND
  Evidence: evidence/pr2-task-9-unpinned.txt

Scenario: No socket survives an error
  Tool: bash
  Steps: Force a mid-session throw; have the server assert it saw a close
  Expected: Close observed; no open handle
  Evidence: evidence/pr2-task-9-ws-error.txt

Scenario: socket.io through a legal ws request
  Tool: bash
  Steps: Local socket.io 4.8.3 server; ws request to /socket.io/?EIO=4&transport=websocket sending
         40 then 42["echo","hi"], keepalive reply enabled
  Expected: 42["echoed","pong:hi"] recorded — proving PR1-T9's documented workaround
  Evidence: evidence/pr2-task-9-socketio.txt
```

**Commit:** YES | `feat(ws): record bounded WebSocket sessions` |
Files: `src/bruno/ws-transport.ts`, `src/bruno/request-dispatch.ts`, `tests/unit/bruno/*`,
`tests/integration/ws-session.test.ts`

---

### PR2-T10: A laziness gate that can actually fail (C1)

The old plan's gate was `process.moduleLoadList`. **Measured: after `require('yaml')` it holds 108
entries, 0 yaml hits, 0 non-native entries** — it never names a userland package, so the assertion
passes even if both transports load eagerly. The `require.cache` fallback is also unavailable because
`package.json` declares `"type": "module"` and tsup builds ESM. This gate protects the whole
dependency decision, so it gets a positive control and a red-proof.

**Files:**
- Create: `tests/integration/lazy-transport-load.test.ts`,
  `tests/helpers/resolve-recorder.mjs`
- Test: itself.

**What to do:** Spawn `dist/index.js` with `--import` pointing at a loader hook registered via
`module.register()` whose `resolve` appends every bare specifier to a file. Run an HTTP-only
collection, assert no line matches `@grpc/` or `^ws$`. Then run a gRPC collection and assert those
lines **do** appear — without that positive control, a recorder that silently writes nothing would
also pass.

**Must NOT do:** Do not use `process.moduleLoadList`. Do not use `require.cache`. Do not accept the
gate until it has been observed failing.

- [ ] **Step 1: Write the recorder hook and the two assertions.**
- [ ] **Step 2: Positive control** — the gRPC run must produce `@grpc/grpc-js` in the log. If it does
      not, the recorder is broken and the negative assertion is worthless.
- [ ] **Step 3: Red-proof.** Add a static `import 'ws'` at the top of `src/index.ts`, rebuild, run the
      gate, **watch it fail**, then revert and rebuild. Record both outputs.
- [ ] **Step 4: Replace the boot-time assertion.** The old plan's second gate compared boot timings
      with a measured spread of 170.8–280.2 ms against a claimed "+18 ms import" — a noise floor six
      times the signal. Assert the module-load fact instead, and record boot timing as an observation
      rather than a gate.

**Acceptance Criteria:**
- [ ] An HTTP-only run's resolve log contains neither `@grpc/` nor `^ws$`.
- [ ] A gRPC run's log **does** contain `@grpc/grpc-js` — the positive control.
- [ ] A WebSocket run's log contains `ws`.
- [ ] The red-proof is recorded: with a static import added the gate fails; reverted, it passes.
- [ ] Boot timing is recorded as an observation with its spread stated, not asserted as a threshold.

**QA Scenarios:**
```
Scenario: The gate fails when it should
  Tool: bash
  Steps: Add `import 'ws'` to src/index.ts; npm run build; run the gate; revert; rebuild; run again
  Expected: FAIL then PASS, both captured
  Evidence: evidence/pr2-task-10-red-proof.txt

Scenario: The recorder is not silently empty
  Tool: bash
  Steps: Run the gRPC collection under the recorder; count lines
  Expected: Non-zero, including @grpc/grpc-js
  Evidence: evidence/pr2-task-10-positive-control.txt
```

**Commit:** YES | `test: gate lazy transport loading with a positive control` |
Files: `tests/integration/lazy-transport-load.test.ts`, `tests/helpers/resolve-recorder.mjs`

---

### PR2-T11: Tool surface and documentation

**Files:**
- Modify: `src/tools/run-tools.ts` (bounds and options for the new kinds)
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-06-grpc-websocket-design.md` (move socket.io from
  "workaround" to "verified working", citing the PR2-T9 evidence)
- Test: `tests/unit/tools/run-tools-transports.test.ts`

**What to do:** Expose the per-run bounds — message count, timeout, byte caps, payload recording
opt-in, keepalive opt-in — with the defaults from PR2-T5 and PR2-T9. Document what each new kind
returns. Fix `run_collection`'s description where it claims unparseable files are skipped:
`request-discovery.ts:214` **throws** for an explicitly named file, and the description is the only
documentation an agent ever reads.

**Must NOT do:** Do not add a `create_request` type parameter — authoring stays out of scope. Do not
document deferred features as present.

- [ ] **Step 1: Write the failing test** asserting each option is accepted, validated and reflected in
      the result, and that the description matches the code's actual skip/throw behaviour.
- [ ] **Step 2: Implement, re-run.**

**Acceptance Criteria:**
- [ ] Every bound is settable per run and reported in the result.
- [ ] Out-of-range bounds are refused with a named reason.
- [ ] `run_collection`'s description agrees with `request-discovery.ts` on named-file behaviour.
- [ ] The README documents both kinds, and the deferred list matches PR1-T9.
- [ ] No tool advertises a capability these two PRs did not build.

**QA Scenarios:**
```
Scenario: The description no longer contradicts the code
  Tool: bash
  Steps: Call run_collection naming an unparseable file; compare behaviour to the tool description
  Expected: They agree
  Evidence: evidence/pr2-task-11-description.txt
```

**Commit:** YES | `feat(mcp): expose grpc and websocket run options` |
Files: `src/tools/run-tools.ts`, `README.md`,
`docs/superpowers/specs/2026-08-06-grpc-websocket-design.md`, `tests/unit/tools/*`

---

### PR 2 Verification Wave

- [ ] **V1. Gates.** `npx tsc --noEmit`, `npx eslint src/ --ext .ts` (including `max-lines`),
      `npx jest`, `npm run build` — all clean, **suite count at or above** PR 1's final count.
- [ ] **V2. Clean install.** `rm -rf node_modules && npm ci && npm run build` succeeds. Record install
      time and `node_modules` size; compare against 3.8 s / 58 MB.
- [ ] **V3. Both transports, both dialects.** Four executions: gRPC and WebSocket, `.bru` and `.yml`.
      All four succeed against local servers.
- [ ] **V4. The laziness gate, with its red-proof recorded.** PR2-T10's evidence files both present.
- [ ] **V5. Security sweep.** Every one of these must hold, each with an evidence file:
      an ambient `http_proxy` records zero CONNECTs; a `grpcs`/`wss` untrusted certificate fails
      without downgrade; the proto boundary refuses the symlink, absolute-import and `$HOME` cases; a
      secret in `variables` is absent from the default transcript; a digest-authed gRPC request
      refuses rather than sending bare.
- [ ] **V6. Allowlist hygiene.** `BRUNO_SSRF_ALLOWLIST` is set and restored per test with
      `resetAllowlistCache()` on **both** sides, and a **canary** asserts that with the allowlist
      cleared, `ws://127.0.0.1` is still refused. The allowlist is process-global and cached
      (`url-validator.ts:654-669`); a leaked assignment would make every later SSRF assertion in that
      worker pass for the wrong reason, and this repo has already had a CI-only failure from exactly
      that cross-file-state class.
- [ ] **V7. No dead branches, no non-null assertions** in the diff. Test-Guard's 95% diff coverage
      passes without an `istanbul ignore` added anywhere.
- [ ] **V8. Scope fidelity.** Re-read the Out-of-scope list against the diff: no streaming, no
      reflection, no proxy support, no held-open session, no `socketio`/`mqtt` block, no
      `create_request` type parameter. The engine.io keepalive reply is **opt-in** and OPEN-gated,
      which is what makes it consistent with "no socket.io framing".
- [ ] **V9. Open the PR as a draft**, body stating what ships, that it depends on PR 1, and that
      merging publishes nothing. Wait for all five CI gates. **Do not merge — the user merges.**

---

## Notes for whoever executes this

- Checkpoint after every task. A task is done when its acceptance criteria are checked off with
  evidence, not when the code compiles.
- `evidence/` is gitignored (`.gitignore:69`), so evidence files are for the executing session and the
  PR body, not for the repository.
- If a task's acceptance criterion turns out to be unachievable as written, stop and say so rather
  than weakening the criterion. Two of the old plan's criteria were unachievable with the mechanism it
  mandated, and that is how the mechanism's hole stayed untested.
- Tagging a release publishes to a public registry irreversibly. Neither PR does that, and no tag is
  pushed without the user naming the release.
