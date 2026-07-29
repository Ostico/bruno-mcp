/**
 * Bruno request builder
 * Handles creation and management of .bru request files
 */

import { promises as fs } from 'fs';
import { writeFileAtomic } from './atomic-write.js';
import { withPathLock } from './path-mutex.js';
import { join, dirname, isAbsolute } from 'path';
import { validatePath } from './path-validator.js';
import {
  BruFile,
  BruAuth,
  YamlRequest,
  YamlHeader,
  YamlAuth,
  BruParam,
  YamlParam,
  CreateRequestInput,
  FileOperationResult,
  BrunoError,
  BruFileError,
  HttpMethod,
  AuthType,
  BodyType
} from './types.js';
import { MultipartFormPart } from './types.js';
import { detectFormat } from './format-detector.js';
import type { CollectionFormat } from './format-detector.js';
import { createWriter, normalizeScriptType } from './format-factory.js';

/** True for body types that serialize as multipart/form-data. */
function isMultipartBodyType(type: string): boolean {
  return type === 'form-data' || type === 'multipart-form';
}

/** Normalize input form-data parts into the canonical multipart YAML shape. */
function toMultipartData(parts: MultipartFormPart[]): MultipartFormPart[] {
  return parts.map((part) => {
    const normalized: MultipartFormPart = {
      name: part.name,
      value: part.value,
      type: part.type ?? 'text',
    };
    if (part.contentType) normalized.contentType = part.contentType;
    return normalized;
  });
}

/**
 * Turn the tool's `query` record into .bru parameter entries.
 *
 * The two formats spell the switched-off flag with opposite polarity, so the
 * .bru side sets `enabled: true` where the .yml side simply omits `disabled`.
 */
function queryToBruParams(query: NonNullable<CreateRequestInput['query']>): BruParam[] {
  return Object.entries(query).map(([name, value]) => ({
    name,
    value: String(value),
    enabled: true,
    type: 'query' as const,
  }));
}

/** Turn the tool's `query` record into .yml parameter entries. */
function queryToYamlParams(query: NonNullable<CreateRequestInput['query']>): YamlParam[] {
  return Object.entries(query).map(([name, value]) => ({
    name,
    value: String(value),
    type: 'query' as const,
  }));
}

/**
 * Replace the query parameters while leaving path parameters alone.
 *
 * `query` is replaced wholesale, the way `headers` already is on this path. Path
 * parameters address a different part of the URL and are never named by the
 * `query` input, so wiping them would be collateral damage from an unrelated
 * edit.
 */
function replaceQueryParams<T extends { type?: string }>(existing: T[] | undefined, fresh: T[]): T[] {
  const paths = (existing ?? []).filter((param) => param.type === 'path');
  return [...paths, ...fresh];
}
import { generateYamlRequest } from './yaml-generator.js';
import { parseBruRequest, generateBruRequest } from './bru-parser.js';
import { parseYamlRequest } from './yaml-parser.js';

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

      if (detection.format === 'yaml') {
        // Build YAML request and write .yml file
        const yamlRequest = this.buildYamlRequest(input);
        const filePath = this.getRequestFilePath(input, '.yml');
        await this.ensureDirectory(dirname(filePath));
        const yamlContent = generateYamlRequest(yamlRequest);
        await writeFileAtomic(filePath, yamlContent);
        if (input.scripts) {
          await this.applyInlineScripts(filePath, detection.format, input.scripts);
        }
        return { success: true, path: filePath };
      } else {
        // Build BRU file structure and write .bru file
        const bruFile = this.buildBruFile(input);
        const filePath = this.getRequestFilePath(input, '.bru');
        await this.ensureDirectory(dirname(filePath));
        const bruContent = generateBruRequest(bruFile);
        await writeFileAtomic(filePath, bruContent);
        if (input.scripts) {
          await this.applyInlineScripts(filePath, detection.format, input.scripts);
        }
        return { success: true, path: filePath };
      }

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

      if (filePath.endsWith('.yml')) {
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
          bruFile.body = {
            type: yamlReq.http.body.type as BodyType,
            content: typeof yamlReq.http.body.data === 'string' ? yamlReq.http.body.data : undefined,
          };
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
      } else if (filePath.endsWith('.bru')) {
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
      if (filePath.endsWith('.yml')) {
        const content = await fs.readFile(filePath, 'utf-8');
        const yamlReq = parseYamlRequest(content);

        if (updates.name) yamlReq.info.name = updates.name;
        if (updates.sequence !== undefined) yamlReq.info.seq = updates.sequence;
        if (updates.method) yamlReq.http.method = updates.method;
        if (updates.url) yamlReq.http.url = updates.url;
        if (updates.headers) {
          yamlReq.http.headers = Object.entries(updates.headers).map(
            ([name, value]): YamlHeader => ({ name, value }),
          );
        }
        if (updates.body && updates.body.type !== 'none') {
          if (isMultipartBodyType(updates.body.type) && updates.body.formData) {
            yamlReq.http.body = {
              type: 'multipart-form',
              data: toMultipartData(updates.body.formData),
            };
          } else {
            yamlReq.http.body = { type: updates.body.type, data: updates.body.content };
          }
        }
        if (updates.auth && updates.auth.type !== 'none') {
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

        const updatedContent = generateYamlRequest(yamlReq);
        await writeFileAtomic(filePath, updatedContent);
      } else if (filePath.endsWith('.bru')) {
        // Load existing BRU request
        const existingBru = await this.loadRequest(filePath);

        // Apply updates
        const updatedBru = this.applyUpdates(existingBru, updates);

        // Generate and write updated content
        const bruContent = generateBruRequest(updatedBru);
        await writeFileAtomic(filePath, bruContent);
      }

      if (updates.scripts) {
        const format: CollectionFormat = filePath.endsWith('.yml') ? 'yaml' : 'bru';
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
          config: authType === 'bearer' ? { token: '{{token}}' } : { username: '{{username}}', password: '{{password}}' }
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
          config: authType === 'bearer' ? { token: '{{token}}' } : { username: '{{username}}', password: '{{password}}' }
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
        seq: input.sequence
      },
      http: {
        method: input.method,
        url: input.url,
        body: input.body?.type || 'none',
        auth: input.auth?.type || 'none'
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

    // Add body if provided
    if (input.body && input.body.type !== 'none') {
      bruFile.body = {
        type: input.body.type,
        content: input.body.content
      };

      // Handle form data
      if (input.body.formData) {
        bruFile.body.formData = input.body.formData.map(field => {
          const part: MultipartFormPart = {
            name: field.name,
            value: field.value,
            type: field.type || 'text',
            enabled: true,
          };
          if (field.contentType) part.contentType = field.contentType;
          return part;
        });
      }
    }

    // Add authentication if provided
    if (input.auth && input.auth.type !== 'none') {
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
            in: (input.auth.config.in as 'header' | 'query') || 'header'
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
      if (isMultipartBodyType(input.body.type) && input.body.formData) {
        yamlRequest.http.body = {
          type: 'multipart-form',
          data: toMultipartData(input.body.formData),
        };
      } else {
        yamlRequest.http.body = {
          type: input.body.type,
          data: input.body.content,
        };
      }
    }

    // Add query params
    if (input.query && Object.keys(input.query).length > 0) {
      yamlRequest.http.params = queryToYamlParams(input.query);
    }

    // Add auth
    if (input.auth && input.auth.type !== 'none') {
      const authObj: Record<string, unknown> = { type: input.auth.type };
      if (input.auth.type === 'bearer' && input.auth.config.token) {
        authObj.token = input.auth.config.token;
      } else if (input.auth.type === 'basic') {
        if (input.auth.config.username) authObj.username = input.auth.config.username;
        if (input.auth.config.password) authObj.password = input.auth.config.password;
      } else if (input.auth.type === 'api-key') {
        if (input.auth.config.key) authObj.key = input.auth.config.key;
        if (input.auth.config.value) authObj.value = input.auth.config.value;
        if (input.auth.config.in) authObj.in = input.auth.config.in;
      }
      yamlRequest.http.auth = authObj as YamlAuth;
    }

    return yamlRequest;
  }

  /**
   * Get file path for request
   */
  private resolveAuthType(auth: YamlAuth | undefined): AuthType {
    if (!auth) return 'none';
    if (typeof auth === 'string') return auth === 'inherit' ? 'none' : auth as AuthType;
    return (auth.type as AuthType) ?? 'none';
  }

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
    }

    if (updates.query) {
      updated.params = replaceQueryParams(updated.params, queryToBruParams(updates.query));
    }

    if (updates.body) {
      updated.http.body = updates.body.type;
      updated.body = {
        type: updates.body.type,
        content: updates.body.content
      };
    }

    if (updates.auth) {
      updated.http.auth = updates.auth.type;
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
            in: (config.in as 'header' | 'query') || 'header'
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