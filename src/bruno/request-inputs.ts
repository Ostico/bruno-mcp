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
  BruFilePart,
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
  RequestSettingsInput,
  TimeoutSetting,
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
 * loadRequest feeds write_request, which writes the request back out. Keeping
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
/**
 * Refuse a graphql body that carries no query text.
 *
 * The opposite of how the run path treats the same state, and deliberately so.
 * Sending an empty query matches upstream and earns a server rejection that a
 * caller can read; *writing* one produces a file that reports success and can
 * only ever fail, with the reason sitting in a block the caller did not think
 * they were authoring. `variables` without a query is the case that reached
 * disk: the writer filled the query in as `''` and said nothing.
 *
 * Whitespace counts as absent. A query of spaces is not a query, and treating
 * it as one only moves the failure to the server.
 */
export function assertGraphqlBodyHasQuery(source: NonNullable<CreateRequestInput['body']>): void {
  if (source.type !== 'graphql' || (source.content ?? '').trim() !== '') return;
  throw new Error(
    'A graphql body needs a query. Pass the query text as `content`. Variables on their own ' +
      'write a request that sends `{"query":""}` and can only fail at the server.',
  );
}

/**
 * Refuse a form-urlencoded body whose parts describe a multipart part.
 *
 * `formData` is the only key/value field on the body input, so it carries the
 * pairs of a form-urlencoded body as well as the parts of a multipart one. What
 * is stored for the two differs: a form-urlencoded pair is a name, a value and
 * an enabled flag, and neither dialect has anywhere to put a part `type` or a
 * `contentType`. Both were accepted and dropped, so a caller who said `type:
 * "file"` got a text pair with the same name and no indication that the request
 * cannot send the file.
 *
 * `type: "text"` is accepted, because it agrees with what is stored: it says
 * the same thing the absent key does. Only the two fields that cannot survive
 * are refused, and the message names the body type that can carry them.
 */
export function assertFormUrlEncodedPartsAreText(
  source: NonNullable<CreateRequestInput['body']>,
): void {
  if (source.type !== 'form-urlencoded') return;
  for (const field of source.formData ?? []) {
    if (field.type !== undefined && field.type !== 'text') {
      throw new Error(
        `A form-urlencoded pair cannot have type "${field.type}": the body stores a name and `
          + `a value, so "${field.name}" would go out as text. Use body.type "multipart-form" `
          + 'for a file part.',
      );
    }
    if (field.contentType !== undefined) {
      throw new Error(
        `A form-urlencoded pair cannot carry a contentType: "${field.name}" would lose it. The `
          + 'body has one Content-Type of its own; use body.type "multipart-form" to type a '
          + 'part.',
      );
    }
  }
}

