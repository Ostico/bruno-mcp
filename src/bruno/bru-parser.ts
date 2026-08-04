import { bruToJsonV2, jsonToBruV2, bruToEnvJsonV2, envJsonToBruV2 } from '@usebruno/lang';
import {
  BrunoError,
  type BruFile,
  type BruMeta,
  type BruHttpRequest,
  type BruAuth,
  type BruHeaders,
  type BruHeader,
  type BruBody,
  type BruFilePart,
  type MultipartFormPart,
  type BrunoEnvironment,
  type EnvFile,
  type EnvVariable,
  type AuthType,
  type BodyType,
  type BruParam,
  type BruAssertion,
  type BruRequestSettings,
  type BruVar,
  type BruVarSets,
  type BruOAuth2AdditionalParameters,
  type BruOAuth2ParamTarget,
} from './types.js';
import { toHttpMethod, normalizeBodyType } from './parse-guards.js';
import { normalizeTags } from './meta-tags.js';
import { applyExtraKeys, BRU_META_KEYS, collectExtraKeys } from './extra-keys.js';
import { toFormUrlEncodedEntries } from './request-inputs.js';

const MAX_SCRIPT_SIZE = 50_000;

interface BruLangJson {
  // `tags` is `unknown` rather than `string[]`: the grammar accepts a list
  // value and a single-line value at the same key, so what comes back is only a
  // list when the file used the list form. normalizeTags is what decides.
  meta?: { name?: string; type?: string; seq?: string | number; tags?: unknown };
  http?: { method?: string; url?: string; body?: string; auth?: string };
  headers?: Array<{ name: string; value: string; enabled?: boolean }>;
  auth?: Record<string, unknown>;
  body?: Record<string, unknown>;
  query?: Array<{ name: string; value: string; enabled?: boolean }>;
  vars?: { req?: Array<{ name: string; value: string; enabled?: boolean }>; res?: Array<{ name: string; value: string; enabled?: boolean }> };
  script?: { req?: string; res?: string };
  tests?: string;
  docs?: string;
  params?: unknown;
  assertions?: unknown;
  settings?: unknown;
  // The reader also returns eight flat `oauth2_additional_parameters_*` keys.
  [key: string]: unknown;
}

interface BruLangEnvJson {
  variables?: Array<{ name: string; value?: string; enabled?: boolean; secret?: boolean; type?: string }>;
  // The reader also returns a top-level `color` key when the file carries one.
  [key: string]: unknown;
}

