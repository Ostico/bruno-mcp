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
  FileOperationResult,
  BrunoError,
  BruFileError,
  HttpMethod,
  AuthType,
  BodyType
} from './types.js';
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
        const bruFile: BruFile = {
          meta: {
            name: yamlReq.info.name,
            type: (yamlReq.info.type as 'http' | 'graphql') || 'http',
            seq: yamlReq.info.seq,
          },
          http: {
            method: yamlReq.http.method as HttpMethod,
            url: yamlReq.http.url,
            body: (yamlReq.http.body?.type as BodyType) || 'none',
            auth: this.resolveAuthType(yamlReq.http.auth),
          },
        };

        if (yamlReq.http.headers && yamlReq.http.headers.length > 0) {
          bruFile.headers = {};
          for (const h of yamlReq.http.headers) {
            bruFile.headers[h.name] = h.value;
          }
        }

        if (yamlReq.http.body && yamlReq.http.body.type !== 'none') {
          bruFile.body = yamlBodyToBruBody(yamlReq.http.body);
        }

        if (yamlReq.http.auth && typeof yamlReq.http.auth !== 'string') {
          bruFile.auth = yamlReq.http.auth as BruAuth;
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

        if (updates.name) yamlReq.info.name = updates.name;
        if (updates.sequence !== undefined) yamlReq.info.seq = updates.sequence;
        if (updates.method) yamlReq.http.method = updates.method;
        if (updates.url) yamlReq.http.url = updates.url;
        if (updates.headers) {
          yamlReq.http.headers = mergeYamlHeaderList(yamlReq.http.headers, updates.headers);
        }
        if (updates.body && updates.body.type !== 'none') {
          yamlReq.http.body = toYamlBody(updates.body);
        }
        if (updates.auth?.type === 'inherit') {
          // The bare token, not a mapping: see the same branch on the create path.
          yamlReq.http.auth = 'inherit';
        } else if (updates.auth && updates.auth.type !== 'none') {
          const authObj: Record<string, unknown> = { type: updates.auth.type };
          if (updates.auth.config) Object.assign(authObj, updates.auth.config);
          yamlReq.http.auth = authObj as YamlAuth;
        }
        if (updates.query) {
          yamlReq.http.params = replaceQueryParams(
            yamlReq.http.params,
            queryToYamlParams(updates.query),
          );
        }
        if (updates.pathParams) {
          yamlReq.http.params = replacePathParams(
            yamlReq.http.params,
            pathParamsToYamlParams(updates.pathParams),
          );
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
   * Create multiple related requests (CRUD operations)
   */
  async createCrudRequests(
    collectionPath: string,
    entityName: string,
    baseUrl: string,
    folder?: string
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
        folder
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
    const bruFile: BruFile = {
      meta: {
        name: input.name,
        type: 'http',
        // Absent has to mean an absent KEY, not a key holding undefined:
        // upstream's serializer writes `${key}: ${meta[key]}` for everything
        // present, so leaving it here emits the literal text "seq: undefined".
        ...(input.sequence !== undefined ? { seq: input.sequence } : {})
      },
      http: {
        method: input.method,
        url: input.url,
        body: input.body?.type || 'none',
        auth: toBrunoAuthMode(input.auth?.type)
      }
    };

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
   * Build a YamlRequest from CreateRequestInput
   */
  private buildYamlRequest(input: CreateRequestInput): YamlRequest {
    const yamlRequest: YamlRequest = {
      info: {
        name: input.name,
        type: 'http',
        seq: input.sequence,
      },
      http: {
        method: input.method,
        url: input.url,
      },
    };

    // Add headers
    if (input.headers && Object.keys(input.headers).length > 0) {
      yamlRequest.http.headers = Object.entries(input.headers).map(
        ([name, value]): YamlHeader => ({ name, value }),
      );
    }

    // Add body
    if (input.body && input.body.type !== 'none') {
      yamlRequest.http.body = toYamlBody(input.body);
    }

    // Add query params
    if (input.query && Object.keys(input.query).length > 0) {
      yamlRequest.http.params = queryToYamlParams(input.query);
    }

    // Path parameters share the `params` field, distinguished by `type`.
    if (input.pathParams && Object.keys(input.pathParams).length > 0) {
      yamlRequest.http.params = [
        ...(yamlRequest.http.params ?? []),
        ...pathParamsToYamlParams(input.pathParams),
      ];
    }

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

    // Add auth
    if (input.auth?.type === 'inherit') {
      // Bruno writes inherit as the bare token, not as a mapping with a type key:
      // there is no local credential to carry, only the instruction to look up the
      // tree. A `{ type: inherit }` mapping is not what its reader matches.
      yamlRequest.http.auth = 'inherit';
    } else if (input.auth && input.auth.type !== 'none') {
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
      yamlRequest.http.auth = authObj as YamlAuth;
    }

    return yamlRequest;
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

    if (updates.name) {
      updated.meta.name = updates.name;
    }

    if (updates.sequence !== undefined) {
      updated.meta.seq = updates.sequence;
    }

    if (updates.method) {
      updated.http.method = updates.method;
    }

    if (updates.url) {
      updated.http.url = updates.url;
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
      updated.http.body = updates.body.type;
      updated.body = toBruBody(updates.body);
    }

    if (updates.auth?.type === 'inherit') {
      // Switching to inherit leaves no local credential, so the block goes with
      // the mode instead of being replaced by a typed-but-empty one. A file that
      // says inherit in the http block must not carry a credential underneath it.
      updated.http.auth = 'inherit';
      delete updated.auth;
    } else if (updates.auth) {
      updated.http.auth = toBrunoAuthMode(updates.auth.type);
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

    if (!input.method) {
      throw new BrunoError('HTTP method is required', 'VALIDATION_ERROR');
    }

    if (!input.url || input.url.trim().length === 0) {
      throw new BrunoError('URL is required', 'VALIDATION_ERROR');
    }

    // Validate HTTP method
    const validMethods: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
    if (!validMethods.includes(input.method)) {
      throw new BrunoError(
        `Invalid HTTP method: ${input.method}`,
        'VALIDATION_ERROR'
      );
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