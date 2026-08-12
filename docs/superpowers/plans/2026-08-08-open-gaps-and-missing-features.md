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

**Updated 2026-08-10.** All eleven defects are closed, plus the two found while
measuring them: A5, A6, A8, A9 and A10 in #154, A4 and A7 in #155, A3 in #157, A2
in #158, A1 in #159, A12 and A13 in #161, and A11 in #162. Their entries are kept
in place, marked CLOSED, rather than moved to the bottom — the evidence in them is
why they were found, and a reader who meets the same symptom again should land on
it. Three also have their classification corrected: A4 was filed as "binary frames
are broken", and the upstream source says there is no binary path to break; A2 was
filed as "the writer injects a block the source never had", and upstream injects
the same block — the real fault was narrower and elsewhere in the same code; and
A11 was cleared as an evidence artefact when it was the defect it looked like.

Two new defects were found while measuring A2 and are filed as A12 and A13.

**A1 closed 2026-08-09 in #159**, in the permissive direction: a request whose
extension its collection's dialect does not read is now operated on and warned
about rather than refused, on both the read and the write side. See its entry for
what only surfaced by doing it.

**A12 and A13 closed 2026-08-10 in #161**, together, both being settings-parser
fidelity: an authored `timeout: inherit` is now modelled and honoured in both
dialects, and an unrecognised `settings.tls` block survives a write instead of being
deleted.

**A11 closed 2026-08-10 in #162**, after being reopened: a `.bru` parse failure
reported its position and no reason, because the report kept the first line of an
error whose reason is on its last. That is also what caused B8 to be filed as a
missing format feature, so B8 is withdrawn — see both entries. **Every defect in
section A is now closed.** What remains in this document is sections B onward, plus
the A-policy question below, which was never a defect.

**Section B is being worked through in order of what unblocks the rest**: B2 in
#163, then B5 and B9 together in #164 — both being about how a session ends and how
what happened in it is read — then B6 and B7 together in #165, which is what makes a
send-wait-send protocol drivable and its handshake negotiable. B7's own guess about
itself was wrong, in a way worth keeping: an authored header was not merely
ineffective, it aborted the handshake. Then B3 in #166, which is what lets a run
leave something behind for CI to read. Then B4 in #178, which turned out to need no new
isolation machinery at all: an iteration is a group, so a row inherits the store, cookie
jar and token cache a group already owns. What remains in section B is B1 (authoring
either transport through the tool surface) and B10.

---

## A. Defects

Things that behave wrongly today.

### A1. The reader and the writer disagree about collection dialect — CLOSED (#159)

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

**Closed by #159, in the permissive direction.** The decision was already
documented in this repo for `.yaml` — read the file, and warn that Bruno will not
— and it applies here for the same reason: refusing left the caller unable to
repair the one file that was being executed anyway. The four tools that refused
now succeed with a warning naming the file and the rename, and discovery emits
the same warning for every mismatched request it finds, so the run path reports
what it previously executed in silence. The trap above dissolved rather than being
worked around: nothing was tightened, so no fixture depended on a stricter reader.

Confirmed at the source first, since the fix rests on the claim that Bruno really
cannot see the file: `bruno-cli/src/utils/collection.js:28` skips any entry whose
`path.extname` differs from `FORMAT_CONFIG[format].ext`, with `format` read from
the root marker.

Two things surfaced only by doing it. The refusal was **masking a latent write
fault**, not preventing it — `add_test_script` chose its serialiser from the
collection's dialect, so the first caller past that gate would have had `.bru`
text written into a file named `.yml`; the dialect now follows the file. And the
two warnings had to be made mutually exclusive: in a `.bru` collection a `.yaml`
request trips both, and the `.yaml` warning's advice (rename to `.yml`) would have
left it exactly as invisible.

### A2. The writer injects a `settings:` block the source file never had — CLOSED (#158), AND MISFILED

**Evidence.** A `.yml` WebSocket request was renamed via `modify_request`. The
file came back with a `settings:` block carrying `encodeUrl`, `timeout`,
`followRedirects` and `maxRedirects` that it did not contain before.

**What the measurement found.** The injection is not the fault. Upstream's three
`.yml` writers in `@usebruno/filestore/src/formats/yml/items` disagree about this
block, and each was read rather than inferred:

