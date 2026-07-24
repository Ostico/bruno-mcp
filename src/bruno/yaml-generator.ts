/**
 * YAML Generator — inverse of yaml-parser.ts.
 *
 * Generates YAML file content from typed structures for opencollection format.
 */

import { stringify as yamlStringify, parse as parseYaml } from 'yaml';
import {
  BrunoError,
  type YamlRequest,
  type YamlCollection,
  type EnvFile,
} from './types.js';

/**
 * Strip undefined and null values from an object tree so they
 * don't appear as `key: null` in the YAML output.
 */
function stripEmpty(obj: unknown): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) {
    const cleaned = obj.map(stripEmpty).filter((v) => v !== undefined);
    return cleaned.length > 0 ? cleaned : undefined;
  }
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const cleaned = stripEmpty(value);
      if (cleaned !== undefined) {
        result[key] = cleaned;
      }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }
  return obj;
}

/**
 * Generate YAML request file content from a YamlRequest object.
 */
export function generateYamlRequest(request: YamlRequest): string {
  const doc: Record<string, unknown> = {};

  // info section
  const info: Record<string, unknown> = { name: request.info.name };
  if (request.info.type) info.type = request.info.type;
  if (request.info.seq !== undefined) info.seq = request.info.seq;
  doc.info = info;

  // http section
  const http: Record<string, unknown> = {
    method: request.http.method,
    url: request.http.url,
  };
  if (request.http.headers && request.http.headers.length > 0) {
    http.headers = request.http.headers.map((h) => ({ name: h.name, value: h.value }));
  }
  if (request.http.body) {
    http.body = stripEmpty(request.http.body);
  }
  if (request.http.params && request.http.params.length > 0) {
    http.params = request.http.params.map((p) => {
      const param: Record<string, unknown> = { name: p.name, value: p.value };
      if (p.type) param.type = p.type;
      if (p.disabled) param.disabled = p.disabled;
      return param;
    });
  }
  if (request.http.auth !== undefined) {
    http.auth = request.http.auth;
  }
  doc.http = http;

  // runtime section
  if (request.runtime && request.runtime.scripts && request.runtime.scripts.length > 0) {
    doc.runtime = {
      scripts: request.runtime.scripts.map((s) => ({ type: s.type, code: s.code })),
    };
  }

  // settings section
  if (request.settings) {
    doc.settings = stripEmpty(request.settings);
  }

  // docs
  if (request.docs) {
    doc.docs = request.docs;
  }

  const cleaned = stripEmpty(doc) as Record<string, unknown>;
  return yamlStringify(cleaned, { indent: 2 });
}

/**
 * Generate YAML opencollection file content from a YamlCollection object.
 */
export function generateYamlCollection(collection: YamlCollection): string {
  const doc: Record<string, unknown> = {
    opencollection: collection.opencollection,
    info: collection.info,
  };

  if (collection.bundled !== undefined) {
    doc.bundled = collection.bundled;
  }

  if (collection.extensions) {
    doc.extensions = stripEmpty(collection.extensions);
  }

  const cleaned = stripEmpty(doc) as Record<string, unknown>;
  return yamlStringify(cleaned, { indent: 2 });
}

/**
 * Generate YAML environment file content from an EnvFile object.
 */
export function generateYamlEnvironment(env: EnvFile): string {
  const doc: Record<string, unknown> = {};

  if (env.name) {
    doc.name = env.name;
  }

  if (env.variables && env.variables.length > 0) {
    doc.variables = env.variables.map((v) => {
      const entry: Record<string, unknown> = { name: v.name };
      if (v.value !== undefined) entry.value = v.value;
      if (v.disabled !== undefined) entry.disabled = v.disabled;
      return entry;
    });
  }

  const cleaned = stripEmpty(doc) as Record<string, unknown>;
  return yamlStringify(cleaned, { indent: 2 });
}

/**
 * Inject a script into existing YAML request file content.
 *
 * @param content     Existing YAML content
 * @param scriptType  'before-request' or 'after-response'
 * @param scriptCode  The script code to inject
 * @param mode        'append' adds to existing scripts, 'replace' replaces scripts of same type
 * @returns Updated YAML content
 */
/**
 * Remove every script of the given type from YAML request file content.
 *
 * Bruno's .yml dialect has a single `after-response` slot, so removing
 * 'after-response' removes what the MCP surface calls both post-response
 * and tests.
 *
 * @returns Updated YAML content
 */
export function removeYamlScript(
  content: string,
  scriptType: 'before-request' | 'after-response',
): string {
  if (scriptType !== 'before-request' && scriptType !== 'after-response') {
    throw new BrunoError(
      `Invalid script type "${scriptType}": expected "before-request" or "after-response"`,
      'VALIDATION_ERROR',
    );
  }

  const parsed = parseYaml(content) as Record<string, unknown>;

  const runtime = parsed.runtime as Record<string, unknown> | undefined;
  if (!runtime || typeof runtime !== 'object' || !Array.isArray(runtime.scripts)) {
    return yamlStringify(parsed, { indent: 2 });
  }

  const scripts = runtime.scripts as Array<{ type: string; code: string }>;
  const kept = scripts.filter((s) => s.type !== scriptType);

  if (kept.length === 0) {
    // Drop the now-empty containers rather than leaving `scripts: []` behind
    delete runtime.scripts;
    if (Object.keys(runtime).length === 0) {
      delete parsed.runtime;
    }
  } else {
    runtime.scripts = kept;
  }

  return yamlStringify(parsed, { indent: 2 });
}

export function injectYamlScript(
  content: string,
  scriptType: 'before-request' | 'after-response',
  scriptCode: string,
  mode: 'append' | 'replace',
): string {
  // Validate scriptType
  if (scriptType !== 'before-request' && scriptType !== 'after-response') {
    throw new BrunoError(
      `Invalid script type "${scriptType}": expected "before-request" or "after-response"`,
      'VALIDATION_ERROR',
    );
  }

  // Reject null bytes
  if (scriptCode.includes('\0')) {
    throw new BrunoError(
      'Script content contains null bytes',
      'VALIDATION_ERROR',
    );
  }

  // Enforce 50KB max
  if (scriptCode.length > 50_000) {
    throw new BrunoError(
      `Script exceeds maximum size of 50KB (${scriptCode.length} bytes)`,
      'VALIDATION_ERROR',
    );
  }

  const parsed = parseYaml(content) as Record<string, unknown>;

  // Ensure runtime.scripts exists
  if (!parsed.runtime || typeof parsed.runtime !== 'object') {
    parsed.runtime = { scripts: [] };
  }
  const runtime = parsed.runtime as Record<string, unknown>;
  if (!Array.isArray(runtime.scripts)) {
    runtime.scripts = [];
  }
  const scripts = runtime.scripts as Array<{ type: string; code: string }>;

  const newEntry = { type: scriptType, code: scriptCode };

  if (mode === 'replace') {
    runtime.scripts = scripts.filter((s) => s.type !== scriptType).concat(newEntry);
  } else {
    scripts.push(newEntry);
  }

  return yamlStringify(parsed, { indent: 2 });
}
