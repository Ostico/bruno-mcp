# gRPC and WebSocket: what is built, what is deferred, and why

Written alongside the implementation of gRPC and WebSocket support so that a later reader does not
re-litigate a decision that was already made, or assume a gap is an oversight. Every item below is
either implemented and named as such, or deferred with the reason.

**Status of this document.** It describes two pieces of work, shipped as two changes. The first —
reading, preserving and reporting these request kinds — is implemented. The second — executing them
— is implemented too, and this document was revised when it landed rather than left in the future
tense. Nothing here describes an unbuilt feature as though it exists; the deferred list below is
still deferred.

## What is implemented

A gRPC or WebSocket request in either dialect (`.bru`, `.yml`) is parsed into the run model, reported
by `read_request`, and written back without loss. Before this, both dialects silently dropped the
target block, the credentials and every stored message: a `modify_request` on *any* request in such a
collection rewrote the file from a model that had never held those blocks.

`run_collection` executes both: one unary call for a gRPC request, and a bounded recorded session for
a WebSocket one. A gRPC result carries the gRPC status code in its own field — never mapped onto the
result's `status`, because gRPC's OK is `0` and `0` is that field's refusal sentinel — and a
WebSocket result carries the transcript, the `stop_reason` and whether it was truncated. Every
WebSocket bound is settable per run; payload recording and the engine.io keepalive reply are both
off by default, each for a security reason given where it is implemented.

The kinds are refused, by name, where they cannot be honoured:

- A request whose declared kind names no transport this server has — and a transport request with no
  target block for its own transport — is a failure with `status: 0` and a reason naming the kind.
  The rest of the collection still runs.
- `modify_request` refuses an edit naming an HTTP-shaped field (method, url, headers, body, auth,
  query, pathParams) on a kind that has no http block, and leaves the file untouched. `name` and
  `sequence` still apply, because a request nothing can edit is the same data problem from the other
  side.
- A file whose declared kind and target block disagree — `type: grpc` with an `http:` block — is a
  parse error naming both. Neither signal wins silently: the type decides what a reader reports and
  the block decides what a runner contacts, so a file where they differ is one that cannot be read
  unambiguously.
- A `.bru` request whose target url is empty is refused on write rather than saved. The grammar drops
  a transport block with a falsy url while keeping its sibling `metadata` block, so writing one would
  produce a file that looks authored, carries a credential, and goes nowhere.

## Out of scope, deliberately

**gRPC streaming of any kind — server, client, bidirectional — and server reflection.** Unary is a
request and a response, which fits the existing per-request result shape. A stream does not: it needs
a session that outlives the call, a bound on how much is recorded, and a place to put a transcript.
Reflection additionally means a round trip to the server before the call, which changes what a run
contacts. Deferred until there is a caller that needs it.

**Proxy support for either new transport.** The existing proxy and certificate-pinning gates are
undici-only. `@grpc/grpc-js` has no public proxy API and honours the ambient `http_proxy` environment
variable whether or not we ask it to; `ws` needs its own agent to be proxied at all. Claiming proxy
support for these kinds would therefore be false for gRPC and unimplemented for WebSocket. The
existing gates are documented as HTTP-only rather than quietly extended.

**Sessions held open across tool calls, and any handle returned to the caller.** A handle implies a
lifetime this server does not have: a tool call is the unit of work, and a socket left open between
calls would outlive the request that created it with nothing responsible for closing it. A WebSocket
recording is bounded within the single call that starts it.

**A `socketio` or `mqtt` block in either dialect.** We do not own either file format. Both are open
upstream — `usebruno/bruno#5887` (socket.io) and `usebruno/bruno#6511` (MQTT) — and a private dialect
would collide with whatever lands there and then need users migrated off it. socket.io is reachable
today as a plain `ws` request; the recipe is below.

**Authoring gRPC or WebSocket requests with `create_request`.** Reading, preserving and reporting:
yes. Creating from scratch: not in this work. A create path needs its own input schema per kind, and
the demand for one has not appeared — an agent that needs such a request can copy a file Bruno wrote.

