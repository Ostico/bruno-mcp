/**
 * Bruno request builder
 * Handles creation and management of .bru request files
 */

import { promises as fs } from 'fs';
import { writeFileAtomic } from './atomic-write.js';
import { withPathLock } from './path-mutex.js';
import { nextRequestSequence } from './request-sequence.js';
import { isYamlRequestFile, isBruRequestFile } from './request-extensions.js';
import { join, dirname, isAbsolute } from 'path';
import { validatePath } from './path-validator.js';
import {
  BruFile,
  BruAuth,
  YamlRequest,
  YamlHeader,
  YamlAuth,
  CreateRequestInput,
  CreateWebsocketMessageInput,
  FileOperationResult,
  BrunoError,
  BruFileError,
  HttpMethod,
  AuthType,
  BodyType
} from './types.js';
import type {
  BruTransportMessage,
  YamlRequestMessage,
  YamlWebsocket,
} from './transport-requests.js';
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
  toYamlApiKeyPlacement,
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
        await this.ensureDirectory(dirname(filePath));
        // With no explicit sequence the file used to be written with no `seq` at
        // all, which the run order treats as last — every such request tied with
        // every other, ordered by nothing. Default to after the folder's others.
        const sequenced = input.sequence !== undefined
          ? input
          : {
            ...input,
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
  async updateRequest(filePath: string, updates: Partial<CreateRequestInput>): Promise<FileOperationResult> {
    // The file is read, merged with `updates`, and written back. Hold the lock
    // across the pair so a concurrent update is not silently discarded.
    return withPathLock(filePath, () => this.updateRequestLocked(filePath, updates));
  }

  private async updateRequestLocked(filePath: string, updates: Partial<CreateRequestInput>): Promise<FileOperationResult> {
    try {
      if (isYamlRequestFile(filePath)) {
        const content = await fs.readFile(filePath, 'utf-8');
        const yamlReq = parseYamlRequest(content);

        // Kind-agnostic updates apply to every kind: refusing them would make a
        // grpc or ws request uneditable, which is the same data problem from the
        // other side.
        if (updates.name) yamlReq.info.name = updates.name;
        if (updates.sequence !== undefined) yamlReq.info.seq = updates.sequence;

        // Everything below reshapes the http block. A kind that has none cannot
        // accept these, and writing them would either crash or silently graft an
        // http block onto a grpc request. Refused by name instead.
        const yamlHttp = yamlReq.http;
        if (!yamlHttp) {
          const httpOnly = (
            ['method', 'url', 'headers', 'body', 'auth', 'query', 'pathParams'] as const
          ).filter((field) => updates[field] !== undefined);
          if (httpOnly.length > 0) {
            return {
              success: false,
              path: filePath,
              error: `Cannot set ${httpOnly.join(', ')} on a "${yamlReq.info.type ?? 'unknown'}" `
                + 'request: it has no http block. Only name and sequence can be changed.',
            };
          }
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
            const authObj: Record<string, unknown> = { type: updates.auth.type };
            if (updates.auth.config) Object.assign(authObj, updates.auth.config);
            yamlHttp.auth = authObj as YamlAuth;
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

      return {
        success: true,
        path: filePath
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Create multiple related requests (CRUD operations).
   *
   * `auth` defaults to `inherit`, not `none`. Omitting it used to write an
   * explicit `auth: none` into all five files, which is not "no opinion" — it is
   * an opt-out that stops the collection's own auth block from applying, so a
   * generated set against an authenticated API returned 401 until every file was
   * edited by hand. `inherit` is what Bruno's own new-request path defaults to
   * (`bruno-app` .../slices/collections/actions.js, `auth ?? { mode: 'inherit' }`).
   * Pass `{ type: 'none', config: {} }` to opt out deliberately.
   */
  async createCrudRequests(
    collectionPath: string,
    entityName: string,
    baseUrl: string,
    folder?: string,
    auth: CreateRequestInput['auth'] = { type: 'inherit', config: {} }
  ): Promise<FileOperationResult[]> {
    const results: FileOperationResult[] = [];

    const crudOperations = [
      {
        name: `Get All ${entityName}`,
        method: 'GET' as HttpMethod,
        url: `${baseUrl}/${entityName.toLowerCase()}`,
        sequence: 1
      },
      {
        name: `Get ${entityName} by ID`,
        method: 'GET' as HttpMethod,
        url: `${baseUrl}/${entityName.toLowerCase()}/{{id}}`,
        sequence: 2
      },
      {
        name: `Create ${entityName}`,
        method: 'POST' as HttpMethod,
        url: `${baseUrl}/${entityName.toLowerCase()}`,
        body: {
          type: 'json' as BodyType,
          content: JSON.stringify({
            name: `New ${entityName}`,
            description: `Description for ${entityName}`
          }, null, 2)
        },
        headers: {
          'Content-Type': 'application/json'
        },
        sequence: 3
      },
      {
        name: `Update ${entityName}`,
        method: 'PUT' as HttpMethod,
        url: `${baseUrl}/${entityName.toLowerCase()}/{{id}}`,
        body: {
          type: 'json' as BodyType,
          content: JSON.stringify({
            name: `Updated ${entityName}`,
            description: `Updated description for ${entityName}`
          }, null, 2)
        },
        headers: {
          'Content-Type': 'application/json'
        },
        sequence: 4
      },
      {
        name: `Delete ${entityName}`,
        method: 'DELETE' as HttpMethod,
        url: `${baseUrl}/${entityName.toLowerCase()}/{{id}}`,
        sequence: 5
      }
    ];

    for (const operation of crudOperations) {
      const result = await this.createRequest({
        collectionPath,
        ...operation,
        folder,
        auth
      });
      results.push(result);
    }

    return results;
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
        type: kind === 'ws' ? 'ws' : input.body?.type === 'graphql' ? 'graphql' : 'http',
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
      const messages = this.buildBruWebsocketMessages(input.websocket?.messages);
      if (messages) bruFile.ws.messages = messages;
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

    // Add headers if provided
    if (input.headers && Object.keys(input.headers).length > 0) {
      bruFile.headers = input.headers;
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
   * The title an authored WebSocket message is written under.
   *
   * Defaulted rather than left empty because upstream's `.yml` writer switches
   * shape on it: one message with no title and some content is written as a flat
   * `message: {type, data}`, anything else as a titled variant list. `message N`
   * is upstream's own default for the variant form, so naming every authored
   * message keeps both dialects on the one shape both writers agree about,
   * instead of making the file's structure depend on how many messages there are.
   */
  private websocketMessageTitle(title: string | undefined, index: number): string {
    const trimmed = title?.trim();
    return trimmed && trimmed.length > 0 ? title as string : `message ${index + 1}`;
  }

  /**
   * Build the `.bru` `body:ws` messages from an authoring input.
   *
   * A deselected message is refused instead of written. `.bru` expresses only the
   * true half of the flag — upstream writes no line for a deselected message and
   * its reader resolves the absence to `false`, so nothing this writer emits can
   * tell "deselected" apart from "not stated". Since the WebSocket transport
   * sends a message that says nothing, writing the request as asked would produce
   * a file whose run sends a frame the caller excluded. `.yml` carries the false
   * explicitly and has no such limit.
   */
  private buildBruWebsocketMessages(
    messages: CreateWebsocketMessageInput[] | undefined,
  ): BruTransportMessage[] | undefined {
    if (!messages || messages.length === 0) return undefined;

    return messages.map((message, index) => {
      if (message.selected === false) {
        throw new BrunoError(
          `Cannot author a deselected WebSocket message ("${this.websocketMessageTitle(message.title, index)}") `
            + 'in a .bru collection: the dialect has no way to record it, and the message would be sent. '
            + 'Leave it out of the request, or use a .yml collection, which carries the flag',
          'VALIDATION_ERROR',
        );
      }

      const out: BruTransportMessage = {
        name: this.websocketMessageTitle(message.title, index),
        content: message.content,
        // Every authored message is one to send, and `.bru` says so only by
        // writing the line: Bruno's own reader treats its absence as deselected,
        // so a file authored without it would open in Bruno with nothing to send.
        selected: true,
      };
      if (message.type !== undefined) out.type = message.type;
      return out;
    });
  }

  /**
   * Build the `.yml` `websocket.message` variants from an authoring input.
   *
   * `selected` is always written, including the false: this dialect records it,
   * and for a streaming request the difference between "not selected" and "not
   * stated" decides what gets sent.
   */
  private buildYamlWebsocketMessages(
    messages: CreateWebsocketMessageInput[] | undefined,
  ): YamlRequestMessage[] | undefined {
    if (!messages || messages.length === 0) return undefined;

    return messages.map((message, index) => {
      const out: YamlRequestMessage = {
        name: this.websocketMessageTitle(message.title, index),
        content: message.content,
        selected: message.selected ?? true,
      };
      if (message.type !== undefined) out.type = message.type;
      return out;
    });
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
      const messages = this.buildYamlWebsocketMessages(input.websocket?.messages);
      if (messages) websocket.messages = messages;
      const auth = this.buildYamlAuth(input);
      if (auth !== undefined) websocket.auth = auth;
      yamlRequest.websocket = websocket;
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

    const authObj: Record<string, unknown> = { type: toBrunoAuthMode(input.auth.type) };
    if (input.auth.type === 'bearer' && input.auth.config.token) {
      authObj.token = input.auth.config.token;
    } else if (input.auth.type === 'basic') {
      if (input.auth.config.username) authObj.username = input.auth.config.username;
      if (input.auth.config.password) authObj.password = input.auth.config.password;
    } else if (input.auth.type === 'api-key') {
      if (input.auth.config.key) authObj.key = input.auth.config.key;
      if (input.auth.config.value) authObj.value = input.auth.config.value;
      // Bruno omits the key entirely when no placement was expressed, so only
      // write it when the caller actually asked for one.
      if (input.auth.config.placement ?? input.auth.config.in) {
        authObj.placement = toYamlApiKeyPlacement(input.auth.config);
      }
    }
    return authObj as YamlAuth;
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
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
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

    // The rest reshape the http block. A kind that has none — grpc, ws — cannot
    // accept them, and grafting an http block onto such a request would make it
    // unopenable in Bruno and change which host it contacts.
    const httpBlock = updated.http;
    if (!httpBlock) {
      const httpOnly = (
        ['method', 'url', 'headers', 'body', 'auth', 'query', 'pathParams'] as const
      ).filter((field) => updates[field] !== undefined);
      if (httpOnly.length > 0) {
        throw new BrunoError(
          `Cannot set ${httpOnly.join(', ')} on a "${updated.meta.type}" request: `
            + 'it has no http block. Only name and sequence can be changed.',
          'VALIDATION_ERROR',
        );
      }
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

    if (updates.assert) {
      updated.assertions = assertionsToBru(updates.assert);
    }

    if (updates.vars) {
      updated.varSets = varsToBruVarSets(updates.vars, updated.varSets);
    }

    if (updates.settings) {
      updated.settings = mergeRequestSettings(updated.settings, updates.settings);
    }

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
      httpBlock.auth = toBrunoAuthMode(updates.auth.type);
      updated.auth = {
        type: updates.auth.type
      };

      // Carry the credential fields over from updates.auth.config so a modify
      // that touches auth updates the secret instead of wiping it. Mirror the
      // creation path (buildBruFile) so the persisted shape stays identical.
      const config = updates.auth.config || {};
      switch (updates.auth.type) {
        case 'bearer':
          updated.auth.bearer = {
            token: config.token || '{{token}}'
          };
          break;
        case 'basic':
          updated.auth.basic = {
            username: config.username || '{{username}}',
            password: config.password || '{{password}}'
          };
          break;
        case 'api-key':
          updated.auth.apikey = {
            key: config.key || 'X-API-Key',
            value: config.value || '{{apiKey}}',
            placement: toBruApiKeyPlacement(config)
          };
          break;
      }
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
    if (kind === 'ws') {
      if (input.method !== undefined) {
        throw new BrunoError(
          'A WebSocket request has no HTTP method: remove `method`, or use kind `http`',
          'VALIDATION_ERROR',
        );
      }
      const httpOnly = (['body', 'query', 'pathParams'] as const).filter(
        (field) => input[field] !== undefined,
      );
      if (httpOnly.length > 0) {
        throw new BrunoError(
          `A WebSocket request cannot carry ${httpOnly.join(', ')}: its payload is `
            + '`websocket.messages`, and it has no query or path parameters',
          'VALIDATION_ERROR',
        );
      }
    } else {
      if (input.websocket !== undefined) {
        throw new BrunoError(
          'The `websocket` object applies to kind `ws` only',
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
}

/**
 * Create a new request builder instance
 */
export function createRequestBuilder(): RequestBuilder {
  return new RequestBuilder();
}