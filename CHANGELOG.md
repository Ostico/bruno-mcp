# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Documentation
- **How to assert on a gRPC or WebSocket result.** `res.getBody()` on a WebSocket request
  is the transcript array, and `res.getStatus()` is always `0` — a test written against the
  status asserts on a constant and cannot fail. The outcome is `res.statusText`, carrying
  the stop reason. Said once at the end of a paragraph about close codes before; now its own
  section with an example, and stated in the `run_collection` description where a caller
  writing assertions will meet it. gRPC's own shape is spelled out alongside.
- **`includePayloads` gates the result, not the script.** A test script always sees the real
  payloads, exactly as `res.body` always carries a full HTTP body while `response_body` is
  gated by `includeResponseBody`. That makes `includePayloads: false` plus content
  assertions the intended shape for CI — the assertions check the frames, and what comes
  back holds only direction, timing and sizes. Previously discoverable only from the source.
- **Simultaneity across separate `run_collection` calls is not promised.** Calls issued
  together may overlap or may serialise; runs meant to be concurrent have been seen starting
  more than twenty seconds apart, each passing its own assertions. A test that depends on two
  things happening at once must be one call with a parallel group.

### Added
- **`bail` stops a run at the first failure.** A chain of dependent requests behind a login
  that stopped working produced one failure for the cause and one for every consequence of
  it, with the cause the least visible of them. `bail: true` on `run_collection` stops at the
  first request that fails or whose tests fail; everything the run did not reach is reported
  in place with `skipped: true` and `skipReason: "bail"`, carrying the method and URL it
  would have sent, and later groups are skipped whole. A skipped request is counted in a new
  `summary.skipped` and in neither `passed` nor `failed`, so `passed + failed` still equals
  `total` and a truncated run cannot read as a shorter one that went green. The run gains a
  `bail` object naming the reason (`request failure` or `test failure`), the request it
  stopped at, that request's file and group, and how many were skipped. JUnit reports the
  skipped requests as skipped rather than as having verified nothing, and the HTML page
  counts them out of both totals. Nothing cancels a request already in flight, so a
  concurrent run skips only what had not started and says so in `warnings` instead of
  leaving the shortfall to be inferred.

- **`move_request` relocates a request, within a collection or between two of them.** There
  was no way to reorganise a collection through this server: a request could be created,
  modified, read and deleted, but never moved, so the only route was delete-and-recreate —
  which loses anything the recreating call did not restate. The new tool moves the file's
  bytes verbatim rather than parsing and regenerating them, so nothing a request declares
  can be lost on the way, including the `.bru` blocks this server does not model. It takes
  `targetFolder` for a folder inside the collection and `targetCollectionPath` to move
  between collections, creates a missing target folder and says so, and takes `copy: true`
  to duplicate instead of move. Two things it deliberately does not do: it does not rename
  the file, which is `modify_request`'s job, and it does not renumber `seq` — a request
  landing on a sequence a sibling already claims is reported, because rewriting the file to
  change one number is the round-trip this avoids, and Bruno breaks such a tie by filename.
  A request that lands in a collection whose dialect does not read its extension is warned
  about, on the same terms as everywhere else.

- **`modify_request` can rename a request's file.** Renaming a request only ever changed the
  name inside the file, which is what Bruno's own rename-name path does — but Bruno pairs it
  with a second path that moves the file, and this server had no equivalent, so a renamed
  request kept a filename contradicting it with no way to correct it. Since every other tool
  addresses a request by path, that drift was actively misleading. `filename` now moves the
  file, and stays independent of `name` the way both are in Bruno: pass both to keep them in
  step. It takes a basename in the request's own folder, appends the collection's extension
  when none is given and refuses the other dialect's, refuses the characters and reserved
  names upstream's filename validator refuses, and refuses a target another file already
  holds — while still allowing a rename that only changes letter case. The response reports
  the path the file moved to.

- **A guide to execution groups and parallelism**, at `docs/execution-groups.md` and linked
  from the README. It documents what a group owns and that nothing crosses its boundary, the
  two independent `parallel` flags and why a group never inherits the run's, ordering within
  a group, iterations over data rows, how the concurrency ceiling is derived and what it
  actually bounds, and what a failure looks like at the request, group and run level. The
  README described the shape of a call; this describes the model, which is what a caller
  needs to predict what a call will do.

- **A group can wait for another to reach a given point, via `startAfter`.** `parallel` starts
  groups together but says nothing about one being *ready* before another acts, so a listener
  that had to be connected before a trigger fired could only be arranged with a `bru.sleep`
  tuned to whatever the latency was that day. `startAfter: { group, requestsCompleted }` names a
  position in another group instead — a fact about the run rather than about the network. It
  needs `parallel: true` on the run; chains are allowed; a request that failed still counts as a
  position reached, since waiting for a verdict would hang the run rather than report the
  failure; and cycles, self-references, unknown names, gates asking for more requests than the
  group runs, and gates on a group that iterates over rows are all refused before anything runs.
  If the group being waited on ends early, the waiting group does not start and reports that as
  its error, naming what it was still waiting for.

### Changed
- **An SSRF refusal now says that an allowlist entry matches one spelling of a target.** An
  allowlisted hostname is deliberately never resolved — the operator vouched for the name, not
  for whatever it points at today — so it does not cover the addresses behind it, and an
  allowlisted address does not cover a name that resolves to it. Nothing said so, which made
  the consequence look like a defect: a caller that reached a service at `http://localhost` and
  was then refused at `http://127.0.0.1` read the guard as inconsistent between name and
  address, rather than as one allowlist entry present and the other missing. The refusal and
  the README now state the rule, and name that pair as the case it explains.

- **A lost MCP registry listing can be republished without cutting a release.** The release
  workflow now takes a manual run with a version to list, which runs the registry job on
  its own against that version's tag. Before, the listing could only be attempted as part
  of a tag push, and a failure there was unrecoverable: the job needs the npm publish that
  precedes it, and npm refuses a version it already serves, so re-running the failed job
  fails earlier than before rather than succeeding. 2.3.0's listing had to be published by
  hand. The manual run cannot publish to npm — that job is now gated to tag pushes — and
  `release-workflow.test.ts` holds both halves of that in place.

### Fixed
- **`create_collection` created a collection `list_collections` could not see, and said
  nothing about it.** `workspace.yml` is Bruno's own registry, and `list_collections`
  reads that registry rather than the disk, so a collection created here appeared in
  neither it nor the Bruno GUI's sidebar until something else wrote that file — while the
  success message mentioned neither the registry nor the consequence, which read as silent
  failure. The new collection is now added to the same workspace `list_collections`
  resolves (`workspacePath`, then `BRUNO_WORKSPACE_PATH`, then the platform default),
  `registerInWorkspace: false` skips it, and the result always says what happened:
  registered, already listed, or not registered and why. A collection that is not
  registered is still usable by every other tool — pass the returned path as
  `collectionPath`.
  The workspace file is edited a line at a time rather than parsed and re-serialised,
  because it belongs to the Bruno app: it quotes every scalar and can carry keys such as an
  empty `specs:` that a YAML round-trip would rewrite. A registry in a shape that cannot be
  extended that way is left untouched and reported.

- **The SSRF allowlist no longer depends on how a target is spelled.** An operator who
  allowlisted `127.0.0.1` still had `http://localhost:8888` refused, because a denylisted name
  is rejected before anything resolves — the same listener reachable or not according to how it
  was written, which half-blocked one real dev environment that defines both spellings. A
  normally-blocked name is now permitted when *every* address it resolves to is allowlisted,
  which is exactly what an address entry vouches for; a name whose addresses are only partly
  covered stays refused, and so does one whose resolution fails, since a DNS message would hide
  why the name was denied. The permitted name still carries its resolved addresses to the
  caller, so the connection remains pinned to them. The refusal text now also states which
  spelling each kind of entry matches, which was previously impossible to work out from inside.

- **A pre-request script did not run at all on a gRPC or WebSocket request.** Both transports
  are executed by a branch that returned before the pre-request phase began, so on either of
  them `bru.setVar` wrote nothing, `req.setUrl` and `req.setHeader` changed nothing, and a
  script that threw did not stop the request. Post-response and test scripts always did run,
  which is what hid it: the missing phase was the one whose whole purpose is to happen before
  substitution, so a script that computed a room name or a topic and then dialled it silently
  dialled the template instead. A script's variable now reaches that request's own
  `{{placeholders}}`, `req.setUrl` replaces the target, `req.setHeader` writes the transport's
  own header surface — handshake headers for WebSocket, metadata for gRPC — and a script that
  throws stops the request before anything is dialled. `req.setBody` is refused with a warning
  rather than guessed at: neither transport sends a single body, so there is no one value for
  it to replace.

- **An oauth2 request sent no credential when its own pre-request script set a variable.**
  Writing any variable from a pre-request script rebuilds the request from its original
  templates, so the new value can reach that request's own `{{placeholders}}`. The rebuild
  was not handed the access token that had already been fetched, and the token is not part
  of any template — so the `Authorization` header vanished and the request went out
  unauthenticated. It was not refused and not warned about, which made it the failure the
  refusal path exists to prevent: against an endpoint permitting anonymous access it passes,
  proving only that anonymous access works. A collection whose login writes a variable — the
  ordinary shape — could report a green authorization suite having never presented a
  credential.

- **The MCP registry manifest's description was too long to publish.** `server.json`
  carried a 126-character description and the registry accepts 100, so publishing 2.3.0
  returned `422 { "message": "expected length <= 100", "location": "body.description" }`.
  It failed after the tag had fired, so npm and the GitHub release were already done and
  only the listing was lost — and a spent version number cannot be republished. The
  description is now 97 characters, and `registry-manifest.test.ts` asserts the limit, so
  the next occurrence is a local test failure rather than a 4xx nobody can undo. The npm
  description is a separate field with no such limit, which is why nothing else noticed.

