# Bruno MCP Server Specification

## Project Overview

**Name:** bruno-mcp  
**Version:** 1.0.0  
**License:** MIT  
**Description:** MCP server for creating, managing, and executing Bruno API testing collections with dual format support

## Objectives

Build a TypeScript MCP (Model Context Protocol) server that enables the generation of Bruno BRU files for API testing. The server will support creating collections, environments, requests, and testing scripts through standardized MCP tools.

## Project Structure

```
bruno-mcp/
├── .gitignore
├── README.md
├── LICENSE
├── SPEC.md
├── package.json
├── tsconfig.json
├── jest.config.ts
├── src/
│   ├── index.ts               # Main entry point & exports
│   ├── server.ts              # MCP server (9 tools)
│   ├── usebruno-lang.d.ts     # Type declarations for @usebruno/lang
│   └── bruno/
│       ├── types.ts             # TypeScript interfaces
│       ├── collection.ts        # Collection management
│       ├── environment.ts       # Environment management
│       ├── request.ts           # Request builder (dual format)
│       ├── bru-parser.ts        # .bru file parser/generator
│       ├── yaml-parser.ts       # YAML request parser
│       ├── yaml-generator.ts    # YAML file generator
│       ├── format-detector.ts   # Auto-detect .bru vs .yml
│       ├── format-factory.ts    # Format-aware read/write routing
│       ├── generator.ts         # Legacy BRU generator
│       ├── collection-stats.ts  # Collection analysis
│       ├── request-executor.ts  # HTTP execution engine
│       ├── test-runner.ts       # VM-sandboxed test runner
│       ├── env-loader.ts        # Environment variable loader
│       ├── workspace.ts         # Workspace resolver
│       ├── list-collections-handler.ts
│       ├── url-validator.ts     # SSRF protection
│       ├── path-validator.ts    # Path traversal prevention
│       └── response-wrapper.ts  # Response object builder
├── tests/
│   ├── unit/                    # 363 unit tests
│   └── fixtures/                # Test collections
└── examples/
    └── jsonplaceholder/         # Example collection
```

## Technical Stack

- **Language:** TypeScript
- **Runtime:** Node.js >=18.0.0
- **MCP SDK:** @modelcontextprotocol/sdk
- **Validation:** Zod
- **YAML:** yaml
- **Bruno Parser:** @usebruno/lang
- **Testing:** Jest
- **Build:** tsup
- **Transport:** stdio (for CLI usage)

## MCP Tools Specification

### 1. `create_collection`
**Purpose:** Initialize a new Bruno collection with configuration

**Input Schema:**
```typescript
{
  name: string;                    // Collection name
  description?: string;            // Optional description
  baseUrl?: string;               // Default base URL
  outputPath: string;             // Directory to create collection
}
```

**Output:**
- Creates `bruno.json` configuration file
- Sets up collection directory structure
- Generates initial `.gitignore` for Bruno files

### 2. `create_environment`
**Purpose:** Create environment configuration files

**Input Schema:**
```typescript
{
  collectionPath: string;         // Path to Bruno collection
  name: string;                   // Environment name (dev, staging, prod)
  variables: Record<string, string>; // Environment variables
}
```

**Output:**
- Creates `environments/{name}.bru` file
- Supports variable interpolation with `{{variable}}` syntax

### 3. `create_request`
**Purpose:** Generate .bru request files

**Input Schema:**
```typescript
{
  collectionPath: string;         // Path to Bruno collection
  name: string;                   // Request name
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  url: string;                    // Request URL
  headers?: Record<string, string>; // HTTP headers
  body?: {                        // Request body (for POST/PUT/PATCH)
    type: 'json' | 'text' | 'form-data' | 'form-urlencoded';
    content: string;
  };
  auth?: {                        // Authentication
    type: 'bearer' | 'basic' | 'oauth2' | 'api-key';
    config: Record<string, string>;
  };
  folder?: string;                // Optional folder organization
}
```

**Output:**
- Creates `.bru` file with proper format
- Supports all HTTP methods and authentication types
- Handles headers, body, and folder organization

