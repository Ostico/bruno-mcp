# Comprehension harness

A gate for the tool surface. It asks a real model to do real work through this
server and grades whether the work came out right — so that shortening a field
description can be checked against behaviour instead of against taste.

It exists because the surface is paid for on every call. The descriptions sit in
the cached prefix of every request a caller makes, and a caller's median call
re-reads around 95k tokens of that prefix. Cutting prose is therefore worth real
money, and the only question that matters is whether a cut takes a fact with it.
This harness answers that question by measurement.

## Running it

```sh
npm run build
node tools/comprehension/run.mjs --server "$PWD/dist/index.js" --trials 30 \
  --out tools/comprehension/reference.json
```

Flags:

| Flag | Meaning |
| --- | --- |
| `--server` | Absolute path to the built server entry point. Required. |
| `--trials` | How many trials to run. Tasks are drawn by weight. |
| `--out` | Where to write the result file. Defaults to stdout only. |
| `--only` | Comma-separated task ids, for iterating on one task. |
| `--concurrency` | Trials in flight at once. Default 4. |
| `--model` | Model to drive the trials. Default is Haiku 4.5, at low effort. |
| `--tasks` | Alternative task file. Defaults to `tasks.json` beside the runner. |
| `--keep` | Leave each trial's temporary directory behind for inspection. |

Each trial costs roughly one Haiku session — a few cents — and takes under a
minute. Thirty trials is a few minutes wall-clock at the default concurrency.

## What a trial is

One trial is one fresh `claude -p` session with this server as its only tool
provider, in a directory that did not exist a moment earlier:

- A per-trial `mkdtemp` root, and the CLI's working directory is inside it. That
  is what blinds the session: this repository's `CLAUDE.md` and the per-project
  memory are both keyed by working directory, so neither is loaded. A session
  that had read them would already know the answers.
- `--setting-sources project` drops user-level hooks, plugins and skills.
- `--strict-mcp-config` with a generated `--mcp-config`, so the only tools
  offered are this server's. Everything else is named on `--disallowed-tools`,
  because a non-allowed tool is still offered and a model that cannot find a
  Bruno tool will reach for `Write`.
- `BRUNO_WORKSPACE_PATH` pointed at a workspace manifest inside the trial root.
  Without it every collection a trial creates is registered permanently in the
  manifest under the user's application-support directory.
- An HTTP fixture on an ephemeral port, so tasks that run requests get real
  responses: `/ping`, `POST /login`, `/items` (401 without a bearer token),
  `/admin/reports` (403 unless the token is the admin one), `POST /echo`.

Tasks whose `setup` is `shop` get a small collection built first — Login, Items,
Admin Reports, Ping, plus a `local` environment. It is built by calling this
server, not committed as bytes, so it cannot go stale against what the writer
currently emits.

## How a trial is graded

The prompt says what the caller wants, never which tool to call. Grading reads
the calls the model made and the files it left behind, in this order:

1. **class 1 — tool error.** Any call the server refused. Reported even when a
   retry then succeeded: the retry spent a round trip on a description that had
   been misread, which is the cost being measured.
2. **class 3 — avoidance.** The tool the task is about was never called.
3. **class 2 — silently wrong.** The right tool, the wrong call: a forbidden
   tool used for something the server cannot express, a file that should be gone
   and is not, arguments that do not contain what the task asked for, written
   bytes missing the thing asked for or holding something forbidden, or one call
   per item where a field takes a list.

Anything else is a pass.

## The self-test, and the controls that failed to be controls

`preflight.mjs` runs before any trial and aborts the run if it fails. It costs
nothing and checks the two things worth checking:

- **A gut reaches the surface.** It removes one sentence from a copy of the
  bundle, starts that copy, and asserts the served surface no longer contains the
  sentence while the real one does — and that the copy still serves its tools.
  Two traps are the reason this check exists: the build resolves its own chunks
  by relative path and its dependencies by walking up to `node_modules`, so a
  copy written anywhere but beside the real entry point starts and immediately
  dies. That failure looks like a timeout, which reads as a flaky trial.