## [2.3.0] - 2026-08-12

### Added

- **Data-driven runs: `data` and `dataFile` on `run_collection`.** A group given rows runs
  once per row, with the row's columns bound as variables over the group's own. One call
  now checks the same requests against fifty accounts, or one login against fifty
  credential pairs. `data` takes the rows inline; `dataFile` reads them from a CSV inside
  the collection, whose first line names the variables. Either can be given per group or
  for the whole run, and a group naming its own rows replaces the run's rather than adding
  to them — the rule `environment` already follows.

  Each row is reported as its own group: same `name`, its own `index`, and an
  `iterationIndex` counting from 0. That is not a reporting choice but the design. A group
  owns its variable store, its cookie jar and its OAuth2 token cache, which is exactly what
  a row needs, because a row commonly *is* a different identity. Two rows differing only in
  a password therefore authenticate separately, where anything sharing state between rows
  would let the second reuse the first one's token and pass its assertions on a credential
  it had never sent.

  A row's values are authored variables, the tier that recurses through interpolation, so a
  cell holding `{{host}}` resolves exactly as the same value typed into `variables` would.
  Rows are independent, so a failing row does not stop the rows after it; this server has
  no `bail`, and none was added here. Two refusals rather than a guess: `data` and
  `dataFile` in one scope, and more than 1000 rows — every row runs every request in the
  group, so a spreadsheet passed by mistake is an outbound request storm.

  Rows are not echoed back in the result. A row read from a `dataFile` is file content, and
  a column named `password` has no business in a transcript because the run reported what
  it bound; `iterationIndex` addresses the row for a caller who already has the data.

- **A CSV reader for data rows**, the first piece of data-driven runs. Nothing calls it yet:
  it lands on its own so the format it accepts can be argued about before the feature that
  depends on it is built.

  It reads RFC 4180 — comma delimiter, `"` quote, `""` escape, LF, CRLF or a bare CR
  ending a record — and nothing beyond it. Written here rather than taken from a package
  for two reasons. Every byte of every data row passes through this code, because a data
  row's purpose is to hold the identity a request runs as, and a dependency on that path
  is a permanent thing to trust and re-audit. And the reader of a rejection is an agent
  that has to repair the file, which it can only do if the message names the line and the
  column; a library reports its own position in its own vocabulary.

  What it refuses is the point. A row whose field count disagrees with the header row is
  rejected rather than padded, because padding binds a value to the wrong column and a run
  that authenticates with one row's password under another row's username still comes back
  green. A repeated or unnamed column is rejected, since one of the two would be
  unreachable. A semicolon- or tab-separated export is rejected by name instead of parsing
  as a single column called `name;password`. No refusal quotes cell contents — positions
  and column names only, the same rule the `.bru` and `.yml` parse-failure summaries follow.

  Two deliberate divergences from the spec, both documented where they happen: a newline
  inside a quoted value is normalised to a bare LF, so a value can never carry a CR into a
  header it is interpolated into; and a byte-order mark is stripped, which is what a
  spreadsheet writes and what would otherwise become part of the first column's name.

  Tested against a real exported file as well as written-for-the-parser strings:
  `tests/fixtures/csv/multilingual-glossary.csv` began as a translation glossary exported
  from a translation tool. Its words are not the original ones — every letter and digit was
  substituted for another from the same Unicode block, so nothing identifying survives —
  but everything the parser can see is the export's own and was chosen by nobody here:
  46 columns, CRLF endings and no final newline, quoted commas, a doubled quote, a
  non-breaking space, Cyrillic, and 30 empty cells in its first data row. Its cells were
  compared one by one against Python's `csv` module, an implementation with no shared
  ancestry, and agreed on all 1,748 of them before and after the substitution. It also
  produced a fix: a real export repeats a column name once per language group, fourteen
  times over, so the duplicate-column error now reports how many columns share the name
  and where the first few are, instead of saying the header names it "twice".

- **`modify_request` edits WebSocket and gRPC requests.** A url, headers, auth and the
  nested `websocket`/`grpc` object all apply, each written where that transport keeps it:
  a gRPC header edit lands in `metadata`, a WebSocket one in `headers`. gRPC also takes
  `method`, `protoPath` and `methodType`. An edited credential is written by the same
  builder as an authored one, so the two produce identical bytes.

  Previously every HTTP-shaped field was refused on a request with no http block, which
  put url, headers and auth out of reach — a WebSocket request's target could not be
  changed for the life of the file. What is refused now is only what the transport has no
  place for: an HTTP method, a body, query parameters, path params, and the other
  transport's nested object.

- **`create_request` authors gRPC requests**, via `kind: "grpc"` with a url and, under
  `grpc`, the fully qualified `method`, the `protoPath`, the `methodType` and the
  `messages`. All four RPC shapes are accepted because Bruno writes all four, though only
  `unary` runs here — the other three author a file Bruno can open and `run_collection`
  refuses by name. As for WebSocket, an HTTP method, a body, query parameters and path
  params are refused by name rather than written and ignored.

  Headers given for a gRPC request are written as **metadata**, that transport's only
  header surface: a `headers` block on a gRPC request is one Bruno's gRPC reader never
  looks at. The `protoPath` must already exist inside the collection and is stored
  relative to it whichever spelling is given, since an absolute path commits the
  operator's directory layout to a shared file; one resolving outside the collection is
  refused, symlinks included — and so is one whose *imports* leave the collection, however
  many hops in, since a confined proto importing a confined neighbour that imports
  `/etc/passwd` names an entry file with nothing wrong with it. The run path checks the
  same graph again, because the file can change between being authored and being run.

  The bytes match upstream's own writer in both formats, including where the two dialects
  disagree: `.bru` writes `protoPath` inside the `grpc` block, `.yml` writes
  `protoFilePath` and nests metadata in the block. Checking against that writer rather
  than a round-trip through our own parser is how the `.yml` key order turned out to be
  wrong here too — ours was url, method, protoFilePath, methodType, auth, metadata,
  message where upstream writes url, method, methodType, protoFilePath, metadata,
  message, auth.

- **`create_request` authors WebSocket requests**, via `kind: "websocket"` with a url and
  `websocket.messages`. Each message carries `content` and, optionally, a `title` and a
  `type` of `text` or `binary`; an untitled one is named by position — `message 1`,
  `message 2` — as Bruno names it. Headers, auth, `assert`, `vars`, `settings` and
  scripts work as they do for an HTTP request, and the fields the transport has no place
  for are refused by name rather than written and ignored: an HTTP method, a body, query
  parameters, path params. Running a request authored this way against a live endpoint
  needed no hand-editing, in either format.

  The file is byte-identical to what Bruno writes for the same request, in both `.bru`
  and `.yml`, checked against upstream's own writer rather than against a round-trip
  through our parser — which is how the `.yml` key order turned out to be wrong: ours
  was url, auth, headers, message where upstream writes url, headers, message, auth.

  One field cannot cross both formats. `selected: false` marks a message as authored but
  not sent; `.yml` records it and `.bru` cannot, because upstream's `.bru` writer emits
  the flag only when true and its reader resolves an absent flag to `false` — so a
  deselected message and an unmarked one are indistinguishable after parsing. Authoring
  one into a `.bru` collection is refused, naming the message, rather than written as a
  message that would then be sent.

- **A run can write report files**, via `report` on `run_collection`: `junit` for a CI
  system, `html` for a person, either or both, each naming its own path. The results
  are still returned as JSON — reports exist because the two consumers that are not an
  agent read files, and the HTML page is around 30 KB, which has no business inline in
  a tool result. Each file written comes back under `reports` with its absolute path
  and size. Paths are confined to the collection: one resolving outside it is refused
  and the reason becomes a run warning, because writing wherever a caller points is a
  far larger authorization than running its requests. A report that cannot be written
  never fails a run.

  The JUnit XML follows upstream's reporter, with four deliberate differences that all
  come down to a report not reading greener than the run it describes: a request that
  ran and verified nothing gets a *skipped* testcase rather than an empty suite, which
  every CI summary renders as a pass; a request file that would not parse, a named
  request that resolved to nothing and a group that crashed each get a suite of their
  own; a named group's label is folded into the suite name, since the schema has no
  concept of one; and the machine's hostname is not written into a file meant to be
  committed. The HTML report is Bruno's own generator, with execution groups as its
  iterations. Note that its page loads Vue and naive-ui from `unpkg.com`, so it needs
  network access when opened — that is upstream's template, unmodified.

- **Each result now carries the `path` of the request file it came from**, absolute and
  in the same shape `list_requests` reports, so a failure in a run of twelve requests
  can be read back or re-run by name instead of being matched up by its title.

- **A WebSocket request can pace the messages it sends**, via `sendIntervalMs` on the
  run's `websocket` options. Every message previously left in one tick — three sends
  all recorded at the same millisecond — which put any send-wait-send protocol out of
  reach: all the replies arrived after the last send, so the exchange had no order to
  assert on. With a gap set, the transcript carries each answer between the sends it
  belongs to. The default of `0` keeps the old behaviour. `maxDurationMs` has to cover
  the whole paced sequence; a session stopped part way through now names the messages
  that never went out, by their authored name, instead of leaving a transcript one
  send short to be misread as a peer that stopped answering. The idle bound is not
  armed while the sequence is still going out, so a `sendIntervalMs` longer than
  `idleTimeoutMs` is safe.

- **An authored `Sec-WebSocket-Protocol` header now negotiates a subprotocol.** Bruno
  has no separate field for one either, but the header alone reached the wire without
  ever reaching the connection, and the library validates the server's answer against
  the list it was given there — so a server that did exactly what the header asked for
  had its handshake aborted for offering a subprotocol nobody had requested. Writing
  the header was worse than leaving it out. The value is comma-split and trimmed as
  upstream does it, read in any case it was written in, and the protocol the server
  agreed to comes back in that result's `response_headers`. An authored
  `Sec-WebSocket-Version` is honoured the same way; a value that is not a number is
  reported as a warning rather than refusing the request without explanation.

