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
  type YamlVar,
  type YamlBody,
  type YamlScript,
  type MultipartFormPart,
} from './types.js';

/**
 * Top-level keys Bruno separates with a blank line. Mirrors the list Bruno's own
 * writer uses, so a file we generate and a file Bruno generates for the same
 * request differ in no bytes.
 */
const BLOCK_KEYS = [
  'info',
  'http',
  'graphql',
  'grpc',
  'websocket',
  'runtime',
  'settings',
  'examples',
  'docs',
  'items',
  'request',
];

/**
 * Serialise a whole document the way Bruno serialises it.
 *
 * The options are Bruno's, not defaults. Two of them matter for anything
 * multi-line — a script body, a long description:
 *
 * - `lineWidth: 0` disables wrapping, so a long line stays one line.
 * - `defaultStringType: 'PLAIN'` makes the library reach for a literal block
 *   (`|-`) rather than a folded one (`>-`) when a string has to be a block.
 *
 * Folded output does round-trip correctly — the library encodes each newline as
 * a blank line and any conforming parser restores it — so this is not a fix for
 * corrupted scripts. It is byte-parity with Bruno, and it stops a hand-edit of
 * the file from being a trap: in a folded block the blank lines are load-bearing,
 * and a human who tidies them away silently joins the lines, at which point a
 * `//` comment really does swallow the statement beneath it.
 */
function stringifyYamlDocument(obj: unknown): string {
  const yaml = yamlStringify(obj, {
    lineWidth: 0,
    indent: 2,
    minContentWidth: 0,
    defaultStringType: 'PLAIN',
  });

  const lines = yaml.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const topLevel = i > 0 && !line.startsWith(' ') && !line.startsWith('\t');
    if (topLevel && BLOCK_KEYS.includes(line.split(':')[0])) {
      if (out.length > 0 && out[out.length - 1].trim() !== '') out.push('');
    }
    out.push(line);
  }
  return out.join('\n');
}

/** The three `runtime.scripts` entry types a .yml request can carry. */
export type YamlScriptType = YamlScript['type'];

const YAML_SCRIPT_TYPES: readonly YamlScriptType[] = [
  'before-request',
  'after-response',
  'tests',
];

/**
 * Guard the entry type at the boundary. The callers are typed, but the value
 * originates in a tool argument that reaches here through a cast, so an
 * unrecognised type has to fail loudly rather than be written to the file.
 */
function assertYamlScriptType(scriptType: string): asserts scriptType is YamlScriptType {
  if (!(YAML_SCRIPT_TYPES as readonly string[]).includes(scriptType)) {
    throw new BrunoError(
      `Invalid script type "${scriptType}": expected one of ${YAML_SCRIPT_TYPES.join(', ')}`,
      'VALIDATION_ERROR',
    );
  }
}

/**
 * Strip undefined and null values from an object tree so they
 * don't appear as `key: null` in the YAML output.
 */


/**
 * The model marks a switched-off multipart part with `enabled: false`, matching
 * the .bru side. A .yml document spells it `disabled: true`, so translate on the
 * way out — otherwise a round-trip would rename the key.
 */
function serialiseBody(body: YamlBody): YamlBody | Record<string, unknown> {
  if (!Array.isArray(body.data)) return body;

  return {
    ...body,
    data: (body.data as MultipartFormPart[]).map((part) => {
      const { enabled, ...rest } = part;
      return enabled === false ? { ...rest, disabled: true } : rest;
    }),
  };
}

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

/** Serialise a vars entry, omitting flags that are not set. */
function toYamlVar(v: YamlVar): Record<string, unknown> {
  return {
    name: v.name,
    value: v.value,
    ...(v.disabled === true ? { disabled: true } : {}),
    ...(v.local === true ? { local: true } : {}),
  };
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
    http.headers = request.http.headers.map((h) => {
      const header: Record<string, unknown> = { name: h.name, value: h.value };
      if (h.disabled) header.disabled = true;
      return header;
    });
  }
  if (request.http.body) {
    http.body = stripEmpty(serialiseBody(request.http.body));
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

  // assert — write back what the parser now preserves
  if (request.assert && request.assert.length > 0) {
    doc.assert = request.assert.map((a) => ({
      name: a.name,
      value: a.value,
      ...(a.disabled === true ? { disabled: true } : {}),
    }));
  }

  // vars
  if (request.vars?.preRequest?.length || request.vars?.postResponse?.length) {
    const vars: Record<string, unknown> = {};
    if (request.vars.preRequest && request.vars.preRequest.length > 0) {
      vars.preRequest = request.vars.preRequest.map(toYamlVar);
    }
    if (request.vars.postResponse && request.vars.postResponse.length > 0) {
      vars.postResponse = request.vars.postResponse.map(toYamlVar);
    }
    doc.vars = vars;
  }

  // docs
  if (request.docs) {
    doc.docs = request.docs;
  }

  const cleaned = stripEmpty(doc) as Record<string, unknown>;
  return stringifyYamlDocument(cleaned);
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
  return stringifyYamlDocument(cleaned);
}

/**
 * Generate YAML environment file content from an EnvFile object.
 *
 * A secret variable is written as the flag plus the name and NOTHING else:
 * Bruno does not persist a secret's value in the environment file, it keeps the
 * value in its own secret store. Writing `value:` for a secret variable would
 * put the credential on disk in plaintext, so the value is dropped here even
 * when the model carries one.
 *
 * Key order matches what Bruno emits: `secret` before `name` for a secret
 * variable, `name` then `value` otherwise, top-level `name` before the
 * unmodelled keys before `variables`.
 */
export function generateYamlEnvironment(env: EnvFile): string {
  const doc: Record<string, unknown> = {};

  if (env.name) {
    doc.name = env.name;
  }

  copyExtraKeys(doc, env.extra, ENV_FILE_KEYS);

  if (env.variables && env.variables.length > 0) {
    doc.variables = env.variables.map((v) => {
      const entry: Record<string, unknown> = {};
      if (v.secret === true) {
        entry.secret = true;
        entry.name = v.name;
      } else {
        entry.name = v.name;
        if (v.value !== undefined) entry.value = v.value;
      }
      if (v.disabled !== undefined) entry.disabled = v.disabled;
      copyExtraKeys(entry, v.extra, ENV_VARIABLE_KEYS);
      return entry;
    });
  }

  const cleaned = stripEmpty(doc) as Record<string, unknown>;
  return stringifyYamlDocument(cleaned);
}

/** Fields of EnvFile that generateYamlEnvironment writes itself. */
const ENV_FILE_KEYS = new Set(['name', 'variables']);

/** Fields of EnvVariable that generateYamlEnvironment writes itself. */
const ENV_VARIABLE_KEYS = new Set(['name', 'value', 'disabled', 'secret']);

/**
 * Copy carried-through keys onto a document, skipping any the caller writes
 * from the typed model.
 *
 * The skip list is what stops a stale carried `value` from resurrecting the
 * plaintext of a variable that has since become secret.
 */
function copyExtraKeys(
  target: Record<string, unknown>,
  extra: Record<string, unknown> | undefined,
  modelled: Set<string>,
): void {
  if (!extra) return;
  for (const [key, value] of Object.entries(extra)) {
    if (modelled.has(key)) continue;
    target[key] = value;
  }
}

/**
 * Remove every script of the given type from YAML request file content.
 *
 * The three entry types are independent slots, so removing 'tests' leaves an
 * 'after-response' script in place and vice versa.
 *
 * @returns Updated YAML content
 */
export function removeYamlScript(
  content: string,
  scriptType: YamlScriptType,
): string {
  assertYamlScriptType(scriptType);

  const parsed = parseYaml(content) as Record<string, unknown>;

  const runtime = parsed.runtime as Record<string, unknown> | undefined;
  if (!runtime || typeof runtime !== 'object' || !Array.isArray(runtime.scripts)) {
    return stringifyYamlDocument(parsed);
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

  return stringifyYamlDocument(parsed);
}

/**
 * Inject a script into existing YAML request file content.
 *
 * @param content     Existing YAML content
 * @param scriptType  'before-request', 'after-response' or 'tests'
 * @param scriptCode  The script code to inject
 * @param mode        'append' adds to existing scripts, 'replace' replaces scripts of same type
 * @returns Updated YAML content
 */
export function injectYamlScript(
  content: string,
  scriptType: YamlScriptType,
  scriptCode: string,
  mode: 'append' | 'replace',
): string {
  assertYamlScriptType(scriptType);

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

  return stringifyYamlDocument(parsed);
}
