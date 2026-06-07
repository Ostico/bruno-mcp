import { bruToJsonV2, jsonToBruV2, bruToEnvJsonV2, envJsonToBruV2 } from '@usebruno/lang';
import {
  BrunoError,
  type BruFile,
  type BruMeta,
  type BruHttpRequest,
  type BruAuth,
  type BruHeaders,
  type BruBody,
  type BrunoEnvironment,
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
    body = { type: http.body };
    const bodyContent = json.body[http.body];
    if (typeof bodyContent === 'string') {
      body.content = bodyContent;
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

  if (bruFile.body?.content) {
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
    throw new BrunoError(
      `Failed to generate .bru environment: ${err instanceof Error ? err.message : String(err)}`,
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
    throw new BrunoError(
      `Failed to generate .bru file after script injection: ${err instanceof Error ? err.message : String(err)}`,
      'GENERATE_ERROR',
    );
  }
}
