/**
 * The merged write path: one tool that creates a request or edits an existing
 * one, chosen by which locator the caller passed.
 *
 * Two tools for one job cost twice, because JSON Schema `$ref` is document-local:
 * the nine byte-identical sub-schemas the two write tools shared could not be
 * sent once between them, and the whole surface sits in the cached prefix of
 * every request a client makes. One tool sends them once.
 *
 * The mode is inferred rather than passed. A `mode` field would only restate
 * what the locator already says, and a caller who set it inconsistently with the
 * locator would have to be refused anyway.
 */

import { z } from 'zod';
import path from 'path';

import {
  CreateRequestInput,
  UpdateRequestInput,
  HttpMethod,
  AuthType,
} from '../bruno/types.js';
import { validateToolPath, resolveRequestFile } from './tool-path.js';
import { topologicalSort } from './topological-sort.js';
import { sanitizeRequestFileName } from '../bruno/request-filename.js';
import {
  inlineScriptsSchema,
  assertionEntrySchema,
  requestBodySchema,
  requestVarsSchema,
  requestSettingsSchema,
  websocketAuthoringSchema,
  grpcAuthoringSchema,
} from './schemas.js';
import type { ToolContext } from './context.js';

/** What a handler hands back: one text block, and whether it is a refusal. */
interface ToolResult {
  /** The SDK's result type is open; without this an implementation cannot satisfy it. */
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: true;
}

/**
 * Everything the tool accepts, beyond the locators the resolver reads.
 *
 * Spelled out rather than inferred from the registration so the two write paths
 * take a named type: a handler split into functions cannot borrow the inline
 * type the SDK infers for its callback.
 */
interface WriteRequestArgs {
  name?: string;
  filename?: string;
  kind?: 'http' | 'websocket' | 'grpc';
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  url?: string;
  headers?: Record<string, string>;
  body?: z.infer<typeof requestBodySchema>;
  auth?: { type: string; config: Record<string, string> };
  query?: Record<string, string | number | boolean>;
  pathParams?: Record<string, string | number | boolean>;
  assert?: z.infer<typeof assertionEntrySchema>[];
  vars?: z.infer<typeof requestVarsSchema>;
  settings?: z.infer<typeof requestSettingsSchema>;
  websocket?: z.infer<typeof websocketAuthoringSchema>;
  grpc?: z.infer<typeof grpcAuthoringSchema>;
  folder?: string;
  sequence?: number;
  scripts?: z.infer<typeof inlineScriptsSchema>;
  scriptMode?: 'replace' | 'append';
}

/** Fields whose presence is only meaningful in one of the two modes. */
const CREATE_ONLY_FIELDS = ['kind', 'folder', 'sequence'] as const;
const EDIT_ONLY_FIELDS = ['filename', 'scriptMode'] as const;

export interface WriteRequestLocators {
  collectionPath?: string;
  name?: string;
  filePath?: string;
  filename?: string;
  kind?: string;
  folder?: string;
  sequence?: number;
  scriptMode?: string;
}

/** Values a batch supplies once for the whole call rather than per item. */
export interface AmbientWriteContext {
  collectionPath?: string;
}

export type WriteTarget =
  | { mode: 'create'; collectionPath: string; name: string }
  | { mode: 'edit'; filePath: string }
  | { error: string };

/**
 * A key the caller wrote, as opposed to one that merely exists.
 *
 * The SDK hands a handler an object carrying every optional key as `undefined`,
 * so a presence test on the key alone would refuse every real call. A truthiness
 * test would be wrong in the other direction: `sequence: 0` and `filename: ''`
 * are values the caller passed, and silently ignoring them is how someone ends
 * up believing a field took effect.
 */
function wasPassed(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
}

function listed(fields: readonly string[]): string {
  return fields.join(', ');
}

/**
 * Decide what a write call is addressing, or why it cannot be addressed.
 *
 * `ambient` carries what a batch stated once for the whole call. It is
 * deliberately not treated as a locator the caller wrote in this item: an
 * ambient collection alongside an item's own `filePath` is the ordinary shape of
 * a batch that edits one request and creates another, and refusing that would
 * make batching useless for exactly the runs that need it most.
 */
export function resolveWriteTarget(
  input: WriteRequestLocators,
  ambient?: AmbientWriteContext,
): WriteTarget {
  const fields = input as Record<string, unknown>;
  const hasFilePath = wasPassed(fields, 'filePath');
  const hasOwnCollectionPath = wasPassed(fields, 'collectionPath');

  if (hasFilePath && hasOwnCollectionPath) {
    return {
      error: 'Pass filePath to edit an existing request, or collectionPath and name to'
        + ' create one. This call passes both filePath and collectionPath, and which one'
        + ' was meant is not something to guess at.',
    };
  }

  if (hasFilePath) {
    const misplaced = CREATE_ONLY_FIELDS.filter((field) => wasPassed(fields, field));
    if (misplaced.length > 0) {
      return {
        error: `${listed(misplaced)} can only be set when creating a request, and this call`
          + ` is an edit of ${String(input.filePath)}. Remove it, or address the request by`
          + ' collectionPath and name to create a new one.',
      };
    }
    return { mode: 'edit', filePath: String(input.filePath) };
  }

  const collectionPath = hasOwnCollectionPath ? input.collectionPath : ambient?.collectionPath;
  if (collectionPath === undefined) {
    return {
      error: 'Pass filePath to edit an existing request, or collectionPath and name to'
        + ' create one. This call passes neither.',
    };
  }

  if (!wasPassed(fields, 'name')) {
    return { error: `Creating a request in ${collectionPath} needs a name.` };
  }

  const misplaced = EDIT_ONLY_FIELDS.filter((field) => wasPassed(fields, field));
  if (misplaced.length > 0) {
    return {
      error: `${listed(misplaced)} can only be set when editing an existing request, and`
        + ` this call is a create in ${collectionPath}. Remove it, or address an existing`
        + ' request by filePath.',
    };
  }

  return { mode: 'create', collectionPath, name: String(input.name) };
}

const collectionPathField = z.string().min(1, 'Collection path is required')
  .describe('Absolute path to existing collection directory. Passing it, with name, creates '
    + 'a new request; pass filePath instead to change an existing one.');

const nameField = z.string().min(1, 'Request name is required')
  .describe('The request\'s name. Required when creating. On an existing request this changes '
    + 'the name inside the file and does NOT rename the file — pass filename for that.');

const filePathField = z.string().min(1, 'File path is required')
  .describe('Absolute path to the .yml or .bru request file to change. Get from list_requests '
    + 'or get_collection_stats. Only provided fields are updated; every other field is kept.');

const filenameField = z.string()
  .describe('Renames the file, keeping it in its own folder. Basename only, no path '
    + 'separators. The extension is optional and must match the collection\'s format if '
    + 'given, since a collection carries one format only. Refused if another file of that '
    + 'name already exists. The new path comes back in the response; use it as filePath '
    + 'from then on, because the old one is gone. Only valid on an existing request.');

const kindField = z.enum(['http', 'websocket', 'grpc'])
  .describe('Transport. Defaults to "http". "websocket" and "grpc" take no method and no '
    + 'body; their payloads are websocket.messages and grpc.messages. Set only when creating: '
    + 'an existing request cannot change transport.');

const methodField = z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])
  .describe('Required for kind "http", refused for "websocket" and "grpc", which have no '
    + 'HTTP method. A gRPC request names its RPC method in grpc.method.');

const urlField = z.string().min(1, 'URL is required')
  .describe('Required when creating a request. On an existing one it replaces the URL.');

const headersField = z.record(z.string());

const authField = z.object({
  type: z.enum(['none', 'bearer', 'basic', 'oauth2', 'api-key', 'digest', 'inherit'])
    .describe('Auth mode. "inherit" defers to the folder or collection auth block and takes no config; pass {} for it.'),
  config: z.record(z.string())
});

const queryField = z.record(z.union([z.string(), z.number(), z.boolean()]));

const pathParamsField = z.record(z.union([z.string(), z.number(), z.boolean()]))
  .describe('Values for :name segments in the URL, e.g. { id: "42" } for /users/:id. On an '
    + 'existing request this replaces the declared path parameters; query parameters are left alone.');

const assertField = z.array(assertionEntrySchema)
  .describe('Declared assertions, evaluated on every run without needing a test() block. On '
    + 'an existing request this replaces the whole assert block; omit to leave existing '
    + 'assertions untouched.');

const folderField = z.string()
  .describe('Subfolder within the collection to create the request in. Only valid when creating.');

const sequenceField = z.number()
  .describe('Run order within the folder. Defaults to after the folder\'s other requests. '
    + 'Only valid when creating.');

const scriptModeField = z.enum(['replace', 'append']).describe(
  'How to write the scripts field. "replace" (the default) overwrites the existing script ' +
  'of each provided type, so repeating the same call is idempotent. "append" ' +
  'concatenates onto the existing script, which accumulates blocks across calls. ' +
  'Each script type has its own slot in both .bru and .yml, so replacing one leaves ' +
  'the others untouched. One exception on .yml: supplying post-response and tests ' +
  'together in a single call still merges both into the after-response slot, so ' +
  'write the tests script in its own call to keep it in the tests slot. Only valid on an ' +
  'existing request. Note there is no zod default: a default would be filled in on every ' +
  'call, including a create, where the field has no meaning.',
);

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Every field that describes one request, as one object.
 *
 * Shared by value, not by copy, between the top-level shape and the batch item
 * shape — and shared as the *already-optional* instances, which is what makes
 * the batch cheap. `zod-to-json-schema` emits a bare `$ref` for a second
 * occurrence of an identical instance, but re-emits the `description` alongside
 * the ref when only the inner type is shared. Wrapping once here is the
 * difference between an array that costs a few hundred characters and one that
 * costs the whole field prose a second time.
 */
const writeFields = {
  name: nameField.optional(),
  filePath: filePathField.optional(),
  filename: filenameField.optional(),
  kind: kindField.optional(),
  method: methodField.optional(),
  url: urlField.optional(),
  headers: headersField.optional(),
  body: requestBodySchema,
  auth: authField.optional(),
  query: queryField.optional(),
  pathParams: pathParamsField.optional(),
  assert: assertField.optional(),
  vars: requestVarsSchema,
  settings: requestSettingsSchema,
  websocket: websocketAuthoringSchema,
  grpc: grpcAuthoringSchema,
  folder: folderField.optional(),
  sequence: sequenceField.optional(),
  scripts: inlineScriptsSchema,
  scriptMode: scriptModeField.optional(),
};

/** The per-request fields, for the refusal when a call is both shapes at once. */
const WRITE_FIELD_NAMES = Object.keys(writeFields);

const dependenciesField = z.array(z.string())
  .describe('Names of other items in this batch that must be written before this one. '
    + 'Write order is what this controls, and since an unnumbered request is placed after '
    + "the folder's existing ones, the run order follows from it. Only meaningful inside "
    + 'requests.');

const requestsField = z.array(z.object({ ...writeFields, dependencies: dependenciesField.optional() }))
  .describe('Write several requests in one call. Each item takes the same fields as a single '
    + 'write, and means the same thing: name creates one in the collection named at the top '
    + 'level, filePath edits an existing one. collectionPath belongs at the top level and is '
    + 'named once for the whole batch. Every item is validated before anything is written, so '
    + 'a refusal leaves no partial state; a write that fails after that is reported against '
    + 'its own item and the remaining items still run. The response lists every item in the '
    + 'order it was passed, with the path written or the reason it failed.');

/** What one item of a batch resolved to, before anything is written. */
type ResolvedItem = {
  index: number;
  label: string;
  target: Exclude<WriteTarget, { error: string }>;
  args: WriteRequestArgs;
  dependencies: string[];
};

function createInputFrom(
  collectionPath: string,
  name: string,
  url: string,
  args: WriteRequestArgs,
): CreateRequestInput {
  return {
    collectionPath,
    name,
    // The tool surface spells the transport out; the model uses the token
    // both dialects' parsers resolve to. Mapped here so the wire name and
    // the on-disk kind can differ without either leaking into the other.
    kind: args.kind === 'websocket' ? 'ws' : args.kind,
    grpc: args.grpc,
    method: args.method as HttpMethod | undefined,
    url,
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
}

/** Only the fields the call actually passed: an absent field is not an empty one. */
function updatesFrom(args: WriteRequestArgs): UpdateRequestInput {
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
    // Default explicitly: the field carries no zod default, because a default
    // would also be filled in on a create, where it has no meaning.
    updates.scriptMode = args.scriptMode ?? 'replace';
  }
  return updates;
}

/**
 * The create path.
 *
 * `url` is required here rather than in the schema because the schema is shared
 * with the edit path, where an omitted URL means "leave it alone". A zod-level
 * requirement would have to be a cross-key refinement, which collapses the whole
 * object into an opaque effect in the JSON Schema the caller is sent.
 */
async function createRequest(
  ctx: ToolContext,
  collectionPath: string,
  name: string,
  args: WriteRequestArgs,
): Promise<ToolResult> {
  try {
    const pathCheck = validateToolPath(collectionPath);
    if (!pathCheck.valid) {
      return errorResult(`Invalid collectionPath: ${pathCheck.reason}`);
    }

    if (args.url === undefined) {
      return errorResult(missingUrlMessage(name));
    }

    const result = await ctx.requestBuilder.createRequest(
      createInputFrom(collectionPath, name, args.url, args),
    );

    if (result.success) {
      return {
        content: [
          {
            type: 'text',
            text: `✅ Request "${name}" created successfully at: ${result.path}`
          }
        ]
      };
    }
    return errorResult(`❌ Failed to create request: ${result.error}`);
  } catch (error) {
    return errorResult(
      `❌ Error creating request: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

function missingUrlMessage(name: string): string {
  return `Creating the request "${name}" needs a url. Pass one, or address an existing`
    + ' request by filePath to change it.';
}

/** The edit path: a partial merge, so an absent field is not an empty one. */
async function editRequest(
  ctx: ToolContext,
  filePath: string,
  args: WriteRequestArgs,
): Promise<ToolResult> {
  try {
    // 1. Path validation (traversal + null bytes)
    const pathCheck = validateToolPath(filePath);
    if (!pathCheck.valid) {
      return errorResult(`Invalid filePath: ${pathCheck.reason}`);
    }

    // 2. Extension, collection root and dialect, in one place. This was
    // three inlined blocks duplicating `resolveRequestFile` — including its
    // dialect check, which is why the same message existed in three files
    // and had to be corrected in all of them.
    const resolvedFile = await resolveRequestFile(filePath, 'filePath');
    if (!resolvedFile.ok) {
      return errorResult(resolvedFile.message);
    }

    const result = await ctx.requestBuilder.updateRequest(filePath, updatesFrom(args));

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
      const newPath = result.path ?? filePath;
      return {
        content: [
          {
            type: 'text',
            text: [
              args.filename === undefined || newPath === filePath
                ? `Successfully modified request "${path.basename(filePath)}"`
                : `Successfully modified request "${path.basename(filePath)}" and `
                  + `renamed the file to "${path.basename(newPath)}". It now lives at `
                  + `${newPath}; pass that as filePath from now on, because the old path is gone.`,
              ...resolvedFile.warnings,
            ].join('\n\n')
          }
        ]
      };
    }
    return errorResult(`Failed to modify request: ${result.error}`);
  } catch (error) {
    return errorResult(
      `Error modifying request: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/**
 * Resolve and validate every item, or refuse the whole batch.
 *
 * Everything that can be known without touching the filesystem is decided here,
 * before the first write: a batch that is refused has written nothing, so the
 * caller can fix the call and send it again without first working out how far it
 * got.
 */
function resolveBatch(
  items: (WriteRequestArgs & { dependencies?: string[] })[],
  collectionPath: string,
): { resolved: ResolvedItem[] } | { error: string } {
  const resolved: ResolvedItem[] = [];
  // Two key spaces, because a create and an edit are addressed differently and a
  // batch that creates "Login" and then edits login.bru is a legitimate call.
  const createTargets = new Map<string, number>();

  for (const [index, item] of items.entries()) {
    const target = resolveWriteTarget(item, { collectionPath });
    if ('error' in target) {
      return { error: `Item ${index + 1}: ${target.error}` };
    }

    const label = target.mode === 'create' ? target.name : path.basename(target.filePath);

    if (target.mode === 'create') {
      if (item.url === undefined) {
        return { error: `Item ${index + 1}: ${missingUrlMessage(target.name)}` };
      }

      // The file the writer will choose, derived the way the writer derives it.
      // The extension is irrelevant to a collision: a collection carries one
      // format, so two items landing on the same basename land on one file.
      const key = path.join(item.folder ?? '', sanitizeRequestFileName(target.name));
      const check = validateToolPath(path.resolve(collectionPath, key), collectionPath);
      if (!check.valid) {
        return {
          error: `Item ${index + 1} (${label}) would be written outside ${collectionPath}: `
            + `${check.reason}`,
        };
      }

      const clash = createTargets.get(key);
      if (clash !== undefined) {
        return {
          error: `Items ${clash + 1} and ${index + 1} both resolve to "${key}", so the second `
            + 'would replace the first. Request names that differ only in case, punctuation or '
            + 'spacing become the same file: give them names that differ, or address one of '
            + 'them by filePath.',
        };
      }
      createTargets.set(key, index);
    } else {
      const check = validateToolPath(target.filePath, collectionPath);
      if (!check.valid) {
        return {
          error: `Item ${index + 1} (${label}) is outside ${collectionPath}: ${check.reason}. `
            + 'A batch writes into the one collection it names.',
        };
      }
    }

    resolved.push({ index, label, target, args: item, dependencies: item.dependencies ?? [] });
  }

  return { resolved };
}

/** Dependency order, or input order when nothing declared a dependency. */
function orderBatch(resolved: ResolvedItem[]): { order: ResolvedItem[] } | { error: string } {
  if (!resolved.some((item) => item.dependencies.length > 0)) {
    return { order: resolved };
  }

  const byLabel = new Map(resolved.map((item) => [item.label, item]));
  const edges = resolved.flatMap((item) =>
    item.dependencies.map((from) => ({ from, to: item.label })));

  const sorted = topologicalSort([...byLabel.keys()], edges);
  if (sorted.error !== undefined || sorted.order === undefined) {
    return { error: sorted.error ?? 'Could not order the batch by its dependencies' };
  }

  // Non-null: every label in the sort came from this map.
  return { order: sorted.order.map((label) => byLabel.get(label)!) };
}

async function writeBatch(
  ctx: ToolContext,
  collectionPath: string | undefined,
  items: (WriteRequestArgs & { dependencies?: string[] })[],
  passedTopLevel: string[],
): Promise<ToolResult> {
  if (passedTopLevel.length > 0) {
    return errorResult(
      `${passedTopLevel.join(', ')} belongs to a single request, and this call passes requests. `
        + 'Move those fields into an item of the array, or drop the array. collectionPath is the '
        + 'one field that stays at the top level, because the batch names its collection once.',
    );
  }

  if (items.length === 0) {
    return errorResult(
      'The requests array is empty, so there is nothing to write. Pass at least one item, or '
        + 'address a single request with the top-level fields.',
    );
  }

  if (collectionPath === undefined) {
    return errorResult(
      'A batch needs collectionPath at the top level: it is the one collection every item is '
        + 'written into, and an item is refused if it would land outside it.',
    );
  }

  const pathCheck = validateToolPath(collectionPath);
  if (!pathCheck.valid) {
    return errorResult(`Invalid collectionPath: ${pathCheck.reason}`);
  }

  const prepared = resolveBatch(items, collectionPath);
  if ('error' in prepared) {
    return errorResult(prepared.error);
  }

  const ordered = orderBatch(prepared.resolved);
  if ('error' in ordered) {
    return errorResult(ordered.error);
  }

  // Sequential, and with no lock of its own. Two items in one collection share
  // the folder's seq space and the same sibling ordering, so they have to be
  // serialised — and `createRequest` and `updateRequest` each take the path lock
  // themselves. It is not reentrant, so a loop that took it would deadlock: the
  // symptom is a hang, not an error.
  const written = new Map<number, string>();
  const failed = new Map<number, string>();

  for (const item of ordered.order) {
    const result = item.target.mode === 'create'
      ? await createRequest(ctx, collectionPath, item.target.name, item.args)
      : await editRequest(ctx, item.target.filePath, item.args);

    const text = result.content[0]?.text ?? 'no result';
    if (result.isError === true) {
      failed.set(item.index, text);
    } else {
      // Read back rather than rebuilt: the writer lowercases the name, and on an
      // edit with filename it may have moved the file.
      written.set(item.index, item.target.mode === 'create'
        ? text.slice(text.lastIndexOf(': ') + 2).trim()
        : item.target.filePath);
    }
  }

  const lines = prepared.resolved.map((item) => {
    const path_ = written.get(item.index);
    return path_ !== undefined
      ? `${item.index + 1}. ${item.label}: ${path_}`
      : `${item.index + 1}. ${item.label}: FAILED — ${failed.get(item.index)}`;
  });

  const summary = failed.size === 0
    ? `Wrote all ${items.length} requests in ${collectionPath}.`
    : `Wrote ${written.size} of ${items.length} requests in ${collectionPath}; `
      + `${failed.size} failed.`;

  return {
    content: [{ type: 'text', text: [summary, ...lines].join('\n') }],
    ...(failed.size === 0 ? {} : { isError: true as const }),
  };
}

export function registerWriteRequestTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'write_request',
    {
      title: 'Write Bruno Request',
      description: 'Create a request file or change an existing one (supports .bru and .yml formats). Which one it does follows from the locator: collectionPath plus name creates, filePath changes what is already there. Creating never overwrites — an existing file is refused, so address it by filePath. Changing is a partial merge: only provided fields are updated and every other field is preserved. Pass requests to write a whole set in one call, which is worth doing whenever more than one request is going into the same collection. Authors HTTP requests by default, WebSocket requests with kind "websocket" (url plus websocket.messages) and gRPC requests with kind "grpc" (url plus grpc.method, grpc.protoPath and grpc.messages); neither takes an HTTP method or a body. Supports multipart/form-data with file uploads and per-part contentType (body.type "form-data" with formData entries of type "file"), and inline scripts (pre-request/post-response/tests) so no separate add_test_script call is needed. Scripts run as async functions: top-level await works, and bru.sleep(ms)/setTimeout/setInterval are available, spending the script timeout (settings.timeout, default 5000ms) — raise it via the settings argument. Inline scripts REPLACE the existing script of the same type by default (idempotent — repeated calls do not accumulate duplicate blocks); pass scriptMode:"append" to concatenate instead. Use remove_script to clear a script entirely. RENAMING: name and filename are independent, as they are in Bruno itself — name changes the request\'s name inside the file and filename moves the file. Pass both to keep them in step, and read the new path back from the response.',
      inputSchema: {
        collectionPath: collectionPathField.optional(),
        ...writeFields,
        requests: requestsField.optional(),
      }
    },
    async (args) => {
      if (args.requests !== undefined) {
        return writeBatch(
          ctx,
          args.collectionPath,
          args.requests,
          WRITE_FIELD_NAMES.filter((field) => wasPassed(args as Record<string, unknown>, field)),
        );
      }

      const target = resolveWriteTarget(args);
      if ('error' in target) {
        return errorResult(target.error);
      }
      return target.mode === 'create'
        ? createRequest(ctx, target.collectionPath, target.name, args)
        : editRequest(ctx, target.filePath, args);
    }
  );
}