export function toYamlBody(source: NonNullable<CreateRequestInput['body']>): YamlBody {
  assertGraphqlBodyHasQuery(source);
  assertFormUrlEncodedPartsAreText(source);
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
  if (source.type === 'file') {
    // A list of parts on disk, never a path string: Bruno's `.yml` reader takes
    // `filePath` off each entry. Writing the path as `data` produced a file
    // whose body block Bruno reads as no files at all.
    return { type: 'file', data: toFilePartList(source) };
  }
  if (source.type === 'graphql' && source.variables) {
    // Only when there are variables. Without them the bare string is what this
    // server has always written and what the graphql block reader already
    // accepts, so widening it unconditionally would rewrite every existing
    // graphql request for no gain.
    return { type: 'graphql', data: { query: source.content ?? '', variables: source.variables } };
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
  assertGraphqlBodyHasQuery(source);
  assertFormUrlEncodedPartsAreText(source);
  const body: BruBody = {
    type: source.type,
    content: source.content,
  };

  if (source.type === 'form-urlencoded') {
    body.formUrlEncoded = toFormUrlEncodedEntries(source);
  }

  // Only for a body type that has multipart parts. `formData` is also how a
  // form-urlencoded body's pairs arrive, and an unguarded test wrote them twice:
  // once as the pairs above, and once as a `body:multipart-form` block, because
  // upstream's `.bru` writer emits that block whenever the model holds
  // `formData` and never looks at the mode. Bruno reads the mode from the http
  // block, so the second block changed nothing about the request — it just sat
  // in the file, and came back out of read_request as multipart parts the caller
  // had not authored.
  if (isMultipartBodyType(source.type) && source.formData) {
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

  if (source.type === 'graphql' && (source.content || source.variables)) {
    const graphql: BruGraphql = { query: source.content ?? '' };
    // Raw text through to `body:graphql:vars`. Parsing it would reformat the
    // author's JSON on the way back out and break a `{{placeholder}}` that is
    // not valid JSON on its own.
    if (source.variables) graphql.variables = source.variables;
    body.graphql = graphql;
  }

  if (source.type === 'file') {
    const files = toFilePartList(source);
    if (files.length > 0) body.file = files;
  }

  return body;
}

/**
 * A file body's parts, from either spelling the caller may use.
 *
 * `files` wins over `content` when both are given: it is the richer field, and
 * the shorthand cannot express a content type or a deselected entry. An entry
 * with no path is dropped rather than written, since Bruno reads a file body by
 * its `filePath` and an entry without one names nothing.
 *
 * `selected` is left to the writers rather than filled in here. The two dialects
 * default it in opposite directions — a `.yml` entry with no flag is one Bruno
 * will not send, a `.bru` entry with no flag is one it will — so each writer
 * states it in its own terms, and a caller that says nothing gets a selected
 * entry either way.
 */
function toFilePartList(source: NonNullable<CreateRequestInput['body']>): BruFilePart[] {
  if (source.files && source.files.length > 0) {
    return source.files.filter((part) => part.filePath).map((part) => ({ ...part }));
  }
  return source.content ? [{ filePath: source.content }] : [];
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

/**
 * What a stored settings block may hold, as opposed to what a caller may author.
 *
 * The two differ in one field: `timeout` can be the word `inherit` on disk, in
 * both dialects, but the MCP schema accepts only a number. Constraining the merge
 * to the input shape instead would make either dialect model unassignable to it,
 * and narrowing the model to match would delete the word on the next write.
 */
type StoredSettings = Omit<RequestSettingsInput, 'timeout'> & { timeout?: TimeoutSetting };

/**
 * Merge a declared `settings` block over whatever the file already had.
 *
 * Per-field merge, following `varsToBruVarSets` above: an absent field leaves
 * the stored value alone rather than deleting it. `assert` is the other
 * available precedent and replaces its whole block, but that fits a list whose
 * entries are only meaningful together — settings are four unrelated switches,
 * and replacing the block would mean raising the script timeout silently turned
 * redirect following back on, which is the kind of edit whose damage only shows
 * up as a lost cookie one request later.
 *
 * `undefined` is tested for explicitly rather than relying on the key being
 * absent: `followRedirects: false` and `maxRedirects: 0` are exactly the values
 * worth writing down and both are falsy, and a handler invoked directly rather
 * than through schema validation can hand us a key that is present and
 * undefined.
 *
 * Generic over the stored shape so both dialects share it. `.yml` settings also
 * carry `tls` and `proxy`, which are not authorable here; spreading the existing
 * block first preserves them.
 */
export function mergeRequestSettings<T extends StoredSettings>(
  existing: T | undefined,
  updates: RequestSettingsInput,
): T {
  const merged = { ...(existing ?? {}) } as T;
  if (updates.timeout !== undefined) merged.timeout = updates.timeout;
  if (updates.followRedirects !== undefined) merged.followRedirects = updates.followRedirects;
  if (updates.maxRedirects !== undefined) merged.maxRedirects = updates.maxRedirects;
  if (updates.encodeUrl !== undefined) merged.encodeUrl = updates.encodeUrl;
  if (updates.keepAliveInterval !== undefined) {
    merged.keepAliveInterval = updates.keepAliveInterval;
  }
  return merged;
}