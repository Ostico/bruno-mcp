# Bruno MCP Studio — author, edit and run Bruno collections from an agent

[![npm version](https://img.shields.io/npm/v/@ostico/bruno-mcp)](https://www.npmjs.com/package/@ostico/bruno-mcp)
[![npm downloads](https://img.shields.io/npm/dw/@ostico/bruno-mcp)](https://www.npmjs.com/package/@ostico/bruno-mcp)
[![node](https://img.shields.io/node/v/@ostico/bruno-mcp)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@ostico/bruno-mcp)](./LICENSE)

**Non-destructive authoring plus a real execution engine for Bruno collections: both
dialects at byte parity, caller-defined execution groups, multi-identity authorization
testing, gRPC and WebSocket — and no `bru` binary.**

An independent [Model Context Protocol](https://modelcontextprotocol.io) server for
[Bruno](https://www.usebruno.com) collections. In August 2026 Bruno's own team announced
an official one, [`usebruno/bruno-mcp`](https://github.com/usebruno/bruno-mcp), which
wraps the `bru` CLI to discover and run requests. This server is aimed elsewhere: it
**writes** collections as well as running them — non-destructively, at byte parity with
Bruno's own writers — and its runner is in-process rather than a subprocess, which is
what lets it offer caller-defined execution groups with their own variable store and
cookie jar, concurrency inside a group, oauth2 and digest exchanged in memory, gRPC and
WebSocket, and multi-identity authorization testing.

If what you need is "list my collections and run one", the official server does that and
will be the one Bruno supports. If you want an agent to build and maintain the suite,
that is what this is for.

It gives an AI agent in Claude Code, Claude Desktop, Cursor, Windsurf, VS Code or Codex CLI eighteen tools for API testing against a real Bruno collection: create and edit requests, read them back as structured JSON, manage environments and variables, write assertions and test scripts, then **run** the collection — auth, cookies, redirects, dependency ordering and all — and get the results back in the same turn. No Bruno GUI, no Bruno CLI, no shelling out. The collection it leaves on disk is a normal Bruno collection: your CI runs it with `bru run`, your teammates open it in the Bruno app.

**Your agent already knows HTTP. It does not know your API, and it does not know Bruno's file format.** So it guesses. It writes a `.bru` file from memory, the run fails, it rewrites the file, the run fails differently, and twenty minutes later you have a passing request and no idea which of the six edits mattered. You paid for every one of those turns, and none of that work is on disk in a form your CI or your team's Bruno GUI can use.

The usual escape is curl. Agents are not bad at curl — the problem is that a shell command holds no state. A login, a token, a created resource, a follow-up call that needs the ID from the last response: each of those is a new command, and the glue between them lives only in the agent's context, when the session ends, all is lost. Twenty endpoints tested by curl leave you with twenty strings in a transcript and no artifact your CI or your teammates can run. Twenty endpoints in a collection leave you with a suite.

## I asked my agent about it

I asked the agent that helps me to maintain this server to explain how its experience with Bruno had been *without* the MCP server, and whether it could simply have tested all my APIs with curls instead. This is what it told me:

> Curl, yes — for one call. Not for a suite. Nothing carries between calls, so I re-derive the auth, re-escape the body, and re-read every response to decide whether it passed. Do that across forty endpoints and most of what I spend goes on rediscovery, not testing.
>
> Writing the collection files myself was worse, and not in the way you would expect. From memory I get the shape of a `.bru` file right and the details wrong — and Bruno never complains. It reads the keys it recognises and ignores the rest. A single-line `tags: smoke` looks tagged and means *untagged* to the runner. Write a tags list the obvious way and it lands on disk one character per line. This server once wrote `.yml` variables and assertions under top-level keys Bruno has never read: the files looked complete, the runner saw an empty request. Its own unit tests passed, because they mocked the serializer and asserted the broken bytes.
>
> The format also moves. Bruno relocated variables into `runtime` and added a second dialect. My weights are older than that. This server imports `@usebruno/lang`, Bruno's own grammar package, and tracks its version — so the bytes come from Bruno's source rather than from what I happen to remember.
>
> And every rewrite deletes what the writer does not model. If I edit these files free-hand, I regenerate the whole file from my head, and any feature I did not know about is silently gone. That is the failure mode you never see, because the run still passes — it just tests nothing.

## What the server does instead

- **The agent stops guessing the format** — it calls a tool, the server writes the bytes, using Bruno's own grammar package
- **Edits are partial merges** — `modify_request` touches the fields you passed and leaves the rest of the file alone
- **It can read before it writes** — `read_request` returns structured JSON, the same shape for both formats
- **It runs the requests itself** — vars, auth, assertions, dependency ordering, no `bru` binary needed
- **No silent loss** — a field this server cannot model yet is carried back out wherever the format can hold it, and anything it cannot put on the wire is named in a run warning rather than dropped quietly into your repo

## Byte-parity with Bruno

This is the part that is hard to copy, so it is worth being precise about what it means.

The server does not wrap the `bru` binary — it implements the request pipeline itself, which is what makes in-memory secrets, wire-level tests and mid-run hooks possible. That freedom is also the risk: an independent implementation is free to be subtly, silently different from the tool your team actually uses. Two mechanisms hold it in place.

**The rules are ported, not inferred.** Redirect caps, timeout resolution, body-mode content types, variable interpolation order, `selected` defaults, URL encoding — each is read out of Bruno's own source (`bruno-cli`, `bruno-filestore`, `bruno-lang`, `@usebruno/common`, which this server also depends on directly) and mirrored, including the parts that look like bugs. Where the two dialects disagree with each other, each is mirrored on its own terms rather than unified into something neither Bruno reader would produce.

**A drift gate proves it.** Every file this server writes is parsed back with **Bruno's own reader**, per dialect, in the test suite. Asserting our bytes against our own expectations can only prove we are self-consistent; asserting them against the reader that Bruno itself uses is the only thing that catches the case where our output stops being Bruno's input. It has caught real ones — a file body that parsed cleanly and would have been sent with no body at all, for instance.

The claim, then: run behaviour matches `bru run`, and every divergence found so far is closed. What keeps it closed is a test rather than a promise. Find one anyway and it is a bug worth an issue.

## The contract

One collection, three consumers: your agent, your CI, and your team's Bruno GUI.

Both Bruno formats work and the server detects which one you have: `.yml` (opencollection) and `.bru` (legacy).

Requires **Node.js >= 22**. CI tests 22.x and 24.x.

## Which Bruno MCP server should I use?

There are several, they do genuinely different jobs, and the honest answer is not always this one. Every row below was read out of that project's own README or source, August 2026.

| Server | What it is | Writes | Reads | Runs | `.bru` / `.yml` | Needs `bru` | Tools |
|---|---|---|---|---|---|---|---|
| **this one** | Authors, reads and runs collections | Create + partial-merge edit | Structured JSON | Yes, own pipeline | both | no | 18 |
| [usebruno/bruno-mcp](https://github.com/usebruno/bruno-mcp) | **The official one**, from Bruno's own team — discovers and runs requests. Announced Aug 2026; at the time of writing its first implementation is an open draft | no | Request metadata | Yes, via the CLI | `.bru` | **yes** (bundled) | 3 |
| [`@dmpv/bruno-mcp`](https://github.com/TheDMPV/bruno-mcp) | Read-only index and search over a collection | no | Ranked search, sanitised contracts, stored examples | no | both | no | 8 |
| [hungthai1401/bruno-mcp](https://github.com/hungthai1401/bruno-mcp) | Runs a collection | no | no | Yes, via the CLI | `.bru` | **yes** | run only |
| [jcr82/bruno-mcp-server](https://github.com/jcr82/bruno-mcp-server) | Runs and inspects collections, with report files | no | Yes | Yes, via the CLI | `.bru` | **yes** | 9 |
| [djkz/bruno-api-mcp](https://github.com/djkz/bruno-api-mcp) | Turns each request into its own MCP tool | no | Exposes them as tools | One at a time | `.bru` | no | one per request |
| [macarthy/bruno-mcp](https://github.com/macarthy/bruno-mcp) | Generates collection files — the project this forked from, inactive since Jul 2025 | Create only | no | no | `.bru` | n/a | 8 |

Pick one of the others if: you want **the server Bruno itself maintains**, and whatever support and longevity that implies (usebruno — the official one, and the reasonable default for "discover and run" once it ships); you want an agent to **understand a large existing collection** without any risk of writing to it, and search it by intent (dmpv, first published July 2026 and at 0.x — new, and interesting); you already have the `bru` CLI in your image and only ever need "run this collection" (hungthai1401); or you want the agent to **call your API through your existing requests** as if each were a native tool (djkz).

Pick this one if: you want the agent to **write** the collection and not just read or run it, you are on `.yml` opencollection format, you need the run to happen **without installing the Bruno CLI**, or you care that what lands in your repo is byte-comparable to what the Bruno app writes.

On the fork parent specifically, since this project owes it its existence: [macarthy/bruno-mcp](https://github.com/macarthy/bruno-mcp) registers eight tools — `create_collection`, `create_request`, `create_environment`, `create_crud_requests`, `create_test_suite`, `add_test_script`, `list_collections`, `get_collection_stats`. It writes `.bru` files and does not read a request back, run anything, or expose an edit tool; a `updateRequest` helper exists in its `src/bruno/request.ts` but no MCP tool reaches it.

## Features

**Authoring**

- **Collections** — create and organise them, or discover the ones Bruno already knows from its `workspace.yml`. A collection this server creates is written to disk and not registered in that file, so `list_collections` will not show it and the Bruno GUI will not list it until someone opens it there once — everything else takes the path directly
- **Requests** — every HTTP method, with headers, query and path params, bodies, auth, assertions, vars and settings
- **Read back** — `read_request` and `read_environment` return structured JSON, identical for `.bru` and `.yml`, so an agent can inspect before it edits
- **Partial-merge edits** — `modify_request` changes only the fields you pass and leaves the rest of the file alone
- **CRUD and suites** — five-request CRUD sets, and test suites with topological dependency ordering
- **Environments** — create, replace, merge, or patch a single variable
- **Dual format** — `.bru` (legacy) and `.yml` (opencollection), auto-detected; `.yaml` is read and flagged
- **Multipart uploads** — `form-data` with per-part `Content-Type` and multi-file fields

**Running**

- **Execution groups** — run one collection as several isolated groups in a single call: different identities, different environments, serial or concurrent, with no leakage between them
- **Real parallelism** — fan out groups, or requests inside a group, under a concurrency ceiling sized for the machine
- **Cookie jar** — a login carries into the requests after it, scoped to its group and never written to disk
- **Variable chaining** — `bru.setVar()`/`bru.getVar()` across requests, and `captureVariables` to read the values back out
- **Async scripts** — top-level `await`, `bru.sleep(ms)`, `setTimeout`/`setInterval` inside the sandbox
- **Inline scripts** — attach pre-request, post-response and test scripts directly when creating or modifying a request
- **Auth applied for you** — bearer, basic, api-key, digest, OAuth 2.0 (client credentials and password grants), or `inherit` from the collection or folder
- **Honest results** — per-group summaries, captured response bodies, per-request warnings, parse failures and missing requests all reported; a crashed group cannot make a run read green

**Safety**

- **SSRF protection** on every request and every redirect hop, with the approved addresses pinned
- **Path confinement** for request references, collection roots, environment names and file uploads
- **Process-isolated scripts** — a forked V8 sandbox with a scrubbed environment and a hard kill

## Install

**Nothing to install.** Point your client at `npx` and it fetches the published package on first run:

```bash
npx -y @ostico/bruno-mcp
```

That is the whole install, and it is what the client configs below use. The package ships with provenance, so npm can show you which commit and workflow built the tarball you are running.

**Pinned instead**, if you would rather not resolve a version at startup:

```bash
npm install @ostico/bruno-mcp
```

which puts a `bruno-mcp` executable in `node_modules/.bin/` and the server itself at `node_modules/@ostico/bruno-mcp/dist/index.js`.

**From source**, for development or to run a branch:

```bash
git clone https://github.com/Ostico/bruno-mcp-studio.git
cd bruno-mcp-studio
npm install     # npm, not yarn — the yarn lockfile is stale
npm run build
```

Node.js >= 22 either way.

## Connect a client

**Any MCP client works.** This is a plain stdio MCP server with no client-specific code: whatever your client calls it, point it at

```
command: npx
args:    ["-y", "@ostico/bruno-mcp"]
```

Claude Code takes it as one line:

```bash
claude mcp add bruno -- npx -y @ostico/bruno-mcp
```

Claude Desktop, Claude Code, Cursor, Codex CLI, opencode, Windsurf, Zed, Cline, Continue, LM Studio, Gemini CLI, MCP Inspector, your own SDK client — all the same server. Nothing below is a compatibility list; it is just where each client keeps its config.

Most clients use the same JSON shape:

```json
{
  "mcpServers": {
    "bruno-mcp": {
      "command": "npx",
      "args": ["-y", "@ostico/bruno-mcp"],
      "env": {}
    }
  }
}
```

Running a clone, or a pinned install, is the same config with `"command": "node"` and `"args": ["/absolute/path/to/dist/index.js"]`.

| Client | Where it goes |
|---|---|
| Claude Desktop | macOS `~/Library/Application Support/Claude/claude_desktop_config.json` · Windows `%APPDATA%/Claude/claude_desktop_config.json` · Linux `~/.config/Claude/claude_desktop_config.json` |
| Claude Code | `claude mcp add`, or `.mcp.json` in the project |
| Cursor | `.cursor/mcp.json` in the project, or the global one |
| Codex CLI | `~/.codex/config.toml`, under an `[mcp_servers.bruno-mcp]` table (TOML, same fields) |
| opencode | `opencode.json`, under `mcp` as a local server (its own schema) |
| Others | Whatever that client documents — the command and args above are all it needs |

Config schemas are the client's, not this server's, and they move. If a client's format differs from the JSON above, follow the client's docs; only `command` and `args` matter here.

See [INTEGRATION.md](./INTEGRATION.md) for worked examples, Docker, and troubleshooting.

## Quick start

```json
// 1. create a collection
{ "name": "my-api", "outputPath": "./collections", "baseUrl": "https://api.example.com" }

// 2. add a request with a test
{ "collectionPath": "./collections/my-api", "name": "Get Users", "method": "GET",
  "url": "{{baseUrl}}/users",
  "scripts": { "tests": "test(\"ok\", function() { expect(res.getStatus()).to.equal(200); });" } }

// 3. run it
{ "collectionPath": "./collections/my-api" }
```

## Tools

18 tools. File paths are absolute, or relative to the collection.

| Tool | What it does |
|---|---|
| `create_collection` | New collection. `format: "yaml"` (default) or `"bru"`. On disk only — not registered in `workspace.yml` |
| `list_collections` | Find collections from Bruno's `workspace.yml` |
| `get_collection_stats` | Counts by method, folders, environments, request list with URLs — filterable by `folder`, `method`, `nameContains`, or `includeRequests: false` for counts only |
| `create_request` | Write a request: method, url, headers, query, body, auth, scripts, settings. `kind: "websocket"` or `kind: "grpc"` for those transports |
| `modify_request` | Partial-merge edit — only the fields you pass change. `filename` renames the file |
| `move_request` | Move or copy a request to another folder or collection |
| `read_request` | Read one request back as JSON, same shape for `.bru` and `.yml` |
| `list_requests` | Every request file in the collection, as absolute paths |
| `delete_request` | Delete a request file. Needs `confirm: true` |
| `create_crud_requests` | Five requests for an entity: List, Get, Create, Update, Delete |
| `create_test_suite` | Several related requests, with optional ordering dependencies |
| `add_test_script` | Attach a script to an existing request (appends by default) |
| `remove_script` | Remove one script, keep the request |
| `create_environment` | New environment file. Refuses to overwrite unless `overwrite: true` |
| `read_environment` | Variables with their `disabled`/`secret` flags. Omit `name` to list environments |
| `update_environment` | Replace or merge an environment's variables |
| `set_environment_variable` | Add or change one variable |
| `remove_environment_variable` | Delete one variable |
| `run_collection` | Execute requests, run their tests, return results |

### Reading before writing

`read_request` returns method, url, headers, query and path params, body, auth mode, scripts, assertions, vars, settings and docs — identical shape for both formats, so the on-disk format stays invisible. Its `notes` array names anything the file declares that the runner will not act on.

Use it before `modify_request` to see the current state, and after `create_request` to confirm what was written.

`read_environment` returns each variable with its value. **Secrets come back by name only** — Bruno stores no value for a secret in either format, so there is none to return.

### Writing requests

`create_request` and `modify_request` take the same shape. `modify_request` merges: fields you omit are left alone.

Notable options:

- `body.type` — `json`, `text`, `xml`, `sparql`, `graphql`, `form-urlencoded`, `form-data`, `file`, `binary`, `none`
- `body.type: "form-data"` — multipart uploads, per-part `contentType`, multi-file fields
- `auth.type` — `bearer`, `basic`, `api-key`, `digest`, `oauth2`, `inherit`, `none`
- `scripts` — inline `pre-request`, `post-response`, `tests` (no separate `add_test_script` call needed)
- `settings.timeout` — script and request timeout in ms

`name` and `filename` are independent, as they are in Bruno itself: `name` changes the request's name inside the file and `filename` moves the file, so pass both to keep them in step. A `filename` is a basename in the request's own folder, its extension is optional and must match the collection's format if given, and a name already taken by another file is refused. The path it moved to comes back in the response — use it as `filePath` from then on.

`modify_request` **replaces** a script of the same type by default, so repeating a call is idempotent. Pass `scriptMode: "append"` to concatenate. `add_test_script` appends by default, being an add.

In `.yml` collections `post-response` and `tests` share Bruno's single `after-response` slot, so replacing either overwrites both.

### Moving requests

`move_request` relocates a request file — into another folder, or into another collection with `targetCollectionPath`. Pass `copy: true` to duplicate it instead.

The bytes are moved verbatim, never parsed and rewritten, so nothing a request declares can be lost on the way. Two consequences follow from that. The file keeps its name, so a copy needs a different folder or collection; renaming is `modify_request`. And `seq` arrives unchanged, so the request can land next to a sibling claiming the same number — that is reported rather than repaired, because renumbering means rewriting the file. Bruno breaks such a tie by filename, so the order is defined either way.

A missing target folder is created, and reported: a folder with no settings file carries no folder-level auth, headers or scripts.

## Running

```json
{
  "collectionPath": "./collections/my-api",
  "environment": "dev",
  "requests": ["auth/login.bru", "users"]
}
```

| Parameter | Meaning |
|---|---|
| `collectionPath` | Collection, or a subfolder of one |
| `requests` | Ordered list of request files and/or directories. Omit to run everything. `[]` runs nothing |
| `groups` | Run the collection as several isolated groups — see below. Cannot be combined with `requests` |
| `environment` | Environment name, loaded from `environments/<name>.yml` |
| `collectionRoot` | The collection `collectionPath` belongs to, when running a subfolder. Must be that path or an ancestor |
| `variables` | `{name: value}` for this run only. Never written to disk — **the correct way to pass a secret** |
| `captureVariables` | Names of `bru.setVar` variables whose values you want back |
| `parallel` | Run the **groups** concurrently. Default `false` |
| `maxConcurrency` | Ceiling on requests in flight. Omit to derive one from the machine; `0` lifts it |
| `cookieJar` | Keep cookies across the run so a login carries forward. Default `true` |
| `includeResponseBody` | Include response bodies. Default `true` |
| `maxResponseBodyBytes` | Truncate bodies past this size. Default `10240` |
| `report` | Also write the run to disk — see [Report files](#report-files) |

A directory in `requests` expands to the requests under it, ordered by `seq` within each folder, subfolders first, ties broken by filename. Duplicates are honoured: naming a request twice runs it twice.

Nothing stops a run early. A request that fails, a file that will not parse, a name that matches nothing — each is reported and the run continues.

## Execution groups

A group is an isolated run inside one call. It owns its request list, environment, variables, `parallel` flag, **variable store, cookie jar and OAuth2 tokens**. Nothing crosses from one group to another, in either direction, at any `parallel` setting.

**The same requests as two users**, with no chance of one login's token or session cookie reaching the other:

```json
{
  "collectionPath": "./collections/my-api",
  "parallel": true,
  "groups": [
    { "name": "alice", "requests": ["auth/login.bru", "orders"], "variables": { "user": "alice" } },
    { "name": "bob",   "requests": ["auth/login.bru", "orders"], "variables": { "user": "bob" } }
  ]
}
```

`parallel: true` runs the two groups against each other. Each group's own requests stay serial, which is what you want when `orders` depends on the login before it.

**One suite against two environments:**

```json
{
  "groups": [
    { "name": "staging",    "requests": ["smoke"], "environment": "staging" },
    { "name": "production", "requests": ["smoke"], "environment": "production" }
  ]
}
```

Group fields: `name`, `requests`, `environment`, `variables`, `parallel`, `data`, `dataFile`.

[docs/execution-groups.md](./docs/execution-groups.md) covers the whole model: what a group
owns, the two `parallel` flags and their defaults, ordering, iterations over data rows, the
concurrency ceiling, and what a failure looks like at each level.

- Omit `requests` to run the **whole collection** under that group's identity. An empty `[]` runs nothing.
- `environment` **replaces** the run-level one; `variables` **merge** over the run-level ones, group winning.
- Set `parallel` on a group to run its own requests concurrently. They share that group's store, so they can genuinely contend on a `bru.setVar` — the point when reproducing a race. Give `maxConcurrency` at least as many slots as racers, or the cap serialises them quietly.

## Results

Results are group-shaped. There is **no top-level `results` array**, not even when you passed no `groups` — that case is one group, and flattening it would make every caller check which way they had called.

```json
{
  "summary": { "total": 4, "passed": 3, "failed": 1, "duration_ms": 1250 },
  "groups": [
    {
      "name": "alice",
      "index": 0,
      "summary": { "total": 2, "passed": 2, "failed": 0, "duration_ms": 620 },
      "results": [
        {
          "name": "Get Users",
          "method": "GET",
          "url": "https://api.example.com/users",
          "status": 200,
          "duration_ms": 312,
          "tests": [{ "description": "ok", "status": "pass" }],
          "response_body": "[{\"id\":1}]",
          "response_content_type": "application/json",
          "response_body_truncated": false,
          "response_headers": {
            "content-type": "application/json",
            "strict-transport-security": "max-age=31536000",
            "set-cookie": ["session=[redacted]; HttpOnly; Secure; SameSite=Lax"]
          }
        }
      ],
      "capturedVariableNames": ["authToken"]
    }
  ]
}
```

Each group carries its own `summary`, `results`, `missingRequests`, `capturedVariableNames`, `capturedVariables` and `warnings`. The top-level `summary` covers the whole run.

`response_headers` needs no flag and no test script. Credential-named values are masked, and `set-cookie` is a **list** — one entry per cookie, because a comma-joined one cannot be split back — whose entries keep every attribute with only the cookie value withheld. Checking `HttpOnly`, `Secure`, `SameSite` or `Strict-Transport-Security` is therefore a single call. `includeResponseBody: false` does not suppress them: that flag is about a body's size.

A WebSocket result carries `response_headers` as well, holding the handshake response — the 101 is the only place a session cookie or an agreed `sec-websocket-protocol` appears for that transport, since frames have no headers. A gRPC result reports its metadata under its own `grpc` detail instead.

A group that could not start at all reports `error` instead of results and counts as one failure — otherwise a run with a dead group would read green.

Run-level fields: `parseErrors` and `parseFailures` name files that could not be parsed, `warnings` collects anything else worth seeing.

## Scripts

Scripts run in a V8 context inside a forked process (see [Security](#security)). Both kinds are async functions, so top-level `await` works.

**Tests and post-response** get `test()`, `expect()`, `res` and `bru`:

| API | Notes |
|---|---|
| `test(name, fn)` | Wraps assertions. **Required for one to be reported** |
| `expect(v)` | Chai-style: `.to.equal`, `.include`/`.contain`, `.match`, `.have.property`/`.lengthOf`/`.keys`, `.be.above`/`.below`/`.least`/`.most`/`.oneOf`, `.throw`, and `.to.not.*` for any of them |
| `res.getStatus()` `res.getStatusText()` | |
| `res.getHeader(name)` `res.getHeaders()` | Header lookup is case-insensitive |
| `res.getSetCookies()` | Cookies the response set |
| `res.getBody()` | Already parsed when the media type's subtype is `json` or ends `+json` |
| `res.getResponseTime()` | ms |
| `res(path, ...fns)` | Bruno's query language over the body: `res("data.pets..name")` descends to every `name`, `[0]` indexes, `[?]` filters or maps with a callback. Also valid as an assertion's left-hand side, where the syntax could not appear bare |
| `bru.setVar(name, v)` `bru.getVar(name)` | Pass values to later requests as `{{name}}` |
| `bru.sleep(ms)` | Also `setTimeout`/`setInterval` and their `clear*` |

**Pre-request** scripts get `req` and `bru` instead — there is no response yet. Mutating `req` changes what is sent: `req.getUrl()`, `req.setUrl()`, `req.getMethod()`, `req.getHeader()`, `req.setHeader()`, `req.getHeaders()`, `req.getBody()`, `req.setBody()`.

### Two things that catch people out

**Wrap assertions in `test()`.** A bare passing `expect()` is never recorded, so the run reports `"tests": []` while the request counts as passed — green with nothing asserted. The runner spots this and says so in that result's `warnings`. A bare *failing* assertion is not silent: it throws and is reported as a script error.

```js
test("status is 200", function() {          // ✅ recorded
  expect(res.getStatus()).to.equal(200);
});

expect(res.getStatus()).to.equal(200);      // ❌ runs, passes, reported nowhere
```

**Do not `JSON.parse(res.getBody())`.** It is already an object whenever the media type's subtype is `json` or carries the `+json` suffix — `application/json`, `text/json`, `application/vnd.api+json` — so parsing again throws `SyntaxError: "[object Object]" is not valid JSON`. Read fields directly. If an endpoint may return either, branch: `typeof b === "string" ? JSON.parse(b) : b`.

Sleeping counts against the script timeout — `settings.timeout`, 5000 ms when unset. `await bru.sleep(10000)` under the default reports a timeout instead of waiting.

## Environments and variables

An environment is `environments/<name>.yml` in the collection:

```yaml
name: dev
variables:
  - name: baseUrl
    value: https://api-dev.example.com
  - name: apiKey
    value: dev-key-123
  - name: skipped
    value: whatever
    disabled: true
```

The tools take variables as a flat object (`{"baseUrl": "..."}`) and write that array for you.

`{{name}}` is substituted into urls, headers, bodies and auth. Disabled variables are skipped; unresolved ones are left as written and named in the run's warnings.

Precedence, lowest first: environment file → run `variables` → a request's own `vars` → `bru.setVar` during the run. This matches Bruno's `--env-var` behaviour.

A variable may be built out of others: `base_url: "https://{{host}}/{{stage}}"` resolves the way it does under `bru run`, using Bruno's own `interpolate`. One exception, deliberate: a value **captured from a response** — by `bru.setVar` or a post-response `vars` block — is inserted as text and never scanned again, so a response echoing `key={{api_key}}` cannot make the next request send your key.

**Generators.** `{{$guid}}`, `{{$timestamp}}`, `{{$randomEmail}}` and the rest of Bruno's ~120 dynamic variables work in urls, headers, query params, bodies and auth. They are not variables: nothing declares them, each occurrence produces its own value, and none is reported as unresolved. A keyword no generator answers to — `{{$gid}}` — is left as written and named in the warnings, so a typo still surfaces. In a JSON body or a GraphQL variables block the generated value is escaped, so a generator that emits a newline (`{{$randomLoremParagraphs}}`) leaves the document parseable.

**Secrets:** neither Bruno format stores a secret's *value* — only its name. So pass secrets as run `variables`, which stay in memory and are never written to a file.

An environment name is a name, not a path. Anything containing a separator is refused.

## Report files

`run_collection` returns its results as JSON, which is what an agent reads. The two other consumers of a test run read files, so `report` writes them:

```json
{ "collectionPath": "/path/to/collection",
  "report": { "junit": "reports/junit.xml", "html": "reports/run.html" } }
```

Name either format or both. The result then carries `reports`, one entry per file written, with its absolute path and its size in bytes.

**Paths are confined to the collection.** A path resolving outside it is refused and the reason becomes a run warning; the run itself still succeeds, because the results are what was asked for and the file is a by-product. Copy the file afterwards if your pipeline collects reports from somewhere else — writing wherever a caller points is a much larger authorization than running its requests. Missing parent directories inside the collection are created, and an existing report is overwritten.

The **JUnit XML** follows `bru run --reporter-junit`: one `<testsuite>` per request, one `<testcase>` per assertion or test, and a request that errored reported as a suite error. Four things it does differently, each because the alternative is a report that reads greener than the run:

- A request that ran and verified nothing gets one **skipped** testcase saying so, instead of an empty suite. An empty suite is invisible in every CI summary, which is exactly the "ran green, checked nothing" reading that the `requestsWithoutTests` counter exists to expose.
- A request file that would not parse, a named request that resolved to nothing, and a group that crashed each get a suite of their own. A report listing only what executed says a subset ran without saying it was a subset.
- A named group's label is folded into the suite name, since JUnit has no concept of one and two identities running the same request would otherwise be indistinguishable.
- No `hostname` attribute. Upstream writes the machine name into the file; these reports are meant to be committed.

The **HTML** report is Bruno's own, rendered by `@usebruno/common`, with execution groups as its iterations — a two-identity run reads as two sections. Two things to know: the page embeds the run's data but loads Vue and naive-ui from `unpkg.com`, so **it needs network access when opened** and shows nothing offline; and its request pane is empty, because a result does not retain the request as it was sent. Assertions and script tests share one list for the same reason — a result does not tell them apart.

A report holds what the results hold, on disk: response bodies included, response headers masked exactly as they are in the JSON.

## Formats

| Marker file in the collection | Format |
|---|---|
| `opencollection.yml` | YAML — checked first |
| `bruno.json` | BRU (legacy) |
| neither | YAML |

New collections are YAML unless you pass `format: "bru"`.

`.yaml` request files are **read** as YAML, exactly like `.yml`, because other Bruno-adjacent tooling writes them. But Bruno's own app and `bru run` do not recognise the extension, so every `.yaml` file read is named in the run's warnings — a silent pass would be a green run of a request Bruno cannot see. Rename to `.yml` to clear it. Nothing this server writes uses `.yaml`.

## gRPC and WebSocket requests

A collection may hold gRPC and WebSocket requests alongside HTTP ones. This server **reads, preserves and reports** them: `read_request` returns the kind, the target, the method and proto path for gRPC, its metadata block, and how many messages are stored; `list_requests` lists them; and editing any request in the collection no longer destroys them. Before this, both formats dropped the target block, the credentials and every stored message, so one `modify_request` on an unrelated request rewrote the file without them.

**`run_collection` runs both.** A gRPC request performs one unary call against the service its `.proto` declares; a WebSocket request opens the socket, sends the frames the file stores and records what comes back until a bound is reached. Each reports its own detail: a gRPC result carries the gRPC status code, the details string and redacted trailing metadata, and a WebSocket result carries the transcript, the `stop_reason` that ended it and whether it was truncated. The gRPC code lives in its own field and is never mapped onto the result's `status`, because gRPC's OK is `0` and `0` is this API's refusal sentinel — a successful call and a security refusal would otherwise be indistinguishable in the field read first.

A WebSocket session has no natural end, so it is bounded, and every bound is settable per run under `run_collection`'s `websocket` argument:

| Bound | Default | What it does |
|---|---|---|
| `maxMessages` | 50 | Inbound frames recorded before stopping |
| `maxDurationMs` | 5000 | Wall-clock ceiling for one session |
| `idleTimeoutMs` | 1500 | Silence that ends a session; `0` waits for the ceiling |
| `sendIntervalMs` | 0 | Gap between the messages a request sends; `0` sends them in one tick |
| `includePayloads` | `false` | Record frame contents, not just size and timing |
| `maxFrameBytes` | 65536 | Per-frame ceiling on recorded payload |
| `maxTranscriptBytes` | 1048576 | Cumulative ceiling, counted from wire size |
| `engineIoKeepalive` | `false` | Answer an engine.io `2` with a `3` |

The wall-clock ceiling is a safety bound rather than a schedule, so `idleTimeoutMs` is what usually ends a session: once nothing has arrived for 1500 ms it stops and reports `stop_reason: "idle"`, which is not counted as truncation because no cap bit and the ceiling went unspent. The clock is armed by the first frame, not at connect, so a listen-only request that authors no messages still waits out `maxDurationMs` for a peer that may yet speak. Set it to `0` for a protocol whose gaps are longer than its answers.

`sendIntervalMs` is what makes a send-wait-send protocol reachable. At the default of `0` a request's messages all leave in one tick, so every reply arrives after the last of them and the exchange has no order to assert on; set a gap and the transcript carries each answer between the sends it belongs to, at the offset it actually arrived. Two consequences worth knowing. `maxDurationMs` has to cover the whole paced sequence — a session stopped part way through names the messages that never went out, by their authored name, rather than leaving a transcript one send short to be read as a peer that stopped answering. And the idle bound is not armed while the sequence is still going out, so a `sendIntervalMs` longer than `idleTimeoutMs` is safe: the gap a request deliberately leaves between its own messages is not the peer's silence.

A subprotocol is authored as a `Sec-WebSocket-Protocol` header on the request, comma-separated for more than one, and is negotiated at the handshake; the one the server agreed to comes back in that result's `response_headers`. There is no separate field for it, here or in Bruno. Writing the header used to be worse than leaving it out: the library validates the server's answer against the list it was given at the connection, so a server that did exactly what the header asked for had its handshake refused for offering a subprotocol nobody requested. An authored `Sec-WebSocket-Version` is honoured the same way, for the same reason.

Each transcript entry says what kind of frame it was — `text`, `binary`, `ping`, `pong` or `close` — carries the authored `title` of a message the session sent, and, on a close frame, the `close_code` the peer gave, with its reason as that entry's payload: `1000` is an ordinary goodbye, `1006` a peer that vanished without one, `1008` a refusal, `1011` a server error. Control frames do not count toward `maxMessages`, or a peer that pings once a second would end a session by itself and report `count` for one that received no answer. A binary frame's payload is base64 and `bytes` is the true wire size for every kind. A post-response script sees the same fields, because the transcript is what `res.body` is on this transport.

### Asserting on a gRPC or WebSocket result

Both transports run post-response and test scripts, and `res` is shaped so there is one thing to learn rather than two. What differs from HTTP is worth stating outright, because guessing it wrong makes a test that cannot fail.

On a **WebSocket** request:

- `res.getBody()` is the transcript — the same array the result carries, handed to the script as a structure rather than as JSON text. `res.rawBody` keeps the serialised form.
- `res.getStatus()` is always `0`. A session has no status, and inventing one would be worse than having none. The outcome is in `res.statusText`, which carries the stop reason (`count`, `timeout`, `bytes`, `closed` or `error`).
- So a WebSocket assertion reads frames and `statusText`. A test written against `res.getStatus()` asserts on a constant.

```js
test("the server answered our subscribe", function() {
  const inbound = res.getBody().filter(f => f.direction === "in" && f.type === "text");
  expect(inbound.length).to.be.at.least(1);
  expect(inbound[0].payload).to.contain('"subscribed"');
  expect(res.statusText).to.equal("count");
});
```

**The payloads a script sees are always the real ones, whatever `includePayloads` says.** That flag gates the transcript in the *result*, not the one in `res`, because outbound frames are recorded after `{{var}}` interpolation and a result returned by default must not carry every secret you passed in. This is the split HTTP already has — `res.body` always holds the full body while `response_body` is gated by `includeResponseBody`. It means `includePayloads: false` together with content assertions is the intended shape for CI, not a workaround: the assertions check the payloads, and what comes back holds only direction, timing and sizes.

On a **gRPC** request `res` is closer to HTTP: `res.getStatus()` is the gRPC status code (`0` is OK), `res.statusText` is the server's own `details` when it supplied any and the code's canonical name otherwise, `res.getBody()` is the parsed response message, and the response trailers arrive as the headers.

`includePayloads` is off by default as a security property, not a preference: outbound frames are recorded **after** `{{var}}` substitution, so recording them by default would write every secret passed in `variables` into a result that is returned by default. `engineIoKeepalive` is off for a related reason — it puts a frame on the wire the request did not author — and even when on it replies only after an OPEN frame has actually been seen.

A WebSocket request can now be authored rather than copied. `create_request` takes `kind: "websocket"` with a url and `websocket.messages`, and refuses the fields that transport has no place for: an HTTP method, a body, query parameters, path params. Each message carries `content` and, optionally, a `title` and a `type` of `text` or `binary`; an untitled message is named `message 1`, `message 2` by position, exactly as Bruno names one. Headers, auth, `assert`, `vars`, `settings` and scripts work as they do for an HTTP request, and the written file is byte-identical to what Bruno writes for the same request in both formats — proven against upstream's own writer, not against a round-trip through our parser.

One field does not survive both formats. `selected: false` marks a message as authored but not sent; `.yml` records it, and `.bru` cannot — upstream's `.bru` writer emits the flag only when it is true, and its reader resolves an absent flag to `false`, so a deselected message and an unmarked one arrive as the same value. Authoring one into a `.bru` collection is therefore refused by name rather than written as a message that would be sent anyway. Leave it out, or use a `.yml` collection.

A gRPC request is authored the same way, with `kind: "grpc"`: a url, and under `grpc`, the fully qualified `method`, the `protoPath`, the `methodType` and the `messages`. It too refuses an HTTP method, a body, query parameters and path params. Three things about it are worth knowing before you write one.

Headers become **metadata**, which is that transport's only header surface — a `headers` block on a gRPC request is one Bruno's gRPC reader never looks at, so the `headers` argument is written as `metadata` instead. The `protoPath` must already exist inside the collection and is stored relative to it whichever spelling you give, because an absolute path is the operator's directory layout committed to a shared file; a path resolving outside the collection is refused, symlinks included, as is one whose imports leave it however many hops in (a well-known `google/protobuf/` import is not a file and is not refused). And all four `methodType` values are accepted, because Bruno writes all four — but only `unary` runs here, so the other three author a file Bruno can open and `run_collection` will refuse by name. As with WebSocket, the bytes are identical to Bruno's own writer in both formats, including the two dialects' disagreement about spelling: `.bru` writes `protoPath` inside the `grpc` block, `.yml` writes `protoFilePath`.

**`modify_request` edits both transports.** A url, headers, auth, `assert`, `vars`, `settings`, `name` and `sequence` all apply, as does the nested `websocket` or `grpc` object — its messages, and for gRPC the `method`, `protoPath` and `methodType`. Each field is written where that transport keeps it, so a gRPC header edit lands in `metadata` and never writes a `headers` block. Everything the edit does not name comes back byte-identical, which matters more here than for HTTP: an edit regenerates the whole file from a parsed model, so anything the model does not carry is gone without a message.

What is still refused is what the transport genuinely has no place for — an HTTP method, a body, query parameters, path params, and the other transport's object — by name, leaving the file byte-unchanged. Refusing url, headers and auth as well used to be the behaviour, which meant a WebSocket request's target could not be changed for the life of the file.

**A pre-request script runs on both transports**, and reaches what each of them actually has. `bru.setVar` is honoured and the value reaches that same request's own `{{placeholders}}`, so a script can compute a room name, a topic or a target and then dial it. `req.setUrl` replaces the target. `req.setHeader` writes the transport's own header surface: a WebSocket's handshake headers, or a gRPC call's metadata — which is the same surface, since grpc-js puts metadata on the wire as HTTP/2 headers. A script that throws stops the request before anything is dialled, and the failure is reported as itself. `req.getUrl()` and `req.getHeaders()` read the substituted target and the request's own headers; credentials the transport computes are not among them, because auth is applied after the script. The one thing not honoured is `req.setBody()`, which warns instead: neither transport sends a single body — a WebSocket session sends a list of messages and a unary gRPC call sends one typed message — so there is nothing for one value to replace, and guessing would put bytes on the wire the file never authored.

Both transports are loaded lazily, and that is enforced rather than asserted: a test records every module the real server resolves and fails if an HTTP-only run names `@grpc/grpc-js` or `ws`. Measured, an HTTP-only run loads `undici` and neither of them.

Two things are refused rather than guessed at. A file whose declared type and target block disagree (`type: grpc` with an `http:` block) is a parse error naming both, because the type decides what a reader reports while the block decides what a runner contacts. And a `.bru` request whose target url is empty is refused on write, because the format drops such a block while keeping the credentials beside it — the result would look authored and go nowhere.

Five things are deliberately not built. **Streaming gRPC calls** and **held-open WebSocket sessions** would make a run's result depend on when it was read, and every response here is a value a caller can assert against. **Server reflection** would fetch the schema over the same connection under test, so a `.proto` path is required instead. **Proxy support and certificate pinning** do not reach these transports: the gating is `undici`-only, `@grpc/grpc-js` exposes no proxy API and honours ambient `http_proxy` on its own, and `ws` would need an agent of its own. And **a socket.io or MQTT block** would invent a file format upstream has not chosen, which is a migration the moment it does.

socket.io needs no block, because it is a framing convention on top of WebSocket rather than a protocol of its own. Measured against socket.io 4.8.3, a plain `ws` request reaches one:

1. Connect to `ws://host:port/socket.io/?EIO=4&transport=websocket`. Both query parameters are required — `EIO=4` selects the Engine.IO version, and `transport=websocket` stops the server expecting an HTTP long-polling handshake first.
2. The server sends `0{…}`, the Engine.IO OPEN packet. Its payload carries `sid`, `pingInterval` and `pingTimeout` in milliseconds.
3. Send `40` to join the default namespace — nothing works before this. A named namespace is `40/namespace,`.
4. The server answers `40{"sid":"…"}`.
5. Send an event as `42["event-name",payload]`: `4` for MESSAGE, `2` for EVENT, then a JSON array whose first element is the event name.
6. The server sends `2` (PING) every `pingInterval` and disconnects a client that does not answer `3` (PONG) within `pingTimeout`. Set `websocket.engineIoKeepalive` on `run_collection` if a recording outlives that window; it is off by default and answers only after a real OPEN frame has been seen.

Steps 1 to 5 are frames the request file already stores, so only step 6 needs anything from the runner. This is pinned to `EIO=4` — Engine.IO v2 and v3 frame differently. Acks (`42<id>[…]` answered by `43<id>[…]`) and binary attachments (a `45` placeholder followed by separate binary frames) are writable by hand and unpleasant in practice.

## Security

**SSRF.** Every outbound URL, including each redirect hop, is resolved and checked. Private, loopback, link-local and otherwise reserved addresses are refused, and the approved addresses are pinned for the request so the name cannot resolve to something else in between. A refusal is reported per request as an `SSRF blocked` error with status `0`.

**Scripts** run in a V8 context inside a forked, disposable process. The child gets a scrubbed environment, so a script that escapes the context still cannot read the server's secrets — they are not in its address space. Its stdout is piped, never inherited, so it cannot write onto the MCP JSON-RPC stream. A runaway script is bounded by SIGKILL on the child, which the in-context timeout alone cannot guarantee. This is defence in depth via an OS process, not a jail: it does not prevent code from running in the child, it makes running there worthless.

**Paths.** Request references must stay inside the collection. `collectionRoot` must contain the collection path. Environment names may not contain separators.

**File uploads.** A `form-data` file part names a path on the server's disk, so it is confined: readable only under the collection root, the user's home directory, the OS temp dir, or a directory the operator added. On top of that, any path component starting with `.` is refused — so `~/.ssh/id_rsa`, `.env` and `.aws` stay unreadable even though home is allowed. Relative paths resolve against the collection root.

Operator escape hatches, all off by default:

| Variable | Effect |
|---|---|
| `BRUNO_SSRF_ALLOWLIST` | Comma-separated exact hostnames, IP literals and/or CIDR ranges allowed despite being private. Read once at startup and never influenced by tool arguments; wildcards are rejected |
| `BRUNO_UPLOAD_DIRS` | Extra directories uploads may read from |
| `BRUNO_PROXY_HOSTS` | Hosts allowed to use a collection's proxy |
| `BRUNO_INSECURE_TLS_HOSTS` | Hosts allowed to skip certificate verification |
| `BRUNO_DNS_TIMEOUT_MS` | DNS resolution timeout |
| `BRUNO_WORKSPACE_PATH` | Where to find Bruno's `workspace.yml` |

An allowlist entry matches a target's **exact spelling**. An allowlisted hostname is never resolved — the operator vouched for the name, not for whatever it points at today — so it does not cover the addresses behind it, and an allowlisted address does not cover a name that resolves to it. `localhost` and `127.0.0.1` are therefore two entries, and allowing one while a request uses the other looks like an inconsistent guard when it is a missing entry. Refusals say so.

This constrains what `run_collection` will fetch. An agent with shell access can reach the network anyway, so treat it as one layer, not a boundary.

## FAQ

### Does it need the Bruno CLI (`bru`) installed?

No. The request pipeline is implemented here — variables, auth, cookies, redirects, assertions, scripts, dependency ordering — so nothing shells out to `bru` and nothing needs the binary on PATH. That is also why the parity work above exists: an independent implementation has to be held to the original deliberately.

### Does it support `.yml` opencollection files, or only `.bru`?

Both, and it detects which one a collection uses rather than asking you. New collections default to `.yml`; `create_collection` takes `format: "bru"` if you want the legacy dialect. Where the two formats genuinely disagree — and they do — each is written the way Bruno's own writer for that dialect writes it.

A collection is one dialect or the other, though, not a mixture: the root manifest picks it, and Bruno reads only that extension, so a `.yml` request inside a `bruno.json` collection is a file in a directory as far as Bruno is concerned. This server still reads, writes and runs such a file — refusing would leave you unable to perform the fix, which is a rename of that very file — but every tool that touches or lists one tells you Bruno cannot see it, and names it.

### Can I run this in CI?

The collection it produces is a normal Bruno collection, so CI runs it with `bru run` exactly as if a human had authored it in the app. The MCP server itself is for the authoring and debugging loop, where an agent is in the room. It writes JUnit XML and HTML report files as well — see [Report files](#report-files) — so a run an agent drove still leaves the artefact a CI dashboard expects.

### Will it rewrite files the Bruno app wrote?

Only the fields you asked to change. `modify_request` is a partial merge, a key this server does not model is carried back out where the format can carry it — `.yml` throughout, and `.bru` wherever its grammar has a dictionary block to hold it — and every write is verified against Bruno's own reader in the test suite. Deletes need an explicit `confirm: true`.

### Which MCP clients work?

Any of them — this is a plain stdio server with no client-specific code. Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, Codex CLI, opencode, Zed, Cline, Continue, LM Studio, Gemini CLI, the MCP Inspector, or your own SDK client. See [Connect a client](#connect-a-client) for where each one keeps its config.

### What happens to my secrets?

Secret environment variables stay in memory for the run and are never written to a file — neither dialect stores a secret's value on disk, which is Bruno's design, not a limitation added here. Credentials are redacted out of the results returned to the agent, including one placed in a query parameter. Scripts run in a forked V8 sandbox with a scrubbed environment. See [Security](#security).

### Is this the same as the original `bruno-mcp`?

It started as a fork of [macarthy/bruno-mcp](https://github.com/macarthy/bruno-mcp), which has been inactive since July 2025 and generated collection files without running them. Everything above — the runner, the readers, both dialects, the parity gate, the sandbox — was built after the fork. The repository is now [Ostico/bruno-mcp-studio](https://github.com/Ostico/bruno-mcp-studio) ([announcement](https://github.com/macarthy/bruno-mcp/issues/4)); the npm package name is unchanged, `@ostico/bruno-mcp`.

### Is it affiliated with Bruno?

No. Bruno is a product of [usebruno](https://www.usebruno.com) and its name and trademarks belong to them. This is a community project that reads Bruno's open-source packages to stay compatible with them; it is not endorsed by or affiliated with usebruno.

Bruno's own team announced an official MCP server, [`usebruno/bruno-mcp`](https://github.com/usebruno/bruno-mcp), in August 2026. This is not it, and does not compete for that role — see [Which Bruno MCP server should I use?](#which-bruno-mcp-server-should-i-use) for what each is good at.

## Upgrading from 1.x

- `requestPath` and `folder` are gone. Both become `requests`, an ordered array of files and/or directories.
- **There is no top-level `results` array.** Read `result.groups[0].results`.
- `parallel: true` used to isolate each folder. It does not any more: with no `groups`, the whole selection is one group sharing one store and one cookie jar. Name the folders as separate groups to keep the old behaviour.
- `seq` no longer constrains execution. It is the default order and the reporting order only.
- An empty `requests: []` runs nothing. It used to run the whole collection.
- Removed exports: `BruGenerator`, `generateBruFile`, `createBasicBruFile`.

Full detail in [CHANGELOG.md](./CHANGELOG.md).

## Development

```bash
npm run build       # compile to dist/
npm test            # full suite
npm run test:unit   # unit only
npm run typecheck
npm run lint
```

Use npm, not yarn — the lockfile is npm's and CI runs `npm ci`.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for what CI checks, the commit conventions, and
the sign-off (DCO) every commit needs.

## License

MIT — see [LICENSE](./LICENSE). Contributions are accepted under the same terms, with a
[DCO sign-off](./CONTRIBUTING.md#sign-your-work--developer-certificate-of-origin).

## Links

- [Bruno](https://www.usebruno.com/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Changelog](./CHANGELOG.md)
- [Integration guide](./INTEGRATION.md)
