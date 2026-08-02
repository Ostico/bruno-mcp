/**
 * Bruno MCP Server
 * Main MCP server implementation for Bruno API testing file generation
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Import our Bruno modules
import { createCollectionManager } from './bruno/collection.js';
import { createEnvironmentManager } from './bruno/environment.js';
import { createRequestBuilder } from './bruno/request.js';
import { createWorkspaceResolver } from './bruno/workspace.js';

import type { ToolContext } from './tools/context.js';

// Tool registrations, one module per domain.
import { registerCreateCollectionTool, registerListCollectionsTool, registerGetCollectionStatsTool } from './tools/collection-tools.js';
import { registerCreateEnvironmentTool, registerUpdateEnvironmentTool, registerSetEnvironmentVariableTool, registerRemoveEnvironmentVariableTool, registerReadEnvironmentTool } from './tools/environment-tools.js';
import { registerCreateRequestTool, registerModifyRequestTool, registerDeleteRequestTool, registerCreateTestSuiteTool, registerCreateCrudRequestsTool, registerListRequestsTool, registerReadRequestTool } from './tools/request-tools.js';
import { registerRunCollectionTool } from './tools/run-tools.js';
import { registerAddTestScriptTool, registerRemoveScriptTool } from './tools/script-tools.js';

export class BrunoMcpServer {
  private server: McpServer;
  private collectionManager;
  private environmentManager;
  private requestBuilder;
  private workspaceResolver;

  constructor() {
    // Initialize MCP server
    this.server = new McpServer(
      {
        name: 'bruno-mcp',
        // Reported to the client on connect. Hand-maintained, and it had drifted
        // two releases behind package.json before anyone looked.
        version: '2.0.0'
      },
      {
        instructions: 'When the user asks to test, call, or run API endpoints, use this server first. ' +
          'Workflow: list_collections → list_requests (to discover request file paths) → run_collection. ' +
          'Do not fall back to curl or direct HTTP calls when Bruno collections already cover the endpoints.',
      },
    );

    // Initialize Bruno managers
    this.collectionManager = createCollectionManager();
    this.environmentManager = createEnvironmentManager();
    this.requestBuilder = createRequestBuilder();
    this.workspaceResolver = createWorkspaceResolver();

    this.setupTools();
  }

  /**
   * Set up all MCP tools
   */
  private setupTools(): void {
    // Built explicitly rather than passing `this`: the class fields are
    // private, so the instance is not assignable to ToolContext, and naming
    // the five dependencies keeps what tools can reach visible here.
    const ctx: ToolContext = {
      server: this.server,
      collectionManager: this.collectionManager,
      environmentManager: this.environmentManager,
      requestBuilder: this.requestBuilder,
      workspaceResolver: this.workspaceResolver,
    };

    // Registration ORDER is part of the contract — it is the order tools are
    // listed to a client — so it stays exactly as it was before the split,
    // rather than following the new module grouping. Pinned by
    // tests/unit/tools/tool-surface-contract.test.ts.
    registerCreateCollectionTool(ctx);
    registerCreateEnvironmentTool(ctx);
    registerUpdateEnvironmentTool(ctx);
    registerSetEnvironmentVariableTool(ctx);
    registerRemoveEnvironmentVariableTool(ctx);
    registerCreateRequestTool(ctx);
    registerModifyRequestTool(ctx);
    registerAddTestScriptTool(ctx);
    registerRemoveScriptTool(ctx);
    registerDeleteRequestTool(ctx);
    registerCreateTestSuiteTool(ctx);
    registerCreateCrudRequestsTool(ctx);
    registerListCollectionsTool(ctx);
    registerListRequestsTool(ctx);
    registerGetCollectionStatsTool(ctx);
    registerRunCollectionTool(ctx);
    registerReadRequestTool(ctx);
    registerReadEnvironmentTool(ctx);
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.error('Bruno MCP Server started successfully! 🚀');
    console.error('Ready to generate Bruno API testing files.');
  }

  /**
   * Close the transport so the client sees a clean disconnect rather than a
   * truncated JSON-RPC stream.
   *
   * Best effort by design: the caller is the uncaughtException guard, where the
   * process is already in an undefined state and there is no safe point at
   * which to await. Failures here must not mask the error being reported.
   */
  async stop(): Promise<void> {
    await this.server.close();
  }
}

/**
 * Create and export server instance
 */
export function createBrunoMcpServer(): BrunoMcpServer {
  return new BrunoMcpServer();
}