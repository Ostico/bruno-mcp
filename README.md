# Bruno MCP Server

> **Active fork** of [macarthy/bruno-mcp](https://github.com/macarthy/bruno-mcp) (original inactive since Jul 2025).
> Maintained at [Ostico/bruno-mcp](https://github.com/Ostico/bruno-mcp) — see [announcement](https://github.com/macarthy/bruno-mcp/issues/4).

A Model Context Protocol (MCP) server for creating, managing, and executing Bruno API testing collections. Supports both `.bru` and `.yml` (opencollection) formats with built-in security hardening.

## Why This MCP Server?

Use this when you want an AI agent (Claude, Copilot, etc.) to create, inspect, or execute Bruno API test collections programmatically — without opening the Bruno GUI or installing the Bruno CLI. Typical use cases: AI-assisted test generation, CI pipeline integration, automated API exploration.

Requires **Node.js >= 18.0.0**.

## Features

- **Collection Management**: Create and organize Bruno collections
- **Environment Configuration**: Manage multiple environments (dev, staging, prod)
- **Request Generation**: Generate request files for all HTTP methods
- **Authentication Support**: Bearer, Basic, OAuth 2.0, API key, Digest
- **Test Scripts**: Add pre/post request scripts and assertions
- **CRUD Operations**: Generate complete CRUD request sets
- **Collection Statistics**: Analyze existing collections
- **Dual Format Support**: `.bru` (legacy) and `.yml` (opencollection YAML) with auto-detection
- **Collection Discovery**: Discover Bruno collections from workspace with zero config
- **Request Modification**: Partial-merge updates to existing request files
- **Variable Chaining**: `bru.setVar()`/`bru.getVar()` for cross-request variable flow
- **Dependency Ordering**: Topological sort for test suite execution order
- **Request Execution**: Execute requests and run tests with structured results, including captured response bodies
- **Multipart Uploads**: `multipart/form-data` bodies with per-part `Content-Type` and multi-file fields
- **Flexible Environment Updates**: Replace, merge, or patch a single variable in an environment
- **Inline Scripts**: Attach pre-request/post-response/test scripts directly on `create_request`/`modify_request`
- **Parallel Execution**: Run collection folders in parallel via `run_collection`'s `parallel` option
- **Security Hardening**: SSRF protection, path traversal prevention, VM sandbox for test scripts

## Installation

```bash
git clone https://github.com/macarthy/bruno-mcp.git
cd bruno-mcp
npm install
npm run build
```

## Client Integration

### Quick Setup for Claude Desktop

1. Edit Claude Desktop config file:
   - **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows:** `%APPDATA%/Claude/claude_desktop_config.json`
   - **Linux:** `~/.config/Claude/claude_desktop_config.json`

2. Add Bruno MCP Server:
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

3. Restart Claude Desktop

### Supported Clients

- **Claude Desktop App** - Full support
- **Claude Code (VS Code)** - Full support
- **Continue** - Tools and resources
- **Cline** - Tools and resources
- **LM Studio** - Tools support
- **MCP Inspector** - Development/testing
- **Custom MCP Clients** - via SDK

For detailed integration instructions with all clients, see [INTEGRATION.md](./INTEGRATION.md)

## Format Detection

The server auto-detects collection format by checking for marker files:

| Marker file | Format | Priority |
|---|---|---|
| `opencollection.yml` | YAML (opencollection) | Checked first |
| `bruno.json` | BRU (legacy) | Fallback |
| Neither | YAML (default) | — |

New collections default to YAML format. Pass `format: "bru"` to `create_collection` for legacy format.

## Available MCP Tools

### `create_collection`
Create a new Bruno collection with configuration.

**Parameters:**
- `name` (string): Collection name
- `description` (string, optional): Collection description
- `baseUrl` (string, optional): Default base URL
- `outputPath` (string): Directory to create collection
- `ignore` (array, optional): Files to ignore
- `format` (string, optional): `"yaml"` (default) or `"bru"`

**Example:**
```json
{
  "name": "my-api-tests",
  "description": "API tests for my application",
  "baseUrl": "https://api.example.com",
  "outputPath": "./collections"
}
```

### `create_environment`
Create environment configuration files. **Replaces the whole environment file** — if an environment with this name already exists, its previous variables are discarded and replaced by `variables`.

**Parameters:**
- `collectionPath` (string): Path to Bruno collection
- `name` (string): Environment name
- `variables` (object): Environment variables

**Example:**
```json
{
  "collectionPath": "./collections/my-api-tests",
  "name": "production",
  "variables": {
    "baseUrl": "https://api.example.com",
    "apiKey": "prod-key-123",
    "timeout": 30000
  }
}
```

### `update_environment`
Partially update an existing environment by **merging** the given variables into the existing set. Unlike `create_environment`, variables not listed here (including disabled ones) are preserved as-is.

**Parameters:**
- `collectionPath` (string): Path to Bruno collection
- `name` (string): Name of the existing environment to update
- `variables` (object): Variables to merge in; existing variables not listed here are kept

**Example:**
```json
{
  "collectionPath": "./collections/my-api-tests",
  "name": "production",
  "variables": { "apiKey": "prod-key-456" }
}
```

### `set_environment_variable`
Set (add or update) a single variable in an existing environment. Merges into the environment — all other variables are preserved.

**Parameters:**
- `collectionPath` (string): Path to Bruno collection
- `environment` (string): Name of the existing environment
- `name` (string): Variable key to set
- `value` (string | number | boolean): Variable value
- `enabled` (boolean, optional): Whether the variable is enabled. This is persisted — `enabled: false` writes the variable as disabled.
- `secret` (boolean, optional): Whether the variable is a secret. **Accepted but not persisted** — the environment file format has no place to store it, so this flag is currently a no-op.

**Example:**
```json
{
  "collectionPath": "./collections/my-api-tests",
  "environment": "production",
  "name": "featureFlag",
  "value": true,
  "enabled": true
}
```

### `remove_environment_variable`
Remove a single variable from an existing environment, preserving the rest.

**Parameters:**
- `collectionPath` (string): Path to Bruno collection
- `environment` (string): Name of the existing environment
- `name` (string): Variable key to remove

**Example:**
```json
{
  "collectionPath": "./collections/my-api-tests",
  "environment": "production",
  "name": "featureFlag"
}
```

### `create_request`
Generate request files (`.bru` or `.yml` based on collection format).

**Parameters:**
- `collectionPath` (string): Path to collection
- `name` (string): Request name
- `method` (string): HTTP method (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS)
- `url` (string): Request URL (supports `{{variable}}` syntax)
- `headers` (object, optional): HTTP headers
- `body` (object, optional): Request body — see [Body Types](#body-types)
- `auth` (object, optional): Authentication — see [Auth Types](#auth-types)
- `query` (object, optional): Query parameters as `Record<string, string | number | boolean>`
- `folder` (string, optional): Subfolder within collection
- `sequence` (number, optional): Execution order
- `scripts` (object, optional): Inline pre-request/post-response/test scripts to persist with the request — see [Inline Scripts](#inline-scripts)

**Example:**
```json
{
  "collectionPath": "./collections/my-api-tests",
  "name": "Get User Profile",
  "method": "GET",
  "url": "{{baseUrl}}/users/{{userId}}",
  "headers": {
    "Authorization": "Bearer {{token}}"
  },
  "folder": "users"
}
```

#### Auth Types

| `auth.type` | Required `auth.config` keys |
|---|---|
| `bearer` | `token` |
| `basic` | `username`, `password` |
| `api-key` | `key`, `value`, `in` (`"header"` or `"query"`) |
| `digest` | `username`, `password` |
| `oauth2` | See Bruno OAuth2 docs |
| `none` | _(omit `auth` entirely)_ |

**Example (bearer):**
```json
{ "auth": { "type": "bearer", "config": { "token": "{{token}}" } } }
```

**Example (api-key):**
```json
{ "auth": { "type": "api-key", "config": { "key": "X-API-Key", "value": "{{apiKey}}", "in": "header" } } }
```

#### Body Types

| `body.type` | Fields | Description |
|---|---|---|
| `json` | `content`: JSON string | JSON body |
| `text` | `content`: plain text | Plain text body |
| `xml` | `content`: XML string | XML body |
| `form-data` | `formData`: `[{name, value, type?, contentType?}]` | Multipart form (`type`: `"text"` or `"file"`; `value` is a string, or an array of strings for multiple files under one field name; `contentType` sets that part's MIME type) |
| `form-urlencoded` | `content`: URL-encoded string | URL-encoded form |
| `binary` | `content`: file path | Binary body |
| `none` | _(omit `body` entirely)_ | No body |

**Example (JSON body):**
```json
{ "body": { "type": "json", "content": "{\"name\": \"test\"}" } }
```

**Example (form-data — text field + file with contentType):**
```json
{
  "body": {
    "type": "form-data",
    "formData": [
      { "name": "description", "value": "profile photo", "type": "text" },
      { "name": "avatar", "value": "/tmp/photo.jpg", "type": "file", "contentType": "image/jpeg" }
    ]
  }
}
```

**Example (form-data — multiple files under one field):**
```json
{
  "body": {
    "type": "form-data",
    "formData": [
      { "name": "attachments", "value": ["/tmp/a.pdf", "/tmp/b.pdf"], "type": "file", "contentType": "application/pdf" }
    ]
  }
}
```

A request with a `form-data` body is sent as real `multipart/form-data` at execution time: file `value`s are read from disk (each array entry becomes its own part with the same field name), and each part's `Content-Type` header is set from `contentType` when provided (defaults to `application/octet-stream` for files, or none for `text` parts).

**Upload file confinement.** Because a collection is untrusted input, a multipart file `value` cannot read arbitrary host files. A file path is accepted only when it resolves under a trusted location — the **collection root** (relative paths resolve here), the user's **home directory**, the **OS temp dir** / `/tmp`, or a directory listed in the **`BRUNO_UPLOAD_DIRS`** environment variable (comma-separated absolute paths, set when launching the server). On top of that, any path segment beginning with `.` is refused, so **dotfiles and dot-directories** (`~/.ssh`, `.aws`, `.env`, `.git`, …) are never readable even though home is allowed. A path outside every trusted location, or through a hidden segment, is refused before any read.

> **Note:** `create_test_suite` supports a subset of auth types (`bearer`, `basic`, `oauth2`, `api-key`) and body types (`json`, `text`, `xml`, `form-data`, `form-urlencoded`). `digest` auth and `binary` body are only available in `create_request`.

### `modify_request`
Update an existing Bruno request file with partial-merge semantics. Only provided fields are updated; all other fields are preserved.

**Parameters:**
- `filePath` (string, required): Absolute path to `.bru` or `.yml` request file
- `name` (string, optional): New request name
- `method` (string, optional): New HTTP method (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS)
- `url` (string, optional): New URL
- `headers` (object, optional): Headers to merge (`Record<string, string>`)
- `body` (object, optional): Request body -- same shape as `create_request` body
- `auth` (object, optional): Authentication -- same shape as `create_request` auth
- `query` (object, optional): Query parameters to merge (`Record<string, string | number | boolean>`)
- `scripts` (object, optional): Inline pre-request/post-response/test scripts appended to the request -- see [Inline Scripts](#inline-scripts)

**Example:**
```json
{
  "filePath": "/path/to/collections/my-api-tests/users/get-users.yml",
  "url": "{{baseUrl}}/v2/users",
  "headers": {
    "X-Api-Version": "2"
  },
  "query": {
    "limit": 50
  }
}
```

#### Inline Scripts

`create_request` and `modify_request` accept an optional `scripts` object to attach pre-request, post-response, and test scripts without a separate `add_test_script` call.

| Canonical key | Alias accepted |
|---|---|
| `pre-request` | `before-request` |
| `post-response` | `after-response` |
| `tests` | _(none)_ |

Aliases are normalized to the canonical key when the request is written. `post-response` and `tests` both run after the response is received. In `.bru` collections they are separate blocks; in `.yml` collections Bruno has a single `after-response` slot, so both compile into one block — supplying both in the same call merges them in the order pre-request, post-response, tests.

**Example:**
```json
{
  "scripts": {
    "pre-request": "req.setHeader('X-Request-Id', String(Date.now()));",
    "tests": "test(\"Status is 200\", function() { expect(res.getStatus()).to.equal(200); });"
  }
}
```

##### Assertions must be wrapped in `test()`

Only assertions inside a `test(description, callback)` block are recorded. A bare
top-level `expect()` still *executes*, but a **passing** one produces no result at
all, so `run_collection` reports `"tests": []` while the request itself counts as
passed — a run that looks green with nothing actually asserted.

```js
// ✅ Recorded — shows up in run_collection results
test("status is 200", function() {
  expect(res.getStatus()).to.equal(200);
});

// ❌ Runs, but a passing assertion is never reported
expect(res.getStatus()).to.equal(200);
```

The runner detects this and attaches a `warnings` array to the affected entry in
`run_collection` output, so the silent case is visible:

```json
{
  "name": "Get Order",
  "status": 200,
  "tests": [],
  "warnings": [
    "1 assertion ran outside a test() block and was not recorded. This run therefore reports zero assertions even though the request itself succeeded. Wrap assertions so they appear in results: test(\"descriptive name\", function() { expect(res.getStatus()).to.equal(200); });"
  ]
}
```

A *failing* bare assertion is not silent — it throws out of the script and is
reported as a `Script error` failure.

**Available in scripts:** `res.getStatus()`, `res.getStatusText()`,
`res.getHeader(name)`, `res.getHeaders()`, `res.getBody()`,
`res.getResponseTime()`, `bru.setVar(name, value)`, `bru.getVar(name)`, and
`expect(actual)` with `.to.equal`, `.to.contain`/`.to.include`,
`.to.have.property`/`.to.have.lengthOf`, `.to.be.a`/`.an`/`.below`/`.above`,
plus `.to.not.*` negations. Pre-request scripts instead get `req.getUrl()`,
`req.setUrl()`, `req.getHeader()`, `req.setHeader()`, `req.getBody()`,
`req.setBody()`, and `bru.setVar`/`getVar`.

##### Replace vs. append

`modify_request` **replaces** the script of each provided type by default, so
calling it repeatedly with the same payload is idempotent instead of stacking up
duplicate blocks. Pass `scriptMode: "append"` when you deliberately want to
concatenate onto what is already there.

| Tool | Default `scriptMode` |
|---|---|
| `modify_request` | `replace` |
| `add_test_script` | `append` (the tool's purpose is to add) |

In `.yml` collections `post-response` and `tests` share one `after-response`
block, so replacing either one overwrites that shared block.

### `create_crud_requests`
Generate a complete set of CRUD operations (5 requests: List, Get, Create, Update, Delete).

**Parameters:**
- `collectionPath` (string): Path to collection
- `entityName` (string): Entity name (e.g., "Users")
- `baseUrl` (string): API base URL
- `folder` (string, optional): Folder name

**Example:**
```json
{
  "collectionPath": "./collections/my-api-tests",
  "entityName": "Products",
  "baseUrl": "{{baseUrl}}/api/v1",
  "folder": "products"
}
```

### `create_test_suite`
Generate a test suite with multiple related requests and optional dependencies.

**Parameters:**
- `collectionPath` (string): Path to collection
- `suiteName` (string): Suite/folder name
- `requests` (array): Array of request definitions (same shape as `create_request`)
- `dependencies` (array, optional): Execution ordering constraints as `[{from: string, to: string}]` — enforces topological order via `seq` numbers. Circular dependencies return an error.

**Example:**
```json
{
  "collectionPath": "./collections/my-api-tests",
  "suiteName": "Auth Flow",
  "requests": [
    { "name": "Login", "method": "POST", "url": "{{baseUrl}}/auth/login" },
    { "name": "Get Profile", "method": "GET", "url": "{{baseUrl}}/auth/profile" }
  ],
  "dependencies": [
    { "from": "Login", "to": "Get Profile" }
  ]
}
```

### `add_test_script`
Add test scripts to existing request files. Format-aware: injects into `.bru` or `.yml` automatically.

**Parameters:**
- `bruFilePath` (string): Path to `.bru` or `.yml` request file
- `scriptType` (string): `"pre-request"`, `"post-response"`, or `"tests"` (aliases `"before-request"` → `pre-request` and `"after-response"` → `post-response` also accepted; see [Inline Scripts](#inline-scripts))
- `script` (string): JavaScript code (max 50KB). Wrap assertions in `test("name", function() { ... })` — see [Assertions must be wrapped in `test()`](#assertions-must-be-wrapped-in-test)
- `scriptMode` (string, optional): `"append"` (default) or `"replace"`

### `remove_script`
Delete a script from a request, leaving the rest of the request intact. This is the
way to undo or clean up a script written by `create_request`, `modify_request`, or
`add_test_script` — including duplicate blocks accumulated by appending.

**Parameters:**
- `bruFilePath` (string): Path to `.bru` or `.yml` request file
- `scriptType` (string): `"pre-request"`, `"post-response"`, or `"tests"` (aliases accepted)

Removing the last script also drops the now-empty script container. If there was
nothing to remove, the tool reports that and does not rewrite the file. In `.yml`
collections `post-response` and `tests` share one `after-response` block, so
removing either clears that shared block.

### `delete_request`
Permanently delete a request file from a collection. Use this to remove a request
created by mistake; to clear only a script and keep the request, use
`remove_script` instead.

**Parameters:**
- `filePath` (string): Path to the `.bru` or `.yml` request file to delete
- `confirm` (boolean): Must be `true` — explicit acknowledgement that the file is deleted permanently

Only `.yml`/`.bru` files whose extension matches a detected Bruno collection can be
deleted. The file is unlinked from disk and cannot be recovered through this server.

### `list_collections`
Discover Bruno collections from the Bruno app's `workspace.yml`.

**Parameters:**
- `workspacePath` (string, optional): Explicit path to `workspace.yml`

**Workspace Resolution Cascade** (highest priority first):
1. Explicit `workspacePath` argument
2. `BRUNO_WORKSPACE_PATH` environment variable (set this when running the server in CI or on a machine where Bruno is not installed at the default location)
3. Platform default:
   - **macOS:** `~/Library/Application Support/bruno/default-workspace/workspace.yml`
   - **Linux:** `~/.config/bruno/default-workspace/workspace.yml`
   - **Windows:** `%APPDATA%/bruno/default-workspace/workspace.yml`

**Returns:**
```json
{
  "collections": [
    { "name": "My API", "path": "/path/to/collection", "exists": true },
    { "name": "Old API", "path": "/missing/path", "exists": false }
  ]
}
```

### `get_collection_stats`
Get detailed statistics about a collection.

**Parameters:**
- `collectionPath` (string): Path to collection

**Returns:**
```json
{
  "totalRequests": 12,
  "requestsByMethod": { "GET": 5, "POST": 4, "PUT": 2, "DELETE": 1 },
  "folders": ["auth", "users", "products"],
  "environments": ["dev", "staging", "prod"],
  "environmentDetails": [
    { "name": "dev", "variables": ["baseUrl", "apiKey"] },
    { "name": "prod", "variables": ["baseUrl", "apiKey", "region"] }
  ],
  "requests": [
    { "name": "Get Users", "method": "GET", "seq": 1, "folder": "users", "hasTests": true }
  ]
}
```

`environmentDetails` lists the variable **names** each environment declares so you can see what is
already defined before merging into it with `set_environment_variable`. Values are deliberately withheld
— environments routinely hold tokens, and knowing a key exists is enough to merge safely.

### `run_collection`
Execute all requests in a collection (or a single request) and run test scripts.

**Parameters:**
- `collectionPath` (string): Path to collection or subfolder
- `environment` (string, optional): Environment name (loads from `environments/<name>.yml`)
- `collectionRoot` (string, optional): Collection root for environment resolution
- `requestPath` (string, optional): Path to a single `.yml`/`.bru` request file, or a subdirectory, to run instead of the full collection
- `parallel` (boolean, optional, default `false`): Run folders in parallel (grouped by the request file's parent directory). Requests within a folder still run serially, in `seq` order. Each folder gets its own variable store while running in parallel — `bru.setVar()` in one folder is **not** visible to another folder until results are merged; use serial mode (the default) if requests in different folders depend on each other's variables
- `includeResponseBody` (boolean, optional, default `true`): Include each request's response body in the results
- `maxResponseBodyBytes` (number, optional, default `10240`): Maximum response body size (bytes) returned per request; longer bodies are truncated

**Execution Flow:**
1. Find all `.yml`/`.bru` request files, sort by `seq` field
2. Load environment variables (if specified)
3. For each request: run the pre-request script (if any) → substitute `{{variables}}` (env + runtime) in URL, headers, and body → execute via `fetch()` → run post-response/test scripts → extract `bru.setVar()` variables for next request
4. Requests execute serially in sequence order (or per-folder in parallel, see `parallel` above); variables accumulate across the run
5. **On failure**: network errors or HTTP errors are recorded in the result — execution continues to the next request (never stops early)
6. Requests with no test scripts report zero tests (still counted in `summary.total`)

**Returns:**
```json
{
  "summary": { "total": 4, "passed": 3, "failed": 1, "duration_ms": 1250 },
  "results": [
    {
      "name": "Get Schema",
      "method": "GET",
      "url": "https://api.example.com/schema",
      "status": 200,
      "duration_ms": 312,
      "tests": [
        { "description": "Status is 200", "status": "pass" },
        { "description": "Body is JSON", "status": "pass" }
      ],
      "response_body": "{\"openapi\":\"3.0.0\", ...}",
      "response_body_truncated": false,
      "response_content_type": "application/json"
    }
  ]
}
```

`response_body`, `response_body_truncated`, and `response_content_type` are included per result unless `includeResponseBody` is set to `false`.

## Environment Variables

Environment files define variables that are substituted into requests at execution time.

**YAML format** (`environments/dev.yml`):
```yaml
name: dev
variables:
  - name: baseUrl
    value: https://dev.api.example.com
  - name: apiKey
    value: dev-key-123
  - name: disabled_var
    value: skip-me
    disabled: true
```

**Input vs file format**: The `create_environment` tool accepts variables as a flat object (`{"baseUrl": "..."}`) and converts them to the YAML array format shown above. You never need to construct the array format yourself when calling the tool.

**Substitution**: Any `{{variableName}}` in request URLs, headers, or body content is replaced with the corresponding environment variable value. Variables with `disabled: true` are skipped. Unresolved references (e.g. `{{missing}}`) are left as-is.

## Test Script API

Test scripts run in a sandboxed VM with these globals:

| Global | Description |
|---|---|
| `test(description, fn)` | Define a test case. `fn` is called synchronously; exceptions mark the test as failed. **Required for an assertion to be reported** — see [Assertions must be wrapped in `test()`](#assertions-must-be-wrapped-in-test). |
| `expect(value)` | Chai-style `expect` — supports `.to.equal()`, `.to.have.property()`, `.to.be.above()`, etc. |
| `res` | Response object (see methods below) |
| `bru` | Variable store for cross-request chaining (see methods below) |

**`bru` methods (variable chaining):**

| Method | Description |
|---|---|
| `bru.setVar(name, value)` | Store a variable for use by subsequent requests. Run-scoped — lost when execution ends. |
| `bru.getVar(name)` | Retrieve a previously set variable. Returns `undefined` if not set. |

Variables set via `bru.setVar()` are merged with environment variables for `{{substitution}}` in subsequent requests. Runtime variables take precedence over environment variables with the same name.

**Pre-request scripts** run in a separate sandbox, before the request is sent, with `req` and `bru` (no `test()`, `expect()`, or `res` — there is no response yet). Mutating `req` changes what is actually sent.

| Method | Description |
|---|---|
| `req.getUrl()` | Get the current request URL |
| `req.getMethod()` | Get the HTTP method |
| `req.getHeaders()` | Get all request headers |
| `req.getHeader(name)` | Get a single header, or `null` if unset |
| `req.getBody()` | Get the current request body |
| `req.setUrl(url)` | Override the request URL |
| `req.setHeader(name, value)` | Set/override a request header |
| `req.setBody(body)` | Override the request body |

**`res` methods:**

| Method | Returns | Description |
|---|---|---|
| `res.getStatus()` | `number` | HTTP status code |
| `res.getStatusText()` | `string` | Status text (e.g. "OK") |
| `res.getHeaders()` | `object` | All response headers |
| `res.getHeader(name)` | `string \| null` | Single header (case-insensitive) |
| `res.getBody()` | `any` | Already-parsed JSON object/array for `application/json` and `+json` content-types, otherwise raw text |
| `res.getResponseTime()` | `number` | Response time in milliseconds |

> **Do not `JSON.parse(res.getBody())`.** The body is parsed for you whenever the
> response content-type is `application/json` or carries a `+json` suffix
> (`application/vnd.api+json`, …), so `res.getBody()` hands back an object or array,
> not a string. Parsing it again stringifies it to `"[object Object]"` first and
> throws `SyntaxError: "[object Object]" is not valid JSON`. Access fields
> directly instead:
>
> ```javascript
> expect(res.getBody().access_token).to.be.a("string");   // ✅
> JSON.parse(res.getBody()).access_token;                 // ❌ throws
> ```
>
> If an endpoint can return either JSON or plain text, branch on the type:
>
> ```javascript
> const b = res.getBody();
> const json = typeof b === "string" ? JSON.parse(b) : b;
> ```
>
> A run that hits this error reports the fix in its `warnings` array.

**Example test script:**
```javascript
test("Status is 200", function() {
  expect(res.getStatus()).to.equal(200);
});

test("Response is JSON array", function() {
  const body = res.getBody();
  expect(body).to.be.an("array");
  expect(body.length).to.be.above(0);
});

test("Response time under 2s", function() {
  expect(res.getResponseTime()).to.be.below(2000);
});

// Chain a variable to subsequent requests
bru.setVar("userId", res.getBody()[0].id);
```

**Variable chaining example** (Login → Profile):
```javascript
// In Login's after-response script:
test("Login returns token", function() {
  expect(res.getBody().access_token).to.be.a("string");
});
bru.setVar("token", res.getBody().access_token);

// In Get Profile's request, {{token}} is now substituted automatically
```

## File Formats

### YAML Request (`.yml`)
```yaml
info:
  name: Get Users
  type: http
  seq: 1
http:
  method: GET
  url: "{{baseUrl}}/users"
  headers:
    - name: Authorization
      value: "Bearer {{token}}"
  body:
    type: json
    data: '{"limit": 10}'
  auth:
    type: bearer
    token: "{{token}}"
runtime:
  scripts:
    - type: after-response
      code: |
        test("Status is 200", function() {
          expect(res.getStatus()).to.equal(200);
        });
settings:
  timeout: 5000
```

### BRU Request (`.bru`)
```bru
meta {
  name: Get Users
  type: http
  seq: 1
}

get {
  url: {{baseUrl}}/users
  body: none
  auth: none
}

headers {
  Content-Type: application/json
  Authorization: Bearer {{token}}
}

tests {
  test("Status should be 200", function() {
    expect(res.status).to.equal(200);
  });
}
```

### Advanced Request Settings

A request's `.yml` (opencollection) file supports a `settings` block; it is not currently supported in the legacy `.bru` format:

```yaml
settings:
  timeout: 5000    # ms; 0 means no timeout. Read and applied by run_collection.
```

`timeout` is the only field here that's fully wired end-to-end today: `run_collection` reads it per request (default 30000ms if omitted) and aborts the request if it's exceeded.

Redirects are always followed automatically regardless of settings — up to 10 hops, with each redirect target re-validated against the [SSRF rules](#ssrf-protection) before the request follows it.

> **Not yet usable via the request file — flagging for verification:** `src/bruno/types.ts` and `src/bruno/fetch-dispatcher.ts` define additional `settings` fields — `followRedirects` (boolean), `maxRedirects` (number), `proxy` (a URL string, dispatched through `undici`'s `ProxyAgent`), and `tls` (`{ rejectUnauthorized?, ca?, cert?, key? }`, dispatched through `undici`'s `Agent`) — and `request-executor.ts` calls `buildDispatcher(yaml.settings)` to use them when present. However, the `.yml` parser (`parseSettings` in `src/bruno/yaml-parser.ts`) currently only reads `encodeUrl`, `timeout`, `followRedirects`, and `maxRedirects` out of a request file — it does not read `tls` or `proxy`, so setting them in a request file's `settings` block has no effect yet. `followRedirects`/`maxRedirects` are parsed but not read anywhere in `request-executor.ts` either (redirects always auto-follow as described above). Treat TLS/proxy support as executor-internal/in-progress rather than an end-user-facing feature until this wiring lands.

### Generated Collection Structure
```
my-collection/
├── opencollection.yml      # YAML format collection config
├── bruno.json              # BRU format collection config
├── .gitignore
├── README.md
├── environments/
│   ├── dev.yml
│   └── prod.yml
├── auth/
│   ├── login.yml
│   └── get-profile.yml
└── users/
    ├── get-users.yml
    └── create-user.yml
```

## Security

### SSRF Protection
All outbound requests from `run_collection` are validated:
- **Private IP blocking**: Requests to `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, and IPv6 equivalents (including IPv4-mapped `::ffff:x.x.x.x`) are blocked
- **DNS resolution before check**: Hostnames are resolved to their IP address(es) *before* the private-range check, so a public-looking domain that resolves to an internal address (e.g. `filters.example.com` → `10.x.x.x`) is blocked. If any resolved address is private/reserved, the request is blocked
- **Scheme validation**: Only `http:` and `https:` schemes allowed
- **Blocked hostnames**: `localhost`, `*.local`, and `metadata.google.internal`
- **Redirect TOCTOU protection**: Each redirect hop is re-validated against SSRF rules (prevents DNS rebinding via redirects to internal IPs)

> **Known residual risk — DNS rebinding:** validation resolves the hostname, but the subsequent HTTP request re-resolves DNS independently and could connect to a different address. Full mitigation (pinning the validated IP at connect time) is tracked as a follow-up. Note that an allowlisted **hostname** is accepted *before* resolution, so it is the less-verified of the two allowlist forms — prefer IP or CIDR entries where you can.

A refusal is reported per-request as an `SSRF blocked` error with `status: 0`, and — when an allowlist entry could legitimately permit the target — carries remediation naming `BRUNO_SSRF_ALLOWLIST` and whether any entries are currently configured. The configured entries themselves are never echoed. Blocks an allowlist cannot fix, such as a DNS failure or a malformed URL, get no remediation, since pointing at the allowlist would be misleading.

This is a control on the MCP surface, not a sandbox: it constrains what `run_collection` will fetch. An agent that also has shell access can make arbitrary outbound requests regardless, so treat it as one layer, and restrict the toolset (or the network) if you need an actual boundary.

#### Allowlisting internal targets — `BRUNO_SSRF_ALLOWLIST`
To reach a known internal service on purpose (e.g. an internal API on `10.x`), set the `BRUNO_SSRF_ALLOWLIST` environment variable **when launching the server** (in your MCP client config `env` block). It is a comma-separated list of explicit exceptions:

| Entry form | Example |
|---|---|
| Exact hostname | `orders-api.internal.example` |
| IPv4 / IPv6 literal | `10.20.30.40`, `fd00::1` |
| CIDR range (v4/v6) | `10.144.0.0/16`, `fd00::/8` |

```jsonc
// claude_desktop_config.json / mcp.json
"env": { "BRUNO_SSRF_ALLOWLIST": "10.20.30.40,orders-api.internal.example" }
```

Security properties:
- **Operator-controlled only.** The variable is read **once at startup** and can NOT be set or altered via tool-call arguments — the AI agent cannot add to or read the allowlist. Only the human who launched the server decides what is permitted.
- **Explicit entries only.** Wildcards (any entry containing `*`) are rejected with a warning; you must name a specific host, IP, or CIDR. Malformed entries are ignored with a warning (warnings go to stderr).
- A request is allowed if its hostname matches an allowlisted host entry, **or** every resolved IP matches an allowlisted IP/CIDR.

#### Collection-supplied TLS / proxy — `BRUNO_INSECURE_TLS_HOSTS`, `BRUNO_PROXY_HOSTS`
A collection file is untrusted input, so its `settings.tls` and `settings.proxy` are **ignored by default**. Left unchecked, any collection could disable certificate verification (`rejectUnauthorized: false`), install its own CA/client certificate, or route every request — with all its credentials — through a proxy it names: a silent man-in-the-middle with no preconditions.

To permit these overrides for specific targets, set — **when launching the server**, same as the SSRF allowlist — a comma-separated, exact-match, case-insensitive list of **target hosts**:

| Variable | Permits, for the listed target hosts |
|---|---|
| `BRUNO_INSECURE_TLS_HOSTS` | a collection's `rejectUnauthorized: false`, `ca`, `cert`, `key` |
| `BRUNO_PROXY_HOSTS` | a collection's `proxy` |

```jsonc
"env": { "BRUNO_INSECURE_TLS_HOSTS": "staging.internal.example", "BRUNO_PROXY_HOSTS": "staging.internal.example" }
```

Security properties (as for the SSRF allowlist):
- **Operator-controlled only**, read once at startup; a tool call cannot set them.
- **Host-scoped**, not a global switch: an override applies only to a request whose target host is listed. A plain `rejectUnauthorized: true` is never a downgrade and is always honoured.
- **Explicit entries only**: any entry containing `*` is ignored with a warning.
- When an override is ignored, a warning naming the host and the ignored setting **names** (never the CA/key/proxy **values**) is written to stderr.

### Path Traversal Prevention
All tool inputs that accept file paths are validated:
- `..` segments rejected
- Null byte (`\0`) injection blocked
- Paths resolved and checked against expected base directory

### VM Sandbox (Test Scripts)
Test scripts execute in a hardened `node:vm` context:
- **Prototype chain isolation**: Context created with `Object.create(null)`
- **Code generation disabled**: `eval()` and `new Function()` blocked via `codeGeneration` option
- **Script size limit**: 50KB maximum
- **Execution timeout**: Default 5 seconds
- **No filesystem/network access**: Only `test()`, `expect()`, `res`, and `bru` are available

## Testing

```bash
npm test           # Run 591 unit tests (95%+ coverage)
```

## Development

### Project Structure

```
src/
├── index.ts                # Main entry point & exports
├── server.ts               # MCP server (13 documented tools; see Available MCP Tools)
└── bruno/
    ├── types.ts             # TypeScript interfaces
    ├── collection.ts        # Collection management
    ├── environment.ts       # Environment management
    ├── request.ts           # Request builder (dual format)
    ├── bru-parser.ts        # .bru file parser/generator
    ├── yaml-parser.ts       # YAML request parser
    ├── yaml-generator.ts    # YAML file generator
    ├── format-detector.ts   # Auto-detect .bru vs .yml
    ├── format-factory.ts    # Format-aware read/write
    ├── collection-stats.ts  # Collection analysis
    ├── request-executor.ts  # HTTP execution engine
    ├── test-runner.ts       # Sandboxed test runner (node:vm)
    ├── env-loader.ts        # Environment variable loader
    ├── workspace.ts         # Workspace resolver
    ├── variable-store.ts    # Run-scoped variable store for cross-request chaining
    ├── list-collections-handler.ts
    ├── url-validator.ts     # SSRF protection
    ├── path-validator.ts    # Path traversal prevention
    └── response-wrapper.ts  # Response object for test scripts
```

### Building

```bash
npm run build      # Build with tsup
npm run typecheck   # TypeScript type checking
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Links

- [Bruno API Client](https://www.usebruno.com/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Bruno Documentation](https://docs.usebruno.com/)
- [BRU Language Specification](https://github.com/brulang/bru-lang)
