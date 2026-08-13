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
  UpdateRequestInput,
  HttpMethod,
  AuthType,
} from '../bruno/types.js';
import { createReader } from '../bruno/format-factory.js';
import { toRequestView } from '../bruno/request-view.js';
import { validateToolPath, resolveRequestFile } from './tool-path.js';
import { collectionDialectWarnings } from '../bruno/request-extensions.js';
import { declaredFormat } from '../bruno/request-discovery.js';
import { withPathLock } from '../bruno/path-mutex.js';
import { topologicalSort } from './topological-sort.js';
import { inlineScriptsSchema, assertionEntrySchema, requestBodySchema, requestVarsSchema, requestSettingsSchema, websocketAuthoringSchema, grpcAuthoringSchema } from './schemas.js';
import type { ToolContext } from './context.js';

export function registerCreateRequestTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'create_request',
    {
      title: 'Create Bruno Request',
      description: 'Generate request files for API testing (supports .bru and .yml formats). Authors HTTP requests by default, WebSocket requests with kind "websocket" (url plus websocket.messages) and gRPC requests with kind "grpc" (url plus grpc.method, grpc.protoPath and grpc.messages); neither takes an HTTP method or a body. Supports multipart/form-data with file uploads and per-part contentType (body.type "form-data" with formData entries of type "file"), and inline scripts (pre-request/post-response/tests) so no separate add_test_script call is needed. Scripts run as async functions: top-level await works, and bru.sleep(ms)/setTimeout/setInterval are available, spending the script timeout (settings.timeout, default 5000ms) — raise it via the settings argument.',
      inputSchema: {
        collectionPath: z.string().min(1, 'Collection path is required').describe('Absolute path to existing collection directory.'),
        name: z.string().min(1, 'Request name is required'),
        kind: z.enum(['http', 'websocket', 'grpc']).optional()
          .describe('Transport. Defaults to "http". "websocket" and "grpc" take no method and no body; their payloads are websocket.messages and grpc.messages.'),
        method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']).optional()
          .describe('Required for kind "http", refused for "websocket" and "grpc", which have no HTTP method. A gRPC request names its RPC method in grpc.method.'),
        url: z.string().min(1, 'URL is required'),
        headers: z.record(z.string()).optional(),
        body: requestBodySchema,
        auth: z.object({
          type: z.enum(['none', 'bearer', 'basic', 'oauth2', 'api-key', 'digest', 'inherit'])
            .describe('Auth mode. "inherit" defers to the folder or collection auth block and takes no config; pass {} for it.'),
          config: z.record(z.string())
        }).optional(),
        query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
        pathParams: z.record(z.union([z.string(), z.number(), z.boolean()])).optional()
          .describe('Values for :name segments in the URL, e.g. { id: "42" } for /users/:id.'),
        assert: z.array(assertionEntrySchema).optional()
          .describe('Declared assertions, evaluated on every run without needing a test() block.'),
        vars: requestVarsSchema,
        settings: requestSettingsSchema,
        websocket: websocketAuthoringSchema,
        grpc: grpcAuthoringSchema,
        folder: z.string().optional(),
        sequence: z.number().optional(),
        scripts: inlineScriptsSchema
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

        const input: CreateRequestInput = {
          collectionPath: args.collectionPath,
          name: args.name,
          // The tool surface spells the transport out; the model uses the token
          // both dialects' parsers resolve to. Mapped here so the wire name and
          // the on-disk kind can differ without either leaking into the other.
          kind: args.kind === 'websocket' ? 'ws' : args.kind,
          grpc: args.grpc,
          method: args.method as HttpMethod | undefined,
          url: args.url,
          headers: args.headers,
          body: args.body as CreateRequestInput['body'],
          auth: args.auth ? {
            type: args.auth.type as AuthType,
            config: args.auth.config
          } : undefined,
          query: args.query,
          pathParams: args.pathParams,
          assert: args.assert,
          vars: args.vars,
          settings: args.settings,
          websocket: args.websocket,
          folder: args.folder,
          sequence: args.sequence,
          scripts: args.scripts as Record<string, string> | undefined
        };

        const result = await ctx.requestBuilder.createRequest(input);

        if (result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `✅ Request "${args.name}" created successfully at: ${result.path}`
              }
            ]
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Failed to create request: ${result.error}`
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
              text: `❌ Error creating request: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function registerModifyRequestTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'modify_request',
    {
      title: 'Modify Request',
      description: 'Update an existing Bruno request file with partial-merge semantics. Only provided fields are updated; all other fields are preserved. Supports multipart/form-data with file uploads and per-part contentType. Inline scripts REPLACE the existing script of the same type by default (idempotent — repeated calls do not accumulate duplicate blocks); pass scriptMode:"append" to concatenate instead. Use remove_script to clear a script entirely. RENAMING: name and filename are independent, as they are in Bruno itself — name changes the request\'s name inside the file and filename moves the file. Pass both to keep them in step, and read the new path back from the response.',
      inputSchema: {
        filePath: z.string().min(1, 'File path is required').describe('Absolute path to the .yml or .bru request file to modify. Get from list_requests or get_collection_stats.'),
        name: z.string().optional()
          .describe('The request\'s name inside the file. Does NOT rename the file — pass filename for that.'),
        filename: z.string().optional()
          .describe('Renames the file, keeping it in its own folder. Basename only, no path '
            + 'separators. The extension is optional and must match the collection\'s format if '
            + 'given, since a collection carries one format only. Refused if another file of that '
            + 'name already exists. The new path comes back in the response; use it as filePath '
            + 'from then on, because the old one is gone.'),
        method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']).optional(),
        url: z.string().optional(),
        headers: z.record(z.string()).optional(),
        body: requestBodySchema,
        auth: z.object({
          type: z.enum(['none', 'bearer', 'basic', 'oauth2', 'api-key', 'digest', 'inherit'])
            .describe('Auth mode. "inherit" defers to the folder or collection auth block and takes no config; pass {} for it.'),
          config: z.record(z.string())
        }).optional(),
        query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
        pathParams: z.record(z.union([z.string(), z.number(), z.boolean()])).optional()
          .describe('Replaces the declared path parameters; query parameters are left alone.'),
        assert: z.array(assertionEntrySchema).optional()
          .describe('Replaces the whole assert block. Omit to leave existing assertions untouched.'),
        vars: requestVarsSchema,
        settings: requestSettingsSchema,
        websocket: websocketAuthoringSchema,
        grpc: grpcAuthoringSchema,
        scripts: inlineScriptsSchema,
        scriptMode: z.enum(['replace', 'append']).optional().default('replace').describe(
          'How to write the scripts field. "replace" (default) overwrites the existing script ' +
          'of each provided type, so calling modify_request repeatedly is idempotent. "append" ' +
          'concatenates onto the existing script, which accumulates blocks across calls. ' +
          'Each script type has its own slot in both .bru and .yml, so replacing one leaves ' +
          'the others untouched. One exception on .yml: supplying post-response and tests ' +
          'together in a single call still merges both into the after-response slot, so ' +
          'write the tests script in its own call to keep it in the tests slot.',
        )
      }
    },
    async (args) => {
      try {
        // 1. Path validation (traversal + null bytes)
        const pathCheck = validateToolPath(args.filePath);
        if (!pathCheck.valid) {
          return {
            content: [{ type: 'text', text: `Invalid filePath: ${pathCheck.reason}` }],
            isError: true,
          };
        }

        // 2. Extension, collection root and dialect, in one place. This was
        // three inlined blocks duplicating `resolveRequestFile` — including its
        // dialect check, which is why the same message existed in three files
        // and had to be corrected in all of them.
        const resolvedFile = await resolveRequestFile(args.filePath, 'filePath');
        if (!resolvedFile.ok) {
          return {
            content: [{ type: 'text', text: resolvedFile.message }],
            isError: true,
          };
        }

        // 5. Build partial update input from provided fields
        const updates: UpdateRequestInput = {};
        if (args.name !== undefined) updates.name = args.name;
        if (args.filename !== undefined) updates.filename = args.filename;
        if (args.method !== undefined) updates.method = args.method as HttpMethod;
        if (args.url !== undefined) updates.url = args.url;
        if (args.headers !== undefined) updates.headers = args.headers;
        if (args.body !== undefined) {
          updates.body = args.body as CreateRequestInput['body'];
        }
        if (args.auth !== undefined) {
          updates.auth = {
            type: args.auth.type as AuthType,
            config: args.auth.config,
          };
        }
        if (args.query !== undefined) updates.query = args.query;
        if (args.pathParams !== undefined) updates.pathParams = args.pathParams;
        if (args.assert !== undefined) updates.assert = args.assert;
        if (args.vars !== undefined) updates.vars = args.vars;
        if (args.settings !== undefined) updates.settings = args.settings;
        if (args.websocket !== undefined) updates.websocket = args.websocket;
        if (args.grpc !== undefined) updates.grpc = args.grpc;
        if (args.scripts !== undefined) {
          updates.scripts = args.scripts as Record<string, string>;
          // Default explicitly: the zod default only applies when the SDK
          // validates input, not when the handler is invoked directly.
          updates.scriptMode = args.scriptMode ?? 'replace';
        }

        // 6. Call updateRequest with partial merge
        const result = await ctx.requestBuilder.updateRequest(args.filePath, updates);

        if (result.success) {
          // The dialect warning rides on success rather than blocking it: the
          // file was modified, and the caller still needs to know Bruno will not
          // see it. Appended to the message the caller already reads, because a
          // second content block is easy to drop.
          // The path is read back rather than rebuilt from `filename`, because
          // the builder normalises the extension and may have left the file
          // where it was. Both halves of the test are needed: a caller that
          // asked for no rename cannot have had one, and a case-only rename
          // that resolved to the same path did not move anything.
          const newPath = result.path ?? args.filePath;
          return {
            content: [
              {
                type: 'text',
                text: [
                  args.filename === undefined || newPath === args.filePath
                    ? `Successfully modified request "${path.basename(args.filePath)}"`
                    : `Successfully modified request "${path.basename(args.filePath)}" and `
                      + `renamed the file to "${path.basename(newPath)}". It now lives at `
                      + `${newPath}; pass that as filePath from now on, because the old path is gone.`,
                  ...resolvedFile.warnings,
                ].join('\n\n')
              }
            ]
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: `Failed to modify request: ${result.error}`
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
              text: `Error modifying request: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
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
            // Same seven modes as create_request and update_request. This enum
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
      description: 'Read a single request file back as structured JSON: method, url, headers, query and path params, body, auth mode, scripts, assertions, vars, settings and docs. Works on both .bru and .yml and returns the same shape for each, so the on-disk format stays invisible. Use this before modify_request to see current state, and after create_request to confirm what was written. A "notes" array reports anything the file declares that the runner will not act on.',
      inputSchema: {
        filePath: z.string().min(1, 'File path is required')
          .describe('Absolute path to the .bru or .yml request file. Use the path returned by create_request or list_requests rather than rebuilding it: request filenames are lowercased on write.'),
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
