/**
 * TypeScript interfaces for Bruno BRU file format
 * Based on the Bru markup language specification
 */

import type { BruGrpc, BruWs, YamlGrpc, YamlWebsocket } from './transport-requests.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

/**
 * Every auth mode this tool can READ, WRITE and REPRESENT.
 *
 * Membership here is not a claim that the executor can perform the scheme —
 * `AppliedAuthType` below is the set it actually puts on the wire. The
 * difference matters because a mode that parses and round-trips faithfully but
 * never authenticates looks identical to a working one until the server answers
 * 401, so the split is written down rather than left to be discovered.
 */
export type AuthType = 'none' | 'bearer' | 'basic' | 'oauth2' | 'api-key' | 'digest' | 'inherit';

/**
 * Auth modes the executor applies to the outgoing request itself.
 *
 * `bearer` and `basic` become an Authorization header; `api-key` becomes either a
 * caller-named header or a query parameter, per its placement. `digest` and
 * `oauth2` are applied too, but not from the request alone: digest answers a
 * 401 challenge and re-sends, and oauth2 fetches a token first. Being here is
 * the promise that a credential reaches the wire, not that it is computed
 * before the first byte.
 */
export type AppliedAuthType = Extract<
  AuthType,
  'bearer' | 'basic' | 'api-key' | 'digest' | 'oauth2'
>;

/**
 * Auth modes `AuthType` accepts that the executor CANNOT perform.
 *
 * Empty since L3. `digest` and `oauth2` were both here: each needs a multi-step
 * exchange with the server, and neither exchange was run. The executor now
 * performs both — a digest challenge/response, and an OAuth2 token grant for
 * the grant types that do not require a browser.
 *
 * Deliberately kept rather than deleted. It is the slot a new mode goes in when
 * it is accepted by the parser before the executor can perform it, and the
 * classification proof below is what forces that choice to be made out loud.
 * One partial case does NOT live here: oauth2's `authorization_code` and
 * `implicit` grants cannot work in a headless server, and are refused per
 * grant inside the oauth2 branch rather than by disowning the whole mode.
 */
export type UnappliedAuthType = never;

/**
 * The auth mode that defers to the enclosing folder or collection.
 *
 * Bruno resolves `inherit` by walking up to the nearest folder or collection auth
 * block. This tool does not model that walk, so a request set to `inherit` goes
 * out with no credential and carries a warning saying so — the same treatment as
 * an `UnappliedAuthType`, for a different reason: the credential is not missing,
 * it is somewhere this tool does not look.
 *
 * It is a member of `AuthType` rather than a mode to normalize away because both
 * file formats write it and reading it as `none` is a silent downgrade: `none`
 * means "send nothing", `inherit` means "send whatever the collection says", and
 * rewriting one as the other changes what Bruno itself would send.
 */
export type InheritedAuthType = Extract<AuthType, 'inherit'>;

/**
 * Compile-time proof that every AuthType member is classified as applied,
 * unapplied, inherited, or `none`.
 *
 * This is what keeps the split honest. Adding a mode to AuthType without
 * deciding whether the executor can perform it makes this alias resolve to
 * `never` and fail to type-check, so the next person cannot quietly widen the
 * promise the way `api-key`, `oauth2` and `digest` were widened before.
 */
type _EveryAuthTypeIsClassified =
  AuthType extends AppliedAuthType | UnappliedAuthType | InheritedAuthType | 'none' ? true : never;
const _authTypesAreClassified: _EveryAuthTypeIsClassified = true;
void _authTypesAreClassified;

/**
 * An auth mode as it appears in a `.bru` file on disk.
 *
 * Bruno spells the api-key mode `apikey`, matching its `auth:apikey` block, so a
 * parsed or generated file carries that token while the tool surface keeps the
 * hyphenated `api-key`. Both have to be readable; only `apikey` is written.
 */
export type BruAuthMode = AuthType | 'apikey';

// 'multipart-form' is the block name used by the .bru wire format (see the
// `body:multipart-form {` block emitted by the generator); 'form-data' is the
// equivalent name used on the MCP-facing side. Both reach BodyType at runtime,
// so both belong in the union.
//
// Every member here is a kebab-case block name. Bruno spells the type in
// camelCase inside the `http` block (`body: formUrlEncoded`, `body:
// multipartForm`) while naming the body block in kebab-case
// (`body:form-urlencoded {`), so parseBruRequest normalizes the camelCase
// spelling to the member below before it reaches this type. Without that
// normalization the declared type was a false claim: raw values like
// 'formUrlEncoded' flowed through a field annotated BodyType, which is what
// concealed the form-urlencoded and graphql bodies being dropped on the way to
// the wire.
export type BodyType =
  | 'none'
  | 'json'
  | 'text'
  | 'xml'
  | 'sparql'
  | 'graphql'
  | 'form-data'
  | 'multipart-form'
  | 'form-urlencoded'
  | 'file'
  | 'binary';

// Bruno Collection Configuration (bruno.json)
export interface BrunoCollection {
  version: string;
  name: string;
  type: 'collection';
  ignore?: string[];
  preRequestScript?: string;
  postResponseScript?: string;
}

// Environment Configuration
export interface BrunoEnvironment {
  name: string;
  variables: Record<string, string | number | boolean>;
}

/**
 * The request kinds this server understands, in one internal vocabulary.
 *
 * The two on-disk dialects disagree on the token for the same kind — `.bru`
 * writes `ws`, `.yml` writes `websocket` — so the token stays at the parse and
 * generate boundaries and everything in between speaks this union. `folder` is
 * deliberately absent: a folder is not a request, and `YamlInfo` carries it
 * separately because that interface is shared with `YamlFolder`.
 */
export type RequestKind = 'http' | 'graphql' | 'grpc' | 'ws';

/** `.bru` `meta.type` tokens, which happen to be the kind names themselves. */
export const BRU_TYPE_TOKENS: Readonly<Record<string, RequestKind>> = {
  http: 'http',
  graphql: 'graphql',
  grpc: 'grpc',
  ws: 'ws',
};

/** `.yml` `info.type` tokens, which spell WebSocket out in full. */
export const YAML_TYPE_TOKENS: Readonly<Record<string, RequestKind>> = {
  http: 'http',
  graphql: 'graphql',
  grpc: 'grpc',
  websocket: 'ws',
};

/** The `.yml` token for a kind, for the writer. */
export const YAML_TOKEN_FOR_KIND: Readonly<Record<RequestKind, string>> = {
  http: 'http',
  graphql: 'graphql',
  grpc: 'grpc',
  ws: 'websocket',
};

// Meta block in .bru files
export interface BruMeta {
  name: string;
  type: RequestKind;
  seq?: number;
  /**
   * Tags the runner filters on, as a list of strings and never a bare string.
   *
   * Upstream normalizes with `Array.isArray(tags) ? tags : []` at both ends —
   * `bruno-cli/src/utils/bru.js:80` and `bruno-filestore`'s `parseApp.ts:22` —
   * so a single-line `tags: smoke` means no tags to Bruno, not one tag. Absent
   * rather than empty when there are none, because upstream writes the key only
   * for a non-empty list.
   */
  tags?: string[];
  /**
   * Keys of the `meta` block this model does not name, carried so a
   * read-modify-write writes them back instead of deleting them.
   *
   * Only unmodelled keys *inside* a block can be carried on the `.bru` side:
   * upstream's serializer emits a dictionary block key by key but drops a
   * top-level block it does not recognise, so there is nowhere to put one. See
   * `extra-keys.ts`.
   */
  extra?: Record<string, unknown>;
}

// HTTP request configuration
export interface BruHttpRequest {
  method: HttpMethod;
  url: string;
  body: BodyType;
  auth: BruAuthMode;
}

// Authentication configurations
export interface BruAuth {
  type: BruAuthMode;
  bearer?: {
    token: string;
  };
  basic?: {
    username: string;
    password: string;
  };
  oauth2?: {
    grantType: 'authorization_code' | 'client_credentials' | 'password';
    accessTokenUrl?: string;
    authorizationUrl?: string;
    clientId?: string;
    clientSecret?: string;
    scope?: string;
    username?: string;
    password?: string;
    /** Extra parameters attached to the authorization/token/refresh calls. */
    additionalParameters?: BruOAuth2AdditionalParameters;
  };
  apikey?: {
    key: string;
    value: string;
    /**
     * Bruno's field and vocabulary — the only spelling that survives a file.
     *
     * This server used to write `in: header|query` instead. That was never
     * readable: upstream's parser maps the block's known keys and discards the
     * rest, so `in` came back missing and the placement silently defaulted.
     * The legacy name is still accepted as tool INPUT and translated here.
     */
    placement?: 'header' | 'queryparams';
  };
  digest?: {
    username: string;
    password: string;
  };
}

// A single multipart/form-data part.
// `value` is a string for text parts; for file parts it is a file path
// (or an array of paths for repeated / multiple-file parts).
export interface MultipartFormPart {
  name: string;
  value: string | string[];
  type?: 'text' | 'file';
  contentType?: string;
  enabled?: boolean;
}

// A single `body:file` entry. `@usebruno/lang` returns `@file(path)` parts as
// { filePath, contentType, selected } (name/value/enabled are stripped for file
// parts), so this mirrors that shape. An absent `selected` means the entry is
// sent — the `.bru` default — and each reader normalises its own dialect to that:
// the `.bru` reader records the flag only when the `~` prefix disables it, while
// the `.yml` reader sets it explicitly, since upstream reads an absent key there
// as not-selected. Only the first selected entry goes on the wire.
export interface BruFilePart {
  filePath: string;
  contentType?: string;
  selected?: boolean;
}

// A `body:graphql` payload. `@usebruno/lang` returns the graphql body as an
// object { query, variables? } (both raw strings), not a string — the string
// guard in the parser used to discard it entirely.
export interface BruGraphql {
  query: string;
  variables?: string;
}

// Request body configurations
export interface BruBody {
  type: BodyType;
  content?: string;
  formData?: MultipartFormPart[];
  formUrlEncoded?: Array<{
    name: string;
    value: string;
    enabled?: boolean;
  }>;
  graphql?: BruGraphql;
  file?: BruFilePart[];
}

// HTTP headers — effective (enabled-only) name→value map. Disabled headers are
// intentionally excluded here because this map drives what actually gets sent;
// their names/values/flags are preserved separately in BruFile.headersList so
// they survive a parse→generate round-trip.
export interface BruHeaders {
  [key: string]: string;
}

// A single header entry preserving its enabled/disabled state, following the
// MultipartFormPart `enabled?` pattern. `enabled` is only recorded
// when the header is explicitly disabled (Bruno's leading `~`); default stays
// enabled. Used for lossless round-tripping alongside the BruHeaders map.
export interface BruHeader {
  name: string;
  value: string;
  enabled?: boolean;
}

// Variable definitions
export interface BruVars {
  [key: string]: string | number | boolean;
}

// Pre-request script
export interface BruPreRequestScript {
  exec: string[];
}

// Post-response script  
export interface BruPostResponseScript {
  exec: string[];
}

// Test assertions
export interface BruTests {
  exec: string[];
}

// Complete .bru file structure
/**
 * A `params:query` / `params:path` entry. Kept as an ordered list rather than a
 * record so duplicate names and the disabled (`~`) marker both survive a
 * round-trip.
 */
export interface BruParam {
  name: string;
  value: string;
  enabled: boolean;
  type: 'query' | 'path';
}

/** An `assert` entry: an expression and the operator+operand applied to it. */
export interface BruAssertion {
  name: string;
  value: string;
  enabled: boolean;
}

/**
 * The request-level `settings` block.
 *
 * These are the keys Bruno's own .bru writer emits. `keepAliveInterval` is
 * websocket-only and `timeout: 'inherit'` is not modelled, so neither is
 * authorable here yet.
 */
/**
 * An authored `settings.timeout`, in milliseconds or as the word `inherit`.
 *
 * Both dialects accept the word: `bruToJsonV2` reads it out of a `.bru` settings
 * block, and `resolveTimeoutSetting` in `bruno-common` carries it through a
 * `.yml` write instead of flattening it to a number. In Bruno's own app it means
 * "use the application-level request-timeout preference"
 * (`bruno-electron/src/utils/collection.js:860`). This server has no preference
 * layer, so what a request inherits here is the runner's own default — the same
 * value an absent timeout already gets.
 *
 * Modelling it as a union rather than narrowing it to a number at the parser is
 * what keeps the word on disk: a modelled key never reaches the passthrough bag,
 * so a parser that dropped the value deleted it on the next write.
 */
export type TimeoutSetting = number | 'inherit';

export interface BruRequestSettings {
  encodeUrl?: boolean;
  timeout?: TimeoutSetting;
  /** The executor honours this; leaving it out of the model dropped it. */
  followRedirects?: boolean;
  maxRedirects?: number;
}

/** A `vars:pre-request` / `vars:post-response` entry. */
export interface BruVar {
  name: string;
  value: string;
  enabled: boolean;
  local?: boolean;
}

/**
 * Full-fidelity vars, split by phase. `BruVars` above is a flat name/value map
 * kept for backward compatibility; it cannot express the disabled or local
 * flags, so this list is the source of truth on generate (same split as
 * `headers`/`headersList`).
 */
export interface BruVarSets {
  req?: BruVar[];
  res?: BruVar[];
}

/** Where an oauth2 additional parameter is attached to its request. */
export type BruOAuth2ParamTarget = 'headers' | 'queryparams' | 'body';

export interface BruOAuth2AdditionalParam {
  name: string;
  value: string;
  enabled: boolean;
  sendIn: BruOAuth2ParamTarget;
}

/**
 * Extra parameters attached to the three oauth2 exchanges. The
 * grammar allows eight blocks: the authorization request takes headers and
 * queryparams, while the token and refresh requests also take body.
 */
export interface BruOAuth2AdditionalParameters {
  authorization?: BruOAuth2AdditionalParam[];
  token?: BruOAuth2AdditionalParam[];
  refresh?: BruOAuth2AdditionalParam[];
}

export interface BruFile {
  meta: BruMeta;
  /**
   * Absent for a non-http kind, which carries its target in its own block.
   *
   * Not synthesized: an empty stand-in would make the request look like a GET to
   * an empty URL, which is what this model used to do and what silently ran, and
   * failed, instead of reporting the kind.
   */
  http?: BruHttpRequest;
  /** Present for kind `grpc`, in place of `http`. */
  grpc?: BruGrpc;
  /** Present for kind `ws`. WebSocket headers live in `headersList`, not here. */
  ws?: BruWs;
  /** gRPC only. WebSocket uses the ordinary `headers` block instead. */
  metadata?: BruHeader[];
  /**
   * Top-level keys this model does not name, restricted to the ones the `.bru`
   * writer can emit again.
   *
   * The restriction is the point. `jsonToBruV2` destructures a fixed set of
   * top-level keys and drops anything else, so a bag that collected everything
   * would advertise preservation it cannot deliver. Everything else in that set
   * is modelled, which leaves `examples` as the only member.
   */
  extra?: Record<string, unknown>;
  auth?: BruAuth;
  headers?: BruHeaders;
  /**
   * Full ordered header list preserving each header's enabled/disabled (`~`)
   * state. `headers` above holds only the enabled subset for value
   * lookup and stays for backward compatibility; when present, this list is the
   * source of truth on generate so a disabled header is never silently re-armed.
   */
  headersList?: BruHeader[];
  body?: BruBody;
  vars?: BruVars;
  script?: {
    'pre-request'?: BruPreRequestScript;
    'post-response'?: BruPostResponseScript;
  };
  tests?: BruTests;
  docs?: string;
  /** `params:query` and `params:path` entries, in document order. */
  params?: BruParam[];
  /** `assert` entries, in document order. */
  assertions?: BruAssertion[];
  /** The request-level `settings` block. */
  settings?: BruRequestSettings;
  /** Vars with their disabled/local flags preserved. */
  varSets?: BruVarSets;
}

// Request creation input
/**
 * One declared assertion as the MCP tools accept it.
 *
 * `disabled` rather than `enabled`: absent means active, so the common case is
 * two fields. The `.bru` writer inverts this to `enabled`.
 */
export interface RequestAssertionInput {
  name: string;
  value: string;
  disabled?: boolean;
}

/** One declared variable as the MCP tools accept it. Same polarity choice. */
export interface RequestVarInput {
  name: string;
  value: string;
  disabled?: boolean;
  /** Pre-request only: keep the value out of the persisted runtime store. */
  local?: boolean;
}

/**
 * The request-level `settings` block as the MCP tools accept it.
 *
 * Unusually for this file there is no polarity or naming difference between the
 * two dialects: `.bru` writes these four as bare `key: value` lines inside a
 * `settings { }` block, `.yml` writes them as a top-level `settings:` mapping,
 * and both spell every key and type the same way. So this shape needs no
 * conversion on either path — it is carried through as-is.
 *
 * Every field is optional and an omitted field means an absent key, not a
 * default written down. A request authored with no settings at all carries no
 * settings block, which is what Bruno itself writes; the executor's fallbacks
 * (redirects followed, 10-hop cap, 5000ms script budget) then apply.
 */
export interface RequestSettingsInput {
  timeout?: number;
  followRedirects?: boolean;
  maxRedirects?: number;
  encodeUrl?: boolean;
}

/**
 * One authored WebSocket message.
 *
 * `selected` is kept as an explicit `false` rather than folded into absence,
 * because for a session that sends several messages the difference between "not
 * selected" and "not stated" decides what reaches the wire. The `.bru` dialect has
 * no field for it at all, which is refused rather than dropped — see
 * `validateRequestInput`.
 */
export interface CreateWebsocketMessageInput {
  /** The message's title, which is how a warning or a transcript entry names it. */
  title?: string;
  /** `text`, `json` or `xml`. Every payload goes on the wire as a string either way. */
  type?: string;
  /** The payload itself. */
  content: string;
  selected?: boolean;
}

/** The WebSocket-only half of a create/modify input. */
export interface CreateWebsocketInput {
  messages?: CreateWebsocketMessageInput[];
}

/** One gRPC message. No type and no selection — the format carries neither. */
export interface CreateGrpcMessageInput {
  /** The message's title. Defaults to `message N` by position, as Bruno names it. */
  title?: string;
  /** The payload, as JSON text. Empty content is written as `{}`, which is what Bruno writes. */
  content: string;
}

/** The gRPC-only half of a create/modify input. */
export interface CreateGrpcInput {
  /**
   * The fully qualified RPC method, e.g. `/greet.Greeter/SayHello`. Not an HTTP
   * verb, which is why it lives here rather than reusing `method`.
   */
  method?: string;
  /**
   * The `.proto` file, relative to the collection. Confined to the collection at
   * author time by the same rule the run path applies, and stored relative to it
   * whichever spelling arrives, so the file survives being cloned somewhere else.
   */
  protoPath?: string;
  /**
   * `unary`, `client-streaming`, `server-streaming` or `bidi-streaming`. Not
   * narrowed to what this server can run: Bruno writes all four, and refusing to
   * author one would make a collection this server cannot round-trip.
   */
  methodType?: string;
  messages?: CreateGrpcMessageInput[];
}

/**
 * What kind of request to author. Absent means `http`, so every call written
 * before this existed still means what it meant.
 */
export type CreateRequestKind = 'http' | 'ws' | 'grpc';

/**
 * The edit side of `CreateRequestInput`: every field optional, plus one that
 * exists only here. Creating a request derives its file's name from the
 * request's name; editing one keeps the two apart, so changing the name leaves
 * the file where it is and `filename` is how the file itself moves. Bruno draws
 * the same line — it has one rename path for each.
 */
export type UpdateRequestInput = Partial<CreateRequestInput> & {
  /** New basename for the file, in the request's own folder. */
  filename?: string;
};

export interface CreateRequestInput {
  collectionPath: string;
  name: string;
  kind?: CreateRequestKind;
  /**
   * Required for an http request and refused for a WebSocket one, which has no
   * method: the optionality is the type admitting that, and
   * `validateRequestInput` is what enforces it.
   */
  method?: HttpMethod;
  url: string;
  /**
   * WebSocket messages. Refused unless `kind` is `ws`, so a stray key cannot
   * quietly do nothing.
   */
  websocket?: CreateWebsocketInput;
  /**
   * The gRPC method, proto file and messages. Refused unless `kind` is `grpc`, so
   * a stray key cannot quietly do nothing.
   */
  grpc?: CreateGrpcInput;
  /**
   * For a gRPC request these are written as metadata, which is the only header
   * surface that transport has: `.bru` puts them in a `metadata` block and `.yml`
   * inside `grpc.metadata`. A `headers` block on a gRPC request is a block
   * Bruno's gRPC parser does not read.
   */
  headers?: Record<string, string>;
  body?: {
    type: BodyType;
    content?: string;
    formData?: MultipartFormPart[];
    /**
     * A graphql body's variables, as the raw JSON text the author wrote.
     *
     * Kept as text on purpose, all the way to disk: both dialects store it that
     * way, and parsing it here would force a re-serialisation on write that
     * reflows the author's JSON and destroys a `{{placeholder}}` which is not
     * valid JSON standing alone.
     */
    variables?: string;
    /**
     * A file body's parts. `content` remains the one-file shorthand — it is
     * read as a single `filePath` — but only this can carry a content type, a
     * deselected entry, or more than one file, which is the shape both dialects
     * actually store.
     */
    files?: BruFilePart[];
  };
  auth?: {
    type: AuthType;
    config: Record<string, string>;
  };
  query?: Record<string, string | number | boolean>;
  /**
   * Values for `:name` segments in the URL, written as a `params:path` block.
   * Separate from `query` because the two address different parts of the URL and
   * are replaced independently on update.
   */
  pathParams?: Record<string, string | number | boolean>;
  /**
   * Declared assertions, written as an `assert` block and evaluated by the
   * executor after the post-response script. `name` is the left-hand expression
   * (`res.status`), `value` is the operator plus operand (`eq 200`).
   *
   * The two file formats spell the switched-off flag with opposite polarity, so
   * this surface picks one — absent `disabled` means active — and each writer
   * converts.
   */
  assert?: RequestAssertionInput[];
  /**
   * Declared variables. The two halves are asymmetric: `preRequest` values are
   * RAW text folded into interpolation before the request is built, while
   * `postResponse` values are JS EXPRESSIONS evaluated against the response.
   */
  vars?: {
    preRequest?: RequestVarInput[];
    postResponse?: RequestVarInput[];
  };
  /**
   * The request-level `settings` block: transport behaviour, not payload.
   *
   * Merged field-by-field on update rather than replaced, so raising the timeout
   * does not silently re-enable redirect following. Omitted entirely on create
   * unless the caller asks for it.
   */
  settings?: RequestSettingsInput;
  folder?: string;
  sequence?: number;
  /**
   * Inline scripts to persist on creation. Keys are script types; canonical
   * values are 'pre-request', 'post-response', 'tests', but the aliases
   * 'before-request' (→ pre-request) and 'after-response' (→ post-response)
   * are also accepted and normalized.
   */
  scripts?: Record<string, string>;
  /**
   * How `scripts` is written on update: 'replace' (default) overwrites the
   * existing script in each targeted slot, 'append' concatenates onto it.
   * Ignored on creation, where the file has no prior scripts.
   */
  scriptMode?: 'append' | 'replace';
}

// Collection creation input
export interface CreateCollectionInput {
  name: string;
  description?: string;
  baseUrl?: string;
  outputPath: string;
  ignore?: string[];
  format?: 'yaml' | 'bru';
}

// Environment creation input
export interface CreateEnvironmentInput {
  collectionPath: string;
  name: string;
  /**
   * Either the flat `name -> scalar` map this tool has always taken, or the full
   * per-variable form.
   *
   * The flat map cannot express `secret`, `disabled` or `dataType`, so creating an
   * environment through it could only ever produce plain, enabled, string-typed
   * variables and a secret took a second `set_environment_variable` call to
   * declare. Both shapes are accepted rather than the map being replaced, because
   * the map is the whole existing surface and it stays correct for the common case.
   */
  variables: Record<string, string | number | boolean> | EnvVariable[];
  /**
   * Replace an environment that already exists. Without it an existing name is
   * refused, because this call replaces the whole file: any variable the caller
   * did not list is gone, and a secret cannot be re-declared from the file alone
   * since no format stores a secret's value.
   *
   * Unmodelled keys in the file are carried either way — refusing is about the
   * caller's variables, not about the keys we do not model.
   */
  overwrite?: boolean;
}

/**
 * Why a create was refused, and enough to choose what to do instead.
 *
 * Carried as structured data rather than only prose so the tool layer renders it
 * one way and tests assert on fields. Values are deliberately absent: a secret
 * has none stored, `get_collection_stats` withholds them by design, and an error
 * message is the wrong channel for a token. `read_environment` is where a caller
 * that needs values goes.
 */
export interface EnvironmentConflict {
  /** The file that would have been replaced. */
  path: string;
  /** Every variable already in the file, by name, with its flags. */
  existing: Array<{ name: string; secret?: boolean; disabled?: boolean }>;
  /** Names in both the file and the request — merging leaves these alone. */
  alreadyPresent: string[];
  /** Names only in the request — merging adds these. */
  added: string[];
  /**
   * Names only in the file. **This is the one that decides.** Empty means the
   * request is a superset and replacing loses nothing; non-empty means replacing
   * deletes real variables, so the caller should merge or pick another name.
   */
  wouldBeLost: string[];
}

// Test script addition input
export interface AddTestScriptInput {
  bruFilePath: string;
  scriptType: 'pre-request' | 'post-response' | 'tests';
  script: string;
}

// Test suite creation input
export interface CreateTestSuiteInput {
  collectionPath: string;
  suiteName: string;
  requests: Array<{
    name: string;
    method: HttpMethod;
    url: string;
    headers?: Record<string, string>;
    body?: {
      type: BodyType;
      content?: string;
    };
    auth?: {
      type: AuthType;
      config: Record<string, string>;
    };
    folder?: string;
  }>;
  dependencies?: Array<{
    from: string;
    to: string;
    variable: string;
  }>;
}

// Bruno file generation options
export interface BruGeneratorOptions {
  indentSize?: number;
  useSpaces?: boolean;
  addTimestamp?: boolean;
  validateSyntax?: boolean;
}

// Error types
export class BrunoError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'BrunoError';
  }
}

export class BruValidationError extends BrunoError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', details);
    this.name = 'BruValidationError';
  }
}

export class BruFileError extends BrunoError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'FILE_ERROR', details);
    this.name = 'BruFileError';
  }
}

// ---------------------------------------------------------------------------
// YAML opencollection format types
// ---------------------------------------------------------------------------

export interface YamlInfo {
  name: string;
  /**
   * A request kind, or `folder` — this interface is shared by `YamlRequest` and
   * `YamlFolder`, so the set is deliberately wider than `RequestKind`.
   */
  type?: RequestKind | 'folder';
  seq?: number;
  /** Runner tags. Same list-or-nothing rule as `BruMeta.tags`. */
  tags?: string[];
  /** Unmodelled `info` keys, carried through a write. See `extra-keys.ts`. */
  extra?: Record<string, unknown>;
}

export interface YamlHeader {
  name: string;
  value: string;
  /** Unmodelled keys on this header entry, carried through a write. */
  extra?: Record<string, unknown>;
  /**
   * A header the author switched off. It must survive a round-trip and must not
   * be sent: dropping the flag silently re-armed a header the user
   * had deliberately disabled, including a credential one.
   */
  disabled?: boolean;
}

export interface FormUrlEncodedPart {
  name: string;
  value: string;
  /** A pair the author switched off. It must round-trip and must not be sent. */
  enabled?: boolean;
}

export interface YamlBody {
  type: string;
  /**
   * Discriminated by `type`, the way multipart already is: a string for the
   * textual bodies, pairs for 'form-urlencoded', an envelope for 'graphql'.
   *
   * Structured bodies stay parsed all the way to buildFetchOptions instead of
   * being serialized here. Serializing early and substituting afterwards is a
   * correctness trap: a string body has `{{var}}` substituted into it at send
   * time, so a variable whose value contains `&` or `=` would splice extra
   * fields into an already-encoded form body, and one containing `"` would
   * break an already-stringified JSON envelope. Encoding after substitution is
   * the only order that cannot forge structure.
   */
  data?: string | MultipartFormPart[] | FormUrlEncodedPart[] | BruFilePart[] | BruGraphql;
}

export type YamlAuth =
  | 'inherit'
  | {
      type: string;
      token?: string;
      username?: string;
      password?: string;
      [key: string]: unknown;
    };

export interface YamlHttp {
  method: string;
  url: string;
  headers?: YamlHeader[];
  body?: YamlBody;
  params?: YamlParam[];
  auth?: YamlAuth;
  /** Unmodelled `http` keys, carried through a write. See `extra-keys.ts`. */
  extra?: Record<string, unknown>;
}

export interface YamlParam {
  name: string;
  value: string;
  type?: 'query' | 'path';
  disabled?: boolean;
  /** Unmodelled keys on this param entry, carried through a write. */
  extra?: Record<string, unknown>;
}

/**
 * A `runtime.scripts` entry. Bruno's .yml dialect has three slots, not two:
 * 'tests' is its own entry type and is read back into the request's `tests`
 * block, whereas 'after-response' becomes `script.res`.
 */
export interface YamlScript {
  type: 'before-request' | 'after-response' | 'tests';
  code: string;
}

export interface YamlRuntime {
  scripts: YamlScript[];
  /**
   * Unmodelled `runtime` keys, carried through a write.
   *
   * The other three blocks upstream puts here — `variables`, `assertions` and
   * `actions` — are modelled on `YamlRequest` itself rather than here, so they
   * are named in `YAML_RUNTIME_KEYS` and never land in this bag.
   */
  extra?: Record<string, unknown>;
}

export interface TlsSettings {
  rejectUnauthorized?: boolean;
  ca?: string;
  cert?: string;
  key?: string;
  /**
   * Unmodelled keys inside the `tls` block, carried through a write.
   *
   * The block needs its own bag because `tls` is a modelled key of
   * `YamlSettings`: an unrecognised field inside it never reaches the settings
   * bag, so without this a `tls` block made of fields we do not name parsed to
   * nothing and was deleted on the next write.
   */
  extra?: Record<string, unknown>;
}

export interface YamlSettings {
  encodeUrl?: boolean;
  timeout?: TimeoutSetting;
  followRedirects?: boolean;
  maxRedirects?: number;
  tls?: TlsSettings;
  proxy?: string;
  /** Unmodelled `settings` keys, carried through a write. */
  extra?: Record<string, unknown>;
}

/** An `assert` entry in a .yml request. */
export interface YamlAssertion {
  name: string;
  value: string;
  disabled?: boolean;
}

/** A `vars` entry in a .yml request. */
export interface YamlVar {
  name: string;
  value: string;
  disabled?: boolean;
  local?: boolean;
  /**
   * Set only when the on-disk value was a typed `{ type, data }` and the type is
   * not `string`. `value` always holds the `data` as written, so substitution
   * never has to know about this; it exists so writing the variable back does
   * not silently retype it as a plain string.
   */
  dataType?: string;
}

export interface YamlVars {
  preRequest?: YamlVar[];
  postResponse?: YamlVar[];
}

export interface YamlRequest {
  info: YamlInfo;
  /** Absent for a non-http kind. See the same field on `BruFile`. */
  http?: YamlHttp;
  /** Present only for a gRPC request, in place of `http`. */
  grpc?: YamlGrpc;
  /** Present only for a WebSocket request, in place of `http`. */
  websocket?: YamlWebsocket;
  runtime?: YamlRuntime;
  settings?: YamlSettings;
  docs?: string;
  /** Assertions, preserved across a round-trip. */
  assert?: YamlAssertion[];
  /** Pre-request and post-response vars, preserved across a round-trip. */
  vars?: YamlVars;
  /**
   * Top-level blocks this model does not name, carried through a write.
   *
   * This is where `examples` lands, and every other block Bruno's grammar has
   * or grows — `graphql`, `grpc`, `websocket`, `items`, `request`. Without it a
   * `modify_request` on a Bruno-authored file deletes them. See `extra-keys.ts`.
   */
  extra?: Record<string, unknown>;
}

export interface YamlFolder {
  info: YamlInfo;
  request?: {
    auth?: YamlAuth;
    [key: string]: unknown;
  };
}

export interface YamlCollection {
  opencollection: string;
  info: {
    name: string;
    [key: string]: unknown;
  };
  bundled?: boolean;
  extensions?: {
    bruno?: {
      ignore?: string[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Workspace types
// ---------------------------------------------------------------------------

export interface WorkspaceCollection {
  name: string;
  path: string;
}

export interface WorkspaceYml {
  opencollection?: string;
  info?: { name: string; type: string };
  collections?: WorkspaceCollection[] | null;
  specs?: unknown;
  docs?: string;
}

export interface CollectionInfo {
  name: string;
  path: string;
  exists: boolean;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface ResponseData {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  responseTime: number;
}

export interface MockResponseData {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  responseTime: number;
  /** Raw response text before any JSON parsing (consumed once from the stream). */
  rawBody?: string;
  /** Every Set-Cookie value, preserved individually — the flat
   * `headers` map comma-joins them, which is lossy because cookie values may
   * contain commas. Present only when the response set at least one cookie. */
  setCookies?: string[];
}

// ---------------------------------------------------------------------------
// Test runner types
// ---------------------------------------------------------------------------

export interface TestResult {
  description: string;
  status: 'pass' | 'fail';
  error?: string;
}

/**
 * One declared assertion to evaluate, reduced to what the sandbox needs.
 *
 * `name` is the left-hand side and is a JS expression (`res.status`,
 * `res.body.items.length`); `value` is the raw `<operator> <operand>` string as
 * authored. Both formats' enabled/disabled polarity is resolved before an
 * assertion reaches this type — a disabled one is dropped, never carried with a
 * flag, so nothing downstream can evaluate a check the author switched off.
 */
export interface SandboxAssertion {
  readonly name: string;
  readonly value: string;
}

export interface TestRunnerOptions {
  timeout?: number;
  /**
   * External (env/collection) variables the script may read via bru.getVar
   *. Seeded into the sandbox's read store only; a variable the
   * script merely reads is not echoed back in the result's `variables`.
   */
  variables?: Record<string, unknown>;
  /**
   * Declared assertions to evaluate alongside the script. Already filtered to
   * the enabled ones.
   */
  assertions?: readonly SandboxAssertion[];
  /**
   * `vars:post-response` entries to evaluate before the script and the
   * assertions, already filtered to the enabled ones.
   *
   * Each `value` is a JS EXPRESSION, not a literal — that is the asymmetry with
   * `vars:pre-request`, whose values are raw text folded into interpolation
   * before the request is even built. The result of each is written to the
   * variable store under `name`, so the script and the assertions both see it.
   */
  postResponseVars?: readonly SandboxAssertion[];
}

export interface ScriptResult {
  results: TestResult[];
  variables: Record<string, unknown>;
  requestMutations?: RequestMutations;
  /**
   * Non-fatal diagnostics about the script itself — e.g. assertions that ran
   * outside a test() block and therefore produced no reportable result.
   */
  warnings?: string[];
}

export interface MockRequestData {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface RequestMutations {
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface PreRequestScriptResult {
  variables: Record<string, unknown>;
  mutations: RequestMutations;
  error?: string;
}

// ---------------------------------------------------------------------------
// Environment types
// ---------------------------------------------------------------------------

export interface EnvVariable {
  name: string;
  value?: string | number | boolean;
  disabled?: boolean;
  /** Whether the variable is a secret. In BOTH on-disk formats a secret's
   * VALUE is never persisted (.bru lists the bare name in `vars:secret [...]`,
   * .yml writes `secret: true` with no `value` key) — the value lives in
   * Bruno's secret store. Preserved across parse/generate/merge so an edit
   * does not downgrade a secret var to plaintext. */
  secret?: boolean;
  /** Keys present on this variable in the file that the fields above do not
   * model (.yml `type`, `description`). Carried verbatim so a
   * read-modify-write does not delete them. Never holds a modelled key. */
  extra?: Record<string, unknown>;
}

export interface EnvFile {
  name?: string;
  variables?: EnvVariable[];
  /** Top-level keys present in the file that the fields above do not model
   * (`color`, `externalSecrets`). Carried verbatim so a read-modify-write does
   * not delete them. Never holds `name` or `variables`. */
  extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Collection stats types
// ---------------------------------------------------------------------------

// Moved to collection-stats-types.ts when this file crossed the repo-wide
// max-lines ceiling, as the run-result types did before them. Re-exported here
// so that types.ts stays the one import a caller needs.
export type {
  RequestDetail,
  RequestDetailFilter,
  EnvironmentDetail,
  CollectionStats,
} from './collection-stats-types.js';

// ---------------------------------------------------------------------------
// Request executor types
// ---------------------------------------------------------------------------

// Moved to run-results.ts when this file crossed the repo-wide max-lines ceiling,
// and re-exported so every existing importer keeps working. The names are part of
// this module's surface whatever file they are declared in.
export type {
  RequestExecutionResult,
  CollectionRunSummary,
  GroupRunResult,
  CollectionRunResult,
  ParseFailure,
} from './run-results.js';

// Utility types for better type safety
export type BrunoCollectionConfig = Omit<BrunoCollection, 'type'> & {
  type?: 'collection';
};

export type HttpRequestMethod = Extract<HttpMethod, 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'>;

// `AuthenticationMethod` used to live here, listing bearer/basic/oauth2/api-key
// as the "authentication methods". Nothing imported it and it was wrong anyway —
// oauth2 is never applied. AppliedAuthType / UnappliedAuthType, declared beside
// AuthType, carry that distinction correctly and are used by the executor.

// ---------------------------------------------------------------------------
// Path validation types
// ---------------------------------------------------------------------------

export interface PathValidationResult {
  valid: boolean;
  resolved: string;
  reason?: string;
}

export interface CollectionPathValidationResult {
  valid: boolean;
  reason?: string;
}

// File system related types
export interface FileOperationResult {
  success: boolean;
  path?: string;
  error?: string;
  /**
   * Set only by createEnvironment, and only when it refused because the
   * environment already exists. `error` still carries a readable summary, so a
   * caller that ignores this field is no worse off than before.
   */
  conflict?: EnvironmentConflict;
}

export interface DirectoryStructure {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: DirectoryStructure[];
}
