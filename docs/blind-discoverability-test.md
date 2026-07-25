# Blind Discoverability Testing

How to measure whether an agent that knows nothing about this server can accomplish a real task using
only the bruno-mcp tool schemas and descriptions.

## Why this test exists

For an MCP server, the tool schemas and descriptions *are* the user interface. A human reads a README;
an agent reads `description` strings and parameter names, and nothing else. If a required convention
lives only in the maintainer's head or in an existing example file, agents will fail on it repeatedly
and the failure will look like the agent being bad rather than the description being incomplete.

A blind test converts that invisible problem into a concrete list of wording fixes. Each failed attempt
maps to exactly one sentence that was missing from a schema.

The output you want is **not** "did the agent succeed". It is: *at which step did it have to guess, and
what text would have prevented the guess?*

## The central threat: context pollution

The test is only valid if the agent cannot obtain the answer from anywhere except the tool schemas. In
practice the answer leaks from six places. Every one must be closed before you run, or the result is
worthless — and worse, misleadingly reassuring.

| # | Pollution source | Why it leaks the answer | Mitigation |
|---|---|---|---|
| 1 | An existing request in the collection doing something similar | Contains the working body shape, ready to copy | Use a purpose-built collection with **zero** requests |
| 2 | An existing request with tests attached | Reveals the assertion/script convention | Same — zero requests, so no script example exists |
| 3 | Pre-set environment variables | Hands over the host/URL the agent was supposed to work out | Ship only unrelated decoy vars |
| 4 | Recognisable names (folder, request, endpoint) | Agent greps *other* collections for the same name and finds a working twin | Rename everything to neutral terms |
| 5 | Persistent memory (Signet, `MEMORY.md`, `.omc/` notes, transcripts) | A prior session already solved this and wrote the answer down | Forbid all memory tools explicitly |
| 6 | Direct HTTP tools (`curl`, `wget`, scripting clients) | Agent debugs outside the server, so server gaps never surface | Forbid all HTTP clients, including "just to check" |

Sources 1–4 are the subtle ones. An agent given a sterile collection but a recognisable endpoint name
will simply search the filesystem for that name and find the polluted twin — which is exactly what
happened in round 1 below.

## Procedure

### 1. Build a sterile collection

Create it outside any registered collection root, e.g. under a scratch/tmp directory. Three files, no
requests:

`opencollection.yml`

```yaml
opencollection: 1.0.0

info:
  name: svc-integration-check
bundled: false
extensions:
  bruno:
    ignore:
      - node_modules
      - .git
```

`environments/dev.yml` — decoy variables only. Critically, **no host/URL variable**, so the agent must
create one itself (which also exercises `set_environment_variable`):

```yaml
name: dev
variables:
  - name: api-key
    value: 5f4dcc3b5aa765d61d8327deb882cf99
  - name: token
    value: q2w3e4r5t6y7u8i9o0p1-a2s3d4f5g6h7j8k9l0z1
```

Plus one empty folder for the agent to write into, e.g. `conversion/`.

Choose neutral names throughout. If the real request is `filters/original2xliff`, make the blind target
`conversion/doc-to-xliff`. The collection name should not hint at the real one either.

The scaffold above may be hand-written by the harness — it is fixture setup. The **request under test
must be produced by the tools**, which is what rule 4 in the prompt enforces.

### 2. Write the spec

Give the agent the task as a developer would state it: a working `curl` invocation, plus any facts about
the *service*. Withhold every fact about *bruno-mcp*.

The line to hold: service facts are fair (the endpoint, the fields, what a success response looks like,
the hostname). Tool facts are not (body `type` values, `formData` shape, `contentType`, the `test()`
wrapper, which tool to call).

Make sure the task is actually solvable from schemas plus spec. A task requiring a hostname the agent
cannot possibly learn is not a blind test, it is a trick — the agent burns its run on an unanswerable
question and you learn nothing about your descriptions.

### 3. Spawn the agent with the prompt template

Use a fresh agent with no conversation history. See the template in the next section.