- `stringifyHttpRequest.ts:113-141` is **unconditional**. It builds all four keys
  and assigns `ocRequest.settings = settings` for every request, defaulting
  `encodeUrl` and `followRedirects` to true, `maxRedirects` to 5 and `timeout` to
  0. For an HTTP request this server already matched it, deliberately, and that
  is still right — the `.yml` reader treats an omitted `encodeUrl` as **true**
  while a missing block means false, so writing no block changes how the request
  runs.
- `stringifyWebsocketRequest.ts:105-113` writes a **different pair** —
  `timeout` and `keepAliveInterval`, both defaulting to 0 — and none of the other
  three. Its reader produces that object for every WebSocket request, so the block
  is always present there too.
- `stringifyGrpcRequest.ts` writes **no settings block at all**.

So the fault is narrower than filed: this writer applied the HTTP shape to all
three kinds. The four keys describe redirect-following and URL encoding, which
neither transport does, and upstream's own gRPC and WebSocket readers never look
at them. A WebSocket request also lost the one key it should have had.

**Fixed in #158.** The block is now chosen by kind. gRPC keeps one the source
authored but gains nothing — a deliberate deviation from upstream, which drops it:
`grpc-transport.ts:374` and `ws-transport.ts:281` both gate TLS on `settings.tls`,
so suppressing the block outright would disarm the gate on the next write.
Suppressing invention is the fix; suppressing the author's own content would be a
different bug.

**What this shows.** The original entry said "Unknown is the problem, not the
injection", and that was the right call — the answer was neither "byte-parity, do
nothing" nor "stop injecting". Reading the three upstream writers was the only way
to see that the block is right, the kind is wrong, and a key was missing.

### A3. Scripts and assertions never run on gRPC or WebSocket requests — CLOSED (#157)

**Severity: highest in this document.**

**Closed 2026-08-09.** Both transports now return a `TransportOutcome` carrying a
`MockResponseData`, and post-response scripts, `test()` blocks, assertions and
`vars:post-response` all run through the same `runVerification` the HTTP path
uses. `res` reports what happened rather than translating it into HTTP: gRPC's
`res.getStatus()` is the gRPC code, so **0 is OK**, and a WebSocket session has
`res.getStatusText()` as its stop reason with the transcript as `res.getBody()`.

**Still open, deliberately scoped out:** pre-request scripts do not run for these
transports. `req.setUrl`, `setHeader` and `setBody` have no target when the
transport builds its own request, which is separate machinery and its own change.

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

### A4. Message `type` is decorative; binary frames cannot be sent at all — CLOSED (#155), AND MISFILED

**Closed 2026-08-09, but read the correction first: the headline above is wrong.**

The defect was real and is fixed. Its *diagnosis* was not, and the difference
matters because acting on the original wording would have made the tool worse.

**What the upstream source says.** Bruno has no binary WebSocket path anywhere.
The only `.send()` on a ws socket is `bruno-requests/src/ws/ws-client.js:218`, fed
by `normalizeMessageByFormat` in the same file, whose every branch returns a
string — the value unchanged, `JSON.stringify(...)`, or `''`. No `Buffer.from`, no
base64 decode, no file read exists in the ws client, the WS UI components, or the
opencollection converter. `type` itself is `Yup.string().nullable()` in
`bruno-schema` with no `.oneOf`; the only enumerated list is the UI constant
`RAW_MODES` = `json`, `xml`, `text`, and the editor collapses anything else to
text.

So `binary` and `base64` are **not upstream concepts**. "Binary frames cannot be
sent at all" describes the format, not a fault in this server, and decoding them
here would have put bytes on the wire that Bruno's own runner never sends — the
trade this project has refused elsewhere. A binary transport stays a gap in the
format, and belongs in section B, not here.

**What the actual defect was**, and what #155 fixed:

- A declared type outside `text`/`json`/`xml` was accepted in silence. It is now
  named in a warning, with an extra sentence for `binary` and `base64` saying the
  gap is in the format rather than in a setting to correct. The frame still goes
  out unchanged.
- **The bug the probe did not find:** a `data:` written as a YAML mapping — the
  obvious way to author a JSON payload in YAML — was `String()`-ed into the
  literal characters `[object Object]` and sent. Now serialised with
  `JSON.stringify`, matching `normalizeMessageByFormat`'s own non-string branch;
  a payload that is already a string is left byte-for-byte alone.
- **Wider than WebSocket:** the gRPC message branch carried the identical
  `String()`. It was harder to spot for the inverse reason to usual — there the
  mangled payload hit `JSON.parse` and failed loudly, so it read as a bad request
  file rather than as our defect. A mapping body works there now.