## socket.io over a plain `ws` request

socket.io is not a protocol on top of nothing; it is a framing convention on top of WebSocket. A
socket.io v4 server accepts a raw WebSocket connection at its own path, and its frames are text with
a numeric prefix. So a `ws` request reaches it with no new block and no new dependency.

Measured against socket.io 4.8.3 while planning this work:

1. **Connect** to `ws://host:port/socket.io/?EIO=4&transport=websocket`. The path and both query
   parameters are required: `EIO=4` selects the Engine.IO protocol version, and `transport=websocket`
   stops the server from expecting an HTTP long-polling handshake first.
2. The server sends **`0{...}`** — the Engine.IO OPEN packet. Its JSON payload carries `sid`,
   `pingInterval` and `pingTimeout`, in milliseconds. Read `pingTimeout`: it is the deadline in
   point 5.
3. **Send `40`** to connect to the default namespace. Nothing works before this. For a named
   namespace it is `40/namespace,`.
4. The server answers **`40{"sid":"…"}`**. Now events can be exchanged.
5. **Send an event** as `42["event-name",payload]` — `4` for MESSAGE, `2` for EVENT, then a JSON
   array whose first element is the event name. A server that echoes answers
   `42["echoed","pong:…"]`.
6. **Answer `2` with `3`.** The server sends `2` (PING) every `pingInterval`; a client that does not
   reply `3` (PONG) is disconnected after `pingTimeout`. Any recording longer than that window
   therefore depends on the runner replying to keepalives on the caller's behalf. **This is now
   built**: `run_collection`'s `websocket.engineIoKeepalive` does it, off by default, and only after
   an OPEN frame has actually been seen — a server that merely sends `2` never gets a `3` it did not
   earn. Steps 1 to 5 need nothing from the runner; they are frames the request file already stores.

Limits, stated plainly:

- **Locked to `EIO=4`.** Engine.IO v2 and v3 frame differently (v3 uses a length-prefixed format);
  the packet numbers above are not portable to them.
- **Acks and binary attachments are impractical by hand.** An ack is `42<id>[…]` with a client-chosen
  id whose reply is `43<id>[…]`, and binary payloads are sent as a `45`-prefixed placeholder packet
  followed by separate binary frames. Both are writable in principle and unpleasant in practice.
- **The file stays a legal `ws` request.** That is the whole reason this beats inventing a block:
  Bruno itself can open, run and edit the file, and nothing has to be migrated when upstream picks a
  spelling of its own.
- **What is verified, and what is not.** Steps 1 to 5 were measured against a real socket.io 4.8.3
  server while planning this work. Step 6 is covered by tests against a purpose-built engine.io peer
  — one that sends the OPEN frame and then pings — rather than against socket.io itself: what those
  tests must observe is our own reply and its two gates, and a real socket.io server would add a
  dependency without adding an observation. The gap that leaves is one real end-to-end session
  against socket.io driven by this recipe, which nothing in the suite performs.

## Why the transports are taken directly rather than through `@usebruno/requests`

`@usebruno/requests` ships both transports, callback-driven, and would have been the byte-parity
choice. Its cost is the problem. Measured installs:

| Tree | Time | Size |
|---|---|---|
| `@ostico/bruno-mcp` today | 3.3 s | 45 MB |
| plus `@usebruno/requests` (and its undeclared `qs`) | 9.9 s | 179 MB |
| plus `@grpc/grpc-js`, `@grpc/proto-loader`, `ws` | 3.8 s | 58 MB |

The 134 MB difference is not gRPC. `@usebruno/requests` declares `@azure` (38 MB), `@faker-js`
(9.7 MB), `@aws-sdk` (8.3 MB) and `@smithy` (7.5 MB) for vault integrations this server does not use
and cannot tree-shake away at install time. The transports are therefore taken directly, and the
parity risk that creates is answered by testing our behaviour against the wire rather than against
upstream's source.
