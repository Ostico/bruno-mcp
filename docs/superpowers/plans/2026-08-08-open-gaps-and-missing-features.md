# Open gaps and missing features

**What this is:** the standing list of what this server does not do, and what it
does wrongly. One entry per item, each with its evidence, its impact, and what
"done" would mean.

**How it was compiled, 2026-08-08, against the 2.2.1 build:** by checking the
current source and by driving the real tool surface, not by copying forward an
earlier list. That mattered — two items carried as open had already been closed,
and are recorded at the bottom so they are not re-litigated.

**Not ranked as a work order.** Section A is defects and should generally go
first; section C is deliberate and should generally not be started at all until
its stated trigger fires.

---

## A. Defects

Things that behave wrongly today.

### A1. The reader and the writer disagree about collection dialect

**Evidence.** `run_collection` discovered and executed a `.yml` request inside a
collection whose root manifest is `bruno.json`. `modify_request` refuses the
identical pair:

> `File extension ".yml" does not match collection format "bru" (expected ".bru")`

**Why it matters.** Format is a per-collection property: the root manifest picks
the dialect and Bruno scans that extension only. A mixed collection is therefore
invisible to Bruno itself. The permissive reader will happily run a file that the
tool your users actually open would never see, so a collection can pass here and
be silently incomplete there.

**Trap.** The existing gRPC and WebSocket integration fixtures are built as
`bruno.json` plus `.yml` files and depend on the permissive reader. Tightening it
without updating them looks like a large unrelated breakage.

**Done when:** one decision applied in both directions, fixtures updated, and a
test pinning whichever behaviour was chosen.

### A2. The writer injects a `settings:` block the source file never had

**Evidence.** A `.yml` WebSocket request was renamed via `modify_request`. The
file came back with a `settings:` block carrying `encodeUrl`, `timeout`,
`followRedirects` and `maxRedirects` that it did not contain before.

**Why it matters.** Possibly nothing — upstream may write the same defaults, in
which case this is byte-parity and correct. Possibly our writer inventing content
the author never wrote, which is the same family as `.bru` injecting `seq: 1`.
Unknown is the problem, not the injection.

**Done when:** compared against a file Bruno itself writes, by reading the
upstream writer at `/Volumes/Projects/tools/working_dir/bruno-tool`. Then either
a test pinning the injection as intended, or a fix. Do not infer the answer from
our own round-trip — our parser tolerates our own malformed output.

### A3. Findings from the live WebSocket probe

An adversarial probe of the run path against `wss://echo.websocket.org` was in
flight when this document was written: headers including handshake-header
collisions and CRLF injection, every auth mode, payload types and sizes, all six
`websocket` run options at their boundaries, variable substitution and secret
leakage into the transcript, and the error paths.

**Done when:** its findings are triaged into this document as their own numbered
entries, or dismissed with a reason. Placeholder, deliberately not pre-judged.

---

## B. Missing capability

Things a caller can reasonably want that there is no way to do.

### B1. Authoring gRPC and WebSocket requests

**Evidence.** `create_request` has no transport-kind discriminant; its schema is
HTTP-shaped throughout. `modify_request` on a WebSocket request permits only
`name` and `seq` — every other field is refused, correctly and explicitly.

**Why it matters.** Through this server alone there is no path to a gRPC or
WebSocket request at all. The stated fallback — "an agent can copy a file Bruno
wrote" — assumes the agent has such a file and a way to put bytes on disk. The
first end-to-end use of the feature required hand-authoring YAML with a
general-purpose writing tool, against a format the author had to be taught.

**Done when:** see `2026-08-08-transport-authoring-tasks.md`, which breaks this
into seven tasks. Note A1 and A2 above were found while measuring it and are
tracked there too; they are repeated here because they are defects, not features.

### B2. Response headers are not returned

**Evidence.** A run result carries `response_body`, `response_content_type` and
`response_body_truncated`. There is no response-headers field anywhere in the
result shape.

**Why it matters.** Headers are reachable only by capturing them in a test script,
which means the caller must author a script to see something the runner already
had in hand. For security testing specifically — checking `Set-Cookie` flags,
`Strict-Transport-Security`, CORS headers, cache directives — this is the
difference between a one-call check and a scripted workaround.

**Design note before starting:** response bodies are already returned by default
and that decision was taken deliberately, so the argument for gating headers
behind a flag is weaker than it looks. Prefer narrowing what is returned by
default over adding a second mask.

**Done when:** headers are available on a result without authoring a script, with
whatever redaction policy matches the existing body handling.

### B3. No report file output

**Evidence.** No JUnit, HTML or any other report writer exists in `src/`.

**Why it matters.** CI wants a JUnit XML file; humans want an HTML summary. Today
the caller gets JSON in a tool result and has to build both themselves.

**Known costs, established earlier and worth not rediscovering:**
`generateHtmlReport` already ships in the dependency tree, so the serializer is
not the work. The data is: results carry no file path, assertions and the
request/response exchange are split, and a realistic HTML report is around 31 KB,
which cannot go inline in a tool result. So this needs a written-to-disk contract
and a path returned, not a bigger payload.

**Done when:** a run can write JUnit and/or HTML to a caller-named path and return
that path.

### B4. No iteration or data-driven primitive

**Evidence.** Nothing resembling iteration count, iteration index, or a data file
exists anywhere in `src/`.

**Why it matters.** Running the same request over a list of inputs — the standard
data-driven test shape, and the natural way to do enumeration or fuzzing — has no
expression. The nearest workaround is naming the same request repeatedly in the
`requests` list, which duplicates rather than parameterises: every run gets the
same variables.

**Interaction:** execution groups already give each group its own variable store
and cookie jar. An iteration primitive should be designed against that, not
alongside it — "iterate this group over these variable sets" may be most of the
feature.

**Done when:** a run can supply N variable sets and get N result sets back,
distinguishable in the output.

---

## C. Deliberate exclusions

Recorded so they are not mistaken for oversights. Each has a trigger that would
justify reopening it; absent that trigger, leave them alone.

### C1. gRPC streaming and server reflection

Unary is a request and a response, which fits the existing per-request result
shape. A stream does not — it needs a session outliving the call, a bound on what
is recorded, and somewhere to put a transcript. Reflection additionally means a
round trip before the call, changing what a run contacts.

**Reopen when:** a caller needs it. The WebSocket transcript and its bounds are
now a working model for what streaming results would look like, so the cost is
lower than when this was first deferred.

### C2. Proxy and certificate pinning for gRPC and WebSocket

The existing gates are undici-only. `@grpc/grpc-js` has no public proxy API and
honours ambient `http_proxy` whether asked to or not — which is why the channel
now sets `grpc.enable_http_proxy: 0` unconditionally. `ws` needs its own agent to
be proxied at all.

**Reopen when:** someone needs to run these transports through a proxy. Until
then the honest position is that the gates are documented HTTP-only rather than
quietly extended to transports they do not cover.

### C3. Sessions held open across tool calls

A handle implies a lifetime this server does not have. A tool call is the unit of
work; a socket left open between calls outlives the request that created it with
nothing responsible for closing it.

**Reopen when:** never, without a design for ownership and cleanup first.

### C4. A `socketio` or `mqtt` block in either dialect

We do not own either file format. Both are open upstream — `usebruno/bruno#5887`
(socket.io) and `usebruno/bruno#6511` (MQTT). A private dialect would collide with
whatever lands there and then need users migrated off it.

socket.io is reachable today as a plain `ws` request; the recipe is in
`docs/superpowers/specs/2026-08-06-grpc-websocket-design.md`, and
`websocket.engineIoKeepalive` exists to make sessions longer than `pingTimeout`
possible.

**Reopen when:** upstream picks a spelling.

---

## D. Verification gaps

Things believed to work that nothing actually proves.

### D1. No end-to-end socket.io session

The socket.io recipe's steps 1–5 were measured against a real socket.io 4.8.3
server while planning the transport work. Step 6 — the keepalive reply — is
covered only against a purpose-built engine.io peer, because what those tests
must observe is our own reply and its two gates.

**The gap:** one real end-to-end session against socket.io driven by the published
recipe. Nothing in the suite performs it, so the recipe is documentation that has
never been executed as a whole.

**Done when:** an integration test, or a recorded manual run, drives all six steps
against a real socket.io server.

---

## E. Visibility and project, not code

### E1. Detach the fork

The repository is `isFork: true` with `parent: null`, so it is excluded from
GitHub repository search — `gh search repos "bruno mcp"` does not find it.
Requested from GitHub support and pending as of 2026-08-08. Not a CLI operation.

### E2. Downstream aggregator listings

The official MCP registry listing went live with 2.2.1 and now updates itself on
every release. mcp.so, Glama, PulseMCP and Smithery ingest the official registry
on their own schedules; whether they have synced has not been checked.

### E3. Comment on `usebruno/bruno#7541`

Upstream maintainers are discussing programmatic runner capability, which is
precisely what this server is.

---

## Closed since the previous sweep

Recorded so they are not re-added from stale notes.

- **Request settings are authorable.** `create_request` takes a `settings`
  argument covering timeout and redirect behaviour.
- **OAuth2 and digest configuration is authorable.** `auth` takes `type` plus a
  free-form `config` record, so mode-specific configuration is no longer dropped.
- **Declared assertions, request vars and inline scripts are authorable** via
  `assert`, `vars` and `scripts`.
- **The transport-block destruction bug is fixed and verified against disk.** A
  rename through `modify_request` preserved a WebSocket request's URL, bearer
  token, headers and both messages with their `selected` flags.
