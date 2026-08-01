/**
 * Conversion of MCP tool input into the two dialects' request models.
 *
 * These helpers are the only place that knows how a field spelled one way in a
 * tool call is spelled in a `.bru` file and in a `.yml` file. They are pure:
 * input in, model out, no filesystem. Split out of request.ts, which had grown
 * past the point where the builder class and the format knowledge could both
 * be read in one sitting.
 */

import {
  BruAssertion,
  BruAuthMode,
  BruBody,
  BruGraphql,
  BruHeader,
  BruParam,
  BruVar,
  BruVarSets,
  BodyType,
  AuthType,
  CreateRequestInput,
  FormUrlEncodedPart,
  MultipartFormPart,
  RequestAssertionInput,
  RequestVarInput,
  YamlAssertion,
  YamlBody,
  YamlHeader,
  YamlParam,
  YamlVar,
  YamlVars,
} from './types.js';

/** True for body types that serialize as multipart/form-data. */
export function isMultipartBodyType(type: string): boolean {
  return type === 'form-data' || type === 'multipart-form';
}

/** Normalize input form-data parts into the canonical multipart YAML shape. */
export function toMultipartData(parts: MultipartFormPart[]): MultipartFormPart[] {
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
export function queryToBruParams(query: NonNullable<CreateRequestInput['query']>): BruParam[] {
  return Object.entries(query).map(([name, value]) => ({
    name,
    value: String(value),
    enabled: true,
    type: 'query' as const,
  }));
}

/** Turn the tool's `query` record into .yml parameter entries. */
export function queryToYamlParams(query: NonNullable<CreateRequestInput['query']>): YamlParam[] {
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
export function replaceQueryParams<T extends { type?: string }>(existing: T[] | undefined, fresh: T[]): T[] {
  const paths = (existing ?? []).filter((param) => param.type === 'path');
  return [...paths, ...fresh];
}

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
export function yamlBodyToBruBody(body: YamlBody): BruBody {
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

/**
 * Turn a form-urlencoded body into entries a serializer can write.
 *
 * Both storage formats keep this body as a list of pairs, never as the raw
 * string a caller supplies. Handing a serializer the `content` string wrote no
 * block at all, so an authored body was silently dropped and the request went
 * out empty.
 *
 * Both shapes a caller might reasonably send are accepted: explicit entries via
 * `formData`, or an encoded string via `content`. The string is parsed with
 * URLSearchParams, so percent-escapes and `+` resolve the way they would on the
 * wire rather than being stored literally.
 *
 * The `enabled` flag here is the in-memory spelling, used by both formats. It
 * is inverted on the way to a `.yml` file, which stores `disabled: true` and
 * nothing at all for an enabled pair — see serialiseBody in yaml-generator.ts.
 */
export function toFormUrlEncodedEntries(
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
 * Build the stored body for a `.yml` request from what a caller supplied.
 *
 * Only the text-ish types are stored as the `content` string they arrive as.
 * The two list-shaped types are not, and routing them through `content` wrote
 * `data: undefined` — a body block naming a type with no payload under it. The
 * executor has no encoder for that, so the request went out with no body at
 * all, and the run reported whatever status the server returns for an empty
 * request as though it were the answer to the body the author wrote.
 *
 * Create and modify both call this. They previously built the body inline and
 * identically, which is how the same defect came to exist twice.
 */
export function toYamlBody(source: NonNullable<CreateRequestInput['body']>): YamlBody {
  if (isMultipartBodyType(source.type) && source.formData) {
    return { type: 'multipart-form', data: toMultipartData(source.formData) };
  }
  if (source.type === 'form-urlencoded') {
    // The entries carry `enabled`, which is the in-memory spelling; the
    // generator inverts it to the `disabled` key Bruno writes. They carry no
    // `type` key, which is what distinguishes a form-urlencoded pair from a
    // multipart part on disk.
    return { type: 'form-urlencoded', data: toFormUrlEncodedEntries(source) };
  }
  return { type: source.type, data: source.content };
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
export function toBruBody(source: NonNullable<CreateRequestInput['body']>): BruBody {
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
export function toBrunoAuthMode(type: AuthType | undefined): BruAuthMode {
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
export function toBruApiKeyPlacement(config: Record<string, string>): 'header' | 'queryparams' {
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
export function toYamlApiKeyPlacement(config: Record<string, string>): 'header' | 'query' {
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
export function mergeBruHeaderList(
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
export function mergeYamlHeaderList(
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
export function replacePathParams<T extends { type?: string }>(existing: T[] | undefined, fresh: T[]): T[] {
  const queries = (existing ?? []).filter((param) => param.type !== 'path');
  return [...queries, ...fresh];
}

/** Turn the tool's `pathParams` record into .bru parameter entries. */
export function pathParamsToBruParams(
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
export function pathParamsToYamlParams(
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
export function assertionsToBru(entries: RequestAssertionInput[]): BruAssertion[] {
  return entries.map((entry) => ({
    name: entry.name,
    value: entry.value,
    enabled: entry.disabled !== true,
  }));
}

/** Turn declared assertions into a .yml `assert` block, which already uses `disabled`. */
export function assertionsToYaml(entries: RequestAssertionInput[]): YamlAssertion[] {
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
export function varsToBruVarSets(
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
export function varsToYamlVars(
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