# Bruno MCP Server

> **Active fork** of [macarthy/bruno-mcp](https://github.com/macarthy/bruno-mcp) (original inactive since Jul 2025).
> Maintained at [Ostico/bruno-mcp](https://github.com/Ostico/bruno-mcp) — see [announcement](https://github.com/macarthy/bruno-mcp/issues/4).

An MCP server that lets an AI agent create, read, edit and **run** Bruno API collections — no Bruno GUI, no Bruno CLI.

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
- **No silent loss** — a field this server cannot model yet is filed and listed, not dropped quietly into your repo

## The contract

Run behaviour matches `bru run`. Where it does not, that is a defect with a number, and the open list ships in the repo (`docs/bruno-mcp-defect-report.md`) rather than in an issue tracker you have to go find.

One collection, three consumers: your agent, your CI, and your team's Bruno GUI.

Both Bruno formats work and the server detects which one you have: `.yml` (opencollection) and `.bru` (legacy).

Requires **Node.js >= 22**. CI tests 22.x and 24.x.

## Features

**Authoring**

- **Collections** — create and organise them, or discover the ones Bruno already knows from its `workspace.yml`
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

```bash
git clone https://github.com/Ostico/bruno-mcp.git
cd bruno-mcp
npm install
npm run build
```

## Connect a client

**Any MCP client works.** This is a plain stdio MCP server with no client-specific code: whatever your client calls it, point it at

```
command: node
args:    ["/absolute/path/to/bruno-mcp/dist/index.js"]
```

Claude Desktop, Claude Code, Cursor, Codex CLI, opencode, Windsurf, Zed, Cline, Continue, LM Studio, Gemini CLI, MCP Inspector, your own SDK client — all the same server. Nothing below is a compatibility list; it is just where each client keeps its config.

Most clients use the same JSON shape:

```json
{
  "mcpServers": {
    "bruno-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/bruno-mcp/dist/index.js"],
      "env": {}
    }
  }
}
```

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
| `create_collection` | New collection. `format: "yaml"` (default) or `"bru"` |
| `list_collections` | Find collections from Bruno's `workspace.yml` |
| `get_collection_stats` | Counts by method, folders, environments, request list |
| `create_request` | Write a request: method, url, headers, query, body, auth, scripts, settings |
| `modify_request` | Partial-merge edit — only the fields you pass change |
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

`modify_request` **replaces** a script of the same type by default, so repeating a call is idempotent. Pass `scriptMode: "append"` to concatenate. `add_test_script` appends by default, being an add.

In `.yml` collections `post-response` and `tests` share Bruno's single `after-response` slot, so replacing either overwrites both.

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

Group fields: `name`, `requests`, `environment`, `variables`, `parallel`.

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
          "response_body_truncated": false
        }
      ],
      "capturedVariableNames": ["authToken"]
    }
  ]
}
```

Each group carries its own `summary`, `results`, `missingRequests`, `capturedVariableNames`, `capturedVariables` and `warnings`. The top-level `summary` covers the whole run.

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

**Secrets:** neither Bruno format stores a secret's *value* — only its name. So pass secrets as run `variables`, which stay in memory and are never written to a file.

An environment name is a name, not a path. Anything containing a separator is refused.

## Formats

| Marker file in the collection | Format |
|---|---|
| `opencollection.yml` | YAML — checked first |
| `bruno.json` | BRU (legacy) |
| neither | YAML |

New collections are YAML unless you pass `format: "bru"`.

`.yaml` request files are **read** as YAML, exactly like `.yml`, because other Bruno-adjacent tooling writes them. But Bruno's own app and `bru run` do not recognise the extension, so every `.yaml` file read is named in the run's warnings — a silent pass would be a green run of a request Bruno cannot see. Rename to `.yml` to clear it. Nothing this server writes uses `.yaml`.

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

This constrains what `run_collection` will fetch. An agent with shell access can reach the network anyway, so treat it as one layer, not a boundary.

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

## License

MIT

## Links

- [Bruno](https://www.usebruno.com/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Changelog](./CHANGELOG.md)
- [Integration guide](./INTEGRATION.md)
