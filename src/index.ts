#!/usr/bin/env node

/**
 * Bruno MCP Server Entry Point
 * Main entry point for the Bruno MCP server application
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createBrunoMcpServer } from './server.js';
import {
  installUnhandledRejectionGuard,
  installUncaughtExceptionGuard,
} from './process-guards.js';

async function main() {
  try {
    // Installed before the server starts, and never removed: a user-supplied
    // .bru script can float a promise rejection (a bare Promise.reject is
    // enough), and Node's default policy would terminate the server. See
    // process-guards.ts for why this cannot live inside the script sandbox.
    installUnhandledRejectionGuard();

    // Create and start the Bruno MCP server
    const server = createBrunoMcpServer();

    // Unlike a rejection, an uncaught exception is not survivable: it can leave
    // the process mid-mutation, so this reports and exits rather than
    // continuing. onFatal closes the transport first so the client sees a clean
    // disconnect. Installed after the server exists and before it starts.
    installUncaughtExceptionGuard({
      onFatal: () => {
        void server.stop();
      },
    });

    await server.start();
    
    // Keep the process running
    process.on('SIGINT', () => {
      console.error('\nBruno MCP Server shutting down gracefully...');
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.error('\nBruno MCP Server shutting down gracefully...');
      process.exit(0);
    });

  } catch (error) {
    console.error('Failed to start Bruno MCP Server:', error);
    process.exit(1);
  }
}

// Start the server if this file is run directly.
//
// `file://${process.argv[1]}` looks like it does this and does not. Two ways it
// silently fails, both of which end with the process exiting 0 having started
// nothing, printed nothing, and answered no JSON-RPC:
//
//   - **Through a symlink.** `npm install` links a package's `bin` into
//     `node_modules/.bin`, so `argv[1]` is the link while `import.meta.url` is
//     the real file. `realpathSync` resolves the link, which is what makes
//     `npx @ostico/bruno-mcp` and every `.bin/bruno-mcp` invocation work.
//   - **A path with a space in it.** A file URL percent-encodes; raw
//     concatenation does not, so `/Users/me/My Projects/…` never matched. That
//     is not exotic — `~/Library/Application Support/…` has one, and a client
//     config pointing there would start a server that quietly wasn't there.
//
// `pathToFileURL` does the encoding, and both are wrapped because a missing or
// deleted `argv[1]` must leave this an import rather than crash it.
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}

export { createBrunoMcpServer } from './server.js';
export * from './bruno/types.js';
export * from './bruno/collection.js';
export * from './bruno/environment.js';
export * from './bruno/request.js';
export * from './bruno/workspace.js';
export * from './bruno/yaml-parser.js';
export * from './bruno/env-loader.js';
export * from './bruno/test-runner.js';
export * from './bruno/response-wrapper.js';
export * from './bruno/collection-stats.js';
export * from './bruno/list-collections-handler.js';
export * from './bruno/request-executor.js';
export * from './bruno/url-validator.js';
export * from './bruno/path-validator.js';
export * from './bruno/format-detector.js';
export * from './bruno/bru-parser.js';
export * from './bruno/yaml-generator.js';
export * from './bruno/format-factory.js';
