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
  BruHeader,
  YamlAuth,
  BruParam,
  YamlParam,
  BruAssertion,
  BruVar,
  BruVarSets,
  YamlAssertion,
  YamlVar,
  YamlVars,
  RequestAssertionInput,
  RequestVarInput,
  CreateRequestInput,
  FileOperationResult,
  BrunoError,
  BruFileError,
  HttpMethod,
  AuthType,
  BruAuthMode,
  BodyType
} from './types.js';
import { MultipartFormPart, BruBody, BruGraphql, FormUrlEncodedPart, YamlBody } from './types.js';
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

/**
 * Turn a form-urlencoded body into the entries upstream's serializer reads.
 *
 * Upstream expects `body.formUrlEncoded` to be an array of {name, value,
 * enabled}. Handing it the raw `content` string wrote no block at all, so an
 * authored body was silently dropped and the request went out empty.
 *
 * Both shapes a caller might reasonably send are accepted: explicit entries via
 * `formData`, or an encoded string via `content`. The string is parsed with
 * URLSearchParams, so percent-escapes and `+` resolve the way they would on the
 * wire rather than being stored literally.
 */
/**
 * Move a parsed `.yml` body onto the BruBody field that matches its payload.
 *
 * `YamlBody.data` is a union: payload text for the text-ish types, a
 * `{ query, variables }` mapping for graphql, and a list of parts for the two
 * form types. BruBody keeps each of those in a different field, so a caller that
 * only reads `content` sees nothing at all for graphql and form bodies — and
 * loadRequest feeds modify_request, which writes the request back out. Keeping
 * only the string meant editing a header on a graphql request silently dropped
 * its query.
 */
function yamlBodyToBruBody(body: YamlBody): BruBody {
  const type = body.type as BodyType;
  const data = body.data;

  if (typeof data === 'string') {
    return { type, content: data };
  }

  if (Array.isArray(data)) {
    // Both form types arrive as a list of parts; only the declared type says
    // which kind of part it is.
    return type === 'form-urlencoded'
      ? { type, formUrlEncoded: data as FormUrlEncodedPart[] }
      : { type, formData: data as MultipartFormPart[] };
  }

  if (data && typeof data === 'object') {
    return { type, graphql: data as BruGraphql };
  }

  return { type };
}

function toFormUrlEncodedEntries(
  body: NonNullable<CreateRequestInput['body']>,
): Array<{ name: string; value: string; enabled: boolean }> | undefined {
  if (body.formData && body.formData.length > 0) {
    return body.formData.map((field) => ({
      name: field.name,
      value: Array.isArray(field.value) ? field.value.join(',') : field.value,
      enabled: field.enabled !== false,
    }));
  }
  if (typeof body.content === 'string' && body.content.length > 0) {
    return [...new URLSearchParams(body.content)].map(([name, value]) => ({
      name,
      value,
      enabled: true,
    }));
  }
  return undefined;
}

/**
 * Build the stored body for a .bru request from what a caller supplied.
 *
 * Two of Bruno's body modes are not plain strings, and every write path here
 * used to treat them as one. `graphql` is stored as `{ query, variables? }`, and
 * a bare string makes upstream's `body.graphql.query` test fail, so the block is
 * skipped and the query text is lost while the method header still claims
 * `body: graphql`. `file` is stored as a list of parts and upstream filters it,
 * so a bare string throws outright. Both are translated here from `content`,
 * which is the only field the tool surface offers for them.
 *
 * Create and modify both call this. They previously built the body separately
 * and had already drifted — create handled multipart parts and modify did not —
 * so keeping one builder is the point rather than an incidental tidy-up.
 *
 * Not expressible through `content` alone, and so not authorable: a graphql
 * `variables` block, and a file body's per-part `contentType` or disabled flag.
 * Those survive a round-trip when Bruno wrote them, but nothing here can add
 * them.
 */
function toBruBody(source: NonNullable<CreateRequestInput['body']>): BruBody {
  const body: BruBody = {
    type: source.type,
    content: source.content,
  };

  if (source.type === 'form-urlencoded') {
    body.formUrlEncoded = toFormUrlEncodedEntries(source);
  }

  if (source.formData) {
    body.formData = source.formData.map((field) => {
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

  if (source.type === 'graphql' && source.content) {
    body.graphql = { query: source.content };
  }

  if (source.type === 'file' && source.content) {
    body.file = [{ filePath: source.content }];
  }

  return body;
}

/**
 * The auth mode token as Bruno spells it, in either file format.
 *
 * Only api-key differs: Bruno writes `apikey` in both the `.bru` `auth:apikey`
 * block and the `.yml` `auth.type`, and its readers match that one spelling
 * exactly. Emitting the hyphenated `api-key` makes Bruno match nothing and
 * discard the whole auth block, so the request goes out unauthenticated. The
 * tool surface keeps the hyphenated name, which is only ours.
 */
function toBrunoAuthMode(type: AuthType | undefined): BruAuthMode {
  if (!type) return 'none';
  return type === 'api-key' ? 'apikey' : type;
}

/**
 * Bruno's api-key placement, from either spelling.
 *
 * Bruno's vocabulary is `header` / `queryparams`; this server used to say
 * `header` / `query`. Callers may pass either, and the legacy one is translated
 * rather than written through.
 */
function toBruApiKeyPlacement(config: Record<string, string>): 'header' | 'queryparams' {
  const raw = config.placement ?? config.in;
  return raw === 'queryparams' || raw === 'query' ? 'queryparams' : 'header';
}

/**
 * Bruno's api-key placement as the `.yml` format spells it on disk.
 *
 * The two formats do NOT share this vocabulary: `.bru` stores `queryparams`
 * while `.yml` stores `query` for the same placement. Bruno's yml writer maps
 * its internal `queryparams` down to `query`, and its yml reader maps `query`
 * back up again, so writing `queryparams` into a `.yml` file matches neither
 * branch and the placement is dropped. `.yml` also names the key `placement`,
 * not `in`.
 */
function toYamlApiKeyPlacement(config: Record<string, string>): 'header' | 'query' {
  const raw = config.placement ?? config.in;
  return raw === 'queryparams' || raw === 'query' ? 'query' : 'header';
}

/**
 * Fold a partial name/value map into a .bru request's full header list.
 *
 * The generator writes headers from `headersList` whenever that list is
 * populated and only falls back to the `headers` map when it is empty, so
 * merging into the map alone is discarded for any request that already has at
 * least one header. Both views have to move together.
 *
 * A name present in the map is set and armed, because `headers` is the
 * enabled-only view of the request. Headers the caller did not mention keep
 * their current value and flag. Note BruHeader spells the flag `enabled`, the
 * opposite polarity from YamlHeader's `disabled`.
 *
 * Arming drops the flag rather than setting it to true, matching how the parser
 * records state: only `enabled: false` is ever stored, and an absent flag means
 * enabled.
 */
function mergeBruHeaderList(
  existing: BruHeader[] | undefined,
  updates: Record<string, string>,
): BruHeader[] {
  const merged: BruHeader[] = [...(existing ?? [])];
  for (const [name, value] of Object.entries(updates)) {
    const at = merged.findIndex((header) => header.name === name);
    if (at >= 0) {
      const { enabled: _wasEnabled, ...rest } = merged[at];
      merged[at] = { ...rest, value };
    } else {
      merged.push({ name, value });
    }
  }
  return merged;
}

/**
 * Fold a partial name/value map into a .yml request's header list.
 *
 * Rebuilding the list from the map alone deleted every header the caller did
 * not mention, and rebuilding each entry as a bare name/value pair cleared the
 * `disabled` flag on the ones it did — silently re-arming a header the author
 * had switched off, a credential header included.
 *
 * A name present in the map is set and armed, matching the .bru behaviour. The
 * flag is removed rather than set to undefined, because an explicit
 * `disabled: undefined` is still a present key and would be written out.
 */
function mergeYamlHeaderList(
  existing: YamlHeader[] | undefined,
  updates: Record<string, string>,
): YamlHeader[] {
  const merged: YamlHeader[] = [...(existing ?? [])];
  for (const [name, value] of Object.entries(updates)) {
    const at = merged.findIndex((header) => header.name === name);
    if (at >= 0) {
      const { disabled: _wasDisabled, ...rest } = merged[at];
      merged[at] = { ...rest, value };
    } else {
      merged.push({ name, value });
    }
  }
  return merged;
}

/** The mirror of replaceQueryParams: swap the path entries, keep the query ones. */
function replacePathParams<T extends { type?: string }>(existing: T[] | undefined, fresh: T[]): T[] {
  const queries = (existing ?? []).filter((param) => param.type !== 'path');
  return [...queries, ...fresh];
}

/** Turn the tool's `pathParams` record into .bru parameter entries. */
function pathParamsToBruParams(
  pathParams: NonNullable<CreateRequestInput['pathParams']>,
): BruParam[] {
  return Object.entries(pathParams).map(([name, value]) => ({
    name,
    value: String(value),
    enabled: true,
    type: 'path' as const,
  }));
}

/** Turn the tool's `pathParams` record into .yml parameter entries. */
function pathParamsToYamlParams(
  pathParams: NonNullable<CreateRequestInput['pathParams']>,
): YamlParam[] {
  return Object.entries(pathParams).map(([name, value]) => ({
    name,
    value: String(value),
    type: 'path' as const,
  }));
}

/**
 * Turn declared assertions into a .bru `assert` block.
 *
 * The tool surface carries `disabled`; .bru carries `enabled`. Inverting here
 * rather than at the parser keeps one spelling on the outside.
 */
function assertionsToBru(entries: RequestAssertionInput[]): BruAssertion[] {
  return entries.map((entry) => ({
    name: entry.name,
    value: entry.value,
    enabled: entry.disabled !== true,
  }));
}

/** Turn declared assertions into a .yml `assert` block, which already uses `disabled`. */
function assertionsToYaml(entries: RequestAssertionInput[]): YamlAssertion[] {
  return entries.map((entry) => ({
    name: entry.name,
    value: entry.value,
    ...(entry.disabled === true ? { disabled: true } : {}),
  }));
}

/**
 * Turn declared vars into .bru `vars:pre-request` / `vars:post-response` blocks.
 *
 * Only the halves that were supplied are written, and each half is replaced
 * whole: they mean different things, so naming one must not discard the other.
 */
function varsToBruVarSets(
  vars: NonNullable<CreateRequestInput['vars']>,
  existing: BruVarSets | undefined,
): BruVarSets {
  const convert = (entries: RequestVarInput[]): BruVar[] =>
    entries.map((entry) => ({
      name: entry.name,
      value: entry.value,
      enabled: entry.disabled !== true,
      ...(entry.local === true ? { local: true } : {}),
    }));
  return {
    ...existing,
    ...(vars.preRequest ? { req: convert(vars.preRequest) } : {}),
    ...(vars.postResponse ? { res: convert(vars.postResponse) } : {}),
  };
}

/** Turn declared vars into a .yml `vars` block. Same per-half replacement. */
function varsToYamlVars(
  vars: NonNullable<CreateRequestInput['vars']>,
  existing: YamlVars | undefined,
): YamlVars {
  const convert = (entries: RequestVarInput[]): YamlVar[] =>
    entries.map((entry) => ({
      name: entry.name,
      value: entry.value,
      ...(entry.disabled === true ? { disabled: true } : {}),
      ...(entry.local === true ? { local: true } : {}),
    }));
  return {
    ...existing,
    ...(vars.preRequest ? { preRequest: convert(vars.preRequest) } : {}),
    ...(vars.postResponse ? { postResponse: convert(vars.postResponse) } : {}),
  };
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
          yamlReq.http.headers = mergeYamlHeaderList(yamlReq.http.headers, updates.headers);
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

    // Add body if provided
    if (input.body && input.body.type !== 'none') {
      bruFile.body = toBruBody(input.body);
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

    // Add auth
    if (input.auth && input.auth.type !== 'none') {
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

    if (updates.body) {
      updated.http.body = updates.body.type;
      updated.body = toBruBody(updates.body);
    }

    if (updates.auth) {
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