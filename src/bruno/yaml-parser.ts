import { parse as parseYaml } from 'yaml';
import { toHttpMethod, toBodyType } from './parse-guards.js';
import {
  BrunoError,
  type YamlRequest,
  type YamlFolder,
  type YamlCollection,
  type YamlHttp,
  type YamlRuntime,
  type YamlSettings,
  type YamlAuth,
  type YamlHeader,
  type YamlBody,
  type BodyType,
  type BruGraphql,
  type YamlScript,
  type YamlInfo,
  type MultipartFormPart,
  type FormUrlEncodedPart,
  type TlsSettings,
  type YamlParam,
  type YamlAssertion,
  type YamlVar,
  type YamlVars,
} from './types.js';

function safeParse(content: string, label: string): Record<string, unknown> {
  if (!content || !content.trim()) {
    throw new BrunoError(
      `Cannot parse ${label}: input is empty`,
      'PARSE_ERROR',
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BrunoError(
      `Failed to parse ${label} YAML: ${message}`,
      'PARSE_ERROR',
    );
  }

  if (parsed === null || parsed === undefined || typeof parsed !== 'object') {
    throw new BrunoError(
      `Cannot parse ${label}: YAML did not produce an object`,
      'PARSE_ERROR',
    );
  }

  return parsed as Record<string, unknown>;
}

function requireSection(
  doc: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, unknown> {
  const section = doc[key];
  if (!section || typeof section !== 'object') {
    throw new BrunoError(
      `Missing required "${key}" section in ${label}`,
      'PARSE_ERROR',
    );
  }
  return section as Record<string, unknown>;
}

function parseInfo(raw: Record<string, unknown>): YamlInfo {
  return {
    name: String(raw.name ?? ''),
    type: raw.type as YamlInfo['type'],
    seq: typeof raw.seq === 'number' ? raw.seq : undefined,
  };
}

function parseHeaders(raw: unknown): YamlHeader[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((h: Record<string, unknown>) => {
    const header: YamlHeader = {
      name: String(h.name ?? ''),
      value: String(h.value ?? ''),
    };
    // Without this the flag was dropped at parse time and the header came back
    // enabled, so a disabled credential header got sent.
    if (h.disabled === true) header.disabled = true;
    return header;
  });
}

/**
 * Turn the `query` / `variables` mapping a graphql body is stored as into the
 * envelope the executor reads. Both members are plain strings upstream, and an
 * empty one is omitted rather than written as a blank.
 */
function parseGraphqlBody(obj: Record<string, unknown>): BruGraphql {
  const graphql: BruGraphql = {
    query: typeof obj.query === 'string' ? obj.query : '',
  };
  if (typeof obj.variables === 'string' && obj.variables !== '') {
    graphql.variables = obj.variables;
  }
  return graphql;
}

/**
 * Coerce a non-array `body.data` to what the request pipeline expects for the
 * declared body type.
 *
 * A JSON body and a graphql body both sit on disk as a YAML mapping, so the
 * plain `String()` this used to do produced the literal text "[object Object]"
 * — still a valid string, so the user's body was replaced by garbage and
 * nothing errored. A mapping under a type that can only hold payload text is a
 * malformed file and is rejected instead of being coerced to something
 * meaningless.
 */
function parseBodyData(value: unknown, type: BodyType): YamlBody['data'] {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    if (type === 'graphql') return parseGraphqlBody(obj);
    // Bruno stores a JSON body as the raw payload text, not as structure, so
    // serialising is what keeps the two representations interchangeable.
    if (type === 'json') return JSON.stringify(value, null, 2);
  }

  throw new BrunoError(
    `Invalid body data for type "${type}": expected text, got ${typeof value}`,
    'PARSE_ERROR',
  );
}

function parseBody(raw: unknown): YamlBody | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  // Validated before the data is read, because the data's meaning depends on
  // it. YamlBody.type is declared string, but this is the value that later
  // becomes a BodyType, and checking it here names the field.
  const type = toBodyType(obj.type);

  let data: YamlBody['data'];
  if (Array.isArray(obj.data) && type === 'form-urlencoded') {
    // A form-urlencoded pair, which is not a multipart part. Bruno writes it
    // with no `type` key at all — that key is what marks a part as `file` — so
    // reading one through the multipart mapper below stamped `type: text` onto
    // every pair, and writing the request back out then put a key in the file
    // that Bruno had never written there.
    data = obj.data.map((entry) => {
      const pair = (entry ?? {}) as Record<string, unknown>;
      const item: FormUrlEncodedPart = {
        name: String(pair.name ?? ''),
        value: String(pair.value ?? ''),
      };
      if (pair.disabled === true) item.enabled = false;
      return item;
    });
  } else if (Array.isArray(obj.data)) {
    // multipart/form-data parts
    data = obj.data.map((entry) => {
      const part = (entry ?? {}) as Record<string, unknown>;
      const item: MultipartFormPart = {
        name: String(part.name ?? ''),
        value: Array.isArray(part.value)
          ? part.value.map(String)
          : String(part.value ?? ''),
        type: part.type === 'file' ? 'file' : 'text',
      };
      if (part.contentType !== undefined) {
        item.contentType = String(part.contentType);
      }
      // The executor skips a part with enabled === false, but nothing in
      // the .yml path ever set it, so a disabled part was silently sent.
      if (part.disabled === true) item.enabled = false;
      return item;
    });
    // A bare `data:` key parses to null. It means the body is absent, so it
    // must stay absent — `String(null)` made it the literal text "null".
  } else if (obj.data !== undefined && obj.data !== null) {
    data = parseBodyData(obj.data, type);
  }

  return { type, data };
}

