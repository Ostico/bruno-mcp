# Sandbox IPC contract

The frozen contract between the MCP server (parent) and the process that runs
untrusted `.bru` scripts (worker). It exists so the two halves of the sandbox
cannot drift, and so the security guarantees are written down where a reviewer
can check them against the code rather than inferring them.

This document is the deliverable of plan task 3.0. It gates task 3.2 (the fork).

## What this buys, and what it does not

The threat is a hostile or buggy `.bru` script — a pre-request or test script
authored by someone other than the operator, or an honest script that misbehaves.

`node:vm` **is not a security boundary.** Node's own documentation says so, and
this project proved it: the reproduced RCE escaped a hardened vm
context through a host-realm closure reachable via `bru`. Hardening the vm in
place (PRs #15–#17) closed the *demonstrated* escape, but cannot prove the
absence of the next one — a vm shares a heap and an event loop with the host.

Moving script execution into a **forked child process** changes what an escape
is worth, not whether one is possible. After the migration, a script that breaks
out of the vm inside the child can still call `require('child_process')` — but it
does so in a process that:

- **cannot read the server's secrets**: the child's `env` is scrubbed to an
  explicit allowlist, so the operator's real credentials (present in the parent's
  `process.env`) are not in the child's address space;
- **cannot corrupt the MCP transport**: the parent's stdout carries the
  JSON-RPC stream, and the child never inherits it (see stdio, below), so a
  script's `console.log` or a forged frame cannot reach the client;
- **cannot hang the server**: the child is killable, and the parent enforces a
  wall-clock bound with `SIGKILL` that does not depend on the vm timeout.

That last point is the structural fix. `node:vm`'s `timeout` is a V8 interrupt
that only covers work **inside `runInContext`**. Any host-side operation on a
script-controlled value *after* `runInContext` returns is unbounded and
uninterruptible — the defect class behind three separate critical bugs in the
in-process implementation. A `SIGKILL` on the child is an absolute bound that
holds regardless of what the script left running.

**Non-goals.** This contract does not attempt to stop code execution inside the
child (no seccomp, no namespaces, no native sandbox — the plan forbids those and
they are not portable). It does not use `worker_threads` (same address space as
the parent — no env or fd isolation). It is defence-in-depth via an OS process
boundary, nothing more, and should be described that way.

## Messages

Exactly one job in, exactly one result out, per child. All fields are
JSON-serialisable so the message survives both `child.send()` structured clone
and a plain JSON round-trip; neither side may place a function, a `Blob`, a
`FormData`, a `BigInt`, or a circular reference on the wire.

Projecting a non-serialisable **request body** to a safe form is the parent's
job, done by `toSendableJob` in `sandbox-host.ts` before `child.send()`. Under
the default `'json'` codec a `FormData` or `Blob` body would otherwise arrive as
`{}`, so a pre-request script would inspect an empty object instead of the body
it was handed. Instead the parent substitutes a truthful,
**names-only** descriptor:

- `FormData` → `{ type: 'multipart/form-data', parts: string[] }` — the part
  names only, de-duplicated; **never** part values or file contents.
- `Blob` → `{ type: 'blob', contentType: string, size: number }` — no bytes.

String, `null`, and plain object/array bodies already round-trip losslessly and
cross unchanged. This projection is a read-only view for the script; the actual
wire request is dispatched by the executor from the original body, not from what
crosses the boundary.

### Parent → worker: `SandboxJob`

```ts
interface SandboxJob {
  kind: 'pre-request' | 'test';
  script: string;
  timeout: number;              // already resolved; the worker applies no default
  request?: MockRequestData;    // present when kind === 'pre-request'
  response?: MockResponseData;  // present when kind === 'test'
}
```

### Worker → parent: `SandboxJobResult`

```ts
type SandboxJobResult =
  | { kind: 'pre-request'; result: PreRequestScriptResult }
  | { kind: 'test'; result: ScriptResult };
```

The reply is discriminated by the same `kind` the job carried. The result
payloads (`PreRequestScriptResult`, `ScriptResult`, `TestResult`) are defined in
`src/bruno/types.ts` and are unchanged by the migration — the parent hands the
`result` straight back to its callers.

`runJob(job): SandboxJobResult` in `src/bruno/sandbox-worker.ts` is the single
implementation of this dispatch. It is pure and synchronous, runs entirely under
the vm timeout, and reads nothing from the host realm. Today the parent's
`TestRunner` calls it in-process; in task 3.2 the forked worker calls it and the
parent talks to the worker over the channel below. There is deliberately **no
second in-process implementation** for the fork to drift from.

## Fork configuration (task 3.2)

The parent forks the built worker (`dist/bruno/sandbox-worker.js`, emitted as a
second tsup entry) with:

- **`stdio: ['ignore', 'pipe', 'pipe', 'ipc']`** — stdin ignored; stdout and
  stderr **piped and captured** by the parent (never inherited — inheriting fd 1
  is what corrupts the JSON-RPC stream); fd 3 the IPC channel for
  the messages above. Captured stdout/stderr are length-capped and returned as
  diagnostics inside the result, never replayed to the parent's own streams.
- **scrubbed `env`** — an explicit allowlist, not the parent's environment. A
  pure-compute worker needs none of the operator's variables.
- **no environment-driven worker path** — the worker location is resolved from
  the parent module's own location (`import.meta.url`), never from an env var.
  A `fork(process.env.SOMETHING)` in the very file meant to remove code execution
  would reintroduce it.

### Lifecycle and bounds

- **One job per child** (fork-per-script), gated by a **concurrency cap** so a
  100-request collection cannot spawn 200 simultaneous cold starts. A cap, not a
  long-lived pool: fork-per-script keeps scripts from leaking state into one
  another, and a hung script is simply killed rather than poisoning a reused
  worker.
- **Two independent budgets**: a spawn/handshake budget (the child failed to come
  up) and the script `timeout` (the script ran too long). They are not the same
  number and must not be conflated.
- **Escalating kill**: `SIGTERM`, a short grace period, then `SIGKILL`. The
  parent resolves the job as a timeout failure naming the script; it never hangs
  waiting on a child that will not exit.
- **`__chain` settles first**: the worker sends its result only after the test
  chain has settled, so an awaited assertion is observed rather than lost. This
  is the same ordering the in-process implementation already enforces.

### `bru` variable semantics across the boundary

- **Reads** see a snapshot seeded into the child at spawn; a script cannot read a
  variable written by a later request.
- **Writes** are collected inside the child and returned in the result for the
  parent to apply. `bru.getVar` stays synchronous — an async getter is refused,
  not awaited, so it cannot be used to stall the child past its budget.

## Failure handling

- A child that dies before replying (crash, `SIGKILL`, spawn failure) resolves as
  a script failure with a describing message — the server never crashes because a
  script did.
- The worker never throws across the boundary: it catches, describes the error as
  a plain string (no accessor or `toString` from a script-controlled value is
  invoked on the parent side), and returns a failing result.
