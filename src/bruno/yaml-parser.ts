import { parse as parseYaml } from 'yaml';
import { toHttpMethod, toBodyType } from './parse-guards.js';
import { normalizeTags } from './meta-tags.js';
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
  type BruFilePart,
  type TlsSettings,
  type YamlParam,
  type YamlAssertion,
  type YamlVar,
  type YamlVars,
  type RequestKind,
  YAML_TYPE_TOKENS,
  YAML_TOKEN_FOR_KIND,
} from './types.js';
import type {
  YamlGrpc,
  YamlWebsocket,
  YamlRequestMessage,
} from './transport-requests.js';
import {
  assertionsFromYaml,
  postResponseVarsFromYaml,
  variablesFromYaml,
} from './yaml-runtime-blocks.js';
import {
  collectExtraKeys,
  YAML_GRPC_KEYS,
  YAML_HEADER_KEYS,
  YAML_HTTP_KEYS,
  YAML_INFO_KEYS,
  YAML_PARAM_KEYS,
  YAML_REQUEST_KEYS,
  YAML_RUNTIME_KEYS,
  YAML_SETTINGS_KEYS,
  YAML_TLS_KEYS,
  YAML_WEBSOCKET_KEYS,
} from './extra-keys.js';
import { readTimeoutSetting } from './timeout-setting.js';
import { graphqlBodyFromYaml, YAML_GRAPHQL_KEYS } from './yaml-graphql-block.js';

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

/**
 * Resolve the on-disk kind token to the model's kind.
 *
 * The `.yml` token for a WebSocket request is `websocket` while the model's kind
 * is `ws`, so this is a real translation and not a cast. It was a cast before,
 * which meant an unrecognised token became a `RequestKind` the compiler trusted
 * and no branch handled — the same defect the `.bru` side had.
 *
 * `folder` is not a request kind but reaches here because `parseInfo` serves both
 * requests and folders, so it passes through unmapped.
 */
function toYamlKind(raw: unknown): YamlInfo['type'] {
  if (raw == null) return undefined;
  if (raw === 'folder') return 'folder';
  const kind = typeof raw === 'string' ? YAML_TYPE_TOKENS[raw] : undefined;
  if (kind === undefined) {
    throw new BrunoError(
      `Unknown request type "${String(raw)}" in info block. `
        + `Expected one of: ${Object.keys(YAML_TYPE_TOKENS).join(', ')}`,
      'PARSE_ERROR',
    );
  }
  return kind;
}

function parseInfo(raw: Record<string, unknown>): YamlInfo {
  const info: YamlInfo = {
    name: String(raw.name ?? ''),
    type: toYamlKind(raw.type),
    seq: typeof raw.seq === 'number' ? raw.seq : undefined,
    tags: normalizeTags(raw.tags),
  };
  const extra = collectExtraKeys(raw, YAML_INFO_KEYS);
  if (extra) info.extra = extra;
  return info;
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
    const extra = collectExtraKeys(h, YAML_HEADER_KEYS);
    if (extra) header.extra = extra;
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
  } else if (Array.isArray(obj.data) && type === 'file') {
    // A file body, which is not a multipart part either. Bruno stores it as a
    // list of `{ filePath, contentType, selected }` (see
    // `bruno-filestore/src/formats/yml/common/body.ts`), and none of those keys
    // exist on a part — so reading one through the multipart mapper below
    // produced `{ name: '', value: '' }` and **dropped the file path entirely**.
    // Rewriting the request then wrote those empty parts back over a file body
    // this server never authored. Same failure the form-urlencoded branch above
    // exists to prevent: the array shape alone does not say what the entries are,
    // only `type` does.
    data = obj.data.map((entry) => {
      const part = (entry ?? {}) as Record<string, unknown>;
      const item: BruFilePart = { filePath: String(part.filePath ?? '') };
      if (part.contentType !== undefined) item.contentType = String(part.contentType);
      // `.yml` and `.bru` disagree about what an absent flag means, and each is
      // read the way its own dialect reads it. Upstream's `.yml` reader is
      // `selected: file.selected ?? false` (`yml/common/body.ts`), so an entry
      // that does not say `selected: true` is one Bruno will not send — and its
      // writer always emits the key, so only a hand-written file lands here
      // without one. The `.bru` side is the opposite: `@usebruno/lang` sets
      // `selected` from the `~` disabled prefix, so no prefix means selected,
      // which is why the `.bru` reader records the flag only when false.
      item.selected = part.selected === true;
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

  const extra = collectExtraKeys(raw, YAML_HTTP_KEYS);
  if (extra) http.extra = extra;

  return http;
}

/** Is this a plain object, as opposed to null, an array or a scalar? */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read a top-level `graphql:` block into the same `YamlHttp` the rest of the code
 * already works with.
 *
 * The block carries the request itself, so everything but the body is read exactly
 * as the `http:` block's equivalent. Only the body differs: upstream stores
 * `{ query, variables }` where the model uses a `{ type, data }` envelope.
 */
function parseGraphqlSection(raw: Record<string, unknown>): YamlHttp {
  const http: YamlHttp = {
    // Upstream defaults a graphql request to POST rather than GET.
    method: typeof raw.method === 'string' && raw.method !== '' ? raw.method : 'POST',
    url: String(raw.url ?? ''),
    headers: parseHeaders(raw.headers),
    body: graphqlBodyFromYaml(raw.body),
    auth: parseAuth(raw.auth),
  };

  const params = parseParams(raw.params);
  if (params.length > 0) http.params = params;

  const extra = collectExtraKeys(raw, YAML_GRAPHQL_KEYS);
  if (extra) http.extra = extra;

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
      const extra = collectExtraKeys(p, YAML_PARAM_KEYS);
      if (extra) param.extra = extra;
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

  // Only the scripts half is modelled here. Variables, assertions and actions
  // live in the same block but are read straight off the raw document by the
  // caller, so a script-less runtime block loses nothing by carrying no scripts.
  const rawScripts = Array.isArray(obj.scripts) ? obj.scripts : [];
  const scripts: YamlScript[] = rawScripts.map(
    (s: Record<string, unknown>) => ({
      type: String(s.type ?? 'after-response') as YamlScript['type'],
      code: String(s.code ?? ''),
    }),
  );

  // A runtime block carrying only keys we do not model still has to come back,
  // or the generator has nowhere to write them from and they are deleted.
  const extra = collectExtraKeys(obj, YAML_RUNTIME_KEYS);
  if (scripts.length === 0 && !extra) return undefined;

  const runtime: YamlRuntime = { scripts };
  if (extra) runtime.extra = extra;
  return runtime;
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

  // The block gets its own bag rather than relying on the settings one: `tls` is
  // a modelled settings key, so nothing inside it ever reaches that bag. Without
  // this, a block of fields we do not name parsed to `undefined` and the whole
  // key was deleted on the next write.
  const extra = collectExtraKeys(obj, YAML_TLS_KEYS);
  if (extra) tls.extra = extra;

  return Object.keys(tls).length > 0 ? tls : undefined;
}

function parseSettings(raw: unknown): YamlSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const settings: YamlSettings = {
    encodeUrl:
      typeof obj.encodeUrl === 'boolean' ? obj.encodeUrl : undefined,
    timeout: readTimeoutSetting(obj.timeout),
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

  const extra = collectExtraKeys(obj, YAML_SETTINGS_KEYS);
  if (extra) settings.extra = extra;

  return settings;
}

/**
 * Read the message list of a gRPC or WebSocket block.
 *
 * Both dialects spell the key singular and accept two forms: a list of titled
 * variants, or one bare message with no wrapper. Upstream's readers handle both
 * and so must this one, or a file Bruno wrote in the second form parses to no
 * messages at all.
 *
 * The forms differ between the two kinds, and that is the whole reason this takes
 * a `nested` flag rather than being one loop. A gRPC variant holds its payload as
 * a bare string under `message`; a WebSocket variant nests it as
 * `message: { type, data }`. Reading a WebSocket payload the gRPC way yields the
 * string `[object Object]`.
 */
/**
 * A message payload, as the wire will carry it.
 *
 * `String()` on a YAML mapping yields `[object Object]`, and that is what used to
 * reach the wire: a `data:` written as a mapping — the obvious way to author a
 * JSON payload in YAML — went out as those fifteen literal characters, having
 * declared a type the runner accepted.
 *
 * Upstream never meets this case, because its payloads only ever come from a text
 * editor and are already strings. Its own normaliser nonetheless serialises a
 * non-string with `JSON.stringify` (`bruno-requests/src/ws/ws-client.js`,
 * `normalizeMessageByFormat`), so that is what a structured payload becomes here
 * rather than something invented for the occasion.
 */
function messagePayload(data: unknown): string {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  if (typeof data === 'object') return JSON.stringify(data);
  return String(data);
}

function parseTransportMessages(
  raw: unknown,
  nested: boolean,
): YamlRequestMessage[] | undefined {
  if (raw == null) return undefined;

  if (Array.isArray(raw)) {
    return raw.map((entry: Record<string, unknown>) => {
      const message: YamlRequestMessage = { name: String(entry.title ?? '') };
      if (nested) {
        const payload = isRecord(entry.message) ? entry.message : {};
        message.type = String(payload.type ?? 'text');
        message.content = messagePayload(payload.data);
        // Kept as an explicit false: for a streaming request the difference
        // between "not selected" and "not stated" decides what gets sent.
        message.selected = entry.selected === true;
      } else {
        message.content = messagePayload(entry.message);
      }
      return message;
    });
  }

  if (nested && isRecord(raw)) {
    return [
      { name: '', type: String(raw.type ?? 'text'), content: messagePayload(raw.data) },
    ];
  }

  // A bare gRPC message. Upstream ignores a blank one rather than recording an
  // empty message, so an all-whitespace value yields no messages.
  if (!nested && typeof raw === 'string') {
    return raw.trim().length > 0 ? [{ name: '', content: raw }] : undefined;
  }

  return undefined;
}

/**
 * Read the `grpc:` block of a `.yml` request.
 *
 * `protoFilePath` is renamed to `protoPath`, which is what `.bru` calls it and
 * what upstream's own reader normalises it to. Both names are never kept at once:
 * a writer would then emit the same path twice.
 */
function parseGrpcSection(raw: Record<string, unknown>): YamlGrpc {
  const grpc: YamlGrpc = { url: String(raw.url ?? '') };

  if (typeof raw.method === 'string') grpc.method = raw.method;
  if (typeof raw.protoFilePath === 'string') grpc.protoPath = raw.protoFilePath;
  if (typeof raw.methodType === 'string') grpc.methodType = raw.methodType;

  const auth = parseAuth(raw.auth);
  if (auth) grpc.auth = auth;

  const metadata = parseHeaders(raw.metadata);
  if (metadata) grpc.metadata = metadata;

  const messages = parseTransportMessages(raw.message, false);
  if (messages) grpc.messages = messages;

  const extra = collectExtraKeys(raw, YAML_GRPC_KEYS);
  if (extra) grpc.extra = extra;

  return grpc;
}

/**
 * Read the `websocket:` block of a `.yml` request.
 *
 * Credentials arrive as ordinary `headers`, not `metadata` — only gRPC has that
 * block. `parseHeaders` is reused rather than reimplemented so the `disabled`
 * polarity is handled in one place; dropping that flag would re-arm a disabled
 * credential header on the next write.
 */
function parseWebsocketSection(raw: Record<string, unknown>): YamlWebsocket {
  const websocket: YamlWebsocket = { url: String(raw.url ?? '') };

  const auth = parseAuth(raw.auth);
  if (auth) websocket.auth = auth;

  const headers = parseHeaders(raw.headers);
  if (headers) websocket.headers = headers;

  const messages = parseTransportMessages(raw.message, true);
  if (messages) websocket.messages = messages;

  const extra = collectExtraKeys(raw, YAML_WEBSOCKET_KEYS);
  if (extra) websocket.extra = extra;

  return websocket;
}

/**
 * Which top-level blocks each kind may carry its target in.
 *
 * `graphql` has two entries and the reason is historical rather than aesthetic:
 * upstream gives a graphql request its own block, and every graphql `.yml` this
 * server wrote before the writer was corrected put the request under `http:`. A
 * literal "the block must be named after the kind" rule would refuse all of those
 * files. Every other kind has exactly one.
 */
const YAML_BLOCKS_FOR_KIND: Record<string, readonly string[]> = {
  http: ['http'],
  graphql: ['graphql', 'http'],
  grpc: ['grpc'],
  ws: ['websocket'],
};

/**
 * Refuse a document whose declared kind and target block disagree.
 *
 * `info.type: grpc` with an `http:` block is the shape that matters: `read_request`
 * would describe the request from the type while the executor dispatched on the
 * block, so a request that presents as a confined internal gRPC call could reach
 * an arbitrary host over HTTP. Neither signal is preferred silently, and this is
 * not a warning — a warning on a run is easy to miss, and this one decides which
 * host is contacted.
 *
 * A document with no `info.type` is left alone: there is nothing declared for a
 * block to contradict, and upstream reads such a file as http.
 */
function assertKindMatchesBlocks(
  kind: YamlInfo['type'],
  present: Record<'http' | 'graphql' | 'grpc' | 'websocket', boolean>,
): void {
  if (!kind) return;
  const allowed = YAML_BLOCKS_FOR_KIND[kind];
  // A kind with no entry — `folder` reaching the request parser — has no target
  // block of its own, so there is nothing to compare. The missing-block check
  // above has already spoken for that case.
  if (!allowed) return;

  const token = YAML_TOKEN_FOR_KIND[kind as RequestKind] ?? kind;
  for (const block of ['http', 'graphql', 'grpc', 'websocket'] as const) {
    if (!present[block] || allowed.includes(block)) continue;
    throw new BrunoError(
      `Request kind and payload disagree: info.type declared ${token} `
        + `but the document carries a "${block}" block. A request of type "${token}" `
        + `carries its target in "${allowed.join('" or "')}".`,
      'PARSE_ERROR',
    );
  }
}

export function parseYamlRequest(content: string): YamlRequest {
  const doc = safeParse(content, 'request');
  const infoRaw = requireSection(doc, 'info', 'request');

  // A graphql request lives in its own top-level `graphql:` block upstream, so
  // either block satisfies the requirement. Both placements are accepted because
  // every graphql `.yml` this server wrote before the writer was corrected put the
  // request under `http:`, and those files still have to load.
  const graphqlRaw = isRecord(doc.graphql) ? doc.graphql : undefined;
  const httpRaw = isRecord(doc.http) ? doc.http : undefined;
  // gRPC and WebSocket requests carry their target in their own block, exactly as
  // graphql does. Refusing them here is what made a `.yml` gRPC file unreadable.
  const grpcRaw = isRecord(doc.grpc) ? doc.grpc : undefined;
  const websocketRaw = isRecord(doc.websocket) ? doc.websocket : undefined;
  if (!graphqlRaw && !httpRaw && !grpcRaw && !websocketRaw) {
    throw new BrunoError(
      'Missing required "http" section in request '
        + '(or "graphql", "grpc" or "websocket" for those kinds)',
      'PARSE_ERROR',
    );
  }

  const result: YamlRequest = {
    info: parseInfo(infoRaw),
  };

  assertKindMatchesBlocks(result.info.type, {
    http: httpRaw !== undefined,
    graphql: graphqlRaw !== undefined,
    grpc: grpcRaw !== undefined,
    websocket: websocketRaw !== undefined,
  });

  if (grpcRaw) result.grpc = parseGrpcSection(grpcRaw);
  if (websocketRaw) result.websocket = parseWebsocketSection(websocketRaw);
  // Upstream's block wins when both are present: it is the one Bruno reads, so
  // it is the one that describes the request as Bruno sees it. A gRPC or
  // WebSocket document has no `http` block, so `http` stays absent — which is
  // what the executor's kind refusal reads.
  if (graphqlRaw) {
    result.http = parseGraphqlSection(graphqlRaw);
  } else if (httpRaw) {
    result.http = parseHttpSection(httpRaw);
  }

  const runtime = parseRuntime(doc.runtime);
  if (runtime) result.runtime = runtime;

  const settings = parseSettings(doc.settings);
  if (settings) result.settings = settings;

  if (typeof doc.docs === 'string') {
    result.docs = doc.docs;
  }

  // Top-level blocks this model does not name — `examples` above all, which
  // Bruno's own reader understands. Rebuilding the document from the model on
  // every write deleted them.
  const docExtra = collectExtraKeys(doc, YAML_REQUEST_KEYS);
  if (docExtra) result.extra = docExtra;

  // Variables, assertions and post-response actions live inside `runtime`, which
  // is where Bruno reads them. Earlier versions of this server wrote them at the
  // top level under `vars` and `assert` instead — names Bruno ignores — so those
  // are still accepted as a fallback and files already on disk keep loading.
  // Upstream's keys win when both are present.
  const runtimeRaw = (doc.runtime ?? {}) as Record<string, unknown>;

  const assertions = assertionsFromYaml(runtimeRaw.assertions);
  const resolvedAssertions = assertions.length > 0 ? assertions : parseAssertions(doc.assert);
  if (resolvedAssertions.length > 0) result.assert = resolvedAssertions;

  const preRequest = variablesFromYaml(runtimeRaw.variables);
  const postResponse = postResponseVarsFromYaml(runtimeRaw.actions);
  if (preRequest.length > 0 || postResponse.length > 0) {
    const vars: YamlVars = {};
    if (preRequest.length > 0) vars.preRequest = preRequest;
    if (postResponse.length > 0) vars.postResponse = postResponse;
    result.vars = vars;
  } else {
    const legacyVars = parseYamlVars(doc.vars);
    if (legacyVars) result.vars = legacyVars;
  }

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