export function parseBruRequest(content: string): BruFile {
  let json: BruLangJson;
  try {
    json = bruToJsonV2(content) as BruLangJson;
  } catch (err) {
    throw new BrunoError(
      `Failed to parse .bru file: ${err instanceof Error ? err.message : String(err)}`,
      'PARSE_ERROR',
    );
  }

  const meta: BruMeta = {
    name: json.meta?.name ?? 'Untitled',
    type: (json.meta?.type as 'http' | 'graphql') ?? 'http',
  };
  if (json.meta?.seq != null) {
    const seq = typeof json.meta.seq === 'string' ? parseInt(json.meta.seq, 10) : json.meta.seq;
    if (!isNaN(seq)) meta.seq = seq;
  }
  const tags = normalizeTags(json.meta?.tags);
  if (tags) meta.tags = tags;
  const metaExtra = collectExtraKeys(json.meta, BRU_META_KEYS);
  if (metaExtra) meta.extra = metaExtra;

  // Checked, not asserted: the block name is whatever the file contained.
  const method = toHttpMethod(json.http?.method);
  const http: BruHttpRequest = {
    method,
    url: json.http?.url ?? '',
    // NOT validated against BodyType/AuthType, deliberately: a .bru file uses
    // Bruno's own vocabulary (`multipartForm`, `formUrlEncoded`, `sparql`,
    // `awsv4`, `ntlm`), which is a different set from these unions. The `as` below is
    // therefore a known-false claim, left in place because correcting it means
    // retyping BruHttpRequest and reworking the generator and round-trip with
    // it — a larger change than this parse guard, and not attempted here.
    body: (json.http?.body ?? 'none') as BodyType,
    auth: (json.http?.auth ?? 'none') as AuthType,
  };

  const headers: BruHeaders = {};
  const headersList: BruHeader[] = [];
  if (json.headers && Array.isArray(json.headers)) {
    for (const h of json.headers) {
      // The map holds only enabled headers (it drives what is actually sent);
      // headersList preserves every header with its disabled flag so a header
      // the user switched off survives generate and is not silently re-armed.
      if (h.enabled !== false) {
        headers[h.name] = h.value;
      }
      const entry: BruHeader = { name: h.name, value: h.value };
      if (h.enabled === false) entry.enabled = false;
      headersList.push(entry);
    }
  }

  let auth: BruAuth | undefined;
  if (json.auth && Object.keys(json.auth).length > 0) {
    auth = { type: http.auth, ...json.auth } as BruAuth;
  }

  let body: BruBody | undefined;
  // A declared type with no content block still declares a type. Upstream keeps
  // the two apart — `request.body = get(json, 'body', {})` then
  // `request.body.mode = get(json, 'http.body', 'none')` (`bruno-cli/src/utils/bru.js:121-122`)
  // — so a file saying `body: graphql` with no `body:graphql` block runs as a
  // graphql request with nothing stored, and sends the envelope `{"variables":{}}`.
  // Reading the type only when a content block exists dropped that: the request
  // went out with no body and no content type, and a rewrite lost the `body:` line
  // from the http block along with it.
  // `http.body` itself is left as the file spelled it. The normalization below
  // happens only where a content block is present, because that is where the
  // spelling has to agree with the key the content was found under; a bare
  // declaration is carried back out in Bruno's own vocabulary.
  if (http.body !== undefined) {
    body = { type: normalizeBodyType(http.body) };
  }
  if (json.body && Object.keys(json.body).length > 0) {
    const multipart = (json.body as Record<string, unknown>).multipartForm;
    if (Array.isArray(multipart)) {
      // Normalize the non-standard 'multipartForm' body type to 'form-data'.
      http.body = 'form-data';
      body = {
        type: 'form-data',
        formData: multipart.map((entry) => {
          const part = (entry ?? {}) as Record<string, unknown>;
          const item: MultipartFormPart = {
            name: String(part.name ?? ''),
            value: Array.isArray(part.value)
              ? part.value.map(String)
              : String(part.value ?? ''),
            type: part.type === 'file' ? 'file' : 'text',
            enabled: part.enabled !== false,
          };
          if (part.contentType) item.contentType = String(part.contentType);
          return item;
        }),
      };
    } else {
      // The `http` block spells the type in Bruno's camelCase vocabulary while
      // the body block is named in kebab-case, so the two disagree for
      // form-urlencoded. Normalize the type to the kebab-case name BodyType
      // declares, but keep the raw spelling to look the content up: the parsed
      // body is keyed by whatever the `http` block actually said.
      const rawType = http.body as string;
      http.body = normalizeBodyType(rawType);
      body = { type: http.body };
      const rawBody = json.body as Record<string, unknown>;
      const bodyContent = rawBody[rawType];
      const graphql = rawBody.graphql as { query?: string; variables?: string } | undefined;
      const formUrlEncoded = rawBody.formUrlEncoded as
        | Array<{ name?: string; value?: string; enabled?: boolean }>
        | undefined;
      const fileParts = rawBody.file as
        | Array<{ filePath?: string; contentType?: string; selected?: boolean }>
        | undefined;
      if (typeof bodyContent === 'string') {
        // json / text / xml / sparql — the body is a raw string.
        body.content = bodyContent;
      } else if (graphql && typeof graphql === 'object') {
        // graphql — { query, variables? }; the string guard above dropped it.
        body.graphql = { query: graphql.query ?? '' };
        if (graphql.variables != null) body.graphql.variables = graphql.variables;
      } else if (Array.isArray(formUrlEncoded)) {
        // form-urlencoded — array of { name, value, enabled }.
        body.formUrlEncoded = formUrlEncoded.map((entry) => {
          const item: { name: string; value: string; enabled?: boolean } = {
            name: String(entry.name ?? ''),
            value: String(entry.value ?? ''),
          };
          if (entry.enabled === false) item.enabled = false;
          return item;
        });
      } else if (Array.isArray(fileParts)) {
        // file — array of { filePath, contentType?, selected }.
        body.file = fileParts.map((entry) => {
          const item: BruFilePart = { filePath: String(entry.filePath ?? '') };
          if (entry.contentType) item.contentType = String(entry.contentType);
          if (entry.selected === false) item.selected = false;
          return item;
        });
      }
    }
  }

  const bruFile: BruFile = { meta, http };
  if (Object.keys(headers).length > 0) bruFile.headers = headers;
  if (headersList.length > 0) bruFile.headersList = headersList;
  if (auth) bruFile.auth = auth;
  if (body) bruFile.body = body;

  if (json.script?.req || json.script?.res) {
    bruFile.script = {};
    if (json.script.req) {
      bruFile.script['pre-request'] = { exec: json.script.req.split('\n') };
    }
    if (json.script.res) {
      bruFile.script['post-response'] = { exec: json.script.res.split('\n') };
    }
  }

  if (json.tests) {
    bruFile.tests = { exec: json.tests.split('\n') };
  }

  if (json.docs) {
    bruFile.docs = json.docs;
  }

  // Carry through the parts of the document the model used to drop, so editing
  // one field does not delete the rest of the user's request.
  const params = readParams(json.params);
  if (params.length > 0) bruFile.params = params;

  const assertions = readAssertions(json.assertions);
  if (assertions.length > 0) bruFile.assertions = assertions;

  const settings = readRequestSettings(json.settings);
  if (settings) bruFile.settings = settings;

  const varSets = readVarSets(json.vars);
  if (varSets) bruFile.varSets = varSets;

  const additionalParameters = readOAuth2AdditionalParams(json as Record<string, unknown>);
  if (additionalParameters && bruFile.auth?.oauth2) {
    bruFile.auth.oauth2.additionalParameters = additionalParameters;
  }

  return bruFile;
}

/** Shape the writer expects for a vars entry. */
function toLangVar(v: BruVar): Record<string, unknown> {
  return { name: v.name, value: v.value, enabled: v.enabled, local: v.local === true };
}

// ---------------------------------------------------------------------------
// Round-trip preservation
//
// `bruToJsonV2` and `jsonToBruV2` are not symmetric for oauth2 additional
// parameters: the reader returns eight flat `oauth2_additional_parameters_*`
// keys, while the writer expects them grouped under
// `auth.oauth2.additionalParameters` with a `sendIn` discriminator. These
// helpers translate between the two shapes.
// ---------------------------------------------------------------------------

/** Which grouped bucket and `sendIn` each flat reader key corresponds to. */
const OAUTH2_PARAM_SOURCES: ReadonlyArray<{
  key: string;
  group: keyof BruOAuth2AdditionalParameters;
  sendIn: BruOAuth2ParamTarget;
}> = [
  { key: 'oauth2_additional_parameters_auth_req_headers', group: 'authorization', sendIn: 'headers' },
  { key: 'oauth2_additional_parameters_auth_req_queryparams', group: 'authorization', sendIn: 'queryparams' },
  { key: 'oauth2_additional_parameters_access_token_req_headers', group: 'token', sendIn: 'headers' },
  { key: 'oauth2_additional_parameters_access_token_req_queryparams', group: 'token', sendIn: 'queryparams' },
  { key: 'oauth2_additional_parameters_access_token_req_bodyvalues', group: 'token', sendIn: 'body' },
  { key: 'oauth2_additional_parameters_refresh_token_req_headers', group: 'refresh', sendIn: 'headers' },
  { key: 'oauth2_additional_parameters_refresh_token_req_queryparams', group: 'refresh', sendIn: 'queryparams' },
  { key: 'oauth2_additional_parameters_refresh_token_req_bodyvalues', group: 'refresh', sendIn: 'body' },
];

interface RawNameValue {
  name?: unknown;
  value?: unknown;
  enabled?: unknown;
  local?: unknown;
  type?: unknown;
}

function asEntries(value: unknown): RawNameValue[] {
  return Array.isArray(value) ? (value as RawNameValue[]) : [];
}

function readParams(value: unknown): BruParam[] {
  return asEntries(value)
    .filter((p) => typeof p.name === 'string')
    .map((p) => ({
      name: String(p.name),
      value: p.value === undefined || p.value === null ? '' : String(p.value),
      enabled: p.enabled !== false,
      type: p.type === 'path' ? ('path' as const) : ('query' as const),
    }));
}

function readAssertions(value: unknown): BruAssertion[] {
  return asEntries(value)
    .filter((a) => typeof a.name === 'string')
    .map((a) => ({
      name: String(a.name),
      value: a.value === undefined || a.value === null ? '' : String(a.value),
      enabled: a.enabled !== false,
    }));
}

function readRequestSettings(value: unknown): BruRequestSettings | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as {
    encodeUrl?: unknown;
    timeout?: unknown;
    followRedirects?: unknown;
    maxRedirects?: unknown;
  };
  const settings: BruRequestSettings = {};
  if (typeof raw.encodeUrl === 'boolean') settings.encodeUrl = raw.encodeUrl;
  if (typeof raw.timeout === 'number') settings.timeout = raw.timeout;
  // Typechecked rather than truthiness-checked: `followRedirects: false` and
  // `maxRedirects: 0` are the values worth writing down, and both are falsy.
  if (typeof raw.followRedirects === 'boolean') {
    settings.followRedirects = raw.followRedirects;
  }
  if (typeof raw.maxRedirects === 'number') {
    settings.maxRedirects = raw.maxRedirects;
  }
  // No carried keys here, unlike the meta block: upstream's own .bru reader
  // models this block's fields explicitly and drops an unrecognised one before
  // we ever see it (it also injects `timeout: 0`). Nothing reaches this function
  // to carry, so there is nothing to keep. See `extra-keys.ts`.
  return Object.keys(settings).length > 0 ? settings : undefined;
}

function readVars(value: unknown): BruVar[] {
  return asEntries(value)
    .filter((v) => typeof v.name === 'string')
    .map((v) => {
      const entry: BruVar = {
        name: String(v.name),
        value: v.value === undefined || v.value === null ? '' : String(v.value),
        enabled: v.enabled !== false,
      };
      if (v.local === true) entry.local = true;
      return entry;
    });
}

function readVarSets(value: unknown): BruVarSets | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { req?: unknown; res?: unknown };
  const sets: BruVarSets = {};
  const req = readVars(raw.req);
  const res = readVars(raw.res);
  if (req.length > 0) sets.req = req;
  if (res.length > 0) sets.res = res;
  return sets.req || sets.res ? sets : undefined;
}

function readOAuth2AdditionalParams(
  json: Record<string, unknown>,
): BruOAuth2AdditionalParameters | undefined {
  const result: BruOAuth2AdditionalParameters = {};

  for (const { key, group, sendIn } of OAUTH2_PARAM_SOURCES) {
    const entries = asEntries(json[key]).filter((p) => typeof p.name === 'string');
    if (entries.length === 0) continue;

    const bucket = result[group] ?? [];
    for (const entry of entries) {
      bucket.push({
        name: String(entry.name),
        value: entry.value === undefined || entry.value === null ? '' : String(entry.value),
        enabled: entry.enabled !== false,
        sendIn,
      });
    }
    result[group] = bucket;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/** The carried meta keys, filtered the way the generator's own writes require. */
function carriedMetaKeys(extra: Record<string, unknown> | undefined): Record<string, unknown> {
  const carried: Record<string, unknown> = {};
  applyExtraKeys(carried, extra, BRU_META_KEYS);
  return carried;
}

/**
 * What to emit for a body the model carries only as `content`.
 *
 * The generator's body chain is presence-based: it looks for `body.graphql`,
 * `body.formUrlEncoded`, `body.file` and so on, and falls through to `content`
 * for everything else. That fall-through used to write `{ [mode]: content }`
 * with the model's own kebab-case mode as the key, which is right for exactly
 * four of the eleven body types and wrong for the rest:
 *
 * - `file` — `@usebruno/lang` tests `body.file.length` and then calls
 *   `enabled(body.file, 'selected')`. A string passes the length test and dies
 *   in the filter with `items.filter is not a function`, so writing the file
 *   threw instead of writing a body.
 * - `form-urlencoded`, `multipart-form`, `form-data` — the key upstream reads
 *   is camelCase (`formUrlEncoded`, `multipartForm`), so a kebab-case key
 *   matched nothing and the body vanished silently. The mode token in the
 *   `http` block stayed kebab-case too, which Bruno does not recognise; the
 *   two structured branches above restore it for exactly this reason.
 * - `graphql` — upstream reads `body.graphql.query`, absent on a string, so
 *   the query was dropped.
 *
 * Nothing reaches this from the tool surface today: `toBruBody` in
 * `request-inputs.ts` fills the structured field as well as `content`, so the
 * branch above always wins. It is still the shape our own `BruBody` type
 * declares legal, which makes it a live trap for the next caller.
 *
 * The conversions here are not invented: they mirror what `toBruBody` already
 * decided for the same input — a `file` body's `content` is a file path, and a
 * `graphql` body's `content` is the query — so both paths produce one file.
 * `form-urlencoded` reuses `toFormUrlEncodedEntries` rather than parsing the
 * string again, so the two cannot drift.
 *
 * Body types with no scalar reading (`multipart-form`, `form-data`) return the
 * mode alone: a bare string cannot name parts, and emitting a block upstream
 * drops is worse than emitting none. `binary` and `none` return nothing, since
 * Bruno has no body block for either.
 */
function bodyFromContent(
  mode: BodyType,
  content: string,
): { mode?: string; body?: Record<string, unknown> } {
  switch (mode) {
    case 'json':
    case 'text':
    case 'xml':
    case 'sparql':
      return { body: { [mode]: content } };
    case 'graphql':
      return { body: { graphql: { query: content } } };
    case 'file':
      return { body: { file: [{ filePath: content, contentType: '', selected: true }] } };
    case 'form-urlencoded':
      return {
        mode: 'formUrlEncoded',
        body: { formUrlEncoded: toFormUrlEncodedEntries({ type: 'form-urlencoded', content }) ?? [] },
      };
    case 'form-data':
    case 'multipart-form':
      return { mode: 'multipartForm' };
    default:
      return {};
  }
}

export function generateBruRequest(bruFile: BruFile): string {
  const json: Record<string, unknown> = {
    meta: {
      name: bruFile.meta.name,
      type: bruFile.meta.type ?? 'http',
      // Spread, not `seq: undefined`. The serializer walks the KEYS of meta and
      // writes `${key}: ${value}` for each, so a key holding undefined becomes
      // the literal text "seq: undefined" — a value, and not a number. Absent
      // has to mean absent.
      ...(bruFile.meta.seq != null ? { seq: String(bruFile.meta.seq) } : {}),
      // Absent for an empty list, for the same reason `seq` is: the serializer
      // writes a list block for whatever key it finds, so an empty one would
      // put a bare `tags: [` / `]` pair in the file. Upstream also writes the
      // key only when `tags?.length` is truthy.
      //
      // A list and never a string. Handed a string, the serializer iterates its
      // characters and writes one tag per letter.
      ...(bruFile.meta.tags?.length ? { tags: bruFile.meta.tags } : {}),
      // Keys of the meta block this model does not name. The serializer walks a
      // dictionary block's keys, so an unmodelled one survives here — unlike an
      // unmodelled top-level block, which it drops outright.
      //
      // Through applyExtraKeys rather than a spread: a spread would let a stale
      // carried `name` win over the one the caller just set.
      ...carriedMetaKeys(bruFile.meta.extra),
    },
    http: {
      method: bruFile.http.method.toLowerCase(),
      url: bruFile.http.url,
      body: bruFile.http.body ?? 'none',
      auth: bruFile.http.auth ?? 'none',
    },
  };

  if (bruFile.headersList && bruFile.headersList.length > 0) {
    // Source of truth when present: preserves each header's disabled (`~`) state
    // so a header the user switched off is re-emitted disabled, not re-armed.
    json.headers = bruFile.headersList.map((h) => ({
      name: h.name,
      value: h.value,
      enabled: h.enabled !== false,
    }));
  } else if (bruFile.headers && Object.keys(bruFile.headers).length > 0) {
    json.headers = Object.entries(bruFile.headers).map(([name, value]) => ({
      name,
      value,
      enabled: true,
    }));
  }

  if (bruFile.auth) {
    const { type, ...rest } = bruFile.auth;
    if (Object.keys(rest).length > 0) {
      json.auth = rest;
    }
  }

  if (
    bruFile.body?.formData &&
    (bruFile.http.body === 'form-data' || bruFile.http.body === 'multipart-form')
  ) {
    // @usebruno/lang expects http.body === 'multipartForm' and a
    // body.multipartForm array of { name, value, enabled, type, contentType }.
    (json.http as Record<string, unknown>).body = 'multipartForm';
    json.body = {
      multipartForm: bruFile.body.formData.map((field) => {
        const isFile = (field.type ?? 'text') === 'file';
        // @usebruno/lang expects file values as an array of paths and text
        // values as a plain string.
        const value = isFile
          ? Array.isArray(field.value)
            ? field.value
            : [field.value]
          : Array.isArray(field.value)
            ? String(field.value[0] ?? '')
            : field.value;
        return {
          name: field.name,
          value,
          type: field.type ?? 'text',
          contentType: field.contentType ?? '',
          enabled: field.enabled !== false,
        };
      }),
    };
  } else if (bruFile.body?.graphql) {
    // @usebruno/lang emits body:graphql from { query } and body:graphql:vars
    // from { variables }.
    const graphql: { query: string; variables?: string } = {
      query: bruFile.body.graphql.query,
    };
    if (bruFile.body.graphql.variables != null) {
      graphql.variables = bruFile.body.graphql.variables;
    }
    json.body = { graphql };
  } else if (bruFile.body?.formUrlEncoded) {
    // Bruno spells this type two ways: the BLOCK is kebab-case
    // (`body:form-urlencoded {`) while the MODE in the method block is
    // camelCase. Parsing normalizes the mode to kebab-case, so without
    // restoring it here a rewrite left `body: form-urlencoded`, which Bruno
    // does not recognise — the block still looked right and the body stopped
    // being sent. Same restoration the multipart branch above does.
    (json.http as Record<string, unknown>).body = 'formUrlEncoded';
    // @usebruno/lang splits body.formUrlEncoded on a truthy `enabled` flag,
    // prefixing disabled entries with `~`.
    json.body = {
      formUrlEncoded: bruFile.body.formUrlEncoded.map((field) => ({
        name: field.name,
        value: field.value,
        enabled: field.enabled !== false,
      })),
    };
  } else if (bruFile.body?.file) {
    // @usebruno/lang splits body.file on a truthy `selected` flag and emits
    // each value as @file(<filePath>) with an optional @contentType(...).
    json.body = {
      file: bruFile.body.file.map((part) => ({
        filePath: part.filePath,
        contentType: part.contentType ?? '',
        selected: part.selected !== false,
      })),
    };
  } else if (bruFile.body?.content) {
    const converted = bodyFromContent(bruFile.http.body, bruFile.body.content);
    if (converted.mode) (json.http as Record<string, unknown>).body = converted.mode;
    if (converted.body) json.body = converted.body;
  }

  const script: Record<string, string> = {};
  if (bruFile.script?.['pre-request']?.exec) {
    script.req = bruFile.script['pre-request'].exec.join('\n');
  }
  if (bruFile.script?.['post-response']?.exec) {
    script.res = bruFile.script['post-response'].exec.join('\n');
  }
  if (Object.keys(script).length > 0) {
    json.script = script;
  }

  if (bruFile.tests?.exec) {
    json.tests = bruFile.tests.exec.join('\n');
  }

  if (bruFile.docs) {
    json.docs = bruFile.docs;
  }

  // Write back the blocks the model now carries, so a read-modify-write keeps
  // the parts of the request the caller never touched.
  if (bruFile.params && bruFile.params.length > 0) {
    json.params = bruFile.params.map((p) => ({
      name: p.name,
      value: p.value,
      enabled: p.enabled,
      type: p.type,
    }));
  }

  if (bruFile.assertions && bruFile.assertions.length > 0) {
    json.assertions = bruFile.assertions.map((a) => ({
      name: a.name,
      value: a.value,
      enabled: a.enabled,
    }));
  }

  if (bruFile.settings && Object.keys(bruFile.settings).length > 0) {
    json.settings = { ...bruFile.settings };
  }

  if (bruFile.varSets?.req || bruFile.varSets?.res) {
    const vars: Record<string, unknown> = {};
    if (bruFile.varSets.req && bruFile.varSets.req.length > 0) {
      vars.req = bruFile.varSets.req.map(toLangVar);
    }
    if (bruFile.varSets.res && bruFile.varSets.res.length > 0) {
      vars.res = bruFile.varSets.res.map(toLangVar);
    }
    json.vars = vars;
  }

  // The writer wants these grouped under auth.oauth2, which is where the parser
  // put them — but only if an auth block is actually being emitted.
  const additionalParameters = bruFile.auth?.oauth2?.additionalParameters;
  if (additionalParameters && json.auth && typeof json.auth === 'object') {
    const auth = json.auth as { oauth2?: Record<string, unknown> };
    if (auth.oauth2) {
      auth.oauth2.additionalParameters = additionalParameters;
    }
  }

  try {
    return jsonToBruV2(json);
  } catch (err) {
    throw new BrunoError(
      `Failed to generate .bru file: ${err instanceof Error ? err.message : String(err)}`,
      'GENERATE_ERROR',
    );
  }
}

export function parseBruEnvironment(content: string, name: string): BrunoEnvironment {
  let json: BruLangEnvJson;
  try {
    json = bruToEnvJsonV2(content) as BruLangEnvJson;
  } catch (err) {
    throw new BrunoError(
      `Failed to parse .bru environment: ${err instanceof Error ? err.message : String(err)}`,
      'PARSE_ERROR',
    );
  }

  const variables: Record<string, string | number | boolean> = {};
  if (json.variables && Array.isArray(json.variables)) {
    for (const v of json.variables) {
      if (v.enabled !== false) {
        variables[v.name] = v.value ?? '';
      }
    }
  }

  return { name, variables };
}

export function generateBruEnvironment(env: BrunoEnvironment): string {
  const variables = Object.entries(env.variables).map(([name, value]) => ({
    name,
    value: String(value),
    enabled: true,
    secret: false,
    type: 'text',
  }));

  try {
    return envJsonToBruV2({ variables });
  } catch (err) {
    /* istanbul ignore next -- defensive: envJsonToBruV2 is handed an internally
       constructed variables[] whose names are object keys / EnvVariable.name and
       whose values are String()-coerced, so the library never throws here */
    throw new BrunoError(
      `Failed to generate .bru environment: ${err instanceof Error ? err.message : String(err)}`,
      'GENERATE_ERROR',
    );
  }
}

/**
 * Parse a .bru environment preserving ALL variables and their enabled/disabled
 * state (unlike parseBruEnvironment, which drops disabled variables). Used by
 * the merge/write path so disabled variables survive edits.
 *
 * A variable listed in the file's `vars:secret [...]` block comes back with
 * `secret: true` and an empty value — the block holds names only, because a
 * secret's value is never stored in the environment file.
 */
export function parseBruEnvironmentRaw(content: string): EnvVariable[] {
  return parseBruEnvironmentFile(content).variables ?? [];
}

/**
 * Top-level .bru environment keys represented by EnvFile's own fields.
 * Everything else the file carries is kept in `EnvFile.extra`.
 */
const BRU_ENV_MODELLED_KEYS = new Set(['variables']);

/**
 * Parse a .bru environment into the full file model: the variables plus any
 * top-level key the model does not name (`color`), so a read-modify-write can
 * write those keys back instead of deleting them.
 */
export function parseBruEnvironmentFile(content: string): EnvFile {
  let json: BruLangEnvJson;
  try {
    json = bruToEnvJsonV2(content) as BruLangEnvJson;
  } catch (err) {
    throw new BrunoError(
      `Failed to parse .bru environment: ${err instanceof Error ? err.message : String(err)}`,
      'PARSE_ERROR',
    );
  }

  const variables: EnvVariable[] = [];
  if (json.variables && Array.isArray(json.variables)) {
    for (const v of json.variables) {
      if (v.name == null || String(v.name) === '') continue;
      const item: EnvVariable = { name: v.name, value: v.value ?? '' };
      if (v.enabled === false) item.disabled = true;
      if ((v as { secret?: boolean }).secret === true) item.secret = true;
      variables.push(item);
    }
  }

  const envFile: EnvFile = { variables };
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
    if (BRU_ENV_MODELLED_KEYS.has(key)) continue;
    extra[key] = value;
  }
  if (Object.keys(extra).length > 0) envFile.extra = extra;

  return envFile;
}

/**
 * Generate a .bru environment from a full variable list, preserving the
 * enabled/disabled state of each variable (disabled === true → enabled: false)
 * and its `secret` flag (writing it unconditionally false
 * downgraded every secret var to plaintext on any env edit).
 *
 * A secret variable is emitted into the `vars:secret [...]` block, which holds
 * bare names — the serializer drops the value, so the credential never reaches
 * the file. `fileExtra` carries back top-level keys read off the same file;
 * only the ones the serializer understands (`color`) survive the round trip.
 */
export function generateBruEnvironmentFull(
  vars: EnvVariable[],
  fileExtra?: Record<string, unknown>,
): string {
  const variables = vars.map((v) => ({
    name: v.name,
    value: String(v.value ?? ''),
    enabled: v.disabled !== true,
    secret: v.secret === true,
    type: 'text',
  }));

  const doc: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fileExtra ?? {})) {
    if (BRU_ENV_MODELLED_KEYS.has(key)) continue;
    doc[key] = value;
  }
  doc.variables = variables;

  try {
    return envJsonToBruV2(doc);
  } catch (err) {
    /* istanbul ignore next -- defensive: envJsonToBruV2 is handed an internally
       constructed variables[] whose names are object keys / EnvVariable.name and
       whose values are String()-coerced, so the library never throws here */
    throw new BrunoError(
      `Failed to generate .bru environment: ${err instanceof Error ? err.message : String(err)}`,
      'GENERATE_ERROR',
    );
  }
}

/**
 * Remove a script block of the given type from .bru file content.
 * Unlike the .yml dialect, .bru has distinct slots for pre-request,
 * post-response, and tests, so removal is precise.
 */
export function removeBruScript(
  content: string,
  scriptType: 'pre-request' | 'post-response' | 'tests',
): string {
  const validTypes = ['pre-request', 'post-response', 'tests'];
  if (!validTypes.includes(scriptType)) {
    throw new BrunoError(`Invalid script type: ${scriptType}`, 'VALIDATION_ERROR');
  }

  let json: BruLangJson;
  try {
    json = bruToJsonV2(content) as BruLangJson;
  } catch (err) {
    throw new BrunoError(
      `Failed to parse .bru file for script removal: ${err instanceof Error ? err.message : String(err)}`,
      'PARSE_ERROR',
    );
  }

  if (scriptType === 'tests') {
    delete json.tests;
  } else if (json.script) {
    const targetField = scriptType === 'pre-request' ? 'req' : 'res';
    delete json.script[targetField];
    if (Object.keys(json.script).length === 0) {
      delete json.script;
    }
  }

  try {
    return jsonToBruV2(json);
  } catch (err) {
    /* istanbul ignore next -- defensive: json here comes from bruToJsonV2 of valid
       content with only tests/script fields deleted, so jsonToBruV2 cannot fail */
    throw new BrunoError(
      `Failed to generate .bru file after script removal: ${err instanceof Error ? err.message : String(err)}`,
      'GENERATE_ERROR',
    );
  }
}

