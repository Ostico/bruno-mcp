/**
 * MCP tool registrations: request tools.
 *
 * Moved out of server.ts unchanged apart from `this.` becoming `ctx.`.
 */

import { z } from 'zod';
import path from 'path';
import { readFile, unlink } from 'node:fs/promises';
import {
  CreateRequestInput,
  HttpMethod,
  AuthType,
} from '../bruno/types.js';
import { createReader } from '../bruno/format-factory.js';
import { detectFormat, findCollectionRoot, findCollectionRootFromDirectory } from '../bruno/format-detector.js';
import { toRequestView } from '../bruno/request-view.js';
import { moveRequestFile } from '../bruno/request-move.js';
import { validateToolPath, resolveRequestFile } from './tool-path.js';
import { collectionDialectWarnings } from '../bruno/request-extensions.js';
import { declaredFormat } from '../bruno/request-discovery.js';
import { withPathLock } from '../bruno/path-mutex.js';
import { topologicalSort } from './topological-sort.js';
import { requestBodySchema } from './schemas.js';
import type { ToolContext } from './context.js';

export function registerMoveRequestTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'move_request',
    {
      title: 'Move Request',
      description: 'Relocate a request file to another folder, or to another collection entirely. '
        + 'Pass copy:true to duplicate it instead of moving it. The bytes are moved verbatim and '
        + 'nothing is parsed and rewritten, so no part of the request can be lost on the way — '
        + 'which also means seq arrives unchanged and may tie with a request already there; that '
        + 'is reported, and Bruno breaks such a tie by filename. The file keeps its name: use '
        + 'write_request with filename to rename it. The new path comes back in the response.',
      inputSchema: {
        filePath: z.string().min(1, 'File path is required')
          .describe('Absolute path to the .yml or .bru request file to move. Get from list_requests or get_collection_stats.'),
        targetCollectionPath: z.string().optional()
          .describe('Absolute path to the collection it should land in. Omit to move within the '
            + "request's own collection."),
        targetFolder: z.string().optional()
          .describe('Folder inside the target collection, relative to its root, e.g. "auth/login". '
            + 'Omit for the collection root. Created if it does not exist.'),
        copy: z.boolean().optional()
          .describe('Leave the original in place and write a duplicate at the destination. Since '
            + 'the file keeps its name, a copy needs a different folder or collection.'),
      }
    },
    async (args) => {
      try {
        const resolved = await resolveRequestFile(args.filePath, 'filePath');
        if (!resolved.ok) {
          return {
            content: [{ type: 'text', text: resolved.message }],
            isError: true,
          };
        }

        // One expression for both cases so the "not a collection" answer has a
        // single reachable check: a targetCollectionPath with no manifest and a
        // source whose root has gone away both land here.
        let targetRoot: string | null;
        if (args.targetCollectionPath !== undefined) {
          const targetCheck = validateToolPath(args.targetCollectionPath);
          if (!targetCheck.valid) {
            return {
              content: [{ type: 'text', text: `Invalid targetCollectionPath: ${targetCheck.reason}` }],
              isError: true,
            };
          }
          // From the directory, not from a file inside it: the marker usually
          // sits in the very directory the caller named.
          targetRoot = await findCollectionRootFromDirectory(targetCheck.resolved);
        } else {
          targetRoot = await findCollectionRoot(args.filePath);
        }
        if (targetRoot === null) {
          return {
            content: [{
              type: 'text',
              text: 'Could not determine the target collection: no opencollection.yml or '
                + 'bruno.json found within 10 parent directories. Pass targetCollectionPath as '
                + "the collection's root directory.",
            }],
            isError: true,
          };
        }

        const result = await moveRequestFile({
          filePath: args.filePath,
          targetCollectionPath: targetRoot,
          targetFolder: args.targetFolder,
          copy: args.copy,
        });

        if (!result.success || result.path === undefined) {
          return {
            content: [{ type: 'text', text: `Failed to move request: ${result.error}` }],
            isError: true,
          };
        }

        // Read against the collection it landed in, not the one it left: moving a
        // .yml request into a bruno.json collection is the very state this
        // warning exists for. Reported and not refused, as everywhere else — the
        // file's own extension stays authoritative, and the repair is a rename.
        const detection = await detectFormat(targetRoot);
        const arrivalWarnings = collectionDialectWarnings([result.path], detection.format);

        return {
          content: [{
            type: 'text',
            text: [
              `${args.copy === true ? 'Copied' : 'Moved'} request `
                + `"${path.basename(args.filePath)}" to ${result.path}`
                + (args.copy === true ? '.' : '; pass that as filePath from now on.'),
              ...result.warnings,
              ...arrivalWarnings,
            ].join('\n\n'),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `❌ Error moving request: ${error instanceof Error ? error.message : 'Unknown error'}`,
          }],
          isError: true,
        };
      }
    }
  );
}

export function registerDeleteRequestTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'delete_request',
    {
      title: 'Delete Request',
      description: 'Permanently delete a Bruno request file from a collection. Use this to remove a request created by mistake; the file is unlinked from disk and cannot be recovered through this server. Only .yml/.bru files inside a detected Bruno collection can be deleted. To clear just a script and keep the request, use remove_script instead.',
      inputSchema: {
        filePath: z.string().min(1, 'File path is required').describe('Absolute path to the .yml or .bru request file to delete. Get from list_requests or get_collection_stats.'),
        confirm: z.literal(true).describe('Must be true. Explicit acknowledgement that the file is deleted permanently.')
      }
    },
    async (args) => {
      try {
        // Re-checked here, not only in the schema: deletion is irreversible
        // and the handler must not depend on upstream validation.
        if (args.confirm !== true) {
          return {
            content: [{ type: 'text', text: 'Refusing to delete: confirm must be true.' }],
            isError: true,
          };
        }

        const resolved = await resolveRequestFile(args.filePath, 'filePath');
        if (!resolved.ok) {
          return {
            content: [{ type: 'text', text: resolved.message }],
            isError: true,
          };
        }

        // Same per-file lock add_test_script and remove_script take. Without it,
        // a script injection that had already read this file could write it back
        // after the unlink, restoring a request this tool had just reported as
        // permanently deleted. Taking the lock orders the two: either the
        // injection finishes and is then deleted, or the delete wins and the
        // injection's read fails with ENOENT.
        await withPathLock(args.filePath, () => unlink(args.filePath));

        return {
          content: [
            {
              type: 'text',
              text: `Deleted request ${path.basename(args.filePath)} (${resolved.format} format)`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Error deleting request: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function registerCreateTestSuiteTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'create_test_suite',
    {
      title: 'Create Test Suite',
      description: 'Generate comprehensive test collections with multiple related requests',
      inputSchema: {
        collectionPath: z.string().min(1, 'Collection path is required').describe('Absolute path to existing collection directory.'),
        suiteName: z.string().min(1, 'Suite name is required'),
        requests: z.array(z.object({
          name: z.string(),
          method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']),
          url: z.string(),
          headers: z.record(z.string()).optional(),
          body: requestBodySchema,
          auth: z.object({
            // Same seven modes as write_request. This enum
            // used to stop at api-key, so a CRUD set could not be given the
            // digest or inherit auth the other two tools accept and the writer
            // handles — the same auth, rejected by whichever tool you reached
            // for. `inherit` in particular is what a request in an authenticated
            // collection normally wants.
            type: z.enum(['none', 'bearer', 'basic', 'oauth2', 'api-key', 'digest', 'inherit']),
            config: z.record(z.string())
          }).optional(),
          folder: z.string().optional()
        })),
        dependencies: z.array(z.object({
          from: z.string(),
          to: z.string(),
        })).optional()
      }
    },
    async (args) => {
      try {
        const pathCheck = validateToolPath(args.collectionPath);
        if (!pathCheck.valid) {
          return {
            content: [{ type: 'text', text: `Invalid collectionPath: ${pathCheck.reason}` }],
            isError: true,
          };
        }

        // Map request names to their created file paths
        const nameToPath: Map<string, string> = new Map();
        const results = [];

        for (let i = 0; i < args.requests.length; i++) {
          const req = args.requests[i];
          const input: CreateRequestInput = {
            collectionPath: args.collectionPath,
            name: req.name,
            method: req.method as HttpMethod,
            url: req.url,
            headers: req.headers,
            // The whole body, not just `{type, content}`. Forwarding two of
            // its fields meant a suite request could name a multipart or file
            // body and then have no way to say what was in it: the parts were
            // dropped here and the body reached the writer as a bare string,
            // which is the shape that made the generator's content fall-through
            // reachable in the first place.
            body: req.body as CreateRequestInput['body'],
            auth: req.auth ? {
              type: req.auth.type as AuthType,
              config: req.auth.config
            } : undefined,
            folder: req.folder || args.suiteName,
            sequence: i + 1
          };

          const result = await ctx.requestBuilder.createRequest(input);
          results.push(result);
          if (result.success && result.path) {
            nameToPath.set(req.name, result.path);
          }
        }

        // Apply dependency ordering if dependencies are provided
        if (args.dependencies && args.dependencies.length > 0) {
          const requestNames = args.requests.map(r => r.name);
          const sortResult = topologicalSort(requestNames, args.dependencies);

          if (sortResult.error) {
            return {
              content: [{ type: 'text', text: sortResult.error }],
              isError: true,
            };
          }

          // Update seq values based on topological order
          for (let i = 0; i < sortResult.order!.length; i++) {
            const name = sortResult.order![i];
            const filePath = nameToPath.get(name);
            if (filePath) {
              await ctx.requestBuilder.updateRequest(filePath, { sequence: i + 1 });
            }
          }
        }

        const successCount = results.filter(r => r.success).length;
        const failCount = results.filter(r => !r.success).length;

        return {
          content: [
            {
              type: 'text',
              text: `✅ Test suite "${args.suiteName}" created with ${successCount} requests${failCount > 0 ? ` (${failCount} failed)` : ''}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Error creating test suite: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function registerCreateCrudRequestsTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'create_crud_requests',
    {
      title: 'Create CRUD Requests',
      description: 'Generate a complete set of CRUD operations for an entity: list, get by id, create, update, delete. All five inherit the collection or folder auth block unless you pass auth.',
      inputSchema: {
        collectionPath: z.string().min(1, 'Collection path is required').describe('Absolute path to existing collection directory.'),
        entityName: z.string().min(1, 'Entity name is required'),
        baseUrl: z.string().min(1, 'Base URL is required'),
        folder: z.string().optional(),
        auth: z.object({
          type: z.enum(['none', 'bearer', 'basic', 'oauth2', 'api-key', 'digest', 'inherit'])
            .describe('Auth mode written to all five requests. "inherit" defers to the folder or collection auth block and takes no config; pass {} for it.'),
          config: z.record(z.string())
        }).optional()
          .describe('Defaults to inherit, matching what Bruno itself gives a new request. Passing "none" is an opt-OUT that stops the collection auth block from applying to these five files, not an absence of opinion.')
      }
    },
    async (args) => {
      try {
        const pathCheck = validateToolPath(args.collectionPath);
        if (!pathCheck.valid) {
          return {
            content: [{ type: 'text', text: `Invalid collectionPath: ${pathCheck.reason}` }],
            isError: true,
          };
        }

        const results = await ctx.requestBuilder.createCrudRequests(
          args.collectionPath,
          args.entityName,
          args.baseUrl,
          args.folder,
          args.auth
        );

        const successCount = results.filter(r => r.success).length;
        const failCount = results.filter(r => !r.success).length;

        return {
          content: [
            {
              type: 'text',
              text: `✅ CRUD operations for "${args.entityName}" created with ${successCount} requests${failCount > 0 ? ` (${failCount} failed)` : ''}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Error creating CRUD requests: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function registerListRequestsTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'list_requests',
    {
      title: 'List Requests',
      description: 'List all request files (.yml/.bru) in a Bruno collection. Returns absolute file paths, each usable as an entry in the requests list of run_collection, or of one of its groups.',
      inputSchema: {
        collectionPath: z.string().min(1).describe('Absolute path to collection directory. Use the path returned by list_collections.')
      }
    },
    async (args) => {
      try {
        const pathCheck = validateToolPath(args.collectionPath);
        if (!pathCheck.valid) {
          return {
            content: [{ type: 'text', text: `Invalid collectionPath: ${pathCheck.reason}` }],
            isError: true,
          };
        }

        const requests = await ctx.collectionManager.listRequests(args.collectionPath);

        // The walk accepts both dialects, but Bruno reads only the one its root
        // manifest declares, so a listing can name files that do not exist as
        // requests in Bruno at all. Saying so here matters more than anywhere
        // else: this is where a caller learns which requests there are, and
        // every other tool's description sends them here to find out.
        //
        // A separate block rather than a prefix, because the first block is a
        // JSON document a caller parses.
        const warnings = collectionDialectWarnings(
          requests,
          await declaredFormat(args.collectionPath),
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ requests }, null, 2)
            },
            ...warnings.map((warning) => ({ type: 'text' as const, text: warning })),
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error listing requests: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function registerReadRequestTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'read_request',
    {
      title: 'Read Bruno Request',
      description: 'Read a single request file back as structured JSON: method, url, headers, query and path params, body, auth mode, scripts, assertions, vars, settings and docs. Works on both .bru and .yml and returns the same shape for each, so the on-disk format stays invisible. Use this before write_request to see current state, and after write_request to confirm what was written. A websocket or grpc request also carries its stored messages in full — title, content, and for a websocket the type and whether the runner will send it — under websocket.messages or grpc.messages, keyed as write_request accepts them. A "notes" array reports anything the file declares that the runner will not act on.',
      inputSchema: {
        filePath: z.string().min(1, 'File path is required')
          .describe('Absolute path to the .bru or .yml request file. Use the path returned by write_request or list_requests rather than rebuilding it: request filenames are lowercased on write.'),
      },
    },
    async (args) => {
      try {
        const resolved = await resolveRequestFile(args.filePath, 'filePath');
        if (!resolved.ok) {
          return {
            content: [{ type: 'text', text: resolved.message }],
            isError: true,
          };
        }

        // Deliberately unlocked. Writes land through atomic-write, so a reader
        // sees either the old file or the new one and never a partial one;
        // taking the path lock here would make a read wait behind a write for
        // no gain in what it can observe.
        const content = await readFile(args.filePath, 'utf-8');
        const parsed = createReader(resolved.format).parseRequest(content);
        const view = toRequestView(parsed, resolved.format, args.filePath);

        // A warning goes in its own block rather than being joined onto the
        // JSON: this tool's whole output is a document a caller parses, and
        // prefixing prose to it would break every reader to tell one of them
        // about a filename.
        return {
          content: [
            { type: 'text', text: JSON.stringify(view, null, 2) },
            ...resolved.warnings.map((warning) => ({ type: 'text' as const, text: warning })),
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Error reading request: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}
