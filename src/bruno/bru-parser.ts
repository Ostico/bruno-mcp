import { bruToJsonV2, jsonToBruV2, bruToEnvJsonV2, envJsonToBruV2 } from '@usebruno/lang';
import {
  BrunoError,
  type BruFile,
  type BruMeta,
  type BruHttpRequest,
  type BruAuth,
  type BruHeaders,
  type BruBody,
  type MultipartFormPart,
  type BrunoEnvironment,
  type EnvVariable,
  type HttpMethod,
  type AuthType,
  type BodyType,
} from './types.js';

const MAX_SCRIPT_SIZE = 50_000;

interface BruLangJson {
  meta?: { name?: string; type?: string; seq?: string | number };
  http?: { method?: string; url?: string; body?: string; auth?: string };
  headers?: Array<{ name: string; value: string; enabled?: boolean }>;
  auth?: Record<string, unknown>;
  body?: Record<string, unknown>;
  query?: Array<{ name: string; value: string; enabled?: boolean }>;
  vars?: { req?: Array<{ name: string; value: string; enabled?: boolean }>; res?: Array<{ name: string; value: string; enabled?: boolean }> };
  script?: { req?: string; res?: string };
  tests?: string;
  docs?: string;
}

interface BruLangEnvJson {
  variables?: Array<{ name: string; value?: string; enabled?: boolean; secret?: boolean; type?: string }>;
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

  const method = (json.http?.method?.toUpperCase() ?? 'GET') as HttpMethod;
  const http: BruHttpRequest = {
    method,
    url: json.http?.url ?? '',
    body: (json.http?.body ?? 'none') as BodyType,
    auth: (json.http?.auth ?? 'none') as AuthType,
  };

  const headers: BruHeaders = {};
  if (json.headers && Array.isArray(json.headers)) {
    for (const h of json.headers) {
      if (h.enabled !== false) {
        headers[h.name] = h.value;
      }
    }
  }

  let auth: BruAuth | undefined;
  if (json.auth && Object.keys(json.auth).length > 0) {
    auth = { type: http.auth, ...json.auth } as BruAuth;
  }

  let body: BruBody | undefined;
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
      body = { type: http.body };
      const bodyContent = json.body[http.body];
      if (typeof bodyContent === 'string') {
        body.content = bodyContent;
      }
    }
  }

  const bruFile: BruFile = { meta, http };
  if (Object.keys(headers).length > 0) bruFile.headers = headers;
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

  return bruFile;
}

export function generateBruRequest(bruFile: BruFile): string {
  const json: Record<string, unknown> = {
    meta: {
      name: bruFile.meta.name,
      type: bruFile.meta.type ?? 'http',
      seq: bruFile.meta.seq != null ? String(bruFile.meta.seq) : undefined,
    },
    http: {
      method: bruFile.http.method.toLowerCase(),
      url: bruFile.http.url,
      body: bruFile.http.body ?? 'none',
      auth: bruFile.http.auth ?? 'none',
    },
  };

  if (bruFile.headers && Object.keys(bruFile.headers).length > 0) {
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
  } else if (bruFile.body?.content) {
    json.body = { [bruFile.http.body]: bruFile.body.content };
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
 * Note: the .bru `secret` flag is not represented in EnvVariable and is dropped.
 */
export function parseBruEnvironmentRaw(content: string): EnvVariable[] {
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
  return variables;
}

/**
 * Generate a .bru environment from a full variable list, preserving the
 * enabled/disabled state of each variable (disabled === true → enabled: false)
 * and its `secret` flag (finding D7 — writing it unconditionally false
 * downgraded every secret var to plaintext on any env edit).
 */
export function generateBruEnvironmentFull(vars: EnvVariable[]): string {
  const variables = vars.map((v) => ({
    name: v.name,
    value: String(v.value ?? ''),
    enabled: v.disabled !== true,
    secret: v.secret === true,
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