export function injectBruScript(
  content: string,
  scriptType: 'pre-request' | 'post-response' | 'tests',
  scriptCode: string,
  mode: 'append' | 'replace',
): string {
  const validTypes = ['pre-request', 'post-response', 'tests'];
  if (!validTypes.includes(scriptType)) {
    throw new BrunoError(`Invalid script type: ${scriptType}`, 'VALIDATION_ERROR');
  }

  if (scriptCode.includes('\x00')) {
    throw new BrunoError('Script content contains null bytes', 'VALIDATION_ERROR');
  }

  if (scriptCode.length > MAX_SCRIPT_SIZE) {
    throw new BrunoError(`Script exceeds maximum size of ${MAX_SCRIPT_SIZE} bytes`, 'VALIDATION_ERROR');
  }

  let json: BruLangJson;
  try {
    json = bruToJsonV2(content) as BruLangJson;
  } catch (err) {
    throw new BrunoError(
      `Failed to parse .bru file for script injection: ${err instanceof Error ? err.message : String(err)}`,
      'PARSE_ERROR',
    );
  }

  if (scriptType === 'tests') {
    const existing = json.tests ?? '';
    if (mode === 'replace') {
      json.tests = scriptCode;
    } else {
      json.tests = existing ? `${existing}\n${scriptCode}` : scriptCode;
    }
  } else {
    if (!json.script) json.script = {};
    const targetField = scriptType === 'pre-request' ? 'req' : 'res';
    const existing = json.script[targetField] ?? '';
    if (mode === 'replace') {
      json.script[targetField] = scriptCode;
    } else {
      json.script[targetField] = existing ? `${existing}\n${scriptCode}` : scriptCode;
    }
  }

  try {
    return jsonToBruV2(json);
  } catch (err) {
    /* istanbul ignore next -- defensive: json here comes from bruToJsonV2 of valid
       content with only string tests/script fields mutated, so jsonToBruV2 cannot fail */
    throw new BrunoError(
      `Failed to generate .bru file after script injection: ${err instanceof Error ? err.message : String(err)}`,
      'GENERATE_ERROR',
    );
  }
}