**Enforce the isolation rules by tool availability, not by instruction.** Rules 1, 3 and 4 forbid HTTP
clients, memory systems, and hand-editing — and then section F asks the agent to certify it complied.
That certification is the one load-bearing claim in the protocol you cannot independently check: you can
reproduce a bug, but you cannot reproduce a *non*-read. Give the subject a trimmed toolset instead and
the rules stop depending on honesty:

```yaml
---
name: blind-probe
tools: Read, Glob, mcp__bruno-mcp__create_request, mcp__bruno-mcp__run_collection, …  # bruno tools only
---
```

Omit `Bash` (rules 1 and 4), every memory tool (rule 3), `Write`/`Edit` (rule 4), and `Agent`/`Task` —
that last one matters, or the subject can delegate to a less restricted agent and the whole scheme
unravels. A removed tool has no schema, so there is no call the agent can emit; this is categorically
different from a deny-rule, which has to filter an open-ended input.

Keep the rules in the prompt anyway. They cost nothing, they still cover rule 2, and section F remains
useful as a cross-check.

**What this cannot enforce:** rule 2, since inspecting its own artifacts requires `Read`. Scope `Read` to
the collection directory if your harness supports it. Round 3 did not, which left one hole worth naming:
an unscoped `Read` can reach the MCP client config (`~/.claude.json`), where server environment — the
SSRF allowlist among it — sits in plaintext. So "the agent could not have learned the route from
tooling" rested on self-report, not on structure.

**Stronger: run the probe as a separate process.** A subagent shares the parent session's MCP
connections, and that has two consequences worth spelling out.

The first is a correctness trap. Tool schemas are captured when the client connects, so a session that
started before you rebuilt the server keeps serving the **old** descriptions — and description wording is
usually the exact thing under test. Round 4 caught this before spending an agent: the session predated
the merge, so an in-session probe would have quietly graded the previous build and reported a pass on
text that was not there. Nothing warns you; the tools simply answer with stale schemas.

The second is that the parent's tool surface is the ceiling on what you can take away.

Both problems disappear if the subject is a fresh process with its own server:

```bash
claude -p "$(cat task.md)" \
  --mcp-config probe-mcp.json --strict-mcp-config \
  --allowedTools "mcp__bruno-mcp" \
  --disallowedTools "Bash,Read,Write,Edit,Glob,Grep,Task,WebFetch,WebSearch" \
  --output-format stream-json --verbose > trace.jsonl
```

with `probe-mcp.json` naming the build under test explicitly:

```json
{"mcpServers": {"bruno-mcp": {"command": "node", "args": ["<repo>/dist/index.js"],
  "env": {"BRUNO_WORKSPACE_PATH": "<tmp>/workspace.yml", "BRUNO_SSRF_ALLOWLIST": "<one entry>"}}}}
```

That buys three things the subagent version cannot:

- **MCP-only.** With `Read` gone the probe cannot reach `~/.claude.json`, which closes the allowlist hole
  named above. Rule 2 stops being a self-report too: point `BRUNO_WORKSPACE_PATH` at a `collections: []`
  registry and the real collections are not merely off-limits, they are invisible.
- **A known build.** The `args` path is the artifact you just built, so which code was graded is not in
  question.
- **A checkable trace.** `--output-format stream-json --verbose` records every call with its result, so
  section F stops being the agent's account of itself and becomes something you read directly.

The price is that removing `Read` also removes the probe's ability to inspect its own output files. It
works blind through the tools — which is the population the MCP surface is written for anyway.

One impurity survives: user-global instructions (`~/.claude/CLAUDE.md`, `SessionStart` hooks) still load
in the fresh process. Round 4's probe answered in the operator's house style, which was harmless. A
global file that discussed the server under test would not be. Check yours before relying on this.

### 4. Verify the report — do not trust it

The report is evidence, not truth. Independently confirm every load-bearing claim:

- **Re-run the request yourself** and check status plus the reported `tests` array.
- **Inspect the produced file** — correct dialect, single script block, variable actually used rather
  than a hardcoded host.
