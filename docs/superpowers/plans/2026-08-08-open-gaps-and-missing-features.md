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

### A3. Scripts and assertions never run on gRPC or WebSocket requests

**Severity: highest in this document.**

**Evidence.** A collection with `runtime.scripts` (pre-request, post-response and
a tests block with two `test()` calls) and `runtime.assertions` on a WebSocket
request returned:

```
"summary": {"total":2,"passed":2,"failed":0,
            "tests":{"total":0,"passed":0,"failed":0},
            "requestsWithoutTests":2}
```

Confirmed in the source rather than left as a black-box observation:
`request-executor.ts:183` enters the WebSocket branch and returns at 197, before
the HTTP path that runs scripts and assertions.

**Wider than the probe found.** The gRPC branch immediately above, at 164–181,
returns the same way. Scripts and assertions never run for **either** transport.
Only WebSocket was probed; gRPC has the identical hole and is easier to miss
because a gRPC result looks busy.

**Why it matters.** A gRPC or WebSocket request cannot fail. It has no way to
express "the server echoed X" or "the response contained Y", so in a mixed
collection both kinds inflate `passed` with zero verification. `requestsWithoutTests`
is the only signal, and it reads as a user omission rather than a capability that
does not exist.

**Done when:** scripts and assertions run for both transports, or the request is
refused with an explicit reason. Silently counting an unverifiable request as
passed is the behaviour to remove either way.

### A4. Message `type` is decorative; binary frames cannot be sent at all

**Evidence.** Echoed back by the server, so this is what reached the wire:

```
type: json,   data: a YAML mapping        → sent 15B "[object Object]"
type: binary, data: "AQIDBA=="            → sent  8B "AQIDBA=="   (ASCII, not 4 bytes)
type: base64, data: "aGVsbG8gYmFzZTY0"    → sent 16B "aGVsbG8gYmFzZTY0"
type: hologram (bogus)                    → sent 18B "bogus-type-payload", no error
```

Every declared type sends `String(data)` as a text frame. A JSON *string* payload
happens to work because it is already a string.

**Why it matters.** There is no way to send a binary WebSocket frame, and no way
to discover that. Any binary protocol — protobuf over WebSocket, MessagePack —
is untestable and fails invisibly, having declared a type the runner accepted.

**Done when:** `binary`/`base64` decode, `json` serialises or is refused, and an
unrecognised type is an error rather than a silent text frame.

### A5. An auth block using the `mode:` spelling is silently ignored

**Evidence.** `auth-apply.ts:86` reads `const mode = String(auth.type ?? 'none')`.
A block spelled `{mode: bearer, bearer: {token: …}}` therefore resolves to `none`
— no credential is applied, and no warning is produced, because the unrecognised-mode
branch at line 124 only fires for a `type` that is *present* and unknown. An
unknown *value* is loud (`auth mode "quantum" is not applied …`); an unknown
*shape* is silent.

**Settled against upstream, not guessed.** In
`packages/bruno-filestore/src/formats/yml/common/auth.ts`, every on-disk auth is
built as `{ type: … }`. `mode` is Bruno's *in-memory* spelling, which
`toOpenCollectionAuth` converts away from. So `.type` is the correct on-disk key
and the applier is right — the defect is accepting the other shape silently
instead of warning.

**Related asymmetry, believed intentional.** Collection and folder roots do use
`mode` on disk and are explicitly translated by `normalizeRootAuth`
(`collection-roots.ts:174`). Requests are not translated. Worth confirming that
root spelling against upstream too, since the same reasoning applies.

**Why it matters.** This is not WebSocket-specific — it is the shared auth path —
but WebSocket has no assertions (A3) to catch it, so a whole authenticated suite
can report success having sent no credential at all. The probe lost its entire
first auth battery of twelve requests to exactly this, every one reporting
success.

**Done when:** an auth block that cannot be interpreted produces a warning, in the
same voice as the unknown-mode message.

### A6. `maxTranscriptBytes` overshoots by a whole frame

**Evidence.** With `maxTranscriptBytes: 100`, a single frame recorded 1968 bytes —
roughly twenty times the budget — because the cap is checked after the entry is
appended.

**Why it matters.** The option exists to stop an unbounded socket blowing up the
tool response, and one large frame defeats it. `maxFrameBytes` already does the
right thing: it clips before storing while still reporting the true `bytes`.