**The lesson worth keeping.** A black-box probe reports what it could not do. It
cannot tell "this server is broken" from "this format has no such thing", and it
guessed the first. Check the upstream source before filing a fidelity defect.

*Original entry follows, unedited.*

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

### A5. An auth block using the `mode:` spelling is silently ignored — CLOSED (#154)

**Closed 2026-08-09, with the framing corrected.** The applier reading `.type` is
*right*: `bruno-filestore/src/formats/yml/common/auth.ts` builds every on-disk auth
as `{ type: … }`, and `mode` is Bruno's in-memory spelling. "Fixing" it by
accepting `mode:` on a request, as the heading implies, would have broken correct
behaviour. What was wrong was accepting an uninterpretable block in silence: a
block with no `type` key now warns, names the keys it did find, and points at the
root-versus-request spelling when it sees `mode`.

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

### A6. `maxTranscriptBytes` overshoots by a whole frame — CLOSED (#154)

**Closed 2026-08-09.** The payload is clipped to the remaining budget before
storage, while the reported `bytes` still gives the frame's true size — the
arrangement `maxFrameBytes` already had.

**Evidence.** With `maxTranscriptBytes: 100`, a single frame recorded 1968 bytes —
roughly twenty times the budget — because the cap is checked after the entry is
appended.

**Why it matters.** The option exists to stop an unbounded socket blowing up the
tool response, and one large frame defeats it. `maxFrameBytes` already does the
right thing: it clips before storing while still reporting the true `bytes`.

**Done when:** the transcript is clipped to the remaining budget before storing.

### A7. A malformed message fabricates an empty frame — CLOSED (#155)

**Closed 2026-08-09.** Such a message is skipped and named in a warning; the
frames around it are unaffected.

**Upstream contradicts itself here, so there was no parity to copy.** The
per-message send guards with `if (message && message.content)` and skips, while
queue-everything-on-connect sends the empty frame — both in
`bruno-electron/src/ipc/network/ws-event-handlers.js`. We follow the guard, and
the source comment records that the choice existed rather than implying it was
forced. Consequence worth stating: there is now no way to send a deliberate empty
frame. If that is ever wanted it needs its own explicit spelling, not the removal
of this check.

**Evidence.** A message entry with no inner `message` object, and one with no
`data` key, each sent a 0-byte frame rather than failing.

**Why it matters.** An empty frame is a meaningful protocol event. Inventing one
from a malformed request is worse than refusing the request.

### A8. A request that sends nothing is reported as a pass — CLOSED (#154)

**Closed 2026-08-09.** The session now warns, in the same voice the run already
used for zero requests and empty groups.

**One thing found here is still open and is not a defect we can settle alone.**
`framesToSend` filters on `selected !== false` deliberately, so that a `.bru`
message — which has no such flag — sends like an equivalent `.yml` one. But the
`.yml` parser resolves `selected` to an explicit boolean before the filter runs,
so an omitted flag has already become `false`. The filter's intent is defeated
upstream of itself. Whether an omitted flag should mean "send" is an upstream
parity question; changing it would change what existing files do, so the warning
makes it visible without deciding it.

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

### A9. Pre-flight refusals lose their `url` — CLOSED (#154)

**Closed 2026-08-09.** The `ws` constructor validates handshake headers and throws
*synchronously*, and that throw escaped the transport entirely. It is caught and
refused with its target. The message is read off the object rather than through
`instanceof Error`, which a cross-realm builtin fails.

**Evidence.** Every refusal raised before dialling reports `url: ""`. Requests
that executed, and connection-level failures, report it correctly.

**Why it matters.** Minor, but it is the field a caller uses to tell which target
was refused when several are refused at once.

### A10. Unknown `websocket` option keys are accepted silently — CLOSED (#154)

**Closed 2026-08-09.** The schema is `.strict()`, so an unrecognised key is
rejected by name instead of dropped.

**Evidence.** `{"websocket": {…, "bogusOption": true}}` ran normally, while
out-of-range *known* keys are properly rejected by the schema.

**Why it matters.** A typo such as `maxMessage` for `maxMessages` silently falls
back to the default, and the run looks fine.

### A11. Parse errors end at a dangling colon — CLOSED (#162); the NOT REPRODUCED verdict was wrong

**Evidence as filed.** `"Failed to parse .bru file: Line 7, col 1:"` — the message
stops where the offending content should follow. Cosmetic, but it reads as
truncated output rather than a complete diagnostic.

