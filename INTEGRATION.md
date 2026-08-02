# Bruno MCP Server Integration Guide

This guide explains how to integrate the Bruno MCP Server with various MCP-compatible clients including Claude Desktop, Claude Code, and other AI applications.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Claude Desktop App](#claude-desktop-app)
- [Claude Code (VS Code Extension)](#claude-code-vs-code-extension)
- [OpenAI Compatible Clients](#openai-compatible-clients)
- [Other MCP-Compatible Clients](#other-mcp-compatible-clients) — Cursor, Codex CLI, opencode, Continue, Cline, LM Studio
- [MCP Inspector (Testing)](#mcp-inspector-testing)
- [Docker Integration](#docker-integration)
- [Environment Variables](#environment-variables)
- [Troubleshooting](#troubleshooting)
- [Configuration Examples](#configuration-examples)

## Prerequisites

1. **Install Bruno MCP Server:**
   ```bash
   git clone <your-repo-url>
   cd bruno-mcp
   npm install
   npm run build
   ```

2. **Verify Installation:**
   ```bash
   npm start
   # Should output: "Bruno MCP Server started successfully! 🚀"
   # Press Ctrl+C to stop
   ```

## Claude Desktop App

### Configuration

1. **Locate Claude Desktop Config:**
   
   **macOS:**
   ```bash
   ~/Library/Application Support/Claude/claude_desktop_config.json
   ```
   
   **Windows:**
   ```bash
   %APPDATA%/Claude/claude_desktop_config.json
   ```
   
   **Linux:**
   ```bash
   ~/.config/Claude/claude_desktop_config.json
   ```

2. **Add Bruno MCP Server Configuration:**
   
   Create or edit the config file:
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

   **Replace `/absolute/path/to/bruno-mcp` with your actual path!**

3. **Get Absolute Path:**
   ```bash
   # From within the bruno-mcp directory
   pwd
   # Copy the output and use it in the config
   ```

4. **Complete Example Config:**
   ```json
   {
     "mcpServers": {
       "bruno-mcp": {
         "command": "node",
         "args": ["/Users/yourname/projects/bruno-mcp/dist/index.js"],
         "env": {
           "NODE_ENV": "production"
         }
       }
     }
   }
   ```

5. **Restart Claude Desktop** to load the new configuration.

### Usage in Claude Desktop

Once configured, you can use Bruno MCP tools in Claude Desktop conversations:

```
Create a Bruno collection for testing a REST API:

Collection name: "ecommerce-api-tests"
Description: "E-commerce API testing suite"
Base URL: "https://api.shop.com"
Output path: "./collections"

Also create environments for development and production.
```

Claude will use the Bruno MCP tools to generate the collection and files.

## Claude Code (VS Code Extension)

### Configuration

1. **Open VS Code Settings** (Cmd/Ctrl + ,)

2. **Search for "Claude Code"** or navigate to Extensions → Claude Code

3. **Find MCP Settings** or edit settings.json directly:

   **Via Settings UI:**
   - Look for "Claude Code: MCP Servers"
   - Add new server configuration

   **Via settings.json:**
   ```json
   {
     "claude-code.mcpServers": {
       "bruno-mcp": {
         "command": "node",
         "args": ["/absolute/path/to/bruno-mcp/dist/index.js"],
         "env": {}
       }
     }
   }
   ```

4. **Alternative: Workspace Configuration**
   
   Create `.vscode/settings.json` in your project:
   ```json
   {
     "claude-code.mcpServers": {
       "bruno-mcp": {
         "command": "node",
         "args": ["./node_modules/.bin/bruno-mcp"],
         "env": {}
       }
     }
   }
   ```

5. **Reload VS Code** to apply changes.

### Usage in Claude Code

Use Bruno MCP tools directly in Claude Code conversations:

```
I need to set up API tests for my Node.js project. Create a Bruno collection with:
- Collection name: "user-service-tests"  
- Base URL from environment variable
- CRUD operations for users endpoint
- Authentication tests with JWT tokens
```

## OpenAI Compatible Clients

For OpenAI API compatible clients that support MCP:

### Generic MCP Client Configuration

```json
{
  "mcp_servers": [
    {
      "name": "bruno-mcp",
      "command": "node",
      "args": ["/path/to/bruno-mcp/dist/index.js"],
      "transport": "stdio"
    }
  ]
}
```

### Example Integration Code

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Connect to Bruno MCP Server
const transport = new StdioClientTransport({
  command: 'node',
  args: ['/path/to/bruno-mcp/dist/index.js']
});

const client = new Client({
  name: 'my-app',
  version: '1.0.0'
});

await client.connect(transport);

// Use Bruno MCP tools
const result = await client.callTool({
  name: 'create_collection',
  arguments: {
    name: 'api-tests',
    outputPath: './collections',
    baseUrl: 'https://api.example.com'
  }
});

console.log(result);
```

## Other MCP-Compatible Clients

This server is a plain stdio MCP server with no client-specific code, so **any MCP client can run it** — the sections here are the ones with worked examples, not the ones that are supported. If your client is not listed, give it `command: node` and `args: ["/path/to/bruno-mcp/dist/index.js"]` in whatever shape it expects.

### Cursor

`.cursor/mcp.json` in the project (or the global equivalent), same shape as Claude Desktop:

```json
{
  "mcpServers": {
    "bruno-mcp": {
      "command": "node",
      "args": ["/path/to/bruno-mcp/dist/index.js"]
    }
  }
}
```

### Codex CLI

`~/.codex/config.toml` — TOML rather than JSON, same fields:

```toml
[mcp_servers.bruno-mcp]
command = "node"
args = ["/path/to/bruno-mcp/dist/index.js"]
```

### opencode

`opencode.json`, under its `mcp` key, as a local server:

```json
{
  "mcp": {
    "bruno-mcp": {
      "type": "local",
      "command": ["node", "/path/to/bruno-mcp/dist/index.js"],
      "enabled": true
    }
  }
}
```

### Continue (VS Code Extension)

Add to your Continue config (`~/.continue/config.json`):

```json
{
  "mcpServers": {
    "bruno-mcp": {
      "command": "node",
      "args": ["/path/to/bruno-mcp/dist/index.js"]
    }
  }
}
```

### Cline (VS Code Extension)

Configure in Cline settings:

```json
{
  "cline.mcpServers": [
    {
      "name": "bruno-mcp",
      "command": "node", 
      "args": ["/path/to/bruno-mcp/dist/index.js"]
    }
  ]
}
```

### LM Studio

1. Open LM Studio
2. Go to Settings → MCP Servers
3. Add new server:
   - **Name:** bruno-mcp
   - **Command:** node
   - **Args:** `/path/to/bruno-mcp/dist/index.js`

## MCP Inspector (Testing)

For development and testing:

```bash
# Start MCP Inspector
npx @modelcontextprotocol/inspector

# When prompted, enter:
# Command: node
# Args: /path/to/bruno-mcp/dist/index.js
```

This opens a web interface to test all Bruno MCP tools interactively.

## Docker Integration

### Dockerfile for Bruno MCP Server

```dockerfile
FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY dist/ ./dist/
COPY bruno-mcp ./bruno-mcp

EXPOSE 3000
CMD ["node", "dist/index.js"]
```

### Docker Compose

```yaml
version: '3.8'
services:
  bruno-mcp:
    build: .
    volumes:
      - ./collections:/app/collections
    environment:
      - NODE_ENV=production
```

### Client Configuration for Docker

```json
{
  "mcpServers": {
    "bruno-mcp": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-v", "$(pwd)/collections:/app/collections", "bruno-mcp"],
      "env": {}
    }
  }
}
```

## Environment Variables

Configure Bruno MCP Server behavior:

```json
{
  "mcpServers": {
    "bruno-mcp": {
      "command": "node",
      "args": ["/path/to/bruno-mcp/dist/index.js"],
      "env": {
        "NODE_ENV": "production",
        "BRUNO_DEFAULT_OUTPUT": "/path/to/collections",
        "BRUNO_DEFAULT_BASE_URL": "https://api.example.com",
        "DEBUG": "bruno-mcp:*"
      }
    }
  }
}
```

## Troubleshooting

### Common Issues

1. **"Command not found" Error**
   ```bash
   # Verify Node.js installation
   node --version
   npm --version
   
   # Verify Bruno MCP build
   ls -la /path/to/bruno-mcp/dist/
   ```

2. **Permission Denied**
   ```bash
   # Make script executable
   chmod +x /path/to/bruno-mcp/dist/index.js
   ```

3. **Module Not Found**
   ```bash
   # Reinstall dependencies
   cd bruno-mcp
   rm -rf node_modules package-lock.json
   npm install
   npm run build
   ```

4. **Path Issues**
   ```bash
   # Use absolute paths in all configurations
   # Get absolute path:
   cd bruno-mcp && pwd
   ```

### Debugging

1. **Enable Debug Logging**
   ```json
   {
     "env": {
       "DEBUG": "bruno-mcp:*",
       "NODE_ENV": "development"
     }
   }
   ```

2. **Test Manually**
   ```bash
   # Test server startup
   node dist/index.js
   
   # Should output startup message
   # Press Ctrl+C to stop
   ```

3. **Check Client Logs**
   - Claude Desktop: Check application logs
   - VS Code: Check Developer Console (Help → Toggle Developer Tools)
   - Other clients: Check their respective log outputs

### Getting Help

1. **Check Server Status**
   ```bash
   npm run build && npm start
   ```

2. **Validate Configuration**
   ```bash
   # Use MCP Inspector for testing
   npx @modelcontextprotocol/inspector
   ```

3. **Common Fixes**
   - Restart the client application after configuration changes
   - Use absolute paths for all file references
   - Ensure Node.js version is 18+ 
   - Verify file permissions on the script

## Configuration Examples

### Development Setup
```json
{
  "mcpServers": {
    "bruno-mcp-dev": {
      "command": "npm",
      "args": ["run", "dev"],
      "cwd": "/path/to/bruno-mcp",
      "env": {
        "NODE_ENV": "development",
        "DEBUG": "bruno-mcp:*"
      }
    }
  }
}
```

### Production Setup
```json
{
  "mcpServers": {
    "bruno-mcp": {
      "command": "node",
      "args": ["/opt/bruno-mcp/dist/index.js"],
      "env": {
        "NODE_ENV": "production",
        "BRUNO_DEFAULT_OUTPUT": "/var/collections"
      }
    }
  }
}
```

### Multiple Instances
```json
{
  "mcpServers": {
    "bruno-mcp-dev": {
      "command": "node",
      "args": ["/path/to/bruno-mcp/dist/index.js"],
      "env": { "BRUNO_ENV": "development" }
    },
    "bruno-mcp-prod": {
      "command": "node", 
      "args": ["/path/to/bruno-mcp/dist/index.js"],
      "env": { "BRUNO_ENV": "production" }
    }
  }
}
```

---

After configuration, you can use natural language with your AI client to create Bruno collections:

> *"Create a Bruno collection for testing a RESTful API with CRUD operations, authentication, and error handling scenarios."*

The AI will use the Bruno MCP Server to generate properly formatted .bru files automatically! 🚀