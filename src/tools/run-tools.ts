/**
 * MCP tool registrations: run tools.
 *
 * Moved out of server.ts unchanged apart from `this.` becoming `ctx.`.
 */

import { z } from 'zod';
import { RequestExecutor } from '../bruno/request-executor.js';
import { forkingScriptRunner } from '../bruno/sandbox-host.js';
import { validateToolPath } from './tool-path.js';
import type { ToolContext } from './context.js';

export function registerRunCollectionTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'run_collection',
    {
      title: 'Run Collection',
      description: 'Execute requests in a Bruno collection and run test scripts. Omit requestPath to run ALL requests. Provide requestPath as a .yml/.bru file to run one request, or as a subdirectory to run all requests in that folder. Each result includes the response body (response_body, response_content_type, response_body_truncated) by default — disable with includeResponseBody=false or cap the size with maxResponseBodyBytes. A request file that cannot be parsed is skipped rather than failing the run: the count is parseErrors and each skipped file is named with its reason in parseFailures, so a run over a whole collection can be a subset without looking like one. Outbound requests are SSRF-filtered: targets resolving to private, loopback, link-local or otherwise reserved addresses are refused unless the server operator has allowlisted them, and a refusal is reported per-request as an "SSRF blocked" error with status 0.',
      inputSchema: {
        collectionPath: z.string().min(1, 'Collection path is required').describe('Absolute path to collection root directory. Use the path returned by list_collections.'),
        environment: z.string().optional().describe('Environment name to use (e.g. "dev", "staging"). Get available names from get_collection_stats.'),
        collectionRoot: z.string().optional().describe('Path to collection root for environment resolution (if different from collectionPath)'),
        requestPath: z.string().optional().describe('Path to a specific .yml or .bru request file, or a subdirectory within the collection. Get file paths from list_requests or get_collection_stats. Omit to run all requests in the collection.'),
        parallel: z.boolean().optional().default(false).describe('Run folders in parallel. Requests within each folder still run sequentially by seq order. Default: false.'),
        includeResponseBody: z.boolean().optional().default(true).describe('Include the response body of each request in the results. Default: true.'),
        maxResponseBodyBytes: z.number().optional().default(10240).describe('Maximum response body size (bytes) to return per request; longer bodies are truncated and response_body_truncated is set. Default: 10240.')
      }
    },
    async (args) => {
      try {
        // Validate collectionPath (no traversal, no null bytes)
        const collectionCheck = validateToolPath(args.collectionPath);
        if (!collectionCheck.valid) {
          return {
            content: [{ type: 'text', text: `Invalid collectionPath: ${collectionCheck.reason}` }],
            isError: true,
          };
        }

        // Validate requestPath is within collectionPath if provided
        if (args.requestPath) {
          const requestCheck = validateToolPath(args.requestPath, args.collectionPath);
          if (!requestCheck.valid) {
            return {
              content: [{ type: 'text', text: `Invalid requestPath: ${requestCheck.reason}` }],
              isError: true,
            };
          }
        }

        // Validate collectionRoot if provided (no traversal, no null bytes)
        if (args.collectionRoot) {
          const rootCheck = validateToolPath(args.collectionRoot);
          if (!rootCheck.valid) {
            return {
              content: [{ type: 'text', text: `Invalid collectionRoot: ${rootCheck.reason}` }],
              isError: true,
            };
          }
        }

        const result = await RequestExecutor.executeCollection(
          args.collectionPath,
          {
            environment: args.environment,
            collectionRoot: args.collectionRoot,
            requestPath: args.requestPath,
            parallel: args.parallel,
            includeResponseBody: args.includeResponseBody,
            maxResponseBodyBytes: args.maxResponseBodyBytes,
            // Production runs untrusted scripts behind the process boundary.
            // Named explicitly even though it is now the executor's default: a
            // security property this entry point depends on should be readable
            // here, not inferred from a default someone could change.
            scriptRunner: forkingScriptRunner,
          },
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error running collection: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}