- **A WebSocket transcript now says what each frame was.** An entry carries its
  `type` — `text`, `binary`, `ping`, `pong` or `close` — the authored `title` of a
  message the session sent, and, on a close frame, the `close_code` the peer gave
  with its reason as that entry's payload. A close code is frequently the entire
  diagnosis of a failed session (`1008` a refusal, `1011` a server error, `1006` a
  peer that vanished) and was previously discarded, along with every ping and pong.
  Control frames do not count toward `maxMessages`: a peer that pings once a second
  would otherwise reach the bound by itself and report `count` for a session that
  received no answer. A binary frame's payload is recorded as base64 rather than
  decoded as UTF-8, which replaced every invalid sequence and reported a size that
  never went over the wire; `bytes` is now the true wire size for every kind of
  frame. A post-response script sees the same fields, since the transcript is what
  `res.body` is on this transport.

- **A WebSocket session ends when it goes quiet**, after 1500 ms of silence,
  reporting `stop_reason: "idle"`. Sessions previously spent every millisecond of
  the wall-clock ceiling waiting on a peer that had already answered — eight
  requests at `maxDurationMs: 2500` took 22 seconds — because that ceiling was the
  only thing that could end a request/response session. The new `idleTimeoutMs`
  bound is settable per run and `0` restores waiting for the ceiling, which is what
  a protocol whose gaps are longer than its answers needs. The clock is armed by the
  first frame rather than at connect, so a listen-only request that authors no
  messages still gets the full budget. An idle stop is **not** reported as
  `truncated`, unlike `count`, `timeout` and `bytes`: no cap bit, and the budget went
  unspent.

- **Response headers on every result, as `response_headers`.** Previously they were
  reachable only by authoring a test script to capture them, which meant writing a
  script to see something the runner already had. No flag gates them, and
  `includeResponseBody: false` does not suppress them — that option bounds a body.
  Credential-named values are masked, with one deliberate exception: a response's
  `set-cookie` keeps every attribute and withholds only the cookie value, because
  `HttpOnly`, `Secure` and `SameSite` are the reason to ask for these headers in the
  first place. It is reported as a **list**, one entry per cookie, since a
  comma-joined `set-cookie` cannot be split back into the cookies that produced it.
  A WebSocket result carries the field too, holding its handshake response: frames
  have no headers, so the 101 is the only place a session cookie or an agreed
  `sec-websocket-protocol` is visible for that transport.

- **gRPC and WebSocket requests can now fail.** Scripts, `test()` blocks and
  assertions ran only on the HTTP path — both transports returned before it — so a
  request's declared checks were parsed, written back faithfully and never
  evaluated. In a mixed collection both kinds inflated `passed` with zero
  verification, and `requestsWithoutTests` was the only signal, which reads as an
  author's omission rather than as a capability that did not exist.

  `res` describes what actually happened rather than a translation into HTTP. For
  gRPC, `res.getStatus()` is the gRPC code — **`0` means OK here**, colliding with
  the refusal sentinel used everywhere else, because mapping OK to 200 would make a
  passing assertion say something untrue about the call; trailers are readable
  through `res.getHeader()`, and `res.getBody()` is the parsed response message.
  For a WebSocket session, `res.getBody()` is the transcript, so a script reads a
  session the way a caller already does, and `res.getStatusText()` is the stop
  reason.

  A request that never happened — refused, blocked, or a handshake that failed —
  carries no response and its assertions are not evaluated: it already reports its
  own error, and checking a request that was never sent would report that single
  failure twice in the wrong vocabulary.

  **A script sees WebSocket payloads even when the surfaced transcript withholds
  them.** That is the split the HTTP path already draws — `res.body` always carries
  the full body while `response_body` is gated — and without it an assertion could
  not check the one thing a session produces. The script-facing copy is bounded by
  its own memory ceiling rather than by `maxTranscriptBytes`, so a display setting
  cannot quietly make an assertion pass by trimming the frame that would have
  failed it.

  Pre-request scripts still do not run for these transports; that is separate
  machinery, since `req.setUrl`/`setHeader`/`setBody` have no target here.

### Changed

- **A JUnit suite name now carries the row it came from.** Two iterations of one group are
  two groups with one name, and a suite name is what a CI dashboard addresses a suite by,
  so 200 rows previously contributed 200 suites indistinguishable from one suite reported
  200 times. They are now `login row 0: alpha`, `login row 1: alpha`, and so on. Runs
  without rows are unchanged.

- **A source archive of the repository now holds only what it takes to build and run the
  server.** `git archive` is what GitHub serves as "Download ZIP" and as the source
  tarball on every release, and until now it carried the whole repository: the test suite
  and its fixtures, the design notes and plans, the CI workflows and issue templates, the
  contributor instructions. `src`, the manifests, the licence, the changelog, the README
  and the integration guide stay; the rest is marked `export-ignore` in `.gitattributes`,
  with a comment against each entry saying why it is not needed to run the server.

  Nothing else changes. The npm package was already `dist/` only, decided by the `files`
  field in `package.json`. A clone, a fetch and a CI checkout are git operations rather
  than archives, so every excluded file is still there for anyone working on the
  repository, and every CI gate still runs against all of them.

  None of it would take effect without the `!.gitattributes` line in `.gitignore`, where
  line 1 is `.*` and an ignored `.gitattributes` is not an error — it simply governs
  nothing. That line was already there, added for the CSV fixture's line endings; its
  comment now names this second thing it silently protects.
  `tests/unit/meta/source-archive.test.ts` builds an archive and reads it back, so both
  that trap and a top-level directory added later without a decision fail by name.

- **Repositioned: this is not "the MCP server for Bruno", and no longer says it is.** In
  August 2026 Bruno's own team announced an official server, `usebruno/bruno-mcp`, which
  wraps the `bru` CLI to discover and run requests. The README now says so in its opening
  paragraph, names what each is good at, and adds it to the comparison table; the npm
  description and the registry manifest lead with what is actually distinct here —
  non-destructive authoring, byte parity across both dialects, execution groups,
  multi-identity authorization testing, gRPC and WebSocket. The "active fork of
  macarthy/bruno-mcp" banner is out of the lead and the provenance now lives in the FAQ,
  where it belongs.

  Two stale claims went with it: the README twice pointed readers elsewhere for JUnit and
  HTML report files, which this server gained earlier in this same unreleased cycle.

- **`LICENSE` names its copyright holders.** It said "Bruno MCP Contributors", which was
  inherited and identified nobody. It now carries the original project's notice and this
  one's separately. Added `CONTRIBUTING.md`, which documents the five CI gates, the two
  traps in trusting a local run, and a DCO sign-off requirement — so that provenance stays
  traceable while the project still has few enough contributors for that to be cheap.

- **A request whose oauth2 token could not be fetched is refused instead of sent
  unauthenticated.** It used to go out with no credential and a warning attached to the
  result. Against a protected endpoint that produces a 401 that reads like a
  misconfiguration; against one that permits anonymous access it produces a pass, having
  exercised an identity the file never named. Authorization testing is what this server is
  mostly for, so a run that goes green as nobody is the worse outcome of the two.

  The refusal is a result, not a thrown error: the request fails by name with `status: 0`,
  and the rest of the group still runs. It applies to HTTP, gRPC and WebSocket alike, and
  only when an automatable grant's exchange actually failed — a grant that needs a browser
  is still reported and still sent without a credential, since no exchange was attempted.
  A run that means to test the unauthenticated case should set the auth type to `none`.

### Fixed

- **`list_requests` and `get_collection_stats` say when a request's extension means Bruno
  will not see it.** A collection's dialect comes from its root manifest, and Bruno reads
  only that extension — so a `.yml` request in a `bruno.json` collection is, to Bruno, a
  file sitting in a directory. Every tool that *reads* a request already warned about
  this; the two that *enumerate* them did not, which is the surface where it matters most,
  since every other tool's description sends the caller there to find out which requests
  exist. Stats counted such a file silently, reporting a total Bruno itself would not
  agree with. Both now warn, in a content block of their own, and both still list and
  count the file: the warning is about what Bruno reads, not about what this server will
  touch.

- **`assert`, `vars` and `settings` now reach a `.bru` WebSocket or gRPC request.** They
  were applied after the http-block path had already returned, and were not in the
  refusal list either, so passing an assertion for a `.bru` transport request neither
  wrote it nor said it had not been written. The `.yml` writer applied all three
  throughout.

- **An edited `.yml` api-key credential is written as `apikey`, the mode Bruno's reader
  matches.** The edit path wrote `type: api-key`, which its reader does not match, on a
  request that had just been told to authenticate — so the credential was on disk and
  inert. Create and edit now share one builder, and a test compares their bytes.

- **A WebSocket message's `selected` flag is now written and read in `.bru`.** The model
  behind both dialects treated the flag as `.yml`-only, so the true case was dropped on
  the way out and never recognised on the way in. It is carried now, in the one
  direction the format can express. The direct dependency on `@usebruno/lang` moved from
  `^0.36.0` to `^0.38.0` for it: 0.36 has no `selected` support in a `body:ws` block at
  all, so our writer emitted the line and upstream's grammar discarded it.

- **A `.bru` file that would not parse was reported with its position and no
  reason.** `parseFailures[].message` kept the first line of the parse error, which
  is where `yaml` puts its reason and where the ohm grammar behind `.bru` puts only
  a line and column — its `Expected …` list comes last. A misspelled block name
  therefore came back as `Failed to parse .bru file: Line 7, col 1:` and nothing
  else. The message now carries the expected-block list as well, with the families
  collapsed (`auth:basic`, `auth:bearer`, … to `auth:*`) so the whole grammar fits
  inside the length cap instead of being cut off before the block the author meant.
  Code-frame lines are still dropped, because they echo the file: a token list
  cannot carry a credential out of a request body.

- **An authored `timeout: inherit` was deleted on the next write.** Both dialects
  accept the word — `bruToJsonV2` reads it out of a `.bru` settings block, and
  Bruno's `.yml` writer carries it through rather than flattening it — but both
  parsers here took `timeout` only as a number. A modelled key never reaches the
  passthrough bag, so the value reached neither the model nor the file it came
  from, and the request came back with no timeout at all: a silent change to how
  somebody's request runs, not just a lost string. The word is now modelled, and
  both the request deadline and the script budget answer it with the runner's own
  default. That is what there is to inherit: Bruno's app inherits an
  application-level preference here, and this server has no preference layer. The
  MCP schema still accepts only a number, so `inherit` is a value this server
  preserves rather than one it can author.

- **An unrecognised `settings.tls` block was dropped whole.** `tls` is a modelled
  settings key, so a field inside it that the model does not name reached neither
  the TLS fields nor the settings passthrough bag: a partially-recognised block
  lost its unknown fields, and a block made entirely of them parsed to nothing and
  took the key with it. The block now carries a bag of its own, so `tls` survives a
  read-modify-write whether or not this server understands what is in it.

- **A gRPC or WebSocket request was written with HTTP's `settings:` block.** Every
  `.yml` request got `encodeUrl`, `followRedirects` and `maxRedirects` — keys that
  describe redirect-following and URL encoding, which neither transport does, and
  which Bruno's own readers for those kinds never look at. A WebSocket request also
  lost the one setting it should have had. Each kind now gets the block Bruno
  writes for it: the four keys for HTTP, `timeout` and `keepAliveInterval` for
  WebSocket, and none for gRPC. A gRPC request keeps a block the author wrote,
  which is a deliberate difference from Bruno — `settings.tls` gates the transport
  here, so discarding it would disarm that gate on the next write.

- **The reader and the writer disagreed about a request whose extension does not
  match its collection.** A run happily executed a `.yml` request sitting in a
  `bruno.json` collection, while `modify_request`, `add_test_script`,
  `remove_script` and `read_request` refused to touch it — so the one file you
  could not repair was the one being executed, and Bruno's own app and `bru run`
  skipped it either way (`bruno-cli` selects request files by the dialect the
  collection's marker declares, not by trying both).

  One decision now applies in both directions, and it is the decision this
  project already documented for `.yaml`: operate on the file, and say Bruno will
  not see it. The four tools succeed and append a warning naming the file and the
  rename that fixes it; `run_collection` reports the same thing for every
  mismatched request it discovers, so a green run here can no longer be read as a
  green run in Bruno. **This is a behaviour change**: calls that previously came
  back as errors now succeed.

  The refusal was also hiding a latent write fault rather than preventing it:
  `add_test_script` picked its serialiser from the *collection's* dialect, so the
  first caller to reach that line with a mismatched file would have had `.bru`
  text written into a file named `.yml`. The dialect now follows the file.

- **A message payload written as a YAML mapping was sent as `[object Object]`.**
  Writing structure as structure is the reason to author a payload in YAML at all,
  and it produced those fifteen literal characters on the wire — the declared type
  accepted, the frame sent, the run passed. A structured payload is now serialised
  as JSON, matching what upstream's own normaliser does with a non-string, while a
  payload that is already a string is left byte-for-byte alone. The gRPC message
  path carried the identical fault and is fixed with it: a mapping body there
  failed with a JSON parse error rather than sending nonsense, and now works.

- **A WebSocket message declaring a type this transport cannot honour now says
  so.** Every declared type produced a text frame carrying the literal characters
  of whatever was written, so a payload announced as `binary` reached the peer as
  the ASCII of its base64 and passed. Nothing decodes it now either — Bruno has no
  binary WebSocket path anywhere, and inventing one here would put bytes on the
  wire its own runner never would — but the request reports what it could not
  honour instead of accepting it in silence. A type outside `text`, `json` and
  `xml` is named in a warning; `binary` and `base64` additionally say the gap is
  in the format rather than in a setting to correct.

- **A message carrying no payload no longer fabricates an empty frame.** An entry
  with no inner `message` object, and one with a `message` object but no `data`
  key, each sent a 0-byte frame. An empty frame is a protocol event in its own
  right — a peer can be waiting for one — so inventing it from a message that
  authored none is worse than sending nothing. Such a message is now skipped and
  named in a warning, and the frames around it are unaffected. This follows
  upstream's per-message send guard rather than its queue-everything-on-connect
  path, which do not agree with each other.

- **An auth block the parser could not interpret was applied as no auth, in
  silence.** An unrecognised auth *value* has always been reported; an
  unrecognised auth *shape* was not, so a request whose file plainly claims a
  credential went out bare with nothing in the result saying so. The specific
  shape worth naming is `mode:`, which is Bruno's in-memory spelling and the one
  collection and folder roots genuinely use on disk — a request spells it `type:`,
  and guessing wrong produced no diagnostic at all. It now warns, names the keys
  it found, and points at the right spelling.

- **`websocket.maxTranscriptBytes` was a hint rather than a bound.** The ceiling
  was only checked after a frame had been appended, so a single large frame was
  recorded whole: a 100-byte budget could hold 2000 bytes. The payload is now
  clipped to what is left of the budget before it is stored, while the reported
  `bytes` still gives the frame's true size — the same honest arrangement
  `maxFrameBytes` already had.

- **A WebSocket request that sends nothing now says so.** Five shapes produce a
  session that connects, sends no frame, records whatever the peer volunteers and
  passes: no `message` key, an empty list, every entry deselected, `selected`
  omitted, and `selected` given as the string `"false"`. The last two look
  selected to anyone reading the file. The run already refuses to let zero
  requests or an empty group pass silently; this applies the same rule to the
  message list.

- **A handshake header the WebSocket constructor rejects now reports which target
  it refused.** The constructor validates headers and throws synchronously — on a
  CR/LF in a value, or a name that is not a token — and that throw escaped the
  transport to be reported without a `url`. A caller refusing several targets at
  once could not tell which one had been rejected.

- **A misspelled `websocket` run option is now rejected instead of ignored.**
  Every option already rejected an out-of-range value by name, but an unknown key
  was accepted and dropped, silently restoring the default. `maxMessage` is one
  character from `maxMessages` and looked applied.

## [2.2.1] - 2026-08-07

### Added

- **Listed on the MCP registry.** A `server.json` declares the server under
  `io.github.Ostico/bruno-mcp-studio`, and `package.json` carries the matching
  `mcpName` that the registry reads back off the published npm manifest to prove
  the two are owned by the same people. A release now updates the listing by
  itself: the release workflow gained a second job that authenticates with the
  same GitHub OIDC token npm already uses, so no additional secret exists to
  leak or rotate. The job is separate from the publish job on purpose — if the
  listing fails it can be re-run alone, where re-running the publish job would
  try to publish a version npm already has and fail permanently.

## [2.2.0] - 2026-08-07

### Fixed

- **A gRPC or WebSocket request was destroyed by an edit to any request in the
  same collection.** Neither dialect's parser modelled a transport block, so the
  run model never held one — and every write rebuilds the file from that model.
  One `modify_request` on an unrelated request, or a rename, rewrote the file
  without its target, its credentials and every stored message. The data was gone
  from disk and nothing reported it. Both dialects now carry `grpc` and
  `websocket` blocks through parse, model and write, and four files — both kinds
  in both formats — are edited on an unrelated field and asserted intact, by
  message *content* rather than by count: the `.bru` grammar substitutes `{}` for
  an empty message body, so two content-destroyed messages still round-trip as two
  blocks and a count assertion would pass on total loss.

### Added

- **gRPC and WebSocket requests run.** A gRPC request performs one unary call
  against the service its `.proto` declares; a WebSocket request opens the socket,
  sends the frames the file stores and records what comes back until a bound is
  reached. Both go through the same SSRF validation, address pinning, variable
  substitution and auth as an HTTP request.

  A gRPC result carries the gRPC status code, the details string and redacted
  trailing metadata. The code lives in its own field and is never mapped onto the
  result's `status`, because gRPC's OK is `0` and `0` is this API's refusal
  sentinel — a successful call and a security refusal would otherwise be
  indistinguishable in the field read first.

- **WebSocket sessions are bounded, and every bound is settable per run.** A
  socket has no natural end, so `run_collection` takes a `websocket` argument:
  `maxMessages` (50), `maxDurationMs` (5000), `maxFrameBytes` (65536),
  `maxTranscriptBytes` (1048576), `includePayloads` (false) and
  `engineIoKeepalive` (false). The result names which bound ended the session in
  `stop_reason` and sets `truncated` for the three that cut one short. Out-of-range
  values are refused by name rather than clamped.

- **`read_request` reports both kinds**: the target, the method and proto path for
  gRPC, the metadata or headers block, and how many messages are stored.
  `list_requests` and `get_collection_stats` include them.

- **A collection can be reached over socket.io** without a socket.io block
  existing in either file format. A socket.io v4 server accepts a raw WebSocket at
  its own path, and its frames are text; the README carries the recipe. The one
  part that cannot be written as a stored frame — answering the server's
  engine.io PING so it does not disconnect you at `pingTimeout` — is
  `websocket.engineIoKeepalive`.

### Changed

- **`run_collection`'s description no longer claims that every unparseable
  request file is skipped.** That holds for a file the server discovered, by
  running the whole collection or expanding a directory. A file you *named*
  yourself fails the group that named it, because you asked for that specific
  request and there is no partial answer to it. The other groups still run. The
  behaviour is unchanged; the description was wrong about it.

- **Neither transport package is loaded until a request needs one.** An HTTP-only
  run resolves `undici` and neither `@grpc/grpc-js` nor `ws`. This is enforced by a
  test that records every module the real server child resolves, with a positive
  control on each transport — a recorder that silently wrote nothing would satisfy
  the negative assertion perfectly.

- **A file whose declared type and target block disagree is now a parse error
  naming both** — `type: grpc` with an `http:` block, say. The type decides what a
  reader reports and the block decides what a runner contacts, so a file where they
  differ cannot be read unambiguously and neither signal should win silently.

- **A `.bru` request whose target url is empty is refused on write.** The grammar
  drops a transport block with a falsy url while keeping its sibling `metadata`
  block, so writing one produces a file that looks authored, carries a credential,
  and goes nowhere.

### Security

- **A gRPC channel never uses an ambient proxy.** `@grpc/grpc-js` honours
  `http_proxy` where undici's `fetch` does not, so a proxy the operator never
  configured for this server would have seen gRPC traffic that HTTP traffic never
  reaches. `grpc.enable_http_proxy` is set to `0` unconditionally, and a test with
  a real proxy listener asserts it counts zero CONNECTs.

- **A proto file's whole import graph is confined to the collection.** Transitive,
  because the escape can be one hop in: a confined entry file importing a confined
  neighbour that imports `/etc/hosts` would otherwise pass. Symlinks that point
  out, absolute imports and paths under `$HOME` are all refused. Bundled
  `google/protobuf/` imports are exempt — they resolve to no file under the
  collection, and treating them as escapes would refuse every proto that uses a
  well-known type.

- **Frame contents are not recorded unless asked for.** Outbound frames are
  recorded *after* `{{var}}` substitution, so recording them by default would write
  every secret passed in `variables` — documented as the only correct way to supply
  one — into a result that is returned by default. `includePayloads` opts in.

- **A target that asked for TLS and cannot have it fails rather than downgrading.**
  Upstream's client falls back to an insecure channel when SSL credentials cannot
  be built; that sends the credential in the clear. Credential-bearing gRPC
  metadata and WebSocket handshake headers are masked by name in results, including
  any header the request's own auth wrote.

- **An auth mode a transport cannot honour is refused, not sent bare and not
  silently dropped.** A digest credential needs a 401 challenge and there is no
  such exchange on either transport, so it refuses. A query-placed api-key refuses
  for gRPC, whose target has no query string, and is appended for WebSocket, whose
  target has one.

## [2.1.1] - 2026-08-05

### Added

- **`npx @ostico/bruno-mcp` works.** The package declares a `bin`, so a client
  config is now `command: "npx"`, `args: ["-y", "@ostico/bruno-mcp"]` with nothing
  installed and no absolute path to keep in sync. `npm install` puts a `bruno-mcp`
  executable in `node_modules/.bin/` for a pinned setup.

### Fixed

- **The server never started when it was invoked through a symlink or a path
  containing a space.** Its main-module check compared `import.meta.url` against
  `` `file://${process.argv[1]}` ``, and neither case matches: `npm` links a `bin`
  into `node_modules/.bin`, where `argv[1]` is the link and `import.meta.url` is
  the target, and a file URL percent-encodes a space where string concatenation
  does not. Both ended the same way — exit code 0, no output, no JSON-RPC, a
  client seeing a server that appears to start and then ignore it. A path such as
  `~/Library/Application Support/…` or any checkout under a directory with a
  space in its name was enough to hit it. Resolved with `realpathSync` plus
  `pathToFileURL`, and covered by integration tests that spawn the built server
  through a symlink and through a spaced path.
- The startup banner said the server was "ready to generate Bruno API testing
  files", which stopped being the whole story when the runner landed.

## [2.1.0] - 2026-08-05

### Added

- **Bruno's dynamic variables work now: `{{$guid}}`, `{{$timestamp}}`, `{{$randomEmail}}`
  and the ~120 others.** A collection written in Bruno that uses one used to send the
  placeholder verbatim — a literal `{{$guid}}` in the path — and then report it as an
  unresolved variable, because nothing declares a generator. They are expanded from
  `mockDataFunctions`, the same table Bruno's app and CLI use, in urls, headers, query
  params, bodies and auth, once per occurrence rather than once per request. A keyword
  no generator answers to is still left as written and still named in the warnings, so
  `{{$gid}}` remains a typo the run tells you about.

  In a JSON body and in a GraphQL variables block the generated value is escaped first.
  `{{$randomLoremParagraphs}}` emits newlines, and a raw newline inside a JSON string
  ends the document; unescaped it produced a body the server could not parse. The
  GraphQL *query* is deliberately not escaped — it is a string in an envelope this
  server stringifies itself, so escaping there would reach the server doubled.

  One nuance worth knowing: a generator written inside an environment variable's value
  is expanded when variables are prepared, before the target field is known, so it is
  not JSON-escaped. Writing the generator in the body rather than in the variable gets
  the escaping.

- **A drift gate: everything we write is read back by Bruno's own reader.** Our
  tests assert our bytes against our own expectations, which cannot catch the one
  failure that actually costs users — a field written under a key Bruno does not
  read. That file parses, round-trips through our parser, and reaches the runner
  empty; it has happened twice. `@usebruno/filestore`, the package Bruno's app
  and CLI parse with, is a devDependency now, and one test hands it our output
  for every body mode, auth, header, query param, assertion and post-response
  variable in both dialects, asserting the values land where upstream's model
  puts them. Nothing here runs at runtime.

  A weekly job re-runs that test against the published `filestore` rather than
  the locked one, so a dialect change upstream shows up as a failing scheduled
  build instead of a user's bug report. It gates no pull request.

- **`res` is callable: Bruno's query language works in scripts and assertions.**
  `res("data.pets..name")` descends to every `name` in the tree, `[0]` indexes and
  `[?]` filters or maps with a callback — the syntax Bruno's docs use, and the only
  way it can reach a declared assertion, since a deep descent is not valid
  JavaScript on its own and a left-hand side must be one expression. Previously
  `res(...)` threw `res is not a function`, so every such path had to be written
  out by hand as loops in a script.

  The implementation is `@usebruno/query`, Bruno's own package, and it is not
  imported into the sandbox — a host function placed in a V8 context is a route
  out of it. Its source is compiled inside the context instead, so the function
  the script calls belongs to the sandbox's realm. A test asserts the published
  bundle still requires nothing and generates no code from strings, which is the
  property that makes this safe; another asserts the response kept every accessor
  and property it had before it became callable.

### Fixed

- **A `file` body is actually sent.** A request whose body mode is `file` — a
  binary upload, the mode Bruno's app writes when you pick a file — reached the
  encoder, matched nothing, and went out with **no body at all** plus a warning
  saying so. It now sends the file, following upstream's rules rather than
  inventing new ones: only the first selected entry is sent, the entry's own
  content type replaces `application/octet-stream` (and replaces an authored
  `Content-Type` header too, which is what Bruno does), an entry naming no type
  sends no `Content-Type`, and a read that fails costs the body rather than the
  request. Paths stay confined to the trusted upload locations, as multipart file
  parts already were, so a collection still cannot name `/etc/passwd`.

- **A file body written to `.yml` is one Bruno will actually send.** The two
  dialects default the `selected` flag in opposite directions: `@usebruno/lang`
  reads a `.bru` entry as selected unless it carries `~`, while the `.yml` reader
  is `selected: file.selected ?? false`. This server modelled both the `.bru` way
  and wrote no flag for a selected entry, so a file body it wrote to `.yml` parsed
  cleanly, kept its path, and then went out of Bruno with an empty body. The
  `.yml` reader now reads an absent flag as not-selected, exactly as upstream
  does, and the `.yml` writer always states the flag — as upstream's writer also
  does. A new oracle test reads the result back with Bruno's own reader and
  asserts it is selected, in both dialects.

- **A variable built out of other variables resolves, as it does under `bru run`.**
  An environment variable holding `https://{{host}}/{{stage}}` used to reach the
  wire with the inner placeholders still in it: substitution was a single pass, so
  an inserted value was never scanned again. Bruno's own `interpolate` — from
  `@usebruno/common`, now a dependency — does that pass for authored values, so
  environment, collection, folder and request variables nest the way upstream's
  do, to any depth.

  **One divergence, on purpose.** A value *captured from a response* — by
  `bru.setVar` or a post-response `vars` block — is inserted verbatim, once, and
  never scanned. A response echoing `key={{api_key}}` therefore sends that text
  rather than the key. The single pass was a template-injection mitigation to
  begin with; keeping it for the one tier the collection does not control is what
  makes recursive expansion safe everywhere else. Provenance, not syntax, decides
  which rule applies: authored values expand against each other first, and
  captured values are substituted into them last, so nothing a response
  contributed is ever re-read.

  A quirk inherited from upstream, pinned by a test rather than papered over: a
  placeholder naming an `Object.prototype` member (`{{constructor}}`) resolves to
  that member inside an authored value, because Bruno resolves against a plain
  object. It reaches nothing outside the variable set — `{{process.env.HOME}}`
  and `{{global}}` stay literal.

- **The graphql envelope matches Bruno's bytes.** `variables` is now always on
  the wire: Bruno reads the block as `... || '{}'`, so a request that stores none,
  or stores an empty one, sends `"variables":{}` rather than omitting the key or
  reporting that the variables do not parse. And a `.bru` file declaring
  `body: graphql` with no `body:graphql` block is a graphql request with nothing
  stored — it now sends `{"variables":{}}` with `application/json`, where before
  it went out with no body and no content type, and a rewrite dropped the `body:`
  line from its http block. A `.yml` graphql request still always carries a
  `query` key and a `.bru` one without a block still has none; that asymmetry is
  Bruno's own, and is reproduced rather than smoothed over.

- **Comments in a JSON body are removed before it is sent.** Bruno's editor lets
  a JSON body carry `//` and `/* */` comments the way `tsconfig.json` does, and
  Bruno strips them on its way to the wire. This server did not, so an annotated
  body was rejected by the server on a collection that runs clean under
  `bru run`. Both payloads Bruno strips are handled: the JSON body and a graphql
  request's `variables` block. Removal happens before variable substitution, as
  it does upstream, so a variable whose value contains `//` keeps it — and a
  `//` inside a string value was never a comment to begin with.

  A graphql `variables` block that does not parse now fails the request by name,
  with `Failed to parse GraphQL variables`, matching Bruno. It was previously
  sent as a raw string, which produced a server-side error that named nothing.

  New dependency: `jsonc-parser` (MIT, no dependencies of its own).

- **`tags` survives a rewrite, in both formats.** A request's runner tags are
  modelled now as what Bruno says they are — a list of strings, or absent — and
  written only when the list has something in it. `.bru` dropped every tags list
  before, because the key had to be excluded to stop `@usebruno/lang` from
  spelling a single-line value one character per line; `.yml` kept the bytes but
  exposed nothing, so tags could not be read or written deliberately; and
  converting `.bru` to `.yml` lost them outright. `read_request` reports tags now.

  A single-line `tags: smoke` is still dropped rather than repaired. Bruno's own
  runner reads any non-list value as no tags, so such a request is already
  untagged to anything that runs it, and turning it into one real tag would
  change which requests a `--tags` run selects.

### Changed

- **A redirect chain stops after 5 hops, not 10 — the number Bruno stops at.** An
  unset `maxRedirects` now resolves to 5, and a negative one to 5 as well, matching
  the arithmetic in Bruno's own runner. A chain that survives in the app survives
  here, and one that dies there dies here at the same hop, so a collection tuned
  against `bru run` behaves the same way under this server. An authored value is
  still honored exactly, and `followRedirects: false` still returns the 3xx
  untouched.

- **A graphql body with no query is refused when authored, and warned about when
  run.** `create_request` and `modify_request` now reject a graphql body whose
  query is empty — variables on their own, or nothing at all — in both formats.
  Such a request wrote successfully before and then could only fail at the
  server. A run still sends a queryless body rather than refusing, because
  upstream reads `body.graphql.query` with no check and does the same, so
  diverging would make a collection behave differently here than under
  `bru run`; the run result now carries a warning naming the request instead.
  The check runs after variable substitution, so a `{{query}}` that resolves to
  nothing is caught too.

- **A JSON body that is not valid JSON is named in a run warning.** The body is
  still sent, because Bruno sends an unparseable body too, but the warning says
  which request and where the syntax breaks instead of leaving a bare `400` to
  be interpreted. Checked after comment removal and after variable
  substitution — that is the text the server sees — and suppressed when a
  variable did not resolve, since an unresolved `{{id}}` is invalid JSON by
  definition and already has a warning of its own.

## [2.0.0] - 2026-08-02

> **Major, and it had to be.** The public API lost three exports after `1.2.3`
> (see *Removed* below), and `run_collection`'s input and output shapes both
> changed (see *Breaking changes* below).

### Breaking changes

- **Execution groups replace the folder as the unit of execution.** A run is now
  an ordered list of *groups*; a group owns its request list, its environment,
  its variables, its `parallel` flag, one variable store and one cookie jar.
  Nothing crosses a group boundary in either direction, at any `parallel`
  setting. The directory a request happens to sit in no longer decides any of
  this.

- **`run_collection` lost `requestPath` and `folder`; use `requests`.** Both were
  singular — one file, or one directory — and both are now one ordered
  `requests` array whose entries are files or directories. Order is the
  caller's, and duplicates are honoured: naming the same request twice runs it
  twice. Migration is mechanical: `requestPath: "auth/login.bru"` becomes
  `requests: ["auth/login.bru"]`.

- **`run_collection` gained `groups` and `maxConcurrency`.** Pass `groups`
  instead of `requests` when one call needs more than one identity or
  configuration — the same five requests as alice and as bob, or against staging
  and against production, in one call and without leakage. Passing both
  `requests` and `groups` is rejected rather than resolved by a precedence rule.
  `maxConcurrency` caps requests in flight across the whole run; omit it and one
  is derived from this machine's cores and memory, `0` lifts it entirely.

- **A named request that will not parse fails its group, not the call.** It used
  to throw out of `run_collection`, so a syntax error in one file meant every
  other group reported nothing at all — including the ones that would have
  passed. The group that named the file now reports `error`, runs nothing and
  counts as one failure; the rest of the run proceeds. The same applies to a
  named file that is not a request at all.

- **An empty `requests` list means nothing, not everything.** Omitting
  `requests` — at the run level or on a group — still runs the whole collection,
  which is how one collection runs under two identities. Supplying `requests:
  []` now runs no requests and warns, where before it ran the entire collection.
  A caller that filters a selection down to nothing was getting the widest
  possible run at the moment it asked for the narrowest.

- **Results are group-shaped: there is no top-level `results` array.** Each entry
  of `groups[]` carries its own `summary`, `results`, `capturedVariableNames`,
  `capturedVariables` and `warnings`; the top-level `summary` covers the run.
  This holds in the no-groups case too, where the run is one group — so a caller
  reading `result.results` reads `undefined`, and must read `result.groups[0]
  .results`. A group that crashed outright reports `error` and counts as one
  failure in the run summary, because a group that ran no requests contributes
  nothing to the per-request tally and would otherwise leave the run reading
  green.

- **`seq` no longer constrains execution.** It is the default ordering and the
  reporting order only. Two requests in one parallel group genuinely run at the
  same time whatever their `seq` says, and may contend on the store they share.

- **Silent behaviour change, worth reading twice.** A caller passing
  `parallel: true` today gets folder isolation: `bru.setVar` in one folder is
  invisible to another. After upgrading, `parallel: true` with no `groups` runs
  the whole selection as **one** group with **one** store and **one** cookie jar,
  so those requests now share state. Nothing errors and nothing warns — the run
  simply means something different. To keep the old isolation, name the folders
  as separate groups. This is the one change here that a passing test suite will
  not catch for you.

- **Node 22 or newer is required** (`engines.node` moved from `>=18.0.0` to
  `>=22.0.0`). Node 20 reached end of life in April 2026 and CI already tests
  only 22.x and 24.x, so the floor now says what was already true.

### Added

- **`create_request` and `modify_request` can author `assert`, `vars` and path
  parameters.** These three features were already applied at run time but had no
  field on any tool, so the execution engine was unreachable from the MCP surface:
  an agent could not write an assertion at all, and a `:id` segment had no way to
  get a value. This is the mirror of the *parsed, persisted, never applied* class
  the previous releases closed — same broken data path, opposite end.

  - `assert` — a list of `{ name, value, disabled? }`, where `name` is the
    left-hand expression and `value` is an operator plus operand (`eq 200`,
    `between 200, 299`, `isNumber`). Evaluated after the post-response script, so
    unlike a bare `expect()` in a script it needs no `test()` wrapper to report.
  - `vars` — `{ preRequest?, postResponse? }`. The halves stay asymmetric,
    matching Bruno: pre-request values are raw text folded into interpolation
    before the request is built, post-response values are JS expressions
    evaluated against the response.
  - `pathParams` — a record mirroring `query`, written as `params:path`. The two
    are replaced independently, so setting one never discards the other.

  Both formats are covered, and the switched-off flag keeps its per-format
  spelling on disk (`.bru` `enabled`, `.yml` `disabled`) while the tool surface
  exposes only `disabled`, absent meaning active.

### Security

- **An environment name may no longer be a path.** Names arriving from
  `run_collection` (per run and per group) and from every `EnvironmentManager`
  entry point were joined straight into `<collection>/environments/`, so a name
  containing a separator left the collection: on the read side it loaded any
  YAML the process could open and substituted its values into outbound
  requests, and on the write side it could overwrite or unlink a file outside
  the collection. Names containing `/`, `\` or a null byte, and the names `.`
  and `..`, are now refused.

- **`collectionRoot` must contain `collectionPath`.** It decides which
  collection- and folder-level scripts are executed, so a root pointing
  elsewhere ran another collection's root scripts against these requests and
  read its environments into these variables. It now has to be the collection
  path itself or an ancestor of it.

- **A run's OAuth2 tokens no longer outlive its group.** The token cache was
  run-wide, so a second group with different credentials was served the first
  group's bearer token, never contacted the provider, and reported success
  under its own name. The cache is per group, and the client secret and
  password are part of its key (hashed).

- **`maxConcurrency` no longer changes the process.** A run's ceiling was
  written into process-global state: overlapping runs re-capped each other,
  and a single `maxConcurrency: 0` left the process unbounded for every run
  after it. It is now a reservation released when the run ends.

### Removed

- **BREAKING:** `BruGenerator`, `generateBruFile`, and `createBasicBruFile` are
  no longer exported. They lived in `src/bruno/generator.ts`, re-exported from
  the package root via `export * from './bruno/generator.js'`, and were removed
  along with that module.

  The module was unreachable from every code path in the package: nothing inside
  the MCP server called it, and it measured 0% coverage once the coverage
  configuration was fixed to see files that no test imports. `.bru` generation
  in the server itself goes through `bru-parser.ts`, which is unaffected.

  These exports were removed *during* the `1.2.3` line rather than at a major
  boundary, so a consumer importing any of them breaks on upgrade with no
  warning. There is no drop-in replacement; the module had no callers to
  migrate. If you depended on it, pin `1.2.3` and open an issue describing the
  use case.

- **BREAKING:** the `BruQuery` type and the `BruFile.query` field are gone.
  Nothing read them: the `.bru` parser never populated the field and the `.bru`
  writer never serialized it, so the only code that assigned it was silently
  discarding data (see *Fixed*). Query parameters live on `BruFile.params` as
  `BruParam` entries, which round-trip and are applied.

### Fixed

- **`form-urlencoded` bodies survive both writing and rewriting.** Bruno spells
  this type two ways on purpose: the BLOCK is kebab-case
  (`body:form-urlencoded {`) while the MODE in the method block is camelCase
  (`body: formUrlEncoded`). The generator already restored that camelCase for
  multipart and simply never did it here, and the authoring path never built the
  entries at all.

  - **Rewriting an existing request downgraded the mode to `form-urlencoded`,**
    which Bruno does not recognise. The block survived, so the file still looked
    correct while the body stopped being sent. Any `modify_request` on a
    form-urlencoded request did this to it.
  - **`create_request` dropped the body entirely.** Upstream reads
    `body.formUrlEncoded` as an array of `{name, value, enabled}`; the builder
    handed it the raw `content` string, so no block was written and the request
    went out as an empty POST. Both shapes are now accepted — explicit entries via
    `formData`, or an encoded string via `content`, parsed with `URLSearchParams`
    so percent-escapes and `+` resolve as they would on the wire.

  A round-trip fixture had the kebab spelling too, which is why the existing
  completeness guard could not see either defect: it described this server's own
  output rather than a file Bruno would write. Corrected, with the multipart
  entry alongside it left as the reference — those two are the only body types
  whose mode differs from their block name.

- **The `.bru` files this server writes are now files Bruno can read.** Four
  defects, all of them invisible to a parse-then-compare test because our own
  parser is tolerant of our own malformed output. Each was found by reading the
  bytes on disk and checking them against upstream's source.

  - **`seq: undefined` was written into `meta`** whenever no sequence was given —
    the common case. The guard was there (`seq: ... : undefined`) but upstream's
    serializer walks the KEYS of `meta` and writes `${key}: ${value}` for each,
    so a key holding `undefined` becomes that literal text. Worse, the truthy
    string then suppressed Bruno's own `if (!meta.seq) meta.seq = 1` default. The
    key is now omitted, and an absent seq reads back as `1` the way Bruno intends.
  - **The method block said `auth: api-key`.** Bruno's token is `apikey`, matching
    its `auth:apikey` block, so the block we correctly emitted was ignored and no
    auth was applied. `api-key` remains the name on the tool surface, which is
    only ours.
  - **`placement` was never written.** We stored `in`, which upstream's serializer
    does not read, so the field came out empty. It is now written with Bruno's
    vocabulary (`header` / `queryparams`). The old `in` spelling is still accepted
    as tool input and translated.
  - **`placement` was never read**, and a request authored in Bruno reached the
    executor as mode `apikey`, missed the `api-key`-only branch, and **lost its
    key and value entirely** — the request went out with no credential while
    warning "api-key auth has no key name" about a file that plainly had one.

  Note there is no file-side back-compat to preserve for `in`: upstream's parser
  keeps a block's known keys and discards the rest, so that field never survived
  a read even for us. Files written with it were already resolving as `header`.

- **`assert` blocks are now evaluated.** They were parsed by both formats and
  written back faithfully, and never checked. A run reported **zero assertions and
  looked green** while every declared check was ignored — the worst shape a test
  failure can take, because nothing signals that nothing was verified. The
  sandbox's own warning text already described the symptom.

  Each assertion is evaluated in the same isolated context as the post-response
  script, where `res` and `bru` already exist, and reports one result of its own.
  Semantics follow Bruno's assertion runtime rather than a fresh interpretation of
  what the fields ought to mean:

  - The `value` field parses as `<operator> <operand>` across 28 operators, 12 of
    them unary. An unrecognised first token means the operator is `eq` and the
    whole string is the operand, which is what makes a bare `200` work.
  - `isTruthy` and `isFalsy` compare strictly against `true` and `false`. The
    names suggest truthiness; upstream does not implement it that way, and matching
    upstream matters more than matching the name.
  - `isJson` asks whether the value already **is** an object or array. A JSON
    *string* is deliberately not json.
  - The operand is coerced before comparison: `true`/`false`/`null`/`undefined`
    become those values, a quoted operand becomes its raw inner text, a numeric
    operand becomes a number — except past `Number.MAX_SAFE_INTEGER`, where the
    string is kept because the number would be altered — and anything else stays
    the text it already is, so a bare word is a string rather than an error.
    Upstream reaches that last case by evaluating the operand as a template
    literal; the sandbox has code generation disabled, so it returns the text
    directly instead. The two agree for every operand without a `${...}`
    placeholder.
  - `empty` throws for a value with no notion of emptiness (`null`, `undefined`, a
    number, a boolean) rather than answering "not empty", because the throw is
    what makes `isNotEmpty` fail on a missing field instead of passing.
  - `between` splits its bounds on commas only. `between [200, 299]` is a failure,
    not a range: upstream strips brackets for `in`/`notIn` alone, so the bounds
    arrive as `[200` and `299]` and fail there too. Extra bounds are ignored
    rather than rejected, because upstream takes the first two and drops the rest.
  - A `{{var}}` operand is resolved against the same merged variable map the URL
    is built from, so `eq {{expectedStatus}}` compares against the value. The
    operand alone is interpolated, and only after the operator has been parsed
    off: resolving the whole `value` first would let a variable's own text be read
    as the operator, so a bare `{{v}}` holding `eq 200` stays an equality check
    against the *string* `eq 200`, as upstream has it. An unresolved placeholder
    is left as written, which is what makes a missing variable visible.

  The post-response script runs **before** the assertions, as in Bruno, so an
  assertion can observe a variable the script set. The script gets its own error
  boundary, so a script that does not even parse no longer discards every declared
  assertion — upstream records a script-error entry and runs the assertions too.

  One consequence worth stating for anyone auditing an untrusted collection: a
  request with an `assert` block and no `script:` block now executes JS from the
  file where before it executed none. The trust boundary is unchanged — an
  assertion's left-hand side is arbitrary JS at exactly the post-response script's
  privilege — but "no `script:` blocks, so nothing runs" is no longer true.

  Three hardening fixes came out of reviewing that surface:

  - A left-hand side is compiled on its own before it is spliced, so it must
    genuinely be one expression. The wrapper's parentheses were never a boundary:
    an expression ending in `);` closed the call, and a trailing comment or a
    rebalancing function expression absorbed the tail. This also fixes a plain
    authoring case that used to fail — `res.status // why`.
  - `__results` is serialised to JSON inside the sandbox and parsed outside, like
    the variable store already was. It is a writable global, so sandboxed code
    could leave getters on it that then ran on the host stack after the vm call
    returned, with the timeout no longer applying.
  - A timeout is corroborated against the clock rather than recognised from its
    message text, which a collection can reproduce. Trusting the text let one
    assertion discard every result already recorded and everything still to run.

  Assertions the author switched off are neither evaluated nor reported. The two
  formats spell that flag with opposite polarity (`enabled` vs `disabled`), and
  here the cost of getting it wrong is higher than for parameters: it would run
  precisely the checks that were turned off and report their failures as the
  request's.

  A malformed assertion fails only itself. Each one is evaluated independently, so
  a bad expression cannot abort the remaining assertions or the post-response
  script.

  Most importantly, the sandbox is now invoked when a request declares assertions
  **but has no post-response script**. It was previously entered only when a script
  existed, so that case could not have worked however correct the evaluation was.

- The sandbox's `expect()` now supports the matchers ordinary chai usage expects:
  numeric comparisons under every common spelling (`above`/`gt`/`greaterThan` and
  the other three), `oneOf`, `match`, `startWith`, `endWith`, `within`, `json`, and
  the negations of each. Previously a post-response script written with
  `expect(x).to.match(/re/)` or `.to.be.within(1, 5)` failed as an unsupported
  matcher, even though the assertion was perfectly ordinary.

  Two details are deliberate. A comparison against a non-number throws rather than
  answering false, because JavaScript answers false for every ordering against a
  non-number and under negation that would read as a pass. And `match` uses
  `String.search` rather than `RegExp.test`, since a caller-supplied `/re/g`
  carries `lastIndex` between calls and the same assertion would otherwise pass and
  then fail.

  The guard that throws on an unrecognised matcher is unchanged: it is what keeps a
  typo from becoming a silent pass.

- `settings.encodeUrl` is now honoured, and URL encoding matches Bruno.

  The setting was parsed and preserved by both formats and read by nothing, while
  parameter values were percent-encoded unconditionally. Both halves of that were
  wrong, and the second is the one that mattered: this server was sending
  different bytes than Bruno for the same collection. A collection runner that
  quietly rewrites the request misreports what the collection does, and anyone
  debugging against the Bruno UI is chasing a difference introduced here.

  The transform is now a deliberate port of Bruno's, applied where Bruno applies
  it — over the whole finished URL, after interpolation, after path parameters,
  and after a pre-request script has had its chance to rewrite the URL:

  - Scheme and authority are preserved verbatim, including userinfo, port and
    bracketed IPv6 literals. A scheme is prepended first when absent, or the colon
    in a `host:port` authority would be encoded as path data.
  - Path segments encode idempotently (decode, then re-encode), so an
    already-encoded path is not encoded twice.
  - The query side is content blind and **intentionally double-encodes**:
    `?q=%20` becomes `?q=%2520`. That is upstream's documented contract — it lets
    a pre-encoded redirect URL survive a server-side decode pass.
  - `#` is data, not a fragment delimiter, and becomes `%23`. To send a literal
    fragment, turn the setting off, which preserves the URL byte for byte.
  - A parameter with no name is dropped; `?flag` stays valueless and distinct
    from `?flag=`.

  The default is two-valued, which is easy to get wrong in either direction: with
  **no** `settings` block the URL is sent **raw**, but a `settings` block that
  does not mention `encodeUrl` defaults it to **on**. Bruno writes
  `encodeUrl: true` explicitly when it saves a request, so anything its UI has
  touched arrives with the flag set.

  Consequently, parameter values are no longer percent-encoded on their own.
  **A value containing `&`, `=`, `?` or `/` changes the structure of the request,
  not just its content** — `q={{v}}` with `v` set to `a&b=c` sends two query
  parameters. This is upstream behaviour rather than a new weakness: Bruno splits
  query pairs on the raw string too, so its transform normalizes and does not
  sanitize. What is guaranteed is narrower and now tested: substitution only ever
  happens after the authority, so **no parameter value can change the target
  host**, and the SSRF check still runs on the final URL. A URL containing a
  newline is encoded (`%0A`) rather than passed through.

- Path parameters now also substitute inside OData-style segments —
  `/Customers(:id)`, `/Orders(Key1=:a,Key2=:b)`. Bruno recognises these in
  addition to a whole `:segment`, and only the latter was handled. A `:name`
  appearing in a query value is correctly left alone: upstream substitutes into
  the path and reattaches the raw query string.

- Query parameters given to `create_request` and `modify_request` are now written
  to the file. Three separate holes, all silent:

  - `create_request` on a **`.bru`** collection stored the pairs on a `BruFile.query`
    field that the `.bru` writer never serialized. The request landed on disk with
    no parameters at all — the caller got `success: true` and a file missing the
    data it had just supplied. The `.yml` path wrote them correctly, so the same
    call lost data in one format and not the other.
  - `modify_request` ignored its `query` input in **both** formats. It is part of
    the advertised tool schema, it was threaded all the way to the update
    function, and that function never read it. The call reported success and
    changed nothing.

  Query parameters replace the previous ones, the way `headers` already do. Path
  parameters are preserved across such an edit: the `query` input never names
  one, so discarding them would be collateral damage from an unrelated change.

  This was the writing half of the defect fixed above. Applying parameters at
  send time only helps a file that declares them, and for `.bru` collections
  created through the MCP tools, none did.

- Per-request `settings` authored in a `.bru` file now take effect. The executor
  reads the timeout, redirect policy, TLS options and proxy off the request's
  settings, and the `.bru`-to-executor translation did not forward them — so a
  `.bru` request's `settings { timeout: … }` was parsed, written back faithfully,
  and then ignored, leaving every such request on the 30s default. The `.yml`
  path honoured the same field, so the two formats disagreed.

- Query and path parameters are now actually sent. They were declared in both
  request formats, populated by both parsers and written back faithfully by both
  generators — and **nothing ever applied them to the outgoing request**. A
  `params:query` entry never reached the query string, and a `params:path` entry
  left `:id` in the URL verbatim.

  This was reachable end to end through the MCP surface: `create_request` stores
  its `query` input, the file on disk looks correct, a round-trip preserves it,
  and `run_collection` sent the request without it.

  Parameters are applied before the URL is validated, so the URL that is checked
  is the one that is sent. Values are substituted raw and encoding is left to
  `settings.encodeUrl` (see above), matching Bruno. A `:name` with no matching
  parameter is deliberately left standing: wrong but visible, rather than quietly
  pointing elsewhere.

  Note for the `.bru` path: the two formats spell the switched-off flag with
  opposite polarity (`enabled` vs `disabled`), so forwarding without inverting
  would have sent exactly the parameters the author turned off.

- **`.include`/`.contain` subset-checks an object**, as chai does, instead of
  refusing any target that is not an array or string. Verified against chai
  directly rather than inferred. Unreachable from the declared `contains`
  operator — its operand is always a coerced primitive, which chai rejects for an
  object target, so an object left-hand side still fails there exactly as it does
  upstream — but a hand-written script reaches it.
- **`length 0` no longer fails on an empty string.** The length was read behind a
  truthiness test, and `""` is falsy while still having a length.
- **`to.not.have.<unknown>` fails loudly.** It was the one chain object left
  unguarded, so an unknown matcher after it read `undefined` and reported a pass.
  No declared operator reaches it; a script can.
- **A zero-argument matcher that is a method rather than a getter now throws.**
  That is the one seam the unknown-matcher guard cannot cover: the property
  exists, so reading it asserts nothing and would report a pass. No operator hits
  it today; this keeps that true for the next one added.

- **`vars:pre-request` and `vars:post-response` are now applied.** The last member
  of the same class: both parsers read them, both generators wrote them back, and
  nothing at execution time ever looked at them. `bruFileToYamlRequest` dropped
  them too, so the `.bru` side would have stayed inert even after the executor
  learned to apply them — both ends needed fixing.

  The two halves are asymmetric, and matching that matters more than making them
  consistent:

  - `vars:pre-request` values are **raw text**, not expressions. They join the
    interpolation map between the environment and the runtime store — upstream's
    precedence is collection < env < folder < **request** < oauth2 < runtime <
    `process.env` — so a request var overrides the environment and anything
    `bru.setVar` wrote still overrides it. Each value is itself substituted
    against the variables established so far, in declaration order, so
    `{{version}}/widgets` resolves if `version` was declared earlier.
  - `vars:post-response` values **are** JS expressions, evaluated against the
    response and stored with `bru.setVar`. They run before the post-response
    script and before the declared assertions, which is upstream's order and is
    what lets both read them. A var whose expression throws is reported as a
    warning rather than a test result — its outcome is a variable, not a check,
    and inventing a failing assertion for it would inflate the reported count.

  Third occurrence of the opposite-polarity trap: `.bru` carries `enabled`,
  `.yml` carries `disabled`. Getting it wrong here is quieter than for an
  assertion — a wrongly applied variable leaves no trace in the report at all.

### Known gaps

Nothing in the request schema is parsed, persisted and round-tripped without being
applied any more — `vars:pre-request` / `vars:post-response` were the last of that
class and are now applied (see above).

One limitation of declared assertions specifically, recorded rather than left to
be discovered:

- **A bare variable name as the left-hand side is a `ReferenceError`, not
  `undefined`.** Bruno spreads env/collection/runtime variables into the
  expression scope, so `someVar: isUndefined` passes there; here it fails. Only
  the `{{var}}` form and `bru.getVar("name")` resolve. Seeding arbitrary variable
  names as context globals would risk shadowing `res`, `bru` and `expect`, so the
  fix belongs in a per-expression scope rather than the shared context.

(The second limitation recorded here — that no tool could author an `assert`
block — is fixed above.)

Auth is not in this category — unapplied types warn explicitly, and
`auth: inherit` reports that collection-level inheritance is unsupported.
`bearer`, `basic` and `api-key` are implemented (`api-key` accepts Bruno's own
one-word `apikey` spelling and honours both header and query placement); only
`oauth2` and `digest` are declared without an implementation, and both warn.

- JSON, XML and SPARQL request bodies are no longer sent labelled as plain text.
  A `Content-Type` is now derived from the body type: `application/json`,
  `application/xml`, `application/sparql-query`.

  The Fetch standard labels *any* string body `text/plain;charset=UTF-8`, and
  nothing set a `Content-Type`, so a JSON payload went out announced as plain
  text. That is worse than sending no type at all — a server handed an explicit
  but wrong type has no reason to sniff the content, so `express.json()` leaves
  `req.body` empty and Spring answers 415. Bruno derives the header at send
  time, so collections authored in the Bruno GUI carry no explicit
  `Content-Type` of their own and were affected by default.

  A `Content-Type` set by the collection always wins, matched case-insensitively
  (RFC 9110 §5.1). `text` bodies are deliberately left to the Fetch default,
  which is already the correct type and additionally declares the charset.

- `form-urlencoded` and `graphql` request bodies authored in a `.bru` file are no
  longer silently dropped. Running such a request sent it with **no body at
  all** — no error and no warning, just whatever the server made of an empty
  payload. Only the textual body types (`json`, `text`, `xml`, `sparql`) and
  `multipart-form` survived the translation into the executor's shape.

  The cause was a type that misdescribed its own data. Bruno spells the body type
  in camelCase inside the `http` block (`body: formUrlEncoded`) while naming the
  body block in kebab-case (`body:form-urlencoded {`). Only `multipartForm` was
  normalized, so `body.type` also carried raw values like `formUrlEncoded` —
  values the declared `BodyType` union does not contain. Because the field
  claimed to be a `BodyType`, nothing flagged the mismatch, and the translation
  only ever looked for a string body or a multipart array. Both of these bodies
  are parsed into their own fields, matched neither, and fell through.

  The camelCase spellings are now normalized at the parse boundary so the
  declared type is true, and `sparql` — a real Bruno body type that was also
  flowing through unlisted — has been added to the union.

  A `Content-Type` is now derived from the body type for these two bodies
  (`application/x-www-form-urlencoded` and `application/json`), since neither is
  usable without one. A `Content-Type` set explicitly by the collection is never
  overwritten.

  Form pairs and the GraphQL envelope are built *after* variable substitution.
  The reverse order is a correctness trap: a `{{var}}` whose value contains `&`
  or `=` would splice extra fields into an encoded form body, and one containing
  `"` would break a stringified JSON envelope.

  `body:file` remains unsent: `@usebruno/lang` 0.36.0 has no such block, so one
  parses as ordinary name/value pairs and the file path is never populated.

- Duplicate request headers are no longer silently dropped. A collection that
  authored the same header name more than once — two `Accept` values, two
  `Cookie` pairs, an `X-Forwarded-For` chain — sent only the last value. Both
  the `.bru` translation and the outgoing-request path collapsed repeats.

  Values are now combined the way the transport does: with `, ` in general
  (RFC 9110 §5.3) and `; ` for `Cookie` (RFC 6265 §5.4). Header names are
  matched case-insensitively while the first occurrence's casing is preserved
  on the wire. Headers explicitly disabled in the collection are still not sent.

### Added

- A warning when a request repeats a header that HTTP defines as single-valued
  (`Content-Type`, `Authorization`, `Host`, and similar).

  Combining is only semantics-preserving for fields defined as a comma-separated
  list; RFC 9110 §5.2 does not permit a sender to repeat a singleton field at
  all, and joining two `Content-Type` values with a comma yields a value the
  origin will usually reject. `fetch` cannot emit two field lines for one header
  name, so the combine stands — the warning exists so that an authoring mistake
  is reported rather than silently turned into an invalid request.

  The warning names the header and never its value. `Cookie` is excluded: it is
  legitimately repeated and is already joined correctly.

## [1.2.3]

Released before this changelog was introduced. See the git history for
per-commit detail.
