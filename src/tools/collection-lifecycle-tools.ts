/**
 * MCP tool registrations: taking a collection back out again.
 *
 * The counterpart of create_collection, in its own file because the two ends of a
 * collection's life share nothing but the workspace resolver: nothing in the
 * toolset could remove a collection or a registry entry, which made a mistyped
 * path permanent from inside the server and left a registry filling up with
 * entries pointing at directories that no longer exist.
 */

import { z } from 'zod';
import { basename, join } from 'path';
import { promises as fs } from 'fs';
import { validateToolPath } from './tool-path.js';
import { createWorkspaceResolver } from '../bruno/workspace.js';
import { unregisterCollectionFromWorkspace } from '../bruno/workspace-unregistrar.js';
import { clearFormatCache } from '../bruno/format-detector.js';
import type { ToolContext } from './context.js';

/** A refusal for the first path argument that fails validation, or undefined. */
function pathRefusal(args: { collectionPath: string; workspacePath?: string }):
{ content: { type: 'text'; text: string }[]; isError: true } | undefined {
  const candidates: [string, string | undefined][] = [
    ['collectionPath', args.collectionPath],
    ['workspacePath', args.workspacePath],
  ];

  for (const [label, value] of candidates) {
    if (value === undefined) continue;
    const check = validateToolPath(value);
    if (!check.valid) {
      return {
        content: [{ type: 'text', text: `Invalid ${label}: ${check.reason}` }],
        isError: true,
      };
    }
  }
  return undefined;
}

/**
 * The marker file that makes a directory a collection root, or undefined.
 *
 * This is the authorization boundary for removing a directory tree: a Bruno
 * collection announces itself with one of these two files, and a path without one
 * is some other directory that a caller arrived at by mistake.
 */
async function collectionMarker(collectionPath: string): Promise<string | undefined> {
  for (const marker of ['opencollection.yml', 'bruno.json']) {
    try {
      await fs.access(join(collectionPath, marker));
      return marker;
    } catch {
      // Not this one.
    }
  }
  return undefined;
}

/** What happened to the registry entry, in one sentence, whatever happened. */
async function unregistrationNote(workspacePath: string, collectionPath: string): Promise<string> {
  let result;
  try {
    result = await unregisterCollectionFromWorkspace(workspacePath, collectionPath);
  } catch (reason) {
    return `The workspace registry at ${workspacePath} could not be written: `
      + `${reason instanceof Error ? reason.message : String(reason)}. `
      + 'Its entry is still listed, and now points at a directory that is gone.';
  }

  switch (result.outcome) {
    case 'removed':
      return `Removed its entry${result.name ? ` ("${result.name}")` : ''} from ${result.workspacePath}.`;
    case 'not-listed':
      return `No entry in ${result.workspacePath} pointed at it, so nothing was removed there.`;
    case 'skipped':
      return `Its entry in ${result.workspacePath} was left alone: ${result.reason}.`;
  }
}