function parseAuth(raw: unknown): YamlAuth | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') return raw as YamlAuth;
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    return { ...obj } as YamlAuth;
  }
  return undefined;
}

function parseHttpSection(raw: Record<string, unknown>): YamlHttp {
  const http: YamlHttp = {
    // Checked, not asserted; an absent method is GET, matching the .bru parser
    // rather than the empty string this used to produce.
    method: toHttpMethod(raw.method),
    url: String(raw.url ?? ''),
    headers: parseHeaders(raw.headers),
    body: parseBody(raw.body),
    auth: parseAuth(raw.auth),
  };

  // The generator already writes params back out; not reading them here is what
  // dropped every query and path parameter on a round-trip.
  const params = parseParams(raw.params);
  if (params.length > 0) http.params = params;

  return http;
}

function parseParams(raw: unknown): YamlParam[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .filter((p) => typeof p.name === 'string')
    .map((p) => {
      const param: YamlParam = {
        name: String(p.name),
        value: p.value === undefined || p.value === null ? '' : String(p.value),
      };
      if (p.type === 'path' || p.type === 'query') param.type = p.type;
      if (p.disabled === true) param.disabled = true;
      return param;
    });
}

function parseAssertions(raw: unknown): YamlAssertion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .filter((a) => typeof a.name === 'string')
    .map((a) => {
      const assertion: YamlAssertion = {
        name: String(a.name),
        value: a.value === undefined || a.value === null ? '' : String(a.value),
      };
      if (a.disabled === true) assertion.disabled = true;
      return assertion;
    });
}

function parseYamlVarList(raw: unknown): YamlVar[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
    .filter((v) => typeof v.name === 'string')
    .map((v) => {
      const entry: YamlVar = {
        name: String(v.name),
        value: v.value === undefined || v.value === null ? '' : String(v.value),
      };
      if (v.disabled === true) entry.disabled = true;
      if (v.local === true) entry.local = true;
      return entry;
    });
}

function parseYamlVars(raw: unknown): YamlVars | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const vars: YamlVars = {};
  const pre = parseYamlVarList(obj.preRequest);
  const post = parseYamlVarList(obj.postResponse);
  if (pre.length > 0) vars.preRequest = pre;
  if (post.length > 0) vars.postResponse = post;
  return vars.preRequest || vars.postResponse ? vars : undefined;
}

function parseRuntime(raw: unknown): YamlRuntime | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.scripts) || obj.scripts.length === 0) return undefined;

  const scripts: YamlScript[] = obj.scripts.map(
    (s: Record<string, unknown>) => ({
      type: String(s.type ?? 'after-response') as YamlScript['type'],
      code: String(s.code ?? ''),
    }),
  );

  return { scripts };
}

function parseTlsSettings(raw: unknown): TlsSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const tls: TlsSettings = {};
  if (typeof obj.rejectUnauthorized === 'boolean') {
    tls.rejectUnauthorized = obj.rejectUnauthorized;
  }
  if (typeof obj.ca === 'string') tls.ca = obj.ca;
  if (typeof obj.cert === 'string') tls.cert = obj.cert;
  if (typeof obj.key === 'string') tls.key = obj.key;
  return Object.keys(tls).length > 0 ? tls : undefined;
}

function parseSettings(raw: unknown): YamlSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const settings: YamlSettings = {
    encodeUrl:
      typeof obj.encodeUrl === 'boolean' ? obj.encodeUrl : undefined,
    timeout: typeof obj.timeout === 'number' ? obj.timeout : undefined,
    followRedirects:
      typeof obj.followRedirects === 'boolean'
        ? obj.followRedirects
        : undefined,
    maxRedirects:
      typeof obj.maxRedirects === 'number' ? obj.maxRedirects : undefined,
  };

  const tls = parseTlsSettings(obj.tls);
  if (tls) settings.tls = tls;
  if (typeof obj.proxy === 'string') settings.proxy = obj.proxy;

  return settings;
}

export function parseYamlRequest(content: string): YamlRequest {
  const doc = safeParse(content, 'request');
  const infoRaw = requireSection(doc, 'info', 'request');
  const httpRaw = requireSection(doc, 'http', 'request');

  const result: YamlRequest = {
    info: parseInfo(infoRaw),
    http: parseHttpSection(httpRaw as Record<string, unknown>),
  };

  const runtime = parseRuntime(doc.runtime);
  if (runtime) result.runtime = runtime;

  const settings = parseSettings(doc.settings);
  if (settings) result.settings = settings;

  if (typeof doc.docs === 'string') {
    result.docs = doc.docs;
  }

  // Assertions and vars were not modelled at all, so they vanished on any
  // read-modify-write of a .yml request.
  const assertions = parseAssertions(doc.assert);
  if (assertions.length > 0) result.assert = assertions;

  const vars = parseYamlVars(doc.vars);
  if (vars) result.vars = vars;

  return result;
}

export function parseYamlFolder(content: string): YamlFolder {
  const doc = safeParse(content, 'folder');
  const infoRaw = requireSection(doc, 'info', 'folder');

  const result: YamlFolder = {
    info: parseInfo(infoRaw),
  };

  if (doc.request && typeof doc.request === 'object') {
    const reqObj = doc.request as Record<string, unknown>;
    result.request = {
      ...reqObj,
      auth: parseAuth(reqObj.auth),
    };
  }

  return result;
}

export function parseYamlCollection(content: string): YamlCollection {
  const doc = safeParse(content, 'opencollection');

  if (!doc.opencollection) {
    throw new BrunoError(
      'Missing required "opencollection" version in opencollection.yml',
      'PARSE_ERROR',
    );
  }

  const infoRaw = requireSection(doc, 'info', 'opencollection');

  const result: YamlCollection = {
    opencollection: String(doc.opencollection),
    info: {
      name: String((infoRaw as Record<string, unknown>).name ?? ''),
    },
  };

  if (typeof doc.bundled === 'boolean') {
    result.bundled = doc.bundled;
  }

  if (doc.extensions && typeof doc.extensions === 'object') {
    result.extensions = doc.extensions as YamlCollection['extensions'];
  }

  return result;
}