- **Reproduce each claimed bug minimally.** If the agent says a tool appends where it should replace,
  build a two-call probe (`create` with test `AAA`, `modify` with test `BBB`, count the blocks). If it
  says a response accessor auto-parses, write a request whose assertions state that directly:

  ```javascript
  test("getBody returns object not string", function(){ expect(typeof res.getBody()).to.equal("object"); });
  test("direct field access works", function(){ expect(res.getBody().successful).to.equal(true); });
  test("JSON.parse on body throws", function(){
    let threw = false;
    try { JSON.parse(res.getBody()); } catch (e) { threw = true; }
    expect(threw).to.equal(true);
  });
  ```

- **Check the real collections were untouched** if any live nearby.

Agents sometimes over-claim friction to sound thorough, and sometimes under-report rule breaks. Both are
caught by reproduction.

### 5. Tear down

Delete the sterile collection. Use `delete_request` for stray requests inside collections you intend to
keep.

## Prompt template

Substitute the bracketed parts. Keep the isolation rules verbatim — each one closes a specific leak, and
the self-report in F is what lets you detect an invalidated run.

```text
You are a CLEAN-ROOM DISCOVERABILITY TEST of the bruno-mcp MCP server. The goal is to measure whether an
agent with no prior knowledge and no examples to copy can build a working request using only the
bruno-mcp tool schemas and descriptions. Behave naturally, but the isolation rules below define the
experiment and must be followed exactly — breaking one invalidates the whole result, so if you are
tempted, stop and report the temptation instead.

ISOLATION RULES:
1. Use ONLY the bruno-mcp MCP tools to create, modify, and run the request. Do NOT use curl, wget,
   httpie, python/node HTTP clients, or any other direct HTTP call — not even to "check" your work or
   debug. If bruno-mcp cannot do it, that is a finding, not a reason to shell out.
2. Work ONLY inside this collection: [STERILE_COLLECTION_PATH]
   Do NOT read, grep, list, cat, or otherwise open any file belonging to any OTHER Bruno collection.
   Specifically off limits: [PATHS_OF_REAL_COLLECTIONS]. Calling list_collections is allowed, but do not
   open the files of any collection other than yours. The point is that you must not copy a working
   request from somewhere else.
3. Do NOT search or read any memory system: no signet_memory_search, signet_recall, memory_search,
   /recall, no MEMORY.md, no .omc/ notes, no session transcripts. Prior sessions may have solved this
   task and recorded the answer; reading it destroys the experiment.
4. Do NOT hand-write or hand-edit any request .yml/.bru file with Write, Edit, sed, tee, heredoc, or
   similar. Every request file must be produced by bruno-mcp tools. You MAY read files inside your own
   collection to inspect what the tools produced.
5. Do not modify anything outside your collection directory.

YOUR TASK:
[PLAIN-LANGUAGE GOAL, e.g. "A developer has a working curl invocation against an internal service and
wants it stored as a reusable Bruno request, with assertions, and verified green."]

[THE CURL INVOCATION]

Additional spec info you are given (this is service documentation, not a hint about Bruno):
- [SERVICE FACTS ONLY — hostnames, what a success response looks like]

Requirements:
- Create the request inside your collection in the folder [FOLDER], named [NAME].
- Attach assertions so that running it verifies [CONDITIONS]. The assertions must show up as reported
  pass/fail results in the run output, not merely execute silently.
- The request must be reusable rather than hardcoding the host inline — your collection has a `dev`
  environment; use it appropriately.
- Actually RUN the request via bruno-mcp against the `dev` environment and confirm it passes.

You are DONE only when a bruno-mcp run reports [SUCCESS CRITERIA] AND your assertions appear as passing
entries in the run result. If you hit errors, keep working the problem with the tools available — it is
solvable.

REPORT BACK — this report is the actual product of your work, so be precise, complete and honest:
A. FINAL OUTCOME: pass or fail. Paste the key fields of the final run result verbatim.
B. EXACT TOOL CALLS in order, with the arguments that mattered. Mark every retry and state exactly what
   you changed between attempts.
C. EVERY ERROR AND DEAD END, quoted verbatim. For each, say explicitly whether a tool
   schema/description/error message told you the fix, or whether you had to guess or experiment. Include
   anything that appeared to succeed but did not actually do what you expected.
D. DISCOVERABILITY RATING 1-5 from tool schemas and descriptions ALONE (5 = obvious, 1 = only by trial
   and error). Justify with reference to specific schema text that did or did not help.
E. SPECIFIC FRICTION: each place a tool name, parameter, description, default, or error message misled
   you or cost you a step. For each, state the concrete wording or behavior change that would have
   prevented it. Only report friction you actually hit — do not invent plausible-sounding issues, and do
   not pad the list. If something was smooth, say it was smooth.
F. ISOLATION SELF-REPORT: confirm explicitly that you used no curl/direct HTTP, opened no other
   collection's files, invoked no memory tools, and hand-edited no request file. If you broke or
   partially broke any rule, say so plainly — an honest report of a broken rule is far more useful than
   a clean-looking lie.
```

Three details in that template do real work and are easy to drop by accident:

- **"the assertions must show up as reported pass/fail results"** — without this, an agent can write bare
  assertions, get a green run with an empty `tests` array, and declare success. The requirement forces
  the reporting convention to be discovered.
- **"that is a finding, not a reason to shell out"** — pre-empts the single most common escape hatch.
- **Section F** — agents comply far better when asked to certify compliance, and an honest deviation
  report tells you whether to discard the run.

## Interpreting the result

**Pass/fail is the least interesting output.** A capable agent will usually get there eventually. What
matters:

- **Retry count and cause.** Each retry traceable to missing schema text is one concrete fix.
- **"Guessed" vs "schema told me".** Section C forces this distinction. Only the guesses are findings.
- **Silent wrong-success.** The worst class of gap: the call reports success but did not do what the
  agent asked. Weight these above hard errors, because they escape into users' collections unnoticed.
- **The rating trend across rounds**, but only between runs of comparable sterility. A contaminated 3/5
  and a sterile 4/5 are not on the same scale — the sterile run is strictly harder.

Treat the 1-5 rating as commentary, not as the measurement. It is the one output produced by the subject
rather than derived from evidence, and it is graded by the agent that just struggled. Retry count
attributable to missing schema text is already collected in section B, is objective, and is what
actually converts into fixes. Rounds 2 and 3 both scored 4/5 while differing sharply in what they found.

Discard a run if the agent reports opening another collection's files, using an HTTP client, or reading
memory. A partially-broken rule (e.g. `ls` on its own directory for discovery) does not invalidate the
result — it is not a source of the answer. Judge by whether the deviation could have leaked the answer,
not by strict letter.

## Worked example: four rounds

Round 1 was contaminated; rounds 2 through 4 were sterile, round 3 was additionally isolated by toolset
rather than by instruction, and round 4 moved the subject into its own process. Rounds 1 and 2 ran
against v1.2.3, round 3 against the post-#7 build, round 4 against the post-#8 build. All four targeted
the same real task — a `multipart/form-data`
document upload with a file part carrying an explicit `contentType`, asserted for HTTP 200 and a boolean
`successful` field.

**Round 1 (contaminated, rated 3/5).** The agent was pointed at the real collection. It found a sibling
request with a working `multipart-form` body and an environment already defining the host, and copied
both. So it never derived the body shape from the schemas, and — because the sibling supplied the
hostname — it never attempted the raw IP, meaning the SSRF-block recovery path never fired. Still
produced three genuine findings:

1. The `test()` wrapper requirement was undocumented. Bare assertions ran but produced an empty `tests`
   array, so the run looked green with nothing asserted. One retry.
2. `modify_request` appended scripts instead of replacing them, accumulating duplicate blocks —
   reproduced minimally with an `AAA`/`BBB` two-call probe.
3. No deletion tool existed, so the duplicate could not be undone through the server at all.

**Round 2 (sterile, rated 4/5).** Purpose-built empty collection, decoy-only environment, neutral names,
raw-IP curl with the hostname supplied as service documentation. All three round-1 gaps were confirmed
fixed: the `test()` convention is now spelled out in the `scripts` description and the agent got it right
on its **first attempt with zero retries**; `modify_request` now defaults to `scriptMode: "replace"`; and
`delete_request` plus `remove_script` now exist.

