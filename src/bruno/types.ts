/**
 * TypeScript interfaces for Bruno BRU file format
 * Based on the Bru markup language specification
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export type AuthType = 'none' | 'bearer' | 'basic' | 'oauth2' | 'api-key' | 'digest';

// 'multipart-form' is the block name used by the .bru wire format (see the
// `body:multipart-form {` block emitted by the generator); 'form-data' is the
// equivalent name used on the MCP-facing side. Both reach BodyType at runtime,
// so both belong in the union.
export type BodyType =
  | 'none'
  | 'json'
  | 'text'
  | 'xml'
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

// Meta block in .bru files
export interface BruMeta {
  name: string;
  type: 'http' | 'graphql';
  seq?: number;
}

// HTTP request configuration
export interface BruHttpRequest {
  method: HttpMethod;
  url: string;
  body: BodyType;
  auth: AuthType;
}

// Authentication configurations
export interface BruAuth {
  type: AuthType;
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
    in: 'header' | 'query';
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
// parts), so this mirrors that shape. `selected` is only recorded when the part
// is explicitly disabled; default stays selected/enabled.
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

// Query parameters
export interface BruQuery {
  [key: string]: string | number | boolean;
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

/** The request-level `settings` block. */
export interface BruRequestSettings {
  encodeUrl?: boolean;
  timeout?: number;
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
  http: BruHttpRequest;
  auth?: BruAuth;
  headers?: BruHeaders;
  /**
   * Full ordered header list preserving each header's enabled/disabled (`~`)
   * state. `headers` above holds only the enabled subset for value
   * lookup and stays for backward compatibility; when present, this list is the
   * source of truth on generate so a disabled header is never silently re-armed.
   */
  headersList?: BruHeader[];
  query?: BruQuery;
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
export interface CreateRequestInput {
  collectionPath: string;
  name: string;
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: {
    type: BodyType;
    content?: string;
    formData?: MultipartFormPart[];
  };
  auth?: {
    type: AuthType;
    config: Record<string, string>;
  };
  query?: Record<string, string | number | boolean>;
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
  variables: Record<string, string | number | boolean>;
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
  type?: 'http' | 'graphql' | 'folder';
  seq?: number;
}

export interface YamlHeader {
  name: string;
  value: string;
  /**
   * A header the author switched off. It must survive a round-trip and must not
   * be sent: dropping the flag silently re-armed a header the user
   * had deliberately disabled, including a credential one.
   */
  disabled?: boolean;
}

export interface YamlBody {
  type: string;
  data?: string | MultipartFormPart[];
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
}

export interface YamlParam {
  name: string;
  value: string;
  type?: 'query' | 'path';
  disabled?: boolean;
}

export interface YamlScript {
  type: 'before-request' | 'after-response';
  code: string;
}

export interface YamlRuntime {
  scripts: YamlScript[];
}

export interface TlsSettings {
  rejectUnauthorized?: boolean;
  ca?: string;
  cert?: string;
  key?: string;
}

export interface YamlSettings {
  encodeUrl?: boolean;
  timeout?: number;
  followRedirects?: boolean;
  maxRedirects?: number;
  tls?: TlsSettings;
  proxy?: string;
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
}

export interface YamlVars {
  preRequest?: YamlVar[];
  postResponse?: YamlVar[];
}

export interface YamlRequest {
  info: YamlInfo;
  http: YamlHttp;
  runtime?: YamlRuntime;
  settings?: YamlSettings;
  docs?: string;
  /** Assertions, preserved across a round-trip. */
  assert?: YamlAssertion[];
  /** Pre-request and post-response vars, preserved across a round-trip. */
  vars?: YamlVars;
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

export interface TestRunnerOptions {
  timeout?: number;
  /**
   * External (env/collection) variables the script may read via bru.getVar
   *. Seeded into the sandbox's read store only; a variable the
   * script merely reads is not echoed back in the result's `variables`.
   */
  variables?: Record<string, unknown>;
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
  /** Whether the .bru `secret` flag is set on this variable. Preserved across
   * parse/generate/merge so an edit does not downgrade a secret var to
   * plaintext. */
  secret?: boolean;
}

export interface EnvFile {
  name?: string;
  variables?: EnvVariable[];
}

// ---------------------------------------------------------------------------
// Collection stats types
// ---------------------------------------------------------------------------

export interface RequestDetail {
  name: string;
  method: string;
  seq: number;
  folder: string;
  hasTests: boolean;
  filePath?: string;
}

export interface EnvironmentDetail {
  name: string;
  /**
   * Variable names only. Values are withheld: environments routinely hold
   * tokens, and the caller's need here is to know what exists before merging
   * into it, not to read secrets back out.
   */
  variables: string[];
}

export interface CollectionStats {
  totalRequests: number;
  requestsByMethod: Record<string, number>;
  environments: string[];
  environmentDetails: EnvironmentDetail[];
  folders: string[];
  requests: RequestDetail[];
}

// ---------------------------------------------------------------------------
// Request executor types
// ---------------------------------------------------------------------------

export interface RequestExecutionResult {
  name: string;
  method: string;
  url: string;
  status: number;
  duration_ms: number;
  tests: TestResult[];
  /**
   * Non-fatal diagnostics for this request — surfaced so a run that recorded
   * zero assertions does not read as an unqualified pass.
   */
  warnings?: string[];
  error?: string;
  response_body?: string;
  response_body_truncated?: boolean;
  response_content_type?: string;
}

export interface CollectionRunSummary {
  total: number;
  passed: number;
  failed: number;
  duration_ms: number;
}

export interface CollectionRunResult {
  summary: CollectionRunSummary;
  results: RequestExecutionResult[];
  parseErrors?: number;
}

// Utility types for better type safety
export type BrunoCollectionConfig = Omit<BrunoCollection, 'type'> & {
  type?: 'collection';
};

export type HttpRequestMethod = Extract<HttpMethod, 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'>;

export type AuthenticationMethod = Extract<AuthType, 'bearer' | 'basic' | 'oauth2' | 'api-key'>;

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
}

export interface DirectoryStructure {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: DirectoryStructure[];
}