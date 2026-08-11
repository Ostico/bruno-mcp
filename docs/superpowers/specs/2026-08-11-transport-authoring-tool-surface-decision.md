# Tool surface for authoring gRPC and WebSocket requests

**Status:** accepted. Option C was chosen, unblocking Tasks 2 and 3 of
`../plans/2026-08-08-transport-authoring-tasks.md`. Task 2 implemented it for
WebSocket; the surface is one `create_request` with an explicit `kind` defaulting
to `http`, plus one optional nested object per transport.

**Question.** `create_request` is HTTP-shaped throughout — `method` is a required
enum of HTTP verbs — and there is no way to author a gRPC or WebSocket request
through this server at all. How should the authoring surface grow to carry two
more transports?

## Options considered

**A. A discriminated union on `create_request`.** One tool, `kind` selecting
between three input shapes. Keeps the surface small, but every caller sees
branches irrelevant to it, and a zod discriminated union reaches an MCP client as
`anyOf` — which models call less reliably than a flat object, and which the
tool-surface contract snapshot records as an opaque wrapper rather than as a
shape. It also puts the existing flat HTTP arguments inside a branch, so the
compatible-by-construction property is lost and has to be re-established by
tests.

**B. Separate `create_websocket_request` and `create_grpc_request` tools.** Each
schema is entirely relevant to its transport, which is the easiest thing for a
model to call correctly. Costs two more tools on an 18-tool surface — tool count
is context cost for every agent that connects, paid on every session whether or
not those transports are used — and splits "make a request" across three names,
so an agent that knows `create_request` does not discover the others.

**C. One tool, an explicit `kind` plus a nested per-transport object.**
Recommended. `create_request` gains `kind: 'http' | 'graphql' | 'websocket' |
'grpc'`, defaulting to `http`, and one optional object per non-HTTP transport
carrying only that transport's fields:

```
create_request({
  collectionPath, name, kind: 'websocket',
  url: 'wss://example.test/socket',
  headers: { 'Sec-WebSocket-Protocol': 'chat' },
  auth: { type: 'bearer', config: { token: '…' } },
  websocket: { messages: [{ title: 'hello', type: 'text', content: '…', selected: true }] },
})
```

## Why C

**It is already the house pattern.** `run_collection` runs all four transports
through one tool: the common arguments stay flat, and transport-specific bounds
live in optional `websocket: {…}` and `grpc: {…}` objects. A caller who never
touches WebSocket never sees a WebSocket field. Authoring should not invent a
second convention for the same problem one call away.

**Nothing existing changes shape.** `kind` defaults to `http`, so every current
call remains valid, and the flat HTTP arguments stay flat rather than moving
inside a union branch. The snapshot in
`tests/unit/tools/tool-surface-contract.test.ts` shows exactly two additions
rather than a rewritten entry, which is the diff a reviewer can actually check.

**The fields that stop applying are enforced, not documented away.** `method` is
HTTP-only; a WebSocket request has no method and a gRPC call names a service and
a method of its own. Under C these become cross-key rules — `method` required when
`kind` is `http` or `graphql`, refused otherwise; the transport object required
when its `kind` is named and refused when it is not. Those rules go in the
**handler**, not in the schema: a `.refine()` turns the input into an opaque
`ZodEffects` and the contract snapshot stops describing the shape it exists to
describe. Each rule gets its own tool-layer test, because a handler guard has no
schema to fail for it.

**Discovery costs nothing extra.** One tool name still answers "make a request",
and its description names the four kinds.

## Consequences for the remaining tasks

- **Task 2 / Task 3** add `websocket` and `grpc` objects and their writers. The
  acceptance criteria are unchanged: byte-comparable output against what Bruno
  writes, read as bytes rather than round-tripped through our own parser.
- **Task 4** (`modify_request` editing transport fields) takes the same shape —
  the same nested objects, the same kind-consistency rule, plus the existing
  refusal for a field the request's own kind cannot carry.
- **Registration order is part of the tool contract** and is pinned by the
  contract snapshot. C adds no tools, so registration order is untouched — one
  fewer thing for a reviewer to check.
- **Task 3's proto path keeps the run path's confinement**, transitively through
  imports. An authoring tool that accepted any path on disk would reopen what the
  run path deliberately closed; this decision does not soften it.

## What this decision does not settle

Whether `kind: 'graphql'` should also become explicit, or stay inferred from
`body.type === 'graphql'` as it is today. Recommended: accept it explicitly and
keep inferring it when absent, so a GraphQL request can be authored the way it
reads without breaking existing calls.
