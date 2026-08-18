/**
 * MCP tool registrations: collection tools.
 *
 * Moved out of server.ts unchanged apart from `this.` becoming `ctx.`.
 */

import { z } from 'zod';
import { basename, join } from 'path';
import { listCollectionsHandler } from '../bruno/list-collections-handler.js';
import { getCollectionStats, filterCollectionStats } from '../bruno/collection-stats.js';
import { collectionDialectWarnings } from '../bruno/request-extensions.js';
import { declaredFormat } from '../bruno/request-discovery.js';
import {
  CreateCollectionInput,
} from '../bruno/types.js';
import { validateToolPath } from './tool-path.js';
import { createWorkspaceResolver } from '../bruno/workspace.js';
import { registerCollectionInWorkspace } from '../bruno/workspace-registrar.js';
import type { ToolContext } from './context.js';

/**
 * Add the new collection to a workspace registry and describe what happened.
 *
 * Always says something. The gap this closes was silence: the collection existed
 * on disk, `list_collections` did not show it, and nothing in the success message
 * explained why.
 */
/**
 * Warn when `outputPath` already ends in the collection name.
 *
 * `outputPath` is the parent and `name` is appended to it, so passing the
 * intended collection path produces the name twice — `…/Blind Retest/Blind
 * Retest`, which then shows up as a phantom folder inside its own collection in
 * get_collection_stats. That is a legal thing to ask for, so this is a note on a
 * success rather than a refusal; the shape is distinctive enough to be worth
 * naming when it appears.
 *
 * Case-insensitive, because a leaf differing from the name only in case is the
 * same mistake, and on macOS it is the same directory.
 */
function doubledPathNote(name: string, outputPath: string, createdPath: string): string | undefined {
  if (basename(outputPath).toLowerCase() !== name.toLowerCase()) {
    return undefined;
  }
  return `Note: outputPath already ended in "${basename(outputPath)}", and name is appended to `
    + `outputPath, so the collection is at ${createdPath} — the name twice. If you meant `
    + `${outputPath}, pass its parent directory as outputPath instead; delete_collection removes `
    + 'this one.';
}

async function registrationNote(
  args: { name: string; workspacePath?: string; registerInWorkspace?: boolean },
  collectionPath: string,
): Promise<string> {
  if (args.registerInWorkspace === false) {
    return 'Not registered in a workspace, as asked. list_collections reads the workspace '
      + 'registry, so it will not show this collection until something registers it.';
  }

  const workspacePath = createWorkspaceResolver().resolveWorkspacePath(args.workspacePath);
  let registration;
  try {
    registration = await registerCollectionInWorkspace(workspacePath, {
      name: args.name,
      path: collectionPath,
    });
  } catch (reason) {
    // The collection is already on disk and usable by path, so a registry that
    // could not be written is reported rather than failing the call.
    return `Created, but the workspace registry at ${workspacePath} could not be written: `
      + `${reason instanceof Error ? reason.message : String(reason)}. `
      + 'The collection is usable by path; it will not appear in list_collections.';
  }

  switch (registration.outcome) {
    case 'added':
      return `Registered in ${registration.workspacePath}, so list_collections will show it.`;
    case 'already-listed':
      return `Already listed in ${registration.workspacePath} at that path, so nothing was added.`;
    case 'skipped':
      return `Not registered in ${registration.workspacePath}: ${registration.reason}. `
        + 'The collection is usable by path; it will not appear in list_collections.';
  }
}

