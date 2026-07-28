/**
 * The slice of BrunoMcpServer that tool registrations need (finding Q14).
 *
 * Each tool used to be a private method reaching into `this`. Passing this
 * context instead is what let the registrations move out of server.ts without
 * changing any of them: the bodies are identical apart from `this.` becoming
 * `ctx.`, so the split is mechanical and the tool surface is provably
 * unchanged (see tests/unit/tools/tool-surface-contract.test.ts).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { createCollectionManager } from '../bruno/collection.js';
import type { createEnvironmentManager } from '../bruno/environment.js';
import type { createRequestBuilder } from '../bruno/request.js';
import type { createWorkspaceResolver } from '../bruno/workspace.js';

export interface ToolContext {
  server: McpServer;
  collectionManager: ReturnType<typeof createCollectionManager>;
  environmentManager: ReturnType<typeof createEnvironmentManager>;
  requestBuilder: ReturnType<typeof createRequestBuilder>;
  workspaceResolver: ReturnType<typeof createWorkspaceResolver>;
}