**Done when:** the transcript is clipped to the remaining budget before storing.

### A7. A malformed message fabricates an empty frame

**Evidence.** A message entry with no inner `message` object, and one with no
`data` key, each sent a 0-byte frame rather than failing.

**Why it matters.** An empty frame is a meaningful protocol event. Inventing one
from a malformed request is worse than refusing the request.

### A8. A request that sends nothing is reported as a pass

**Evidence.** Five separate shapes — `selected` omitted, `selected: "false"` as a
string, zero selected, an empty message list, and no `message` key — all connect,
send nothing, and report `passed` with no warning. The check is `=== true`, so
the string `"false"` is also not-sent, correctly, but silently.

**Why it matters.** The same principle is already applied one level up, and
applied well:

```
"warnings": ["No runnable requests were found …, so this run executed nothing.
              Zero requests is not a pass.",
             "Group 0 resolved to no requests. An empty group is reported rather
              than passing silently."]
```

That reasoning stops at groups and does not reach messages. An externally
generated file that omits `selected` connects, sends nothing, and goes green.

### A9. Pre-flight refusals lose their `url`

**Evidence.** Every refusal raised before dialling reports `url: ""`. Requests
that executed, and connection-level failures, report it correctly.

**Why it matters.** Minor, but it is the field a caller uses to tell which target
was refused when several are refused at once.

### A10. Unknown `websocket` option keys are accepted silently

**Evidence.** `{"websocket": {…, "bogusOption": true}}` ran normally, while
out-of-range *known* keys are properly rejected by the schema.

**Why it matters.** A typo such as `maxMessage` for `maxMessages` silently falls
back to the default, and the run looks fine.

### A11. Parse errors end at a dangling colon

**Evidence.** `"Failed to parse .bru file: Line 7, col 1:"` — the message stops
where the offending content should follow. Cosmetic, but it reads as truncated
output rather than a complete diagnostic.

---

## A-policy. OAuth2 token-fetch failure downgrades to an unauthenticated request

Separated from the defects above because it is **deliberate**, and filing it as a
bug would send someone hunting for a fault that does not exist.

**Evidence.** With an unresolvable `accessTokenUrl`, the request connected anyway
and the run reported passed, carrying only a warning:

```
warnings ["oauth2 token endpoint blocked: DNS resolution failed for hostname: …"]
error    null
```

**Why it is not a bug.** `request-executor.ts:172` documents the intent: *"a
failed exchange is a request sent without the credential, not a run that stops"*,
and the HTTP, gRPC and WebSocket paths all fold the failure into warnings the same
way. It is consistent policy, not an oversight, and it is unrelated to the
"refuse rather than send bare" contract, which governs auth *modes a transport
cannot honour* — those are correctly refused, with reasons.

**The question worth putting to a human.** Against a server that permits anonymous
access, this produces a green run that proved nothing. Whether a credential that
was *intended and unavailable* should behave like a credential that was never
configured is a product decision. Changing it would affect all three transports.

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

### B5. The WebSocket transcript is missing most of what a diagnosis needs

Surfaced by the live probe. Each of these is small on its own; together they are
why a failed session is hard to read.

- **No frame type.** Entries are `{direction, offset_ms, bytes, payload}` only, so
  a text frame cannot be told from a binary one.
- **No control frames at all** — ping, pong and close are absent, *including the
  close code and reason*, which is frequently the entire diagnostic value of a
  WebSocket failure.
- **No message title.** `title:` is authored but never returned, so correlating a
  transcript entry back to the file means matching payloads by hand.

**Done when:** a transcript entry carries its frame type and its authored title,
and close frames appear with their code and reason.

### B6. No inter-message pacing

**Evidence.** All selected messages are sent in one tick — three sends all
recorded at `156ms`.

**Why it matters.** Any send-wait-send protocol is out of reach. Combined with A3,
this means a request/response protocol over WebSocket can be neither driven nor
asserted on.

### B7. No subprotocol field

There appears to be no way to express `Sec-WebSocket-Protocol`. Untested — the
probe had no server requiring one — so confirm before building.

### B8. `.bru` cannot express a WebSocket request

**Evidence.** A hand-written `.bru` WebSocket request is rejected, and reported
honestly:

```
"parseErrors": 1,
"parseFailures": [{"file": ".../bru/ws.bru", "message": "Failed to parse .bru file: Line 7, col 1:"}]
```

It fails loudly rather than silently, so this is a gap and not a defect. But
combined with the per-collection format rule, it means a `.bru` collection cannot
contain WebSocket requests at all — the dialect choice silently decides which
transports are available.

### B9. A WebSocket request always burns its full duration budget

**Evidence.** Eight requests at `maxDurationMs: 2500` took `22058 ms` in total,
strictly sequential. Sessions end early only on `count` or `bytes`; there is no
idle close.

**Why it matters.** At the 5000 ms default, a twenty-request WebSocket collection
takes about 100 seconds even when every peer answers in 200 ms. That is a
usability cliff for exactly the mixed collections this feature was built for.

**Done when:** a session can end on idle, or the default is reconsidered.

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

### D2. WebSocket handshake header content is unverified on the wire

The largest hole the live probe could not close, and it named it rather than
papering over it. No public WebSocket endpoint reflects request headers back, so
nothing confirms that an authored header is actually sent, that a `disabled` one
is not, which of two duplicates wins, or that `Authorization: Bearer` reaches the
handshake. HTTP controls through the same server prove those behaviours *for
HTTP*, but that is a different code path.

**One header conclusion is solidly established, and it is negative:**
`Connection: close`, `Upgrade: h2c` and `Sec-WebSocket-Version: 8` were authored
and the connection upgraded anyway. A conforming server could not have done that,
so those headers are silently overridden rather than rejected.

**Done when:** a local WebSocket listener in the test suite records the handshake
and asserts on it. Everything else about WebSocket header content is currently
inference from reading `ws-transport.ts`, including the diagnosed-not-observed
claim that duplicate header names collapse last-wins on WebSocket where HTTP
joins them.

### D3. Paths that exist in the code but were never triggered

- **`stop_reason: "closed"`** — neither echo endpoint closes the connection, so
  the peer-close path, close codes, and whether `truncated` is false there are all
  unverified.
- **`engineIoKeepalive` end to end** — no reachable engine.io endpoint during the
  probe; `wss://ws.postman-echo.com/socketio/` returned 502. This overlaps D1.
- **Received binary frames** — no endpoint sent one, so inbound binary rendering
  is unverified as well as outbound (A4).
- **WebSocket inside parallel execution groups** — sequential behaviour measured,
  parallel not.

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

---

## Verified sound

Recorded because a gap list that only lists failures misrepresents the state of
the thing. All of the following were confirmed by the live probe against
`wss://echo.websocket.org`, not asserted.

- **SSRF gating covers WebSocket.** `ws://127.0.0.1:1/` is refused as an
  authorization decision, with a message that says it will not resolve by
  retrying. `file:///etc/passwd` is refused on scheme. NXDOMAIN is blocked before
  dialling.
- **Header injection is impossible.** CR, LF and NUL in a header name or value are
  all refused before the socket opens.
- **Timeout containment covers the handshake**, not just the session: a blackholed
  port with `maxDurationMs: 1500` returned at 1507 ms.
- **Option bounds are enforced by the schema**, by name, at both ends of every
  range — 0 and 1001 for `maxMessages`, 99 and 60001 for `maxDurationMs`.
- **`stop_reason` accurately distinguishes** `count`, `timeout`, `bytes` and
  `error`.
- **Credentials are redacted in reported URLs**: an api-key query parameter comes
  back `REDACTED`, and URL userinfo is stripped entirely.
- **`maxFrameBytes` clips the recorded payload while still reporting the true
  byte count** — the honest way round, and the model A6 should follow.
- **Kind and payload disagreement is caught** with a message naming both.
- **Payload fidelity holds**: empty, ~2 KB, unicode with emoji, and embedded-NUL
  payloads all round-trip byte-exactly, and ordering is preserved.
- **Variables interpolate** in url, headers and payloads, including dynamic ones,
  with undefined variables passing through unexpanded as Bruno does.

One known-and-accepted item, flagged rather than filed: a variable declared
`secret: true` appears verbatim in the transcript. HTTP returns it verbatim in
`response_body` too, so this is product-wide policy rather than a WebSocket
regression — but WebSocket transcripts are on by default and echo endpoints
reflect payloads back, which doubles the exposure.