**What the probe found.** The grammar's message is complete. `bruToJsonV2` was
called directly on four malformed inputs, and every one produced a full diagnostic
— position, a three-line code frame with a caret, and an expectation:

```
"Line 8, col 1:\n  7 | body:ws {\n> 8 | \n      ^\nExpected \"}\" or \":\""
```

Nothing in `src/` truncates it: `bru-parser.ts:317` interpolates `err.message`
whole, and there is no first-line slice anywhere in the tree. The reported symptom
is therefore an artefact of how the message was recorded or displayed, not of what
the server produced — the newlines were lost somewhere after the throw.

**That verdict was wrong, and this is a defect. Closed 2026-08-10.** The probe
checked the thrower and stopped there. The first-line slice it reported finding
nowhere is `parse-failure.ts:22`, `raw.split('\n', 1)[0]`, one layer above — the
run result never carried what `bru-parser.ts` threw. Reading only the layer that
produces a value says nothing about the layer that reports it, and that gap is why
the recorded evidence looked like a display artefact.

The slice was deliberate and half right: `yaml` puts its reason in the first line
and a source-echoing code frame under it. The ohm grammar behind `.bru` inverts
that — position first, `Expected …` last — so the rule that kept `.yml`
diagnostics whole reduced every `.bru` one to a coordinate. The report now carries
the expected-token list too, with families collapsed to fit the message cap, and still
drops the frame. Details and the cost of the missing diagnosis are in B8, which was
filed *because* of this defect.

### A12. An authored `timeout: inherit` is dropped on the next write — CLOSED (#161)

**Evidence.** `resolveTimeoutSetting` in `yaml-generator.ts:191` handles the string
`inherit` explicitly, but `parseSettings` in `yaml-parser.ts` accepts `timeout`
only when `typeof obj.timeout === 'number'`. The key is modelled, so it is excluded
from the passthrough bag as well. An authored `timeout: inherit` therefore reaches
neither the model nor the file it came from, and comes back as `0`.

**Why it matters.** `settings.timeout` is read by the executor and by
`grpc-transport.ts`, so this is a silent behaviour change to somebody's request, not
just a lost string. Upstream accepts the value: `parseGraphQLRequest.ts:121-122`
has the `=== 'inherit'` branch this parser is missing.

**Why it was not fixed alongside A2.** `YamlSettings.timeout` is typed `number`,
and widening it makes every consumer a type error — which is the right way to find
them, but it means implementing inherit semantics, not just parsing the word. That
is its own change.

**Done when:** the parser keeps the value and every consumer decides what
inheriting means, or the writer preserves it verbatim without the model claiming to
understand it.

**Closed 2026-08-10 in #161**, the first way: `TimeoutSetting = number | 'inherit'`
is the model, both dialect parsers read the word through one shared reader, and both
consumers answer it with the runner's own default — which is what there is to
inherit, since Bruno's app inherits an application-level preference
(`bruno-electron/src/utils/collection.js:860`) and this server has no preference
layer. No warning is emitted: the value was honoured, not discarded.

Two things the entry did not anticipate. The defect was in **both** dialects, not
just `.yml` — `bruToJsonV2` reads the bare word out of a `.bru` settings block too,
and `bru-parser.ts` was discarding it identically; the oracle test now records that
measurement. And widening the type broke `mergeRequestSettings`, whose generic was
constrained to the *input* shape — the shape a caller may author is now stated
separately from the shape a file may hold, because the MCP schema still accepts only
a number.

### A13. An unrecognised `settings.tls` shape is dropped whole — CLOSED (#161)

**Evidence.** Found while writing a fixture for A2: `settings: {tls: {enabled:
true}}` round-trips to nothing at all. `tls` is a modelled key, so it never reaches
the passthrough bag, and `parseTls` keeps only the fields it names — so an object
made entirely of unrecognised fields parses to `undefined` and the key vanishes.

**Why it matters.** This is the failure mode the passthrough bag exists to prevent,
reappearing one level down. A partially-recognised `tls` block loses its unknown
fields silently; a wholly-unrecognised one loses the block. Same class as A2, but
nested, and it applies to every kind.

**Done when:** unmodelled keys inside `tls` survive a write, or the parser refuses
a `tls` block it cannot read rather than deleting it.

**Closed 2026-08-10 in #161**, the first way: the block carries a bag of its own,
keyed by `YAML_TLS_KEYS`, and the generator flattens it back the way the top level
already did — otherwise the bag itself reaches the file as a literal `extra:` key.

Worth recording for whoever meets this class next: a unit test asserted the
defect as the contract (*"omits settings.tls when no recognized tls fields are
present"*), so the suite was green over a data-loss bug and the round-trip fixture
that would have caught it did not exist. `settings.tls` is also **ours** rather than
Bruno's — upstream's `.yml` reader and writer name no TLS fields at all, taking that
configuration from app preferences and CLI flags — so nothing upstream would have
flagged it either.

---

## A-policy. OAuth2 token-fetch failure downgrades to an unauthenticated request — CLOSED (decided: refuse)

**Resolution.** The policy was changed: an automatable grant whose token exchange
fails now refuses the request rather than sending it with no credential. The
refusal carries the exchange's own reason, the request's redacted url and
`status: 0`, so the request fails by name and the rest of the group still runs.
HTTP, gRPC and WebSocket all take the same path, through one helper in
`request-executor.ts`.

The decisive argument is the one the section already raised, plus one it did not:
the harm is not merely a green run that proved nothing, it is an *identity
substitution*. The file says "as this principal", the wire says "as nobody", and
against an endpoint permitting anonymous access the run reports a pass. A caller
who means to test the unauthenticated case can say so with `auth.type: none`.

A grant that needs a browser is untouched, and cannot be affected: `resolveOAuth2`
returns no error at all for a non-automatable grant, so `error` present means
exactly "an automatable exchange was attempted and failed". The existing test for
that case is the regression guard.

Covered by `request-executor-digest-oauth2.test.ts` (refusal, and the url
redaction — the url is substituted by then, so it can hold the secret) and
`oauth2-refusal-transports.test.ts` (the two transports are never entered).

Original writeup follows.

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

### B1. Authoring gRPC and WebSocket requests — CLOSED (#168, #169, #170)

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

**Done.** `create_request` takes `kind` (`http` by default, plus `graphql`, `grpc`,
`websocket`) with a nested per-transport object, and `modify_request` edits a url,
headers, auth and that nested object on a request with no http block. Both refuse by
name what the transport has no place for rather than writing it and ignoring it. The
seven tasks are annotated individually in that file; Task 7 could not be executed as
written and is closed there with the reason.

### B2. Response headers are not returned — CLOSED (#163)

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

**Closed 2026-08-10 in #163.** `response_headers` is on every result that reached
the wire, with no flag: the design note was right that a second mask was the wrong
shape, and `undici` already bounds a whole header map at its 16 KB
`maxHeaderSize`, so there was nothing for a size knob to protect either.

The policy is where the work was. Reusing `redactMetadata` would have masked
`set-cookie` whole, which is the one header B2 was filed to make visible — the
value is the credential, and `HttpOnly`, `Secure` and `SameSite` are the answer to
the question being asked. So a response's cookies keep every attribute and lose
only the bytes between the first `=` and the first `;`. A value that cannot be
taken apart that way is withheld whole rather than guessed at.

Two things that only surfaced by doing it. `set-cookie` is reported as a **list**,
taken from the response's own `getSetCookie()` rather than the flat header map,
because a joined value cannot be split back — a cookie value may contain a comma,
and two cookies is the ordinary case. And a WebSocket had nowhere at all to read
its headers, script or no script: frames have none, so the 101 is the only place a
session cookie or an agreed subprotocol appears. It now populates the same
`response_headers` field, captured on `ws`'s `upgrade` event. gRPC already reported
its metadata under its own detail and is unchanged.

### B3. No report file output — CLOSED (#166)

**Evidence.** No JUnit, HTML or any other report writer exists in `src/`.

**Why it matters.** CI wants a JUnit XML file; humans want an HTML summary. Today
the caller gets JSON in a tool result and has to build both themselves.

**Known costs, established earlier and worth not rediscovering:**
`generateHtmlReport` already ships in the dependency tree, so the serializer is
not the work. The data is: results carry no file path, assertions and the
request/response exchange are split, and a realistic HTML report is around 31 KB,
which cannot go inline in a tool result. So this needs a written-to-disk contract
and a path returned, not a bigger payload.

**Closed by an optional `report` object** on `run_collection`, naming a `junit`
and/or an `html` file. The run writes each after it finishes and names it back on
the result with its byte count, and every result now carries `path`, the absolute
file the request came from. Three decisions are worth recording, because none of
them follows from "write a report".

A report path is resolved against the collection directory and must stay inside
it. An unrestricted caller-named path would turn a request-running tool into a
general file-write primitive, so confinement is the authorization boundary, not a
convenience. A refused path is a warning on the result rather than a failed run:
the results are what the caller asked for, and dropping them over a bad path
would be the worse outcome.

The JUnit document diverges from `bruno-cli` in four places, all answering the
same rule — a report must not read greener than the run. A request that verified
nothing gets a skipped testcase instead of upstream's empty suite, which readers
render as a pass. Parse failures, unresolved references and a group that crashed
before running get their own suites with `errors=1`; upstream never sees them.
Group names are folded into suite names, since one document can now describe
several execution groups. And there is no `hostname` attribute, because a report
is committable and a developer machine name is not part of the run.

Upstream's HTML report is not self-contained: `generateHtmlReport` emits a page
that loads Vue and naive-ui from `unpkg.com`, so the file renders blank offline
even though the run's own data is embedded in it. That is stated in the tool
description, the README and the source, and a test asserts the script tag so
nobody archives the file believing otherwise. Masking was deliberately not
extended to the caller's run variables: `walkAndMask` has no length floor, so a
variable holding a short value would blank every occurrence of it across the
report, to hide data the caller already receives inline in the same response.

### B4. No iteration or data-driven primitive — CLOSED (#178)

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

### B5. The WebSocket transcript is missing most of what a diagnosis needs — CLOSED (#164)

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

**Closed.** An entry now carries `type` (`text`, `binary`, `ping`, `pong`,
`close`), the authored `title` on frames the session sent, and `close_code` on a
close frame with the peer's reason as that entry's payload. Two things only came
out of doing it. Control frames must NOT count toward `maxMessages`: a peer that
pings once a second would otherwise reach the bound on its own and report `count`
for a session that received no answer at all. And a binary frame's payload is
recorded as base64, because the UTF-8 decode it used to get replaced every invalid
sequence and reported a size that never went over the wire — `bytes` is now the
true wire size for every kind of frame, which is what a display cap and a
cumulative ceiling are both counted from.

A post-response script sees the same fields, since the transcript is what
`res.body` is on this transport, so an assertion can now name a frame kind or a
close code instead of matching payloads by hand.

### B6. No inter-message pacing — CLOSED (#165)

**Evidence.** All selected messages are sent in one tick — three sends all
recorded at `156ms`.

**Why it matters.** Any send-wait-send protocol is out of reach. Combined with A3,
this means a request/response protocol over WebSocket can be neither driven nor
asserted on.

**Closed by `sendIntervalMs`** on the run's `websocket` options, defaulting to `0`,
which is the one-tick behaviour every session had. Two decisions in the fix are worth
recording, because neither is implied by "wait between sends":

- **A sequence a bound cut short names what it did not send.** A transcript one send
  short is indistinguishable from a peer that stopped answering, so the unsent
  messages are reported by their authored name. The count is read after the session
  rather than from inside the loop: the loop learns it was stopped one microtask after
  the bound fired, and it is racing the teardown that builds the result.
- **The idle bound is not armed while the sequence is still going out**, and starts
  from the last send. The gap a request deliberately leaves between its own messages
  is not the peer's silence; without this, any `sendIntervalMs` above `idleTimeoutMs`
  would have ended every session after its first message. This is the same
  first-recorded-frame reasoning B9 settled, applied to a session that is still
  talking.

The interleaving cannot be asserted in a unit test — with everything leaving in one
tick there is no order to observe — so the proof is an integration test whose
transcript alternates `sent` and `received` against a real echo server.

### B7. No subprotocol field — CLOSED (#165)

There appears to be no way to express `Sec-WebSocket-Protocol`. Untested — the
probe had no server requiring one — so confirm before building.

**The confirmation changed the fix, and the entry's premise was wrong.** The header
was authorable all along and did reach the wire. What it could not do was reach the
*connection*: `ws` validates the 101's `Sec-WebSocket-Protocol` against the list
handed to its constructor, so a request that wrote only the header, talking to a
server that agreed to it, had the handshake aborted with `Server sent a subprotocol
but none was requested` (`node_modules/ws/lib/websocket.js`, in `initAsClient`'s
upgrade handler; the sibling errors are `Server sent an invalid subprotocol` and
`Server sent no subprotocol`). Writing the header was worse than leaving it out, and
"just write the header" would have been the wrong advice to close this with.

Upstream has no field for it either — `bruno-requests/src/ws/ws-client.js` extracts
the header into the constructor's `protocols` argument, comma-split and trimmed, and
coerces `Sec-WebSocket-Version` into `protocolVersion` because `ws` overwrites that
header from its own option. This now does both, so one file negotiates the same
protocols in Bruno and here, and the agreed protocol is visible in
`response_headers` (B2). One deliberate divergence from upstream: the header is read
in whatever case it was written in, not only the two spellings upstream checks, since
the cost of missing a spelling is an aborted handshake rather than a header that does
nothing. An empty entry — the trailing comma in `chat,` — is left in, because `ws`
refuses it and dropping it would negotiate something Bruno would not.

### B8. `.bru` cannot express a WebSocket request — WITHDRAWN (#162); the parse report that hid it is fixed

**The headline was wrong.** `.bru` expresses a WebSocket request fully, and this
server already reads and writes one. Measured against the grammar rather than
inferred from the failure:

- `ws = "ws" dictionary` (`bruno-lang/v2/src/bruToJson.js:125`) carries `url`,
  `body` and `auth`, exactly as `http` does.
- `bodyws = "body:ws" dictionary` (`:178`) carries one message per block, with
  `name`, `content`, `type` and `selected`; repeated blocks accumulate in order.
- Headers use the same `headers { … }` block every request kind uses.
- A round-trip fixture for that shape already existed here, at
  `tests/unit/bruno/bru-roundtrip-completeness.test.ts:586`, which is the second
  reason the headline should not have survived being written.

Two details worth keeping. Upstream's own reader drops `selected`, so a message
deselected in Bruno's UI comes back selected from disk; our transport treats an
absent `selected` as selected (`ws-transport.ts:170`), which agrees. And
`body:ws { greeting: hello }` — the name used as the key, which is the natural
mistake — parses to one message with an empty name and empty content, then runs
and warns that nothing was sent (`ws-transport.ts:306`). It is legal `.bru` and
does nothing.

**What actually failed** in the file behind the evidence was the block name:
`websocket {` where the grammar says `ws {`. Re-running it reproduces the recorded
message to the character, `Line 7, col 1:` included.

**The real defect is that message.** `describeParseFailure` kept the first line of
a parse error only, on the reasoning that `yaml` puts the reason there and a code
frame under it echoes the source back. The ohm grammar behind `.bru` is the other
way around: the first line is a position and nothing else, and the `Expected …`
list that names `ws` is last. So every `.bru` parse failure reported a coordinate
with no diagnosis — and the one time that happened, the conclusion drawn from it
was that the format lacked a feature it has.

**Fixed 2026-08-10.** The report now carries the expected-token list as well as
the position, with the token families collapsed (`auth:basic`, `auth:bearer`, … to
`auth:*`) because the raw list runs past a thousand characters and `ws` sits near
the end of it, where the message cap would have cut it off. Code-frame lines are
still dropped: a token list is grammar text, an echoed source line can carry a
credential out of a request body.

**Left open by this:** nothing in `.bru`. B1 still covers authoring either
transport through the tool surface, in either dialect.

### B9. A WebSocket request always burns its full duration budget — CLOSED (#164)

**Evidence.** Eight requests at `maxDurationMs: 2500` took `22058 ms` in total,
strictly sequential. Sessions end early only on `count` or `bytes`; there is no
idle close.

**Why it matters.** At the 5000 ms default, a twenty-request WebSocket collection
takes about 100 seconds even when every peer answers in 200 ms. That is a
usability cliff for exactly the mixed collections this feature was built for.

**Done when:** a session can end on idle, or the default is reconsidered.

**Closed.** A session now ends after 1500 ms of silence and reports
`stop_reason: "idle"`; `idleTimeoutMs: 0` waits for the wall-clock ceiling, which
is what a protocol whose gaps are longer than its answers needs. The integration
test that proves it ends a session with an 8000 ms ceiling in about 200 ms.

Two decisions worth not re-deriving. The clock is armed by the first recorded
frame rather than at open, so a listen-only request — one that authors no messages
and waits for the peer to volunteer something — still gets the whole budget it
asked for; silence *after* activity is the signal, silence before it is the point
of the request. And an idle stop is NOT reported as `truncated`, unlike `count`,
`timeout` and `bytes`: no cap bit, and the clock budget went unspent. Flagging it
would put the warning on nearly every healthy session, which is how a warning stops
being read.

### B10. No binary WebSocket frame can be sent, by anyone

Moved here from A4, where it was filed as a defect in this server. It is not one:
the capability does not exist upstream either, so there is nothing to be faithful
to and nothing broken to repair.

**Evidence.** `bruno-requests/src/ws/ws-client.js` — the only `.send()` call site
is fed by `normalizeMessageByFormat`, whose every branch returns a string. No
`Buffer.from`, no base64 decode, no file read anywhere in the ws client, the WS UI
components, or the opencollection converter. `type` is `Yup.string().nullable()`
in `bruno-schema` with no `.oneOf`.

**Why it matters.** Any binary protocol over WebSocket — protobuf, MessagePack —
is untestable. As of #155 that at least fails visibly: a message declaring
`binary` or `base64` warns that the gap is in the format.

**Before starting, note what it costs.** Sending real bytes means diverging from
Bruno: a collection would behave differently under this runner than under Bruno's
own, which is the trade refused in `decision-keep-our-own-runner`. It also needs a
spelling on disk that Bruno will not round-trip, and the transcript and
`response_body` would both need a binary representation. Worth doing only with a
concrete protocol to test against — not speculatively.

**Done when:** there is a way to put bytes on the wire and read bytes back, with
the divergence from upstream stated where an author will see it.

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

### D2. WebSocket handshake header content is unverified on the wire — CLOSED (#167)

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

**Closed by `tests/integration/ws-handshake.test.ts`**, a listener that records
`req.rawHeaders` per connection — `rawHeaders` and not `req.headers`, because Node
joins duplicates in the parsed map and the question is what was sent. An authored
header arrives with the name, case and value the file gave it; a `disabled` one is
withheld entirely; `{{token}}` arrives substituted; an `auth:bearer` block reaches
the handshake as `Authorization: Bearer …`; and `Connection`/`Upgrade` are observed
being overridden to `Upgrade`/`websocket`, which turns the probe's negative
conclusion into a direct reading. `Sec-WebSocket-Version: 8` negotiates 8 because
the transport extracts it into the library's `protocolVersion`; the header alone
cannot set it.

**The duplicate-name answer was half right.** Two exact duplicates collapse
last-wins in the transport's own map, as diagnosed. Two spellings differing in case
*survive* that map — it is keyed by the authored name, and `X-Dup` is not `x-dup` —
and collapse one layer lower: Node's outgoing header store is keyed
case-insensitively, so the second replaces the first and takes its own casing with
it. Measured separately against a plain `http.request`, which places the behaviour
in Node rather than in something the transport could decide differently while still
handing over an object.

### D3. Paths that exist in the code but were never triggered — MOSTLY CLOSED (#167)

- **`stop_reason: "closed"`** — CLOSED, and this bullet was already stale when it
  was written: #164 and #165 record a real peer's close code and reason, and
  distinguish a peer-initiated close from truncation.
- **`engineIoKeepalive` end to end** — STILL OPEN. No reachable engine.io endpoint
  during the probe; `wss://ws.postman-echo.com/socketio/` returned 502. This
  overlaps D1 and needs a real socket.io server, so it is the one bullet #167 does
  not touch.
- **Received binary frames** — CLOSED (#167). A peer-sent frame comes back with
  `type: 'binary'`, the payload base64 and `bytes` as the wire length. The fixture
  is `00 01 ff fe`, invalid UTF-8 on purpose, so a UTF-8 decode could not quietly
  pass for the same bytes. Outbound binary stays refused for A4's reason.
- **WebSocket inside parallel execution groups** — CLOSED (#167). Two sessions in
  two groups hold their sockets open at the same time, asserted from the server's
  side: both transcripts read correctly whether the run serialises or not, so the
  only honest evidence is a peak of two concurrent sockets. The test was checked
  against `parallel: false`, where the peak is 1 and it fails — which is what makes
  it a test about concurrency rather than about two sessions completing.

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

**Closed 2026-08-09** — entries kept in place above, marked CLOSED:

- #154, the silent-acceptance cluster: A5, A6, A8, A9, A10. One root cause in five
  costumes — the server accepted something it could not act on, acted on nothing,
  and reported a pass.
- #155, the send path: A4 and A7. Both change what goes on the wire, which is why
  they were held back from #154.

Two corrections came out of closing them, and both are recorded on the entries
themselves because the original wording would have misled whoever picked them up:
**A5 named the wrong culprit** (the applier was right; accepting the other shape in
silence was the fault), and **A4 named a defect that does not exist** (there is no
binary path upstream to break). Both were settled by reading the upstream source
rather than by reasoning from the symptom.

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
