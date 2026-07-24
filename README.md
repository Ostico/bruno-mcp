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
- **Request Execution**: Execute requests and run tests with structured results
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
Create environment configuration files.

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
| `form-data` | `formData`: `[{name, value, type?}]` | Multipart form (`type`: `"text"` or `"file"`) |
| `form-urlencoded` | `content`: URL-encoded string | URL-encoded form |
| `binary` | `content`: file path | Binary body |
| `none` | _(omit `body` entirely)_ | No body |

**Example (JSON body):**
```json
{ "body": { "type": "json", "content": "{\"name\": \"test\"}" } }
```

**Example (form-data):**
```json
{ "body": { "type": "form-data", "formData": [{"name": "file", "value": "photo.jpg", "type": "file"}] } }
```

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
- `scriptType` (string): `"pre-request"`, `"post-response"`, or `"tests"`
- `script` (string): JavaScript code (max 50KB)

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
  "requests": [
    { "name": "Get Users", "method": "GET", "seq": 1, "folder": "users", "hasTests": true }
  ]
}
```

### `run_collection`
Execute all requests in a collection (or a single request) and run test scripts.

**Parameters:**
- `collectionPath` (string): Path to collection or subfolder
- `environment` (string, optional): Environment name (loads from `environments/<name>.yml`)
- `collectionRoot` (string, optional): Collection root for environment resolution
- `requestPath` (string, optional): Run a single request file instead of the full collection

**Execution Flow:**
1. Find all `.yml` request files, sort by `seq` field
2. Load environment variables (if specified)
3. For each request: substitute `{{variables}}` (env + runtime) in URL, headers, and body → execute via `fetch()` → run test scripts → extract `bru.setVar()` variables for next request
4. Requests execute serially in sequence order; variables accumulate across the run
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
      ]
    }
  ]
}
```

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
| `test(description, fn)` | Define a test case. `fn` is called synchronously; exceptions mark the test as failed. |
| `expect(value)` | Chai `expect` — supports `.to.equal()`, `.to.have.property()`, `.to.be.above()`, etc. |
| `res` | Response object (see methods below) |
| `bru` | Variable store for cross-request chaining (see methods below) |

**`bru` methods (variable chaining):**

| Method | Description |
|---|---|
| `bru.setVar(name, value)` | Store a variable for use by subsequent requests. Run-scoped — lost when execution ends. |
| `bru.getVar(name)` | Retrieve a previously set variable. Returns `undefined` if not set. |

Variables set via `bru.setVar()` are merged with environment variables for `{{substitution}}` in subsequent requests. Runtime variables take precedence over environment variables with the same name.

**`res` methods:**

| Method | Returns | Description |
|---|---|---|
| `res.getStatus()` | `number` | HTTP status code |
| `res.getStatusText()` | `string` | Status text (e.g. "OK") |
| `res.getHeaders()` | `object` | All response headers |
| `res.getHeader(name)` | `string \| null` | Single header (case-insensitive) |
| `res.getBody()` | `any` | Parsed JSON if content-type is `application/json`, otherwise raw text |
| `res.getResponseTime()` | `number` | Response time in milliseconds |

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

> **Known residual risk — DNS rebinding:** validation resolves the hostname, but the subsequent HTTP request re-resolves DNS independently and could connect to a different address. Full mitigation (pinning the validated IP at connect time) is tracked as a follow-up.

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
├── server.ts               # MCP server (10 tools)
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
