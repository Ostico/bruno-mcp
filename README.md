# Bruno MCP Server

A Model Context Protocol (MCP) server for creating, managing, and executing Bruno API testing collections. Supports both .bru and .yml (opencollection) formats with built-in security hardening.

## Overview

Bruno MCP Server enables you to create, manage, and generate Bruno API testing collections, environments, and requests through standardized MCP tools. This allows for automated setup of API testing workflows and integration with Claude and other MCP-compatible clients.

## Features

- **📁 Collection Management**: Create and organize Bruno collections
- **🌍 Environment Configuration**: Manage multiple environments (dev, staging, prod)
- **🔧 Request Generation**: Generate .bru files for all HTTP methods
- **🔐 Authentication Support**: Bearer tokens, Basic auth, OAuth 2.0, API keys
- **📝 Test Scripts**: Add pre/post request scripts and assertions
- **🔄 CRUD Operations**: Generate complete CRUD request sets
- **📊 Collection Statistics**: Analyze existing collections
- **📂 Dual Format Support**: `.bru` (legacy) and `.yml` (opencollection YAML) with auto-detection
- **🔍 Collection Discovery**: `list_collections` tool to discover Bruno collections from workspace
- **▶ Request Execution**: `run_collection` tool to execute requests and run tests
- **🛡 Security Hardening**: SSRF protection, path traversal prevention, VM sandbox for test scripts

## Installation

```bash
# Clone the repository
git clone https://github.com/macarthy/bruno-mcp.git
cd bruno-mcp

# Install dependencies
npm install

# Build the project
npm run build
```

## Client Integration

The Bruno MCP Server can be integrated with various AI clients that support the Model Context Protocol:

### Quick Setup for Claude Desktop

1. **Edit Claude Desktop config file:**
   - **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows:** `%APPDATA%/Claude/claude_desktop_config.json`
   - **Linux:** `~/.config/Claude/claude_desktop_config.json`

2. **Add Bruno MCP Server:**
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

3. **Restart Claude Desktop**

### Supported Clients

- ✅ **Claude Desktop App** - Full support
- ✅ **Claude Code (VS Code)** - Full support  
- ✅ **Continue** - Tools and resources
- ✅ **Cline** - Tools and resources
- ✅ **LM Studio** - Tools support
- ✅ **MCP Inspector** - Development/testing
- ✅ **Custom MCP Clients** - via SDK

**📖 For detailed integration instructions with all clients, see [INTEGRATION.md](./INTEGRATION.md)**

## Usage

### With Claude Code or MCP Inspector

1. Start the MCP server:
```bash
npm start
```

2. Use the MCP Inspector to test tools:
```bash
npx @modelcontextprotocol/inspector
```

### Available MCP Tools

#### `create_collection`
Create a new Bruno collection with configuration.

**Parameters:**
- `name` (string): Collection name
- `description` (string, optional): Collection description
- `baseUrl` (string, optional): Default base URL
- `outputPath` (string): Directory to create collection
- `ignore` (array, optional): Files to ignore

**Example:**
```json
{
  "name": "my-api-tests",
  "description": "API tests for my application", 
  "baseUrl": "https://api.example.com",
  "outputPath": "./collections"
}
```

#### `create_environment`
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

#### `create_request`
Generate .bru request files.

**Parameters:**
- `collectionPath` (string): Path to collection
- `name` (string): Request name
- `method` (string): HTTP method
- `url` (string): Request URL
- `headers` (object, optional): HTTP headers
- `body` (object, optional): Request body
- `auth` (object, optional): Authentication config
- `folder` (string, optional): Folder organization

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

#### `create_crud_requests`
Generate complete CRUD operation sets.

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

#### `add_test_script`
Add test scripts to existing requests.

**Parameters:**
- `bruFilePath` (string): Path to .bru file
- `scriptType` (string): Script type (pre-request, post-response, tests)
- `script` (string): JavaScript code

#### `get_collection_stats`
Get statistics about a collection.

**Parameters:**
- `collectionPath` (string): Path to collection

#### `list_collections`
Discover Bruno collections in a workspace.

**Parameters:**
- `workspacePath` (string, optional): Path to workspace directory

#### `run_collection`
Execute API requests and run test scripts.

**Parameters:**
- `collectionPath` (string): Path to collection
- `environment` (string, optional): Environment name
- `requestPath` (string, optional): Run single request

## Generated File Structure

```
my-collection/
├── bruno.json              # BRU format collection config
├── opencollection.yml      # YAML format collection config
├── environments/
│   ├── development.bru     # or .yml
│   └── production.bru      # or .yml
└── requests/
    ├── get-users.bru       # BRU format request
    └── create-user.yml     # YAML format request
```

## Bruno BRU File Format

Generated .bru files follow the Bruno markup language specification:

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

script:pre-request {
  bru.setVar("timestamp", Date.now());
}

script:post-response {
  if (res.status === 200) {
    bru.setVar("userId", res.body[0].id);
  }
}

tests {
  test("Status should be 200", function() {
    expect(res.status).to.equal(200);
  });
}
```

## Testing

```bash
npm test           # Run 363 unit tests
```

## Examples

See the `examples/` directory for complete usage examples:

- `examples/jsonplaceholder/` - JSONPlaceholder API testing

## Development

### Project Structure

```
src/
├── index.ts                # Main entry point & exports
├── server.ts               # MCP server (9 tools)
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
    ├── test-runner.ts       # Sandboxed test runner
    ├── env-loader.ts        # Environment variable loader
    ├── workspace.ts         # Workspace resolver
    ├── list-collections-handler.ts
    ├── url-validator.ts     # SSRF protection
    ├── path-validator.ts    # Path traversal prevention
    └── response-wrapper.ts  # Response object builder
```

### Building

```bash
npm run build      # Build with tsup
npm run typecheck   # TypeScript type checking
```

### Code Quality

```bash
npm run lint       # ESLint
npm run format     # Prettier
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

---

**Generated with Bruno MCP Server** 🚀