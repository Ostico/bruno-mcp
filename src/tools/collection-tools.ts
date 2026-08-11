/**
 * MCP tool registrations: collection tools.
 *
 * Moved out of server.ts unchanged apart from `this.` becoming `ctx.`.
 */

import { z } from 'zod';
import { listCollectionsHandler } from '../bruno/list-collections-handler.js';
import { getCollectionStats } from '../bruno/collection-stats.js';
import { collectionDialectWarnings } from '../bruno/request-extensions.js';
import { declaredFormat } from '../bruno/request-discovery.js';
import {
  CreateCollectionInput,
} from '../bruno/types.js';
import { validateToolPath } from './tool-path.js';
import type { ToolContext } from './context.js';

export function registerCreateCollectionTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'create_collection',
    {
      title: 'Create Bruno Collection',
      description: 'Create a new Bruno API testing collection with configuration',
      inputSchema: {
        name: z.string().min(1, 'Collection name is required'),
        description: z.string().optional(),
        baseUrl: z.string().url().optional(),
        outputPath: z.string().min(1, 'Output path is required').describe('Absolute path where the new collection directory will be created.'),
        ignore: z.array(z.string()).optional(),
        format: z.enum(['yaml', 'bru']).optional().default('yaml')
      }
    },
    async (args) => {
      try {
        const pathCheck = validateToolPath(args.outputPath);
        if (!pathCheck.valid) {
          return {
            content: [{ type: 'text', text: `Invalid outputPath: ${pathCheck.reason}` }],
            isError: true,
          };
        }

        const input: CreateCollectionInput = {
          name: args.name,
          description: args.description,
          baseUrl: args.baseUrl,
          outputPath: args.outputPath,
          ignore: args.ignore,
          format: args.format as 'yaml' | 'bru',
        };

        const result = await ctx.collectionManager.createCollection(input);

        if (result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `✅ Bruno collection "${args.name}" created successfully at: ${result.path}`
              }
            ]
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Failed to create collection: ${result.error}`
              }
            ],
            isError: true
          };
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Error creating collection: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function registerListCollectionsTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'list_collections',
    {
      title: 'List Collections',
      description: 'List the Bruno collections REGISTERED IN workspace.yml, with their names and paths. This is a registry listing, not a filesystem scan: a collection that exists on disk but is not registered will NOT appear, and registered entries that no longer exist are returned with "exists": false. If you already know a collection\'s absolute path, pass it directly to the other tools — it does not need to appear here. Use the returned path as collectionPath in other tools (get_collection_stats, list_requests, run_collection).',
      inputSchema: {
        workspacePath: z.string().optional().describe('Optional explicit path to workspace.yml')
      }
    },
    async (args) => {
      try {
        // Validate workspacePath if provided (basic traversal check)
        if (args.workspacePath) {
          const wsCheck = validateToolPath(args.workspacePath);
          if (!wsCheck.valid) {
            return {
              content: [{ type: 'text', text: `Invalid workspacePath: ${wsCheck.reason}` }],
              isError: true,
            };
          }
        }

        const collections = await listCollectionsHandler(
          ctx.workspaceResolver,
          { workspacePath: args.workspacePath }
        );

        if (collections.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  collections: [],
                  message: 'No collections found. Ensure Bruno workspace.yml exists or provide an explicit workspacePath.'
                }, null, 2)
              }
            ]
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ collections }, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error listing collections: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function registerGetCollectionStatsTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'get_collection_stats',
    {
      title: 'Get Collection Statistics',
      description: 'Get statistics about a Bruno collection — request counts by method, folders, environments, and per-request details including file paths. environmentDetails lists each environment with the NAMES of the variables it declares (values are withheld), so you can see what an environment already defines before merging into it with set_environment_variable. Use filePath values as entries in the requests list of run_collection.',
      inputSchema: {
        collectionPath: z.string().min(1, 'Collection path is required').describe('Absolute path to collection directory. Use the path returned by list_collections.')
      }
    },
    async (args) => {
      try {
        // Validate collectionPath
        const pathCheck = validateToolPath(args.collectionPath);
        if (!pathCheck.valid) {
          return {
            content: [{ type: 'text', text: `Invalid collectionPath: ${pathCheck.reason}` }],
            isError: true,
          };
        }

        const stats = await getCollectionStats(args.collectionPath);

        // Counting a file Bruno never reads makes the totals disagree with what
        // Bruno itself would report, so the same warning the reading tools give
        // belongs on the counts. It goes in its own block: the first one is a
        // JSON document.
        const warnings = collectionDialectWarnings(
          stats.requests.map((request) => request.filePath).filter((p): p is string => !!p),
          await declaredFormat(args.collectionPath),
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(stats, null, 2),
            },
            ...warnings.map((warning) => ({ type: 'text' as const, text: warning })),
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error getting collection stats: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}
