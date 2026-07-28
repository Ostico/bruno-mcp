#!/usr/bin/env node

/**
 * Bruno MCP Server Entry Point
 * Main entry point for the Bruno MCP server application
 */

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

// Start the server if this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
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
