import { parse as parseYaml } from 'yaml';
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
  type YamlScript,
  type YamlInfo,
  type MultipartFormPart,
  type TlsSettings,
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
  return raw.map((h: Record<string, unknown>) => ({
    name: String(h.name ?? ''),
    value: String(h.value ?? ''),
  }));
}

function parseBody(raw: unknown): YamlBody | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;

  let data: YamlBody['data'];
  if (Array.isArray(obj.data)) {
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
      return item;
    });
  } else if (obj.data !== undefined) {
    data = String(obj.data);
  }

  return {
    type: String(obj.type ?? ''),
    data,
  };
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
  return {
    method: String(raw.method ?? '').toUpperCase(),
    url: String(raw.url ?? ''),
    headers: parseHeaders(raw.headers),
    body: parseBody(raw.body),
    auth: parseAuth(raw.auth),
  };
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