export function registerUnregisterCollectionTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'unregister_collection',
    {
      title: 'Unregister Collection',
      description: 'Remove a collection from the workspace registry, leaving every file on disk '
        + 'untouched. list_collections reads that registry, so this is how an entry stops being '
        + 'listed — including a stale entry whose directory is gone, which is what accumulates when '
        + 'collections are created in temporary directories. To delete the collection itself, use '
        + 'delete_collection.',
      inputSchema: {
        collectionPath: z.string().min(1, 'Collection path is required').describe(
          'Absolute path of the collection as it is listed. Use the path from list_collections: '
          + 'matching is by path, not by name, because two entries are allowed to share a name.',
        ),
        workspacePath: z.string().optional().describe(
          'Absolute path of the workspace.yml to remove the entry from. Defaults to the same one '
          + 'list_collections reads: BRUNO_WORKSPACE_PATH, or the Bruno app\'s workspace for this '
          + 'platform.',
        ),
      }
    },
    async (args) => {
      try {
        const refusal = pathRefusal(args);
        if (refusal) return refusal;

        const workspacePath = createWorkspaceResolver().resolveWorkspacePath(args.workspacePath);
        const result = await unregisterCollectionFromWorkspace(workspacePath, args.collectionPath);

        switch (result.outcome) {
          case 'removed':
            return {
              content: [{
                type: 'text',
                text: `Unregistered "${result.name || args.collectionPath}" from ${result.workspacePath}. `
                  + 'Its files are untouched; list_collections will no longer show it.',
              }],
            };
          case 'not-listed':
            return {
              content: [{
                type: 'text',
                text: `Nothing to remove: no entry in ${result.workspacePath} points at `
                  + `${args.collectionPath}.`,
              }],
            };
          case 'skipped':
            // Reported as an error, unlike create_collection's registry failures:
            // editing the registry is the whole of what this call does, so there
            // is no success left for it to be a caveat on.
            return {
              content: [{
                type: 'text',
                text: `Could not unregister it from ${result.workspacePath}: ${result.reason}.`,
              }],
              isError: true,
            };
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error unregistering collection: ${error instanceof Error ? error.message : 'Unknown error'}`,
          }],
          isError: true,
        };
      }
    }
  );
}

export function registerDeleteCollectionTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'delete_collection',
    {
      title: 'Delete Collection',
      description: 'Permanently delete a Bruno collection: the collection directory and everything '
        + 'inside it is removed from disk, and its workspace registry entry is removed with it. '
        + 'Nothing here can be recovered through this server. Only a directory that is itself a '
        + 'collection root — one holding opencollection.yml or bruno.json — can be deleted, so this '
        + 'cannot be pointed at an arbitrary directory. To keep the files and only stop the '
        + 'collection being listed, use unregister_collection instead.',
      inputSchema: {
        collectionPath: z.string().min(1, 'Collection path is required').describe(
          'Absolute path of the collection directory to delete. Use the path from list_collections.',
        ),
        confirm: z.literal(true).describe(
          'Must be true. Explicit acknowledgement that the directory and every request in it are '
          + 'deleted permanently.',
        ),
        workspacePath: z.string().optional().describe(
          'Absolute path of the workspace.yml holding its entry. Defaults to the same one '
          + 'list_collections reads: BRUNO_WORKSPACE_PATH, or the Bruno app\'s workspace for this '
          + 'platform.',
        ),
      }
    },
    async (args) => {
      try {
        // Re-checked here, not only in the schema: this removes a directory tree,
        // and the handler must not depend on upstream validation.
        if (args.confirm !== true) {
          return {
            content: [{ type: 'text', text: 'Refusing to delete: confirm must be true.' }],
            isError: true,
          };
        }

        const refusal = pathRefusal(args);
        if (refusal) return refusal;

        const marker = await collectionMarker(args.collectionPath);
        if (marker === undefined) {
          return {
            content: [{
              type: 'text',
              text: `Refusing to delete ${args.collectionPath}: it holds neither opencollection.yml `
                + 'nor bruno.json, so it is not a collection root. If it is a directory that merely '
                + 'contains collections, delete each collection by its own path.',
            }],
            isError: true,
          };
        }

        // The directory first, then the registry: the files going is what the
        // caller asked for, and an entry left behind is both reported below and
        // removable afterwards with unregister_collection.
        await fs.rm(args.collectionPath, { recursive: true, force: true });
        // Format detection is memoised per collection path, and a path that has
        // just been deleted must not answer from that memo if something creates a
        // collection there again.
        clearFormatCache();

        const workspacePath = createWorkspaceResolver().resolveWorkspacePath(args.workspacePath);
        return {
          content: [{
            type: 'text',
            text: `Deleted collection ${basename(args.collectionPath)} (${marker}) and everything `
              + `in ${args.collectionPath}.\n`
              + `${await unregistrationNote(workspacePath, args.collectionPath)}`,
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error deleting collection: ${error instanceof Error ? error.message : 'Unknown error'}`,
          }],
          isError: true,
        };
      }
    }
  );
}