One new gap, responsible for the round's only failed run: `res.getBody()` auto-parses JSON responses and
the schema never says so. The agent called `JSON.parse()` on it and got
`SyntaxError: "[object Object]" is not valid JSON`. Confirmed independently with the three-assertion
probe shown above. *(Fixed in #7; round 3 confirms it — see below.)*

The pattern worth internalising: **round 1's most expensive gap became round 2's zero-cost step, purely
by adding a sentence to a description.** That is the whole return on this technique.

**Round 3 (sterile, structurally isolated, rated 4/5).** First round against the post-#7 build. Same
service, a fresh sterile collection (`stage/unit-a`), assertions requiring HTTP 200 plus two fields read
off the response body. **Pass, exactly one retry.**

The `res.getBody()` gap was confirmed fixed: the agent read `res.getBody().successful` and `.filename`
directly, with no `JSON.parse` anywhere in the produced file, and cited the new RETURN TYPE clause as
having "saved a guaranteed failed run". The `test()` convention was again correct first try. Three
rounds in, the two most expensive gaps ever found are now both zero-cost steps.

Round 3's one retry was the SSRF block, which is the first time that path has ever fired — see below.
It produced three findings, none of which cost more than the single retry:

1. **The SSRF refusal is diagnostic but not actionable.** It names the rule and the CIDR and stops
   there. No schema in the roster mentions that outbound requests are filtered at all.
2. **No tool can read an environment's variables.** `get_collection_stats` returned `environments:
   ["dev"]` — names only — so the agent read the YAML directly. Without file access it would have been
   merging into state it could not observe, which is exactly what `set_environment_variable`'s
   "MERGES into the environment" promises about.
3. **`list_collections` returned seven collections marked `exists: false` while omitting the real one**,
   because it is a `workspace.yml` registry dump rather than a filesystem scan. Cost no steps here (the
   agent had an absolute path) but it is a ready-made dead end.

All three are addressed in the same change that added this section: the refusal now carries remediation,
`get_collection_stats` exposes `environmentDetails` (variable names, values withheld), and
`list_collections` says what it actually lists. A fourth round is what decides whether those wordings
work — that is the point of keeping this document.

**Round 4 (sterile, MCP-only, separate process, rated 4/5).** First round against the post-#8 build, and
the first run as its own `claude -p` process rather than a subagent — which is the only reason it graded
the right code, since this session's server was still serving pre-#8 schemas. Zero-request collection,
`dev` holding three decoys and no host variable, the raw-IP `curl` again presented as the artifact to
reproduce, and the hostname demoted to one of three background wiki notes among decoys. **Pass, 3/3
assertions green.** Four runs, three retries — but only one caused by this server.

Two of the three round-3 wordings did their job:

- **The SSRF remediation worked, and the trace proves where the recovery came from.** The block fired on
  the raw IP and the message arrived whole, including `1 entry is configured; none match this target`,
  without naming the entry. One `set_environment_variable` call fixed it, and the agent's report cited
  the *error text* — round 3 recovered from the spec, which was the finding. This is the wording paying
  for itself.
- **`environmentDetails` removed a guessing step entirely.** One `get_collection_stats` call returned
  `[{name: dev, variables: [apiKey, authToken, retryCount]}]`; the agent saw no host variable and went
  straight to adding `baseUrl`. No probing, no invented variable name.
- **`list_collections` was never called.** The spec carried an absolute path, so the agent went directly
  to `get_collection_stats`. That rewording is still unexercised and is now the known untested path.

The `test()` convention and direct `res.getBody()` field access were both correct on the first attempt,
four and two rounds after those gaps were closed.

Round 4's own finding came from the two retries this server *did* cause:

**The failure messages were opaque.** The first hostname run hung for 95.9s and returned only
`The operation was aborted due to timeout` — no target, no limit, no elapsed time, no indication whether
a retry was worth anything. The agent read it as evidence the address was wrong, switched the URL to
`https://`, got `fetch failed` in 109ms (the real cause, `ECONNREFUSED`, never surfaced), and then
reverted to the identical `http://` config, which passed in 210ms. Two runs spent because neither message
said what it knew. Both are now enriched: timeouts name the target, the elapsed time, `settings.timeout`
and how to change it, and state plainly that a timeout is not evidence the URL is wrong; `fetch failed`
digs the socket-level code out of the `cause` chain and explains it.

One anomaly recorded rather than explained: the abort signal is armed at `settings.timeout` (30s by
default) but 95.9s elapsed, and that measurement excludes DNS validation. The limit did not hold. The new
message reports the configured limit and the real elapsed time side by side specifically so the next
occurrence is visible instead of being rounded away.

## The SSRF path — covered in rounds 3 and 4

For two rounds this section read "known untested path". Both agents were given the hostname prominently,
sensibly used it, and never touched the private IP, so nobody ever had to recover from
`SSRF blocked: Blocked IP: private address (10.0.0.0/8)`.

**What made it fire:** present the raw-IP `curl` as the artifact to reproduce *faithfully*, and demote
the DNS name to a service fact further down the spec. An agent transcribing the invocation honestly then
reaches for the IP on its own. The block fired, and recovery cost one `set_environment_variable` call —
the request file was never touched.

Do not withhold the hostname entirely. The allowlist is operator configuration read from the server's
environment; an agent cannot add itself to it, so a spec with no allowlisted route makes the task
unsolvable rather than hard. That is the trick this document warns about in step 2.

**The finding this produced is about where the recovery came from: the task spec, not the tooling.**
Nothing in any schema mentioned SSRF, allowlisting, or private-address filtering, and the error named no
remedy — no config key, not even an acknowledgement that an allowlist mechanism exists. An agent given
only the curl would have been stuck with no in-band way to discover a route existed.

Round 4 re-ran the same path against the remediated message and settles what the wording is worth. The
message cannot hand over a route — entries are deliberately never echoed, so an agent that does not
already know an allowlisted name still cannot invent one. What changed is the shape of the dead end: the
refusal now names the mechanism, says how many entries exist without disclosing them, and tells the agent
to escalate to the operator rather than keep trying. Round 4's agent recovered in one move and credited
the error text for it. The correct outcome for a genuinely unreachable target is still a clean stop —
that branch of the message (`No entries are configured`) has not itself been exercised blind.

Worth recording for future rounds: the guard matches allowlisted **hostnames before DNS resolution** and
allowlisted **IPs/CIDRs after**, so the same host can be refused by address and permitted by name. That
asymmetry is a config choice, not a property of the target.

## Checklist

Before:

- [ ] Sterile collection: zero requests, zero script examples
- [ ] Environment: decoys only, no host/URL variable
- [ ] Names neutral enough that grepping for them finds nothing
- [ ] Spec contains service facts only, no tool facts
- [ ] Task is genuinely solvable from schemas plus spec
- [ ] Isolation rules 1–5 present verbatim; report sections A–F requested
- [ ] Subject's toolset trimmed: no `Bash`, no `Write`/`Edit`, no memory tools, no `Agent`/`Task`
- [ ] `Read` scoped to the sterile collection, or the gap noted in the write-up
- [ ] **The server under test is the build you think it is** — a session started before the rebuild
      serves the old schemas; run the probe as its own process pinned to the freshly built `dist`
- [ ] `BRUNO_WORKSPACE_PATH` pointed at a `collections: []` registry, so real collections are invisible
- [ ] User-global `CLAUDE.md` and `SessionStart` hooks checked for anything about the server under test
- [ ] Target service confirmed reachable before spending the agent, and the exact request verified by
      hand so ground truth is known

After:

- [ ] Re-ran the request independently
- [ ] Read the call trace, not just the report, and checked the two against each other
- [ ] Inspected the produced file (dialect, script blocks, variable use)
- [ ] Minimally reproduced every claimed bug
- [ ] Read section F and judged whether any deviation could have leaked the answer
- [ ] Real collections confirmed untouched
- [ ] Memory searched for the round's identifiers, to confirm nothing leaked into a store
- [ ] Sterile collection torn down
- [ ] Each "guessed" step converted into a concrete wording change
