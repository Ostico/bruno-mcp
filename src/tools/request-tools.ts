/**
 * MCP tool registrations: request tools.
 *
 * Moved out of server.ts unchanged apart from `this.` becoming `ctx.`.
 */

import { z } from 'zod';
import path from 'path';
import { readFile, unlink } from 'node:fs/promises';
import { createReader } from '../bruno/format-factory.js';
import { detectFormat, findCollectionRoot, findCollectionRootFromDirectory } from '../bruno/format-detector.js';
import { toRequestView } from '../bruno/request-view.js';
import { moveRequestFile } from '../bruno/request-move.js';
import { validateToolPath, resolveRequestFile } from './tool-path.js';
import { collectionDialectWarnings } from '../bruno/request-extensions.js';
import { declaredFormat } from '../bruno/request-discovery.js';
import { withPathLock } from '../bruno/path-mutex.js';
import type { ToolContext } from './context.js';

export function registerMoveRequestTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'move_request',
    {
      title: 'Move Request',
      description: 'Relocate a request file to another folder, or to another collection entirely. Pass copy:true to ' +
        'duplicate it instead of moving it. The bytes are moved verbatim, nothing is parsed and rewritten, ' +
        'so seq arrives unchanged and may tie with a request already there; that is reported, and Bruno ' +
        'breaks such a tie by filename. The file keeps its name: use write_request with filename to rename ' +
        'it. The new path comes back in the response.',
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
      title: 'Delete Requests',
      description: 'Permanently delete request files from a Bruno collection. One confirm covers the '
        + 'whole list. Each file is unlinked and cannot be recovered through this server. Only '
        + '.yml/.bru files inside a detected collection can be deleted. Every path is checked '
        + 'before the first unlink, so one unusable path deletes nothing. The result names each '
        + "file's outcome. To clear a script and keep the request, use remove_script.",
      inputSchema: {
        filePaths: z.array(z.string().min(1, 'File path is required'))
          .min(1, 'At least one file path is required')
          .describe('Absolute paths to the .yml or .bru request files to delete, from '
            + 'list_requests or get_collection_stats. A one-element list deletes one request.'),
        confirm: z.literal(true).describe('Must be true. Every file in filePaths is '
          + 'deleted permanently.')
      }
    },
    async (args) => {
      try {
        // Re-checked here, not only in the schema: deletion is irreversible
        // and the handler must not depend on upstream validation. The count is
        // in the refusal because one confirm now covers a whole list, and a
        // caller who meant to delete one request has to be able to see from the
        // refusal that this call would have deleted more.
        if (args.confirm !== true) {
          return {
            content: [{
              type: 'text',
              text: `Refusing to delete ${args.filePaths.length} `
                + `file${args.filePaths.length === 1 ? '' : 's'}: confirm must be true.`,
            }],
            isError: true,
          };
        }

        // Every path is resolved before the first unlink. A batch whose second
        // path is unusable deletes nothing: with an irreversible operation, a
        // half-done call is worse than a refused one, and the caller can fix
        // the list and send it again.
        const targets: { filePath: string; format: string }[] = [];
        const seen = new Map<string, number>();
        for (const [index, filePath] of args.filePaths.entries()) {
          const previous = seen.get(filePath);
          if (previous !== undefined) {
            return {
              content: [{
                type: 'text',
                text: `filePaths[${index}] is named twice: "${filePath}" is already `
                  + `filePaths[${previous}]. Remove the repeat — the second delete would fail on `
                  + 'a file this same call had removed, and be reported as a failure.',
              }],
              isError: true,
            };
          }
          seen.set(filePath, index);

          const resolved = await resolveRequestFile(filePath, `filePaths[${index}]`);
          if (!resolved.ok) {
            return {
              content: [{ type: 'text', text: `${resolved.message} (filePaths[${index}]: ${filePath})` }],
              isError: true,
            };
          }
          targets.push({ filePath, format: resolved.format });
        }

        const outcomes: string[] = [];
        let failed = 0;
        for (const [index, target] of targets.entries()) {
          const label = `${index + 1}. ${path.basename(target.filePath)}`;
          try {
            // Same per-file lock add_test_script and remove_script take, and it
            // belongs inside this loop rather than around it: one lock taken for
            // the batch would hold the wrong key for every file after the first.
            // Without it, a script injection that had already read this file
            // could write it back after the unlink, restoring a request this
            // tool had just reported as permanently deleted. Taking the lock
            // orders the two: either the injection finishes and is then deleted,
            // or the delete wins and the injection's read fails with ENOENT.
            await withPathLock(target.filePath, () => unlink(target.filePath));
            outcomes.push(`${label}: deleted (${target.format} format)`);
          } catch (error) {
            // Per file, and the rest of the list still runs: one unreadable
            // file is not a reason to leave the others behind.
            failed += 1;
            outcomes.push(
              `${label}: FAILED — ${error instanceof Error ? error.message : 'Unknown error'}`,
            );
          }
        }

        const total = targets.length;
        const summary = failed === 0
          ? `Deleted ${total === 1 ? '1 request' : `all ${total} requests`}.`
          : `Deleted ${total - failed} of ${total} requests; ${failed} failed.`;

        return {
          content: [{ type: 'text', text: [summary, ...outcomes].join('\n') }],
          ...(failed > 0 ? { isError: true as const } : {}),
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Error deleting requests: ${error instanceof Error ? error.message : 'Unknown error'}`
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
      description: 'Read a single request file back as structured JSON: method, url, headers, query and path params, body, auth mode, scripts, assertions, vars, settings and docs. Both .bru and .yml return the same shape, so the on-disk format stays invisible. Use this before write_request to see current state, and after it to confirm what was written. A websocket or grpc request also carries its stored messages in full — title, content, and for a websocket the type and whether the runner will send it — under websocket.messages or grpc.messages, keyed as write_request accepts them. A "notes" array reports anything the file declares that the runner will not act on.',
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