export function registerCreateCollectionTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'create_collection',
    {
      title: 'Create Bruno Collection',
      description: 'Create a new Bruno API testing collection with configuration. '
        + 'outputPath is the PARENT directory and name is appended to it: outputPath '
        + '"/work/apis" with name "Billing" creates the collection at /work/apis/Billing. '
        + 'Do not put the collection name in outputPath as well. '
        + 'The new collection is also added to the workspace registry, because '
        + '`list_collections` reads that registry and not the disk: a collection that is '
        + 'not listed there is invisible to it and to the Bruno app. The result says '
        + 'whether it was registered and, if not, why.',
      inputSchema: {
        name: z.string().min(1, 'Collection name is required'),
        description: z.string().optional(),
        baseUrl: z.string().url().optional(),
        outputPath: z.string().min(1, 'Output path is required').describe('Absolute path of the PARENT directory to create the collection directory in. name is appended to it, so outputPath "/work/apis" with name "Billing" creates /work/apis/Billing. Passing "/work/apis/Billing" here would create /work/apis/Billing/Billing.'),
        ignore: z.array(z.string()).optional(),
        format: z.enum(['yaml', 'bru']).optional().default('yaml'),
        workspacePath: z.string().optional().describe(
          'Absolute path of the workspace.yml to register the new collection in. Defaults to '
          + 'the same one list_collections reads: BRUNO_WORKSPACE_PATH, or the Bruno app\'s '
          + 'workspace for this platform.',
        ),
        registerInWorkspace: z.boolean().optional().describe(
          'Set false to create the collection without touching any workspace file. It will '
          + 'not appear in list_collections until something else registers it.',
        ),
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

        // Checked before anything is created, so a bad workspace path cannot
        // leave a collection on disk that the same call then refuses to report.
        if (args.workspacePath !== undefined) {
          const workspaceCheck = validateToolPath(args.workspacePath);
          if (!workspaceCheck.valid) {
            return {
              content: [{ type: 'text', text: `Invalid workspacePath: ${workspaceCheck.reason}` }],
              isError: true,
            };
          }
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
          // The manager's path, not `outputPath`: the collection lives in a
          // directory named after it, one level below the path asked for.
          const createdPath = result.path ?? join(args.outputPath, args.name);
          const doubled = doubledPathNote(args.name, args.outputPath, createdPath);
          return {
            content: [
              {
                type: 'text',
                text: `✅ Bruno collection "${args.name}" created successfully at: ${result.path}`
                  + `\n${await registrationNote(args, createdPath)}`
              },
              ...(doubled ? [{ type: 'text' as const, text: doubled }] : []),
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

        // Named where the entries are listed, not only where one is read. A
        // registry holding entries that point at directories which are gone is
        // still a working registry, so this is a note rather than an error — but
        // nothing said which of the listed entries were dead weight or what to do
        // about them, and a caller reading forty-five of them has no way to tell
        // that removing them is even possible.
        const stale = collections.filter((c) => !c.exists);
        const staleNote = stale.length > 0
          ? [{
            type: 'text' as const,
            text: `${stale.length} of these ${stale.length === 1 ? 'entry points' : 'entries point'} at a `
              + 'directory that no longer exists ("exists": false), so it cannot be used. Pass its path '
              + 'to unregister_collection to take it out of the registry.',
          }]
          : [];

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ collections }, null, 2)
            },
            ...staleNote,
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
      description: 'Get statistics about a Bruno collection — request counts by method, folders, environments, and per-request details including each request\'s file path and URL. environmentDetails lists each environment with the NAMES of the variables it declares (values are withheld), so you can see what an environment already defines before merging into it with set_environment_variable. Use filePath values as entries in the requests list of run_collection.\n\nSIZE: the per-request array is the bulk of the response and grows with the collection — a few hundred requests run to tens of kilobytes. Narrow it with folder, method or nameContains, or pass includeRequests: false for counts only. The counts always describe the WHOLE collection; a filtered call adds matchedRequests so the two cannot be confused.',
      inputSchema: {
        collectionPath: z.string().min(1, 'Collection path is required').describe('Absolute path to collection directory. Use the path returned by list_collections.'),
        folder: z.string().optional().describe('Report only requests in this folder, path relative to the collection root. Nested folders are included, so "auth" also matches "auth/oauth2".'),
        method: z.string().optional().describe('Report only requests with this method, case-insensitive. A request that has no method is bucketed under its kind, so "GRPC" and "WS" work here too.'),
        nameContains: z.string().optional().describe('Report only requests whose name contains this text, case-insensitive.'),
        includeRequests: z.boolean().optional().default(true).describe('Set false to drop the per-request array and return only the counts, folders and environments.')
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
        // Computed from the unfiltered scan, before the filter narrows anything:
        // the dialect of a file the caller filtered out is still the dialect of
        // a file in this collection, and a warning that disappears when someone
        // asks a narrower question is a warning nobody ever sees.
        const warnings = collectionDialectWarnings(
          stats.requests.map((request) => request.filePath).filter((p): p is string => !!p),
          await declaredFormat(args.collectionPath),
        );

        const reported = filterCollectionStats(stats, {
          folder: args.folder,
          method: args.method,
          nameContains: args.nameContains,
          includeRequests: args.includeRequests,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(reported, null, 2),
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
