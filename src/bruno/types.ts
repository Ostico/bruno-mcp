/**
 * TypeScript interfaces for Bruno BRU file format
 * Based on the Bru markup language specification
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export type AuthType = 'none' | 'bearer' | 'basic' | 'oauth2' | 'api-key' | 'digest';

export type BodyType = 'none' | 'json' | 'text' | 'xml' | 'form-data' | 'form-urlencoded' | 'binary';

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
}

// HTTP headers
export interface BruHeaders {
  [key: string]: string;
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
export interface BruFile {
  meta: BruMeta;
  http: BruHttpRequest;
  auth?: BruAuth;
  headers?: BruHeaders;
  query?: BruQuery;
  body?: BruBody;
  vars?: BruVars;
  script?: {
    'pre-request'?: BruPreRequestScript;
    'post-response'?: BruPostResponseScript;
  };
  tests?: BruTests;
  docs?: string;
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

export interface YamlRequest {
  info: YamlInfo;
  http: YamlHttp;
  runtime?: YamlRuntime;
  settings?: YamlSettings;
  docs?: string;
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
}

export interface ScriptResult {
  results: TestResult[];
  variables: Record<string, unknown>;
  requestMutations?: RequestMutations;
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

export interface CollectionStats {
  totalRequests: number;
  requestsByMethod: Record<string, number>;
  folders: string[];
  environments: string[];
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
  error?: string;
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