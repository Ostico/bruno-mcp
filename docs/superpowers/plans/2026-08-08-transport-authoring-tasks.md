# Transport request authoring — task list

**Goal:** an agent working only through this server can create and edit gRPC and
WebSocket requests, not merely run and preserve ones a human authored in Bruno.

**Status:** Tasks 1 and 2 are done. This document is the task list, not a plan —
each task names its files and acceptance criteria, but the implementation approach
for the larger ones is still open and is called out where it is.

## Why this exists

The gRPC/WebSocket work that shipped in 2.2.0 deliberately excluded authoring.
From `docs/superpowers/specs/2026-08-06-grpc-websocket-design.md`, under "Out of
scope, deliberately":

> **Authoring gRPC or WebSocket requests with `create_request`.** Reading,
> preserving and reporting: yes. Creating from scratch: not in this work. A
> create path needs its own input schema per kind, and the demand for one has not
> appeared — an agent that needs such a request can copy a file Bruno wrote.

Both halves of that reasoning were sound at the time. The cost is real: each kind
needs its own input schema, its own validation and writer coverage in both
dialects. And the urgent half of the work was elsewhere — a gRPC or WebSocket
request was being *destroyed* by an edit to any request in the same collection,
which had to land first.

What has changed is the second half. "An agent can copy a file Bruno wrote"
assumes the agent has such a file and some way to put bytes on disk. Through this
server alone there is no path to a WebSocket request at all. The first attempt to
exercise the feature end-to-end hit this immediately: producing anything to run
required hand-authoring YAML with a general-purpose file-writing tool, against a
format the author had to be taught. That is not copying a file Bruno wrote; it is
reimplementing the writer by hand.

So the deferral was reasonable while demand was hypothetical. It is no longer
hypothetical.

## Verified starting state

Measured on 2026-08-08 against the 2.2.1 build, by driving the server's real tool
surface over stdio. Every claim below is an observed result, not a reading of the
source.

- **`create_request` has no notion of transport kind.** The schema is HTTP-shaped
  throughout — there is no `kind` discriminant anywhere in
  `src/tools/request-tools.ts`. There is no argument combination that produces a
  `websocket` or `grpc` request.

- **`modify_request` refuses non-HTTP fields explicitly, and says why.** Setting
  headers on a WebSocket request returns:

  > `Cannot set headers on a "ws" request: it has no http block. Only name and sequence can be changed.`

  This is good behaviour and should be preserved: the refusal is explicit and
  names the reason, rather than silently writing an `http` block onto a request
  that has none. It also means editing is limited to `name` and `seq`.

- **A permitted edit preserves the transport block.** Renaming the request kept
  the URL, the `auth.bearer.token`, the headers and both messages with their
  `selected` flags intact. The 2.2.0 fidelity fix holds under a real write.

- **The writer injects a `settings:` block the source file did not contain.**
  After the rename, the file gained `settings:` with `encodeUrl`, `timeout`,
  `followRedirects` and `maxRedirects`. Whether upstream Bruno does the same on
  write is not established — see Task 6.

- **The reader and the writer disagree about dialect.** `run_collection` happily
  discovered and executed a `.yml` request inside a collection whose root
  manifest is `bruno.json`. `modify_request` refuses the same pair:

  > `File extension ".yml" does not match collection format "bru" (expected ".bru")`

  One of the two is wrong — see Task 5.

---

## Task 1: Decide the tool surface — DONE

Settled in `docs/superpowers/specs/2026-08-11-transport-authoring-tool-surface-decision.md`:
one `create_request`, an explicit `kind` defaulting to `http`, and one optional
nested object per transport. No new tools, so the registration order is untouched.

**Blocking.** Tasks 2 and 3 cannot start until this is settled, and it is a
product decision rather than an implementation one.

Two candidate shapes:

- **A `kind` discriminant on `create_request`.** One tool, a discriminated union
  input. Keeps the surface small, which matters because tool count is context
  cost for every agent that connects. Costs: the schema becomes a union that most
  callers see irrelevant branches of, and the existing flat HTTP arguments have to
  keep working unchanged.

- **Separate `create_websocket_request` / `create_grpc_request` tools.** Each gets
  a schema that is entirely relevant to it, which is easier for a model to call
  correctly. Costs two more tools on the surface, and splits "make a request"
  across three names.

**Acceptance:** a written decision with its reasoning, recorded in
`docs/superpowers/specs/`. Registration order is part of the tool contract and is
pinned by `tests/unit/tools/tool-surface-contract.test.ts` — if new tools are
added, that test tells you where they may go.

---

## Task 2: Author WebSocket requests — DONE

Both acceptance halves met: byte parity with `stringifyRequest` in `.bru` and
`.yml`, and a live run of an unedited authored request in both formats. Three
things measurement caught that inference would not have:

- `.bru` does carry a message's `selected`, but only its true half. Our model said
  the field did not exist there. Upstream's writer emits it when truthy and its
  reader resolves an absent pair to `false`, so absent and deliberate-false are
  indistinguishable after parsing — which is why authoring `selected: false` into
  a `.bru` collection is refused rather than written.
- Our pinned `@usebruno/lang` (0.36.0) could not write the flag at all. Raised to
  `^0.38.0`.
- Our `.yml` websocket key order was url, auth, headers, message; upstream writes
  url, headers, message, auth. Reordered.

**Follow-up gap, deliberately not closed here.** Our `.bru` reader treats a
message with no `selected` line as one to send; upstream treats it as deselected.
Adopting upstream's reading would silently stop sending frames for every
hand-written `.bru` file that omits the flag, so it needs its own decision rather
than being folded into an authoring change.

## Task 2 (original text)

**Depends on:** Task 1.

**Files:** `src/tools/request-tools.ts`, the `.yml` and `.bru` writers, tests
under `tests/unit/tools/` and a round-trip test under `tests/integration/`.

The input needs, at minimum: `url`, `headers`, `auth`, and a message array whose
entries carry a title, a payload type, the payload itself, and a `selected` flag.
The flag is not optional detail — for a streaming request the difference between
"not selected" and "not stated" decides what reaches the wire, which is why
`parseTransportMessages` keeps it as an explicit `false`.

**Acceptance:**
- A request created through the tool, with no hand-editing, runs successfully
  against a live echo endpoint and produces a transcript.
- The file the tool writes is byte-comparable to what Bruno writes for the same
  request. Read the bytes; do not trust a round-trip through our own parser,
  which tolerates our own malformed output.
- Both dialects covered, and a test that fails if either writer drops a field.

---

## Task 3: Author gRPC requests — DONE

Landed with every acceptance criterion met. Three things worth recording:

The `.yml` key order was wrong here too, in the same way and for the same reason as
WebSocket's: ours was url, method, protoFilePath, methodType, auth, metadata, message
where upstream writes url, method, methodType, protoFilePath, metadata, message, auth.
Measuring against upstream's writer rather than round-tripping through our own parser is
the only thing that would have found it. Everything else in the gRPC model was already
right — the `protoPath`/`protoFilePath` split between dialects, the `.bru` block order,
metadata as the header surface.

Unlike WebSocket, `.yml` writes gRPC messages as a titled variant list unconditionally,
so there is no shape switch to reproduce, and it writes no `settings` block for a gRPC
request at all — which is why the byte-parity test needed no injected-settings workaround.

The transitive import check moved rather than being duplicated. It lived in
`grpc-transport.ts`, which pulls in grpc-js; the writer needs the same rule, and importing
the transport from the writer would drag grpc-js into every authoring path. It is now
`assertProtoImportsConfined` in `proto-path.ts`, which is where the confinement rules
belong and has no transport dependency. Both ends call it: the writer so an escaping
import is refused when the request is written, the runner because the proto can change
between then and the run, and because a hand-written request never passed the writer.

## Task 3 (original text)

**Depends on:** Task 1. Larger than Task 2 and worth sequencing after it.

**Files:** as Task 2, plus proto handling.

Beyond the message list, this needs a proto file path, a service and a method.
The proto path is the hard part: it is validated against the collection boundary
transitively, because the escape can be one hop in via an import. An authoring
path that accepts a proto path must apply the same confinement as the run path,
not a weaker check — a create tool that can point at any file on disk reopens
what the run path deliberately closed.

**Acceptance:**
- A created request runs a real unary call.
- A proto path outside the collection is refused at authoring time, including
  when the escape is via a transitive import rather than the named file.
- `google/protobuf/` bundled imports still resolve.

---

## Task 4: Let `modify_request` edit transport fields

**Depends on:** Tasks 2 and 3, whose schemas it should reuse rather than restate.

Today only `name` and `seq` can change on a gRPC or WebSocket request. Everything
else is refused. Once a request can be created it should be editable — otherwise
the only way to change a URL is to delete and recreate, losing anything the tool
does not model.

**Acceptance:**
- URL, headers, auth and messages are all editable on both kinds.
- The explicit-refusal behaviour is preserved for fields that genuinely do not
  apply — the failure mode to avoid is silently writing an `http` block onto a
  request that has none.
- A test that edits one field and asserts every other field survives byte-for-byte.

---

## Task 5: Reconcile the reader and the writer on collection dialect

**Independent of the others.** Small, and a correctness question rather than a
feature.

`run_collection` executes a `.yml` request inside a `bruno.json` collection.
`modify_request` refuses the same combination. Both cannot be right.

The format is a per-collection property: the root manifest picks the dialect and
Bruno scans that extension only, which means a mixed collection is invisible to
Bruno itself. That argues the writer is correct and the reader is too permissive —
it will execute a file that the tool Bruno users actually run would never see.

Note before changing anything: the existing WebSocket and gRPC integration tests
build their fixtures as `bruno.json` plus `.yml` files, so they depend on the
permissive reader. Tightening it without updating them will look like a large
unrelated breakage.

**Acceptance:** one decision, applied consistently in both directions, with the
integration fixtures updated to match. Whichever way it goes, a test pins it.

---

## Task 6: Establish whether the injected `settings:` block is correct

**Independent.** Investigation first; it may turn out to be no work at all.

Writing a `.yml` request adds a `settings:` block with `encodeUrl`, `timeout`,
`followRedirects` and `maxRedirects` that the source file did not contain. This
may be exactly what upstream does, in which case it is byte-parity and correct.
It may equally be our writer adding content the author never wrote — the same
family as `.bru` injecting `seq: 1`.

**Acceptance:** read the upstream writer at
`/Volumes/Projects/tools/working_dir/bruno-tool` and compare against a file Bruno
itself writes. Then either a test pinning the injection as intended, or a fix.
Do not infer the answer from our own round-trip.

---

## Task 7: Fold in the live-probe findings

An adversarial probe of the WebSocket run path against `wss://echo.websocket.org`
was running when this list was written — headers including handshake-header
collisions and CRLF injection, every auth mode, payload types and sizes, all six
run options at their boundaries, variable substitution and secret leakage into the
transcript, and the error paths.

Its findings are about the *run* path, where this list is about the *authoring*
path, so they are expected to be separate work. Triage them into this list or into
their own once they land, rather than assuming either.