- **The grader bites.** It grades six synthetic trials, one per class plus a pass,
  and asserts each lands where it should. A run of thirty passes means nothing if
  the grader passes everything.

There were two model-facing controls here, each removing one sentence from the
surface and expected to fail because of it. **Both passed.** Removing "Must be
true. Every file in filePaths is deleted permanently." changed nothing, because
the field is a `z.literal(true)` and the JSON schema says `const: true` by
itself. Removing "Write several requests in one call." changed nothing either,
because a field taking an array of request items says that by its shape.

That is a finding about the prose, not a fault in the harness — and it is the
thesis this harness was built to test, arriving early. But a control that must
fail and does not would make every run void, so both are gone and the
deterministic self-test took their place. If a sentence is ever found that a
capable model demonstrably needs, it belongs back here as a control.

## The recorded baseline

`reference.json` is a 30-trial run against the surface as it stands. Twenty-seven
passed. The three failures are reproducible and are **surface defects, not
harness bugs** — they are recorded here so that a later run showing them is not
read as damage done by a compression pass:

- **`run-two-identities`, class 1, twice out of two trials in this run and three
  times out of four seen overall.** The model passes `requests` and `groups` in
  the same call and is refused: "Pass `requests` or `groups`, not both." It then
  retries correctly, so the end state is right and a round trip was still spent.
  The refusal message is good; what is missing is the same fact where `requests`
  is described, which is where the model is when it decides. This one wants a
  clause *added*, not cut.
- **`refuse-oauth2-browser-grant`, class 2, twice out of three seen overall.**
  Asked for an OAuth2 authorization-code grant with a browser redirect — which
  this server does not do — the model writes the request anyway rather than
  saying so, even though the prompt offers that answer. Nothing on the surface
  says the browser-redirect grants are refused. Intermittent, which is its own
  information: the fact is inferable but not reliably.

Everything else passed. Two earlier reference runs are the reason to distrust a
clean sheet: the first hid three harness bugs behind a plausible-looking result,
and the second passed every `run-*` task while every request in those runs was
being refused as SSRF, because the fixture answers on loopback and the tasks were
graded only on the tool having been called. Both are fixed — the runner
allowlists the fixture host, and a run task now also grades what the run itself
reported.

## What it does not prove

- **It is a sample, not a proof.** Thirty clean trials bound the failure rate at
  roughly 10% at 95% confidence; sixty at roughly 5%. A green run does not mean
  a cut was free, it means the cut did not cost more than the sample can see.
- **It measures one model at one effort.** Haiku 4.5 at low effort is the
  cheapest caller that still does the work, chosen so that a fact a stronger
  model can infer from context still registers as missing here. It says nothing
  about a different model's reading of the same prose.
- **Passing does not mean the bytes are right.** Grading checks what each task
  names. A field no task exercises is unmeasured, and the weights are drawn from
  what callers were recorded doing, so the tail is thin by design.
- **A failure is a lead, not a verdict.** Class 1 against the current surface
  usually means a harness bug. Class 2 or 3 usually means the surface is missing
  a fact — but read the trial before believing it, since a prompt can be
  ambiguous in a way the grader cannot see.

## Files

| File | What it is |
| --- | --- |
| `run.mjs` | The runner: trials, isolation, the CLI invocation, concurrency. |
| `grade.mjs` | The classes and the grading order. Pure, and takes the calls and the trial root. |
| `tasks.json` | The task set, weighted by what callers were recorded doing. |
| `preflight.mjs` | The deterministic self-test the runner calls before spending anything. |
| `fixtures/http-server.mjs` | The endpoints a trial can call. |
| `fixtures/mcp-client.mjs` | A newline-delimited JSON-RPC stdio client, for building fixtures through the server. |
| `fixtures/shop.mjs` | The starting collection for tasks that need one. |
| `reference.json` | The last recorded reference run, to compare a later run against. |

Nothing here ships: `tools/` is outside the jest roots, outside `package.json`'s
`files`, and classified as excluded by the source-archive test.