### 4. `add_test_script`
**Purpose:** Add pre-request and post-request scripts to existing request files

**Input Schema:**
```typescript
{
  bruFilePath: string;            // Path to .bru or .yml request file
  scriptType: 'pre-request' | 'post-response' | 'tests';
  script: string;                 // JavaScript test script
  mode?: 'append' | 'replace';    // Default: 'append'
}
```

**Output:**
- Reads existing file, injects script via format-aware parser, writes back. Supports both .bru and .yml formats.

### 5. `create_test_suite`
**Purpose:** Generate comprehensive test collections

**Input Schema:**
```typescript
{
  collectionPath: string;         // Path to Bruno collection
  suiteName: string;              // Test suite name
  requests: Array<{               // Array of related requests
    name: string;
    method: string;
    url: string;
    // ... other request properties
  }>;
  dependencies?: Array<{          // Request dependencies
    from: string;
    to: string;
    variable: string;
  }>;
}
```

**Output:**
- Creates related requests with dependencies
- Sets up data-driven testing scenarios
- Generates comprehensive test workflows

### 6. `list_collections`
**Purpose:** Discover Bruno collections in a workspace

**Input Schema:**
```typescript
{
  workspacePath?: string;         // Path to workspace (optional)
}
```

**Output:**
- Discovers Bruno collections by scanning for `bruno.json` or `opencollection.yml` marker files.

### 7. `get_collection_stats`
**Purpose:** Analyze a Bruno collection and return summary statistics

**Input Schema:**
```typescript
{
  collectionPath: string;         // Path to collection directory
}
```

**Output:**
- Returns request count, methods breakdown, folders, environments, test coverage.

### 8. `run_collection`
**Purpose:** Execute requests in a Bruno collection

**Input Schema:**
```typescript
{
  collectionPath: string;         // Path to collection
  environment?: string;           // Environment name
  requests?: string[];            // Ordered request files or directories; omit for all
  groups?: Array<{                // Isolated groups; cannot be combined with requests
    name?: string;
    requests?: string[];          // Omit for the whole collection under this identity
    environment?: string;         // Replaces the run-level environment
    variables?: Record<string, string | number | boolean>;
    parallel?: boolean;           // This group's own requests, concurrently
  }>;
  parallel?: boolean;             // Runs the GROUPS concurrently
  maxConcurrency?: number;        // Requests in flight; 0 is unbounded
}
```

**Output:**
- Executes HTTP requests with SSRF protection, runs test scripts in sandboxed VM, and returns group-shaped results: each group carries its own summary and results, and the top-level summary covers the run. There is no top-level `results` array.

## Bruno BRU File Format

### File Structure
Bruno uses the BRU markup language with three main block types:

1. **Meta Block:** Request metadata
2. **HTTP Block:** Request definition (method, URL, headers, body)
3. **Script Blocks:** Pre-request and post-response scripts

### Example BRU File
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
  // Pre-request script
  bru.setVar("timestamp", Date.now());
}

script:post-response {
  // Post-response script
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

## Testing Strategy

### 1. Unit Testing (Jest)
- Test BRU file generation logic
- Validate file format compliance
- Test environment variable interpolation
- Mock file system operations

### 2. MCP Protocol Testing
- Use MCP Inspector for tool validation
- Test request/response schemas
- Validate error handling and edge cases

### 3. Integration Testing
- Generate BRU files via MCP tools
- Import into actual Bruno application
- Execute with `bruno-cli run` command
- Verify API responses and test results

### 4. Test Data & Scenarios
- **Sample APIs:** JSONPlaceholder, httpbin.org, ReqRes
- **Authentication:** Bearer tokens, Basic auth, OAuth 2.0, API keys
- **Request Types:** GET, POST, PUT, DELETE, PATCH
- **Complex Scenarios:** File uploads, large payloads, error handling
- **Edge Cases:** Special characters, encoding, timeout scenarios

## Implementation Progress

### Phase 1: Project Setup ✅
- [x] Initialize git repository and create directory structure
- [x] Create package.json with dependencies
- [x] Configure TypeScript with tsconfig.json
- [x] Create .gitignore and MIT LICENSE files
- [x] Create this specification file

### Phase 2: Core Bruno Implementation ✅
- [x] Define TypeScript interfaces for Bruno BRU file format
- [x] Implement BRU file generator with proper syntax
- [x] Create collection and environment management modules

### Phase 3: MCP Server & Tools ✅
- [x] Set up MCP server with stdio transport
- [x] Implement create_collection MCP tool
- [x] Implement create_environment MCP tool
- [x] Implement create_request MCP tool
- [x] Implement add_test_script MCP tool
- [x] Implement create_crud_requests MCP tool
- [x] Implement create_test_suite MCP tool
- [x] Implement get_collection_stats MCP tool
- [x] Implement list_collections MCP tool

### Phase 4: Documentation & Integration ✅
- [x] Create example collections with test data scenarios
- [x] Create comprehensive README with usage examples and API docs
- [x] Create detailed INTEGRATION.md with client setup instructions
- [x] Test MCP server functionality and build process
- [x] Create initial git commit with complete implementation

### Phase 5: Testing & Security ✅
- [x] 363 unit tests across 16 test suites
- [x] VM sandbox hardening (prototype chain, eval, Function blocked)
- [x] SSRF protection (private IPs, cloud metadata, scheme blocking)
- [x] Path traversal prevention in all tool handlers
- [x] Dual format support (.bru and .yml auto-detection)

## Client Integration Support

The Bruno MCP Server supports integration with multiple AI clients:

### Fully Supported Clients ✅
- **Claude Desktop App** - Complete MCP tool integration
- **Claude Code (VS Code Extension)** - Full development workflow
- **MCP Inspector** - Development and testing interface
- **Continue (VS Code)** - Code generation and API testing
- **Cline (VS Code)** - Autonomous development workflows
- **LM Studio** - Local LLM integration

### Integration Documentation
- **INTEGRATION.md** - Comprehensive setup guide for all clients
- **Client-specific configurations** - Detailed JSON configurations
- **Troubleshooting guide** - Common issues and solutions
- **Environment variable support** - Custom configuration options

## Key Features

- **File Generation:** Create properly formatted .bru files
- **Dual Format Support:** Auto-detection of .bru and .yml (opencollection) formats
- **Environment Management:** Handle multiple environments with variables
- **Authentication Support:** Bearer tokens, Basic auth, OAuth 2.0, API keys
- **Test Scripting:** Pre/post request scripts with assertions
- **Collection Organization:** Folder structure and request grouping
- **Variable Interpolation:** {{variable}} syntax support
- **Security Hardening:** SSRF protection, path traversal prevention, sandboxed test execution
- **Request Execution:** Run collections with environment substitution and test assertions
- **CLI Integration:** Works with Bruno CLI for test execution

## Dependencies

### Production Dependencies
- `@modelcontextprotocol/sdk`: MCP protocol implementation
- `zod`: Schema validation and type safety
- `yaml`: YAML parsing and generation
- `@usebruno/lang`: BRU markup language parser

### Development Dependencies
- `typescript`: TypeScript compiler and language support
- `@types/node`: Node.js type definitions
- `jest` + `@types/jest` + `ts-jest`: Testing framework
- `tsup`: Build bundler
- `eslint` + `@typescript-eslint/*`: Code linting
- `prettier`: Code formatting
- `ts-node`: TypeScript execution for development

## Usage Example

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Start MCP server
npm start

# Test with MCP Inspector
npx @modelcontextprotocol/inspector

# Run generated tests with Bruno CLI
bruno-cli run examples/api-tests/
```

## Repository Information

- **Type:** Private Git Repository
- **Name:** bruno-mcp
- **Branching:** Standard Git workflow (main branch)
- **CI/CD:** Prepared for future GitHub Actions integration
- **Versioning:** Semantic versioning with git tags

---

*This specification is a living document and will be updated as the project evolves.*