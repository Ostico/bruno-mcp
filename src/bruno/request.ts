/**
 * Bruno request builder
 * Handles creation and management of .bru request files
 */

import { promises as fs } from 'fs';
import { writeFileAtomic } from './atomic-write.js';
import { withPathLock } from './path-mutex.js';
import { nextRequestSequence } from './request-sequence.js';
import { isYamlRequestFile, isBruRequestFile } from './request-extensions.js';
import { ensureRenameTargetFree, resolveRenameTarget, sanitizeRequestFileName } from './request-filename.js';
import { join, dirname, isAbsolute, relative } from 'path';
import { realpathSync } from 'fs';
import { assertProtoImportsConfined, confineProtoPath } from './proto-path.js';
import { validatePath } from './path-validator.js';
import {
  BruFile,
  BruAuth,
  YamlRequest,
  YamlHeader,
  YamlAuth,
  CreateRequestInput,
  UpdateRequestInput,
  FileOperationResult,
  BrunoError,
  BruFileError,
  HttpMethod,
  AuthType,
  BodyType
} from './types.js';
import type {
  YamlWebsocket,
  YamlGrpc,
} from './transport-requests.js';
import {
  applyBruTransportUpdates,
  applyKindAgnosticUpdates,
  applyYamlTransportUpdates,
  buildBruAuthBlock,
  transportKindToEdit,
  buildBruWebsocketMessages,
  buildGrpcMessages,
  buildYamlAuthValue,
  buildYamlWebsocketMessages,
} from './transport-writes.js';
import { detectFormat } from './format-detector.js';
import type { CollectionFormat } from './format-detector.js';
import { createWriter, normalizeScriptType } from './format-factory.js';

import { generateYamlRequest } from './yaml-generator.js';
import { parseBruRequest, generateBruRequest } from './bru-parser.js';
import { parseYamlRequest } from './yaml-parser.js';
import {
  assertionsToBru,
  assertionsToYaml,
  mergeBruHeaderList,
  mergeRequestSettings,
  mergeYamlHeaderList,
  pathParamsToBruParams,
  pathParamsToYamlParams,
  queryToBruParams,
  queryToYamlParams,
  replacePathParams,
  replaceQueryParams,
  toBruApiKeyPlacement,
  toBruBody,
  toBrunoAuthMode,
  toYamlBody,
  varsToBruVarSets,
  varsToYamlVars,
  yamlBodyToBruBody,
} from './request-inputs.js';

export class RequestBuilder {

  /**
   * Create a new .bru request file
   */
  async createRequest(input: CreateRequestInput): Promise<FileOperationResult> {
    try {
      // Validate input
      this.validateRequestInput(input);

      // Detect collection format
      const detection = await detectFormat(input.collectionPath);
      const isYaml = detection.format === 'yaml';
      const filePath = this.getRequestFilePath(input, isYaml ? '.yml' : '.bru');
      // After format detection, so a collection that does not exist is reported as
      // that rather than as an unreadable proto root.
      const confined = await this.confineAuthoredProtoPath(input);

      // Creation takes the same per-file lock updateRequest takes, for two
      // reasons. With `scripts`, this is itself a read-modify-write: the file is
      // written and then read back to inject them, so two creations of the same
      // path can interleave and the second injection can be written over the
      // first. And even without scripts, an unlocked write is not excluded from a
      // concurrent locked read-modify-write elsewhere — a lock only serializes
      // the callers that take it, so the writer that skips it is precisely the
      // one whose write can land between another caller's read and write and be
      // discarded. Locking only the mutating half of a file's API leaves the
      // lost update the lock was added to prevent.
      return await withPathLock(filePath, async () => {
        // Creating must not clobber. Nothing else guards it: this path is
        // ensureDirectory plus writeFileAtomic, so a call meant as an edit would
        // replace the whole file and report success. Checked inside the lock, so
        // two creations of one path cannot both pass the check and then have one
        // silently lose its content to the other.
        if (await this.pathExists(filePath)) {
          return {
            success: false,
            error: `${filePath} already exists. To change it, address it by filePath `
              + 'instead of creating it again.',
          };
        }
        await this.ensureDirectory(dirname(filePath));
        // With no explicit sequence the file used to be written with no `seq` at
        // all, which the run order treats as last — every such request tied with
        // every other, ordered by nothing. Default to after the folder's others.
        const sequenced = input.sequence !== undefined
          ? confined
          : {
            ...confined,
            sequence: await nextRequestSequence(dirname(filePath), input.collectionPath),
          };
        const content = isYaml
          ? generateYamlRequest(this.buildYamlRequest(sequenced))
          : generateBruRequest(this.buildBruFile(sequenced));
        await writeFileAtomic(filePath, content);
        if (input.scripts) {
          await this.applyInlineScripts(filePath, detection.format, input.scripts);
        }
        return { success: true, path: filePath };
      });

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Load an existing .bru or .yml request file
   */
  async loadRequest(filePath: string): Promise<BruFile> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');

      if (isYamlRequestFile(filePath)) {
        const yamlReq = parseYamlRequest(content);
        // A kind with no http block carries its target elsewhere; narrowed once so
        // the mapping below is not littered with the same optional chain.
        const yamlHttp = yamlReq.http;
        const bruFile: BruFile = {
          meta: {
            name: yamlReq.info.name,
            // `folder` cannot appear here: this is a request file.
            type: yamlReq.info.type === 'folder' ? 'http' : (yamlReq.info.type ?? 'http'),
            seq: yamlReq.info.seq,
          },
          http: yamlHttp
            ? {
              method: yamlHttp.method as HttpMethod,
              url: yamlHttp.url,
              body: (yamlHttp.body?.type as BodyType) || 'none',
              auth: this.resolveAuthType(yamlHttp.auth),
            }
            : undefined,
        };

        if (yamlHttp?.headers && yamlHttp.headers.length > 0) {
          bruFile.headers = {};
          for (const h of yamlHttp.headers) {
            bruFile.headers[h.name] = h.value;
          }
        }

        if (yamlHttp?.body && yamlHttp.body.type !== 'none') {
          bruFile.body = yamlBodyToBruBody(yamlHttp.body);
        }

        if (yamlHttp?.auth && typeof yamlHttp.auth !== 'string') {
          bruFile.auth = yamlHttp.auth as BruAuth;
        }

        if (yamlReq.runtime?.scripts && yamlReq.runtime.scripts.length > 0) {
          bruFile.script = {};
          for (const s of yamlReq.runtime.scripts) {
            if (s.type === 'before-request') {
              bruFile.script['pre-request'] = { exec: s.code.split('\n') };
            } else if (s.type === 'after-response') {
              bruFile.script['post-response'] = { exec: s.code.split('\n') };
            }
          }
        }

        if (yamlReq.docs) {
          bruFile.docs = yamlReq.docs;
        }

        return bruFile;
      } else if (isBruRequestFile(filePath)) {
        return this.parseBruFile(content);
      }

      throw new BrunoError(`Unsupported file extension: ${filePath}`, 'VALIDATION_ERROR');

    } catch (error) {
      throw new BruFileError(
        `Failed to load request from ${filePath}`,
        { originalError: error }
      );
    }
  }

  /**
   * Update an existing request
   */
  async updateRequest(filePath: string, updates: UpdateRequestInput): Promise<FileOperationResult> {
    // The file is read, merged with `updates`, and written back. Hold the lock
    // across the pair so a concurrent update is not silently discarded.
    return withPathLock(filePath, () => this.updateRequestLocked(filePath, updates));
  }

  private async updateRequestLocked(filePath: string, updates: UpdateRequestInput): Promise<FileOperationResult> {
    try {
      // Settle the rename before writing anything. The write happens first
      // either way, so refusing the filename afterwards would report a failure
      // over edits that are already on disk.
      let renameTo: string | undefined;
      if (updates.filename !== undefined) {
        const resolved = resolveRenameTarget(filePath, updates.filename);
        if (!resolved.ok) {
          return { success: false, error: `Cannot rename the file: ${resolved.reason}.` };
        }
        if (resolved.target !== filePath) {
          const free = await ensureRenameTargetFree(filePath, resolved.target);
          if (!free.ok) {
            return { success: false, error: `Cannot rename the file: ${free.reason}.` };
          }
          renameTo = resolved.target;
        }
      }

      if (isYamlRequestFile(filePath)) {
        const content = await fs.readFile(filePath, 'utf-8');
        const yamlReq = parseYamlRequest(content);

        // Kind-agnostic updates apply to every kind: refusing them would make a
        // grpc or ws request uneditable, which is the same data problem from the
        // other side.
        if (updates.name) yamlReq.info.name = updates.name;
        if (updates.sequence !== undefined) yamlReq.info.seq = updates.sequence;

        // Everything below reshapes the http block. A kind that has none has its
        // own block instead, and writing an http one onto a grpc request would
        // graft a second target onto it. The fields that have no equivalent there
        // are refused by name.
        const yamlHttp = yamlReq.http;
        if (!yamlHttp) {
          applyYamlTransportUpdates(yamlReq, transportKindToEdit(yamlReq.info.type), updates);
        }

        if (yamlHttp) {
          if (updates.method) yamlHttp.method = updates.method;
          if (updates.url) yamlHttp.url = updates.url;
          if (updates.headers) {
            yamlHttp.headers = mergeYamlHeaderList(yamlHttp.headers, updates.headers);
          }
          if (updates.body && updates.body.type !== 'none') {
            yamlHttp.body = toYamlBody(updates.body);
          }
          if (updates.auth?.type === 'inherit') {
            // The bare token, not a mapping: see the same branch on the create path.
            yamlHttp.auth = 'inherit';
          } else if (updates.auth && updates.auth.type !== 'none') {
            // The same builder the create path uses. It used to copy the whole
            // config across under the caller's own spelling of the type, so an
            // edit setting api-key auth wrote `type: api-key` where Bruno writes
            // `apikey` — a mode its reader does not match, on a request that had
            // just been told to authenticate.
            yamlHttp.auth = buildYamlAuthValue(updates.auth.type, updates.auth.config || {});
          }
          if (updates.query) {
            yamlHttp.params = replaceQueryParams(
              yamlHttp.params,
              queryToYamlParams(updates.query),
            );
          }
          if (updates.pathParams) {
            yamlHttp.params = replacePathParams(
              yamlHttp.params,
              pathParamsToYamlParams(updates.pathParams),
            );
          }
        }
        if (updates.assert) {
          yamlReq.assert = assertionsToYaml(updates.assert);
        }
        if (updates.vars) {
          yamlReq.vars = varsToYamlVars(updates.vars, yamlReq.vars);
        }
        if (updates.settings) {
          yamlReq.settings = mergeRequestSettings(yamlReq.settings, updates.settings);
        }

        const updatedContent = generateYamlRequest(yamlReq);
        await writeFileAtomic(filePath, updatedContent);
      } else if (isBruRequestFile(filePath)) {
        // Load existing BRU request
        const existingBru = await this.loadRequest(filePath);

        // Apply updates
        const updatedBru = this.applyUpdates(existingBru, updates);

        // Generate and write updated content
        const bruContent = generateBruRequest(updatedBru);
        await writeFileAtomic(filePath, bruContent);
      }

      if (updates.scripts) {
        const format: CollectionFormat = isYamlRequestFile(filePath) ? 'yaml' : 'bru';
        await this.applyInlineScripts(
          filePath,
          format,
          updates.scripts,
          updates.scriptMode ?? 'replace',
        );
      }

      if (renameTo !== undefined) {
        // The lock covers the old path only. A caller that took the target's
        // lock instead is not excluded from this move, which is the same window
        // Bruno's own rename leaves open.
        await fs.rename(filePath, renameTo);
      }

      return {
        success: true,
        path: renameTo ?? filePath
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Create authentication test requests
   */
  async createAuthRequests(
    collectionPath: string,
    baseUrl: string,
    authType: AuthType,
    folder = 'auth'
  ): Promise<FileOperationResult[]> {
    const results: FileOperationResult[] = [];

    const authRequests = [
      {
        name: 'Login',
        method: 'POST' as HttpMethod,
        url: `${baseUrl}/auth/login`,
        body: {
          type: 'json' as BodyType,
          content: JSON.stringify({
            username: '{{username}}',
            password: '{{password}}'
          }, null, 2)
        },
        headers: {
          'Content-Type': 'application/json'
        },
        sequence: 1
      },
      {
        name: 'Get Profile',
        method: 'GET' as HttpMethod,
        url: `${baseUrl}/auth/profile`,
        auth: authType !== 'none' ? {
          type: authType,
          // inherit takes no credential of its own; the basic-style fallback below
          // would attach a username and password to a mode that has nowhere to put
          // them, describing the request as something it is not.
          config: authType === 'inherit' ? {}
            : authType === 'bearer' ? { token: '{{token}}' }
              : { username: '{{username}}', password: '{{password}}' }
        } as { type: AuthType; config: Record<string, string> } : undefined,
        sequence: 2
      },
      {
        name: 'Refresh Token',
        method: 'POST' as HttpMethod,
        url: `${baseUrl}/auth/refresh`,
        body: {
          type: 'json' as BodyType,
          content: JSON.stringify({
            refreshToken: '{{refreshToken}}'
          }, null, 2)
        },
        headers: {
          'Content-Type': 'application/json'
        },
        sequence: 3
      },
      {
        name: 'Logout',
        method: 'POST' as HttpMethod,
        url: `${baseUrl}/auth/logout`,
        auth: authType !== 'none' ? {
          type: authType,
          // inherit takes no credential of its own; the basic-style fallback below
          // would attach a username and password to a mode that has nowhere to put
          // them, describing the request as something it is not.
          config: authType === 'inherit' ? {}
            : authType === 'bearer' ? { token: '{{token}}' }
              : { username: '{{username}}', password: '{{password}}' }
        } as { type: AuthType; config: Record<string, string> } : undefined,
        sequence: 4
      }
    ];

    for (const authRequest of authRequests) {
      const result = await this.createRequest({
        collectionPath,
        ...authRequest,
        folder
      });
      results.push(result);
    }

    return results;
  }

  /**
   * Build BRU file structure from input
   */
  private buildBruFile(input: CreateRequestInput): BruFile {
    const kind = input.kind ?? 'http';
    const bruFile: BruFile = {
      meta: {
        name: input.name,
        // A graphql request says so in its meta block. Bruno writes
        // `type: graphql` there (see `bruno-tests/collection/graphql/*.bru`) and
        // its UI reads that key, not the body mode, to decide a request is a
        // graphql one. Hardcoding 'http' produced a file whose body block was
        // right and whose identity was wrong. The `.yml` side needs no
        // equivalent: its generator already settles `info.type` from the body.
        type: kind !== 'http' ? kind : input.body?.type === 'graphql' ? 'graphql' : 'http',
        // Absent has to mean an absent KEY, not a key holding undefined:
        // upstream's serializer writes `${key}: ${meta[key]}` for everything
        // present, so leaving it here emits the literal text "seq: undefined".
        ...(input.sequence !== undefined ? { seq: input.sequence } : {})
      },
    };

    if (kind === 'ws') {
      // No `http` block at all, and the target lives in `ws` instead. `body: ws`
      // names the mode that owns the `body:ws` blocks; without it the file is
      // saved with its messages orphaned from the block that declares them.
      // Headers are deliberately not set here — a `.bru` WebSocket request keeps
      // them in the ordinary top-level `headers` block, written below.
      bruFile.ws = {
        url: input.url,
        body: 'ws',
        auth: toBrunoAuthMode(input.auth?.type),
      };
      const messages = buildBruWebsocketMessages(input.websocket?.messages);
      if (messages) bruFile.ws.messages = messages;
    } else if (kind === 'grpc') {
      // Same shape as the `ws` branch: no `http` block, and `body: grpc` names the
      // mode that owns the `body:grpc` blocks. `protoPath` keeps the model's name
      // here because `.bru` spells it that way; only the `.yml` writer restores
      // `protoFilePath`.
      bruFile.grpc = {
        url: input.url,
        body: 'grpc',
        auth: toBrunoAuthMode(input.auth?.type),
      };
      if (input.grpc?.method !== undefined) bruFile.grpc.method = input.grpc.method;
      if (input.grpc?.protoPath !== undefined) bruFile.grpc.protoPath = input.grpc.protoPath;
      if (input.grpc?.methodType !== undefined) bruFile.grpc.methodType = input.grpc.methodType;
      const messages = buildGrpcMessages(input.grpc?.messages);
      if (messages) bruFile.grpc.messages = messages;
    } else {
      bruFile.http = {
        // Present on this path: `validateRequestInput` refuses an http request
        // with no method, and every caller of this builder validates first. The
        // narrowing is asserted rather than re-checked so the check has one home
        // and its failure one message.
        method: input.method as HttpMethod,
        url: input.url,
        body: input.body?.type || 'none',
        auth: toBrunoAuthMode(input.auth?.type)
      };
    }

    // Add headers if provided.
    //
    // A gRPC request has no `headers` block — the transport's header surface is
    // metadata, and Bruno's gRPC parser reads a `metadata` block and nothing else.
    // Writing `headers` for this kind would produce a file whose credentials are
    // on disk and invisible to both Bruno and our own runner.
    if (input.headers && Object.keys(input.headers).length > 0) {
      if (kind === 'grpc') {
        bruFile.metadata = Object.entries(input.headers).map(([name, value]) => ({
          name,
          value,
          enabled: true,
        }));
      } else {
        bruFile.headers = input.headers;
      }
    }

    // Add query parameters if provided.
    //
    // These must go on `params`: that is the field the .bru writer serializes
    // (as a `params:query` block) and the field the executor applies. An earlier
    // version stored them on a `query` field that nothing ever wrote out, so a
    // request created with query params landed on disk without them.
    if (input.query && Object.keys(input.query).length > 0) {
      bruFile.params = queryToBruParams(input.query);
    }

    // Path parameters share the `params` field, distinguished by `type`.
    if (input.pathParams && Object.keys(input.pathParams).length > 0) {
      bruFile.params = [
        ...(bruFile.params ?? []),
        ...pathParamsToBruParams(input.pathParams),
      ];
    }

    if (input.assert && input.assert.length > 0) {
      bruFile.assertions = assertionsToBru(input.assert);
    }

    if (input.vars) {
      bruFile.varSets = varsToBruVarSets(input.vars, bruFile.varSets);
    }

    // Only when asked for. A request created without settings gets no settings
    // block, matching what Bruno's own writer produces; writing the executor's
    // fallbacks out as explicit keys would make every created request differ
    // from a hand-authored one.
    if (input.settings) {
      bruFile.settings = mergeRequestSettings(bruFile.settings, input.settings);
    }

    // Add body if provided
    if (input.body && input.body.type !== 'none') {
      bruFile.body = toBruBody(input.body);
    }

    // Add authentication if provided. inherit is deliberately absent: it is
    // declared by the `auth: inherit` line in the http block above, and has no
    // local credential to put in a block of its own. The generator would also
    // drop a config-less block on its way out, so this is the intent stated where
    // the decision is rather than left to fall out of an emptiness check.
    if (input.auth && input.auth.type !== 'none' && input.auth.type !== 'inherit') {
      bruFile.auth = {
        type: input.auth.type
      };

      // Configure auth based on type
      switch (input.auth.type) {
        case 'bearer':
          bruFile.auth.bearer = {
            token: input.auth.config.token || '{{token}}'
          };
          break;
        case 'basic':
          bruFile.auth.basic = {
            username: input.auth.config.username || '{{username}}',
            password: input.auth.config.password || '{{password}}'
          };
          break;
        case 'api-key':
          bruFile.auth.apikey = {
            key: input.auth.config.key || 'X-API-Key',
            value: input.auth.config.value || '{{apiKey}}',
            placement: toBruApiKeyPlacement(input.auth.config)
          };
          break;
      }
    }

    return bruFile;
  }

  /**
   * Check an authored `protoPath` against the collection, and return the input
   * with it rewritten to the collection-relative form.
   *
   * The same boundary the run path applies (`confineProtoPath`), applied when the
   * file is written rather than only when it is run: a request naming a proto
   * outside the collection is one this server will refuse to run, so authoring it
   * silently would hand back a path and a request that cannot work. It also
   * rejects a proto that does not exist yet, which means the `.proto` has to be in
   * the collection before the request that names it — the right order anyway,
   * since the alternative is a request whose method nothing can check.
   *
   * The stored form is relative to the collection whichever spelling arrives.
   * Absolute is not portable: a committed request naming `/Users/someone/...`
   * breaks on clone, and it writes the operator's directory layout into a file
   * meant to be shared. Relative is also what our own loader resolves against.
   *
   * The import graph is checked too, not just the entry file, because the escape
   * can be one hop further in: a confined proto importing a confined neighbour
   * that imports `/etc/passwd` names an entry file with nothing wrong with it. The
   * run path checks the same graph again — the file can change between authoring
   * and running, so neither check makes the other redundant. It is affordable in
   * both places because it is a regex scan for `import` lines, not a parse.
   */
  private async confineAuthoredProtoPath(input: CreateRequestInput): Promise<CreateRequestInput> {
    const protoPath = input.grpc?.protoPath;
    if (protoPath === undefined) return input;

    const realTarget = confineProtoPath(protoPath, input.collectionPath);
    await assertProtoImportsConfined(realTarget, realpathSync(input.collectionPath));
    return {
      ...input,
      grpc: { ...input.grpc, protoPath: relative(realpathSync(input.collectionPath), realTarget) },
    };
  }

  /**
   * Build a YamlRequest from CreateRequestInput
   */
  private buildYamlRequest(input: CreateRequestInput): YamlRequest {
    const kind = input.kind ?? 'http';
    const yamlRequest: YamlRequest = {
      info: {
        name: input.name,
        // The model's kind, not the on-disk token: `generateYamlRequest` maps `ws`
        // to `websocket` on the way out, the same way the parser maps it back.
        type: kind,
        seq: input.sequence,
      },
    };

    const headerList = input.headers && Object.keys(input.headers).length > 0
      ? Object.entries(input.headers).map(([name, value]): YamlHeader => ({ name, value }))
      : undefined;

    if (kind === 'ws') {
      // No `http` block: a WebSocket request's target, headers and credential all
      // live in its own block, and an empty `http:` key is one no Bruno file has.
      const websocket: YamlWebsocket = { url: input.url };
      if (headerList) websocket.headers = headerList;
      const messages = buildYamlWebsocketMessages(input.websocket?.messages);
      if (messages) websocket.messages = messages;
      const auth = this.buildYamlAuth(input);
      if (auth !== undefined) websocket.auth = auth;
      yamlRequest.websocket = websocket;
      return this.applyYamlRequestExtras(yamlRequest, input);
    }

    if (kind === 'grpc') {
      // Headers become `metadata` here, which is where Bruno's gRPC parser reads
      // them from — `.yml` nests them in the block rather than keeping a top-level
      // one as `.bru` does. `url` and `method` are always written, empty or not,
      // because upstream's writer writes them unconditionally.
      const grpc: YamlGrpc = { url: input.url, method: input.grpc?.method ?? '' };
      if (input.grpc?.methodType !== undefined) grpc.methodType = input.grpc.methodType;
      if (input.grpc?.protoPath !== undefined) grpc.protoPath = input.grpc.protoPath;
      if (headerList) grpc.metadata = headerList;
      const messages = buildGrpcMessages(input.grpc?.messages);
      if (messages) grpc.messages = messages;
      const auth = this.buildYamlAuth(input);
      if (auth !== undefined) grpc.auth = auth;
      yamlRequest.grpc = grpc;
      return this.applyYamlRequestExtras(yamlRequest, input);
    }

    yamlRequest.http = {
      // See `buildBruFile`: validation has already refused an http request with
      // no method, so this is asserted rather than checked a second time.
      method: input.method as HttpMethod,
      url: input.url,
    };
    // Bound to a local so the field's optionality does not have to be re-checked
    // at every assignment below.
    const http = yamlRequest.http;

    // Add headers
    if (headerList) {
      http.headers = headerList;
    }

    // Add body
    if (input.body && input.body.type !== 'none') {
      http.body = toYamlBody(input.body);
    }

    // Add query params
    if (input.query && Object.keys(input.query).length > 0) {
      http.params = queryToYamlParams(input.query);
    }

    // Path parameters share the `params` field, distinguished by `type`.
    if (input.pathParams && Object.keys(input.pathParams).length > 0) {
      http.params = [
        ...(http.params ?? []),
        ...pathParamsToYamlParams(input.pathParams),
      ];
    }

    const auth = this.buildYamlAuth(input);
    if (auth !== undefined) http.auth = auth;

    return this.applyYamlRequestExtras(yamlRequest, input);
  }

  /**
   * The `.yml` blocks that belong to the request rather than to its transport:
   * assertions, variables and settings. Shared by every kind, because none of
   * them is addressed to the target.
   */
  private applyYamlRequestExtras(
    yamlRequest: YamlRequest,
    input: CreateRequestInput,
  ): YamlRequest {
    if (input.assert && input.assert.length > 0) {
      yamlRequest.assert = assertionsToYaml(input.assert);
    }

    if (input.vars) {
      yamlRequest.vars = varsToYamlVars(input.vars, yamlRequest.vars);
    }

    // Same as the .bru path: no block at all unless the caller declared one.
    if (input.settings) {
      yamlRequest.settings = mergeRequestSettings(yamlRequest.settings, input.settings);
    }

    return yamlRequest;
  }

  /**
   * The `.yml` credential, in the one form both the http and websocket blocks
   * take. Returns undefined when there is nothing to write, so a caller can leave
   * the key off rather than write an empty one.
   */
  private buildYamlAuth(input: CreateRequestInput): YamlAuth | undefined {
    if (input.auth?.type === 'inherit') {
      // Bruno writes inherit as the bare token, not as a mapping with a type key:
      // there is no local credential to carry, only the instruction to look up the
      // tree. A `{ type: inherit }` mapping is not what its reader matches.
      return 'inherit';
    }
    if (!input.auth || input.auth.type === 'none') return undefined;

    return buildYamlAuthValue(input.auth.type, input.auth.config);
  }

  /**
   * The declared auth mode of a parsed `.yml` request.
   *
   * `inherit` is reported as itself, not folded into `none`. The two are
   * different instructions — `none` sends no credential, `inherit` sends whatever
   * the enclosing folder or collection declares — so collapsing them left a
   * caller unable to tell an inheriting request from an unauthenticated one, and
   * unable to write back the mode it had just read.
   */
  private resolveAuthType(auth: YamlAuth | undefined): AuthType {
    if (!auth) return 'none';
    if (typeof auth === 'string') return auth as AuthType;
    return (auth.type as AuthType) ?? 'none';
  }

  /**
   * Get file path for request
   */
  private getRequestFilePath(input: CreateRequestInput, extension: string): string {
    const fileName = this.sanitizeFileName(input.name) + extension;

    if (input.folder) {
      const folder = input.folder;

      // Reject absolute-path folders outright: they must be relative to the
      // collection root.
      if (isAbsolute(folder)) {
        throw new BruFileError(
          `Invalid folder "${folder}": absolute paths are not allowed`,
          { folder },
        );
      }

      // Reject any parent-directory traversal segment before touching the fs.
      if (folder.split(/[\\/]+/).includes('..')) {
        throw new BruFileError(
          `Invalid folder "${folder}": parent directory traversal ('..') is not allowed`,
          { folder },
        );
      }

      // Final containment check: the resolved path (also catches null bytes)
      // must stay inside the collection root.
      const candidate = join(input.collectionPath, folder, fileName);
      const check = validatePath(candidate, input.collectionPath);
      if (!check.valid) {
        throw new BruFileError(
          `Invalid folder "${folder}": ${check.reason}`,
          { folder },
        );
      }

      return candidate;
    }

    return join(input.collectionPath, fileName);
  }

  /**
   * Sanitize file name for filesystem
   */
  private sanitizeFileName(name: string): string {
    return sanitizeRequestFileName(name);
  }

  private parseBruFile(content: string): BruFile {
    return parseBruRequest(content);
  }

  /**
   * Apply updates to existing BRU file
   */
  private applyUpdates(existingBru: BruFile, updates: Partial<CreateRequestInput>): BruFile {
    const updated = { ...existingBru };

    // Name and sequence are kind-agnostic and apply to every kind.
    if (updates.name) {
      updated.meta.name = updates.name;
    }

    if (updates.sequence !== undefined) {
      updated.meta.seq = updates.sequence;
    }

    // The rest reshape the http block. A kind that has none — grpc, ws — has its
    // own, and grafting an http block onto such a request would make it unopenable
    // in Bruno and change which host it contacts.
    const httpBlock = updated.http;
    if (!httpBlock) {
      applyBruTransportUpdates(updated, transportKindToEdit(updated.meta.type), updates);
      applyKindAgnosticUpdates(updated, updates);
      return updated;
    }

    if (updates.method) {
      httpBlock.method = updates.method;
    }

    if (updates.url) {
      httpBlock.url = updates.url;
    }

    if (updates.headers) {
      updated.headers = { ...updated.headers, ...updates.headers };
      updated.headersList = mergeBruHeaderList(updated.headersList, updates.headers);
    }

    if (updates.query) {
      updated.params = replaceQueryParams(updated.params, queryToBruParams(updates.query));
    }

    if (updates.pathParams) {
      updated.params = replacePathParams(
        updated.params,
        pathParamsToBruParams(updates.pathParams),
      );
    }

    applyKindAgnosticUpdates(updated, updates);

    if (updates.body) {
      httpBlock.body = updates.body.type;
      updated.body = toBruBody(updates.body);
    }

    if (updates.auth?.type === 'inherit') {
      // Switching to inherit leaves no local credential, so the block goes with
      // the mode instead of being replaced by a typed-but-empty one. A file that
      // says inherit in the http block must not carry a credential underneath it.
      httpBlock.auth = 'inherit';
      delete updated.auth;
    } else if (updates.auth) {
      // The credential comes over from updates.auth.config so a modify that
      // touches auth updates the secret instead of wiping it, and it is built by
      // the same function the creation path uses so the persisted shape is
      // identical either way.
      httpBlock.auth = toBrunoAuthMode(updates.auth.type);
      updated.auth = buildBruAuthBlock(updates.auth.type, updates.auth.config || {});
    }

    return updated;
  }

  /**
   * Validate request input
   */
  private validateRequestInput(input: CreateRequestInput): void {
    if (!input.name || input.name.trim().length === 0) {
      throw new BrunoError('Request name is required', 'VALIDATION_ERROR');
    }

    if (!input.collectionPath || input.collectionPath.trim().length === 0) {
      throw new BrunoError('Collection path is required', 'VALIDATION_ERROR');
    }

    if (!input.url || input.url.trim().length === 0) {
      throw new BrunoError('URL is required', 'VALIDATION_ERROR');
    }

    // Which fields apply is decided by the kind, and the ones that stop applying
    // are refused rather than ignored: a WebSocket request written from an input
    // carrying a method and a JSON body would silently drop both, and the caller
    // would have no way to tell that from a request that did not ask for them.
    const kind = input.kind ?? 'http';
    if (kind !== 'http') {
      const transport = kind === 'ws' ? 'WebSocket' : 'gRPC';
      if (input.method !== undefined) {
        throw new BrunoError(
          `A ${transport} request has no HTTP method: remove \`method\`, or use kind \`http\``
            + (kind === 'grpc' ? '. For the RPC method, use `grpc.method`' : ''),
          'VALIDATION_ERROR',
        );
      }
      const httpOnly = (['body', 'query', 'pathParams'] as const).filter(
        (field) => input[field] !== undefined,
      );
      if (httpOnly.length > 0) {
        const payload = kind === 'ws' ? '`websocket.messages`' : '`grpc.messages`';
        throw new BrunoError(
          `A ${transport} request cannot carry ${httpOnly.join(', ')}: its payload is `
            + `${payload}, and it has no query or path parameters`,
          'VALIDATION_ERROR',
        );
      }
      // Each transport refuses the other's object, so naming the wrong one is an
      // error rather than a field that writes nothing.
      const otherKey = kind === 'ws' ? 'grpc' : 'websocket';
      if (input[otherKey] !== undefined) {
        throw new BrunoError(
          `The \`${otherKey}\` object does not apply to kind \`${kind}\``,
          'VALIDATION_ERROR',
        );
      }
    } else {
      const transportOnly = (['websocket', 'grpc'] as const).filter(
        (field) => input[field] !== undefined,
      );
      if (transportOnly.length > 0) {
        throw new BrunoError(
          `The \`${transportOnly.join('` and `')}\` object applies to its own kind only, `
            + 'not to kind `http`',
          'VALIDATION_ERROR',
        );
      }

      if (!input.method) {
        throw new BrunoError('HTTP method is required', 'VALIDATION_ERROR');
      }

      // Validate HTTP method
      const validMethods: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
      if (!validMethods.includes(input.method)) {
        throw new BrunoError(
          `Invalid HTTP method: ${input.method}`,
          'VALIDATION_ERROR'
        );
      }
    }

    // Validate auth configuration if provided
    if (input.auth && input.auth.type !== 'none') {
      this.validateAuthConfig(input.auth.type, input.auth.config);
    }
  }

  /**
   * Validate authentication configuration
   */
  private validateAuthConfig(authType: AuthType, config: Record<string, string>): void {
    switch (authType) {
      case 'bearer':
        if (!config.token) {
          throw new BrunoError('Bearer token is required', 'VALIDATION_ERROR');
        }
        break;
      case 'basic':
        if (!config.username || !config.password) {
          throw new BrunoError('Username and password are required for basic auth', 'VALIDATION_ERROR');
        }
        break;
      case 'api-key':
        if (!config.key || !config.value) {
          throw new BrunoError('Key and value are required for API key auth', 'VALIDATION_ERROR');
        }
        break;
    }
  }

  /**
   * Persist inline scripts to an already-written request file using the same
   * script-injection path as add_test_script. Script-type keys may use the
   * canonical values (pre-request/post-response/tests) or the aliases
   * before-request (→ pre-request) and after-response (→ post-response).
   *
   * Scripts that land in the same underlying slot are merged into one code
   * string before a single write, so a 'replace' never discards a sibling
   * script supplied in the same call. This matters for the .yml dialect, where
   * post-response and tests both compile to one `after-response` entry.
   *
   * @param mode 'replace' overwrites the existing script(s) in each targeted
   *             slot; 'append' concatenates onto what is already there.
   */
  private async applyInlineScripts(
    filePath: string,
    format: CollectionFormat,
    scripts: Record<string, string>,
    mode: 'append' | 'replace' = 'replace',
  ): Promise<void> {
    const writer = createWriter(format);
    let content = await fs.readFile(filePath, 'utf-8');

    // Deterministic order so merged slots read the same way every run
    const ORDER = ['pre-request', 'post-response', 'tests'] as const;
    const byCanonical = new Map<string, string[]>();

    for (const [rawType, code] of Object.entries(scripts)) {
      if (code === undefined || code === null || code === '') continue;
      const canonical = normalizeScriptType(rawType);
      const bucket = byCanonical.get(canonical);
      if (bucket) bucket.push(code);
      else byCanonical.set(canonical, [code]);
    }

    // Group canonical types by the slot they actually occupy in this format.
    // In YAML, post-response and tests share the single after-response slot.
    const slots = new Map<string, { scriptType: string; codes: string[] }>();
    for (const canonical of ORDER) {
      const codes = byCanonical.get(canonical);
      if (!codes) continue;
      const slotKey =
        format === 'yaml' && (canonical === 'post-response' || canonical === 'tests')
          ? 'after-response'
          : canonical;
      const slot = slots.get(slotKey);
      if (slot) slot.codes.push(...codes);
      else slots.set(slotKey, { scriptType: canonical, codes: [...codes] });
    }

    for (const { scriptType, codes } of slots.values()) {
      content = writer.injectScript(content, scriptType, codes.join('\n'), mode);
    }

    await writeFileAtomic(filePath, content);
  }

  /**
   * Ensure directory exists
   */
  private async ensureDirectory(dirPath: string): Promise<void> {
    try {
      await fs.access(dirPath);
    } catch {
      await fs.mkdir(dirPath, { recursive: true });
    }
  }

  /**
   * Whether a path exists.
   *
   * `stat` rather than a read, because a read that a test has stubbed resolves
   * with `undefined` and reports every path as present.
   */
  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Create a new request builder instance
 */
export function createRequestBuilder(): RequestBuilder {
  return new RequestBuilder();
}
