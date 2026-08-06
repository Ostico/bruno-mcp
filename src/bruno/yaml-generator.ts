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
  type YamlBody,
  type YamlScript,
  type MultipartFormPart,
  type BruFilePart,
} from './types.js';
import {
  assertionsToYaml,
  postResponseVarsToYaml,
  variablesToYaml,
} from './yaml-runtime-blocks.js';
import {
  applyExtraKeys,
  YAML_HEADER_KEYS,
  YAML_HTTP_KEYS,
  YAML_INFO_KEYS,
  YAML_PARAM_KEYS,
  YAML_REQUEST_KEYS,
  YAML_RUNTIME_KEYS,
  YAML_SETTINGS_KEYS,
} from './extra-keys.js';
import {
  graphqlBodyToYaml,
  isGraphqlRequest,
  YAML_GRAPHQL_KEYS,
} from './yaml-graphql-block.js';

/**
 * Top-level keys Bruno separates with a blank line. Mirrors the list Bruno's own
 * writer uses, so a file we generate and a file Bruno generates for the same
 * request differ in no bytes.
 *
 * Note what is *not* here: `vars` and `assert`. This list was copied from
 * Bruno and never had them, because Bruno has no such top-level keys — which is
 * corroboration for moving those blocks into `runtime`, where it does read them.
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
 *
 * A `file` body is not a part list and is written the way upstream writes one:
 * all three keys, every entry, `selected` included. That last one is not
 * cosmetic. Upstream's `.yml` reader treats an absent `selected` as **false**, so
 * a file body written without the key is one Bruno silently sends with no body at
 * all — while the same model written to `.bru` would send the file, because there
 * the default runs the other way. Writing the flag out keeps both dialects
 * saying what they mean.
 */
function serialiseBody(body: YamlBody): YamlBody | Record<string, unknown> {
  if (!Array.isArray(body.data)) return body;

  if (body.type === 'file') {
    return {
      ...body,
      data: (body.data as BruFilePart[]).map((part) => ({
        filePath: part.filePath,
        contentType: part.contentType ?? '',
        selected: part.selected !== false,
      })),
    };
  }

  return {
    ...body,
    data: (body.data as MultipartFormPart[]).map((part) => {
      const { enabled, ...rest } = part;
      return enabled === false ? { ...rest, disabled: true } : rest;
    }),
  };
}

/**
 * The timeout upstream would write, byte for byte.
 *
 * Mirrors `resolveTimeoutSetting` in `bruno-common/src/utils/index.ts`:
 *
 * ```js
 * if (value === TIMEOUT_INHERIT) return value;
 * if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
 * return 0;
 * ```
 *
 * `0` is upstream's "no timeout", so a zero, a negative, a NaN and an absent
 * value all collapse to it. `'inherit'` is a legal value there and is carried
 * through rather than flattened, even though this server's own input surface
 * cannot yet produce one — a file authored elsewhere can.
 */
function resolveTimeoutSetting(value: unknown): number | 'inherit' {
  if (value === 'inherit') return value;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return 0;
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

/**
 * Generate YAML request file content from a YamlRequest object.
 */
export function generateYamlRequest(request: YamlRequest): string {
  const doc: Record<string, unknown> = {};

  // A non-http kind — grpc, ws — has no http block at all, and its target lives
  // in its own top-level block. Narrowed once here so the section below reads the
  // same as it did when the field was mandatory.
  const httpBlock = request.http;

  // info section
  const isGraphql = isGraphqlRequest(request.info.type, httpBlock?.body);

  const info: Record<string, unknown> = { name: request.info.name };
  // `info.type` is what Bruno dispatches on, so it has to agree with the block
  // written below. A graphql body under `info.type: http` would send the file to
  // Bruno's http parser, which finds no `http:` block and reads the request as
  // having no url and no query — so the type is settled from the body rather than
  // trusted to match it.
  if (isGraphql) {
    info.type = 'graphql';
  } else if (request.info.type) {
    info.type = request.info.type;
  }
  if (request.info.seq !== undefined) info.seq = request.info.seq;
  // Only when there is something in it: upstream guards the same write with
  // `item.tags?.length`, so an empty `tags: []` is a key no Bruno file has.
  if (request.info.tags?.length) info.tags = request.info.tags;
  applyExtraKeys(info, request.info.extra, YAML_INFO_KEYS);
  doc.info = info;

  // http, or graphql — the request block. Bruno gives a graphql request its own
  // top-level `graphql:` block and dispatches on `info.type` to choose a parser,
  // so the two are alternatives rather than a body variant.
  const headers = httpBlock?.headers?.length
    ? httpBlock.headers.map((h) => {
      const header: Record<string, unknown> = { name: h.name, value: h.value };
      if (h.disabled) header.disabled = true;
      applyExtraKeys(header, h.extra, YAML_HEADER_KEYS);
      return header;
    })
    : undefined;

  const params = httpBlock?.params?.length
    ? httpBlock.params.map((p) => {
      const param: Record<string, unknown> = { name: p.name, value: p.value };
      if (p.type) param.type = p.type;
      if (p.disabled) param.disabled = p.disabled;
      applyExtraKeys(param, p.extra, YAML_PARAM_KEYS);
      return param;
    })
    : undefined;

  // Three-way, not two: a grpc or ws request has no http block to write, and
  // fabricating an empty one would emit an `http:` key no Bruno file has. Its own
  // target block is written separately.
  if (httpBlock && isGraphql) {
    // Upstream's key order for this block, which differs from the http one:
    // params come before body here, and after it there.
    const graphql: Record<string, unknown> = {
      method: httpBlock.method,
      url: httpBlock.url,
    };
    if (headers) graphql.headers = headers;
    if (params) graphql.params = params;
    const graphqlBody = graphqlBodyToYaml(httpBlock.body);
    if (graphqlBody) graphql.body = graphqlBody;
    if (httpBlock.auth !== undefined) graphql.auth = httpBlock.auth;
    applyExtraKeys(graphql, httpBlock.extra, YAML_GRAPHQL_KEYS);
    doc.graphql = graphql;
  } else if (httpBlock) {
    const http: Record<string, unknown> = {
      method: httpBlock.method,
      url: httpBlock.url,
    };
    if (headers) http.headers = headers;
    if (httpBlock.body) {
      http.body = stripEmpty(serialiseBody(httpBlock.body));
    }
    if (params) http.params = params;
    if (httpBlock.auth !== undefined) http.auth = httpBlock.auth;
    applyExtraKeys(http, httpBlock.extra, YAML_HTTP_KEYS);
    doc.http = http;
  }

  // runtime section — variables, scripts, assertions and actions, in upstream's
  // own key order. Only `scripts` used to live here; the other three were
  // written at the top level under names Bruno does not read, so a request this
  // server wrote had its variables and assertions invisible to `bru run`.
  const runtime: Record<string, unknown> = {};
  if (request.vars?.preRequest?.length) {
    runtime.variables = variablesToYaml(request.vars.preRequest);
  }
  if (request.runtime?.scripts?.length) {
    runtime.scripts = request.runtime.scripts.map((s) => ({ type: s.type, code: s.code }));
  }
  if (request.assert?.length) {
    runtime.assertions = assertionsToYaml(request.assert);
  }
  // Post-response variables are `set-variable` actions upstream, not variables.
  if (request.vars?.postResponse?.length) {
    runtime.actions = postResponseVarsToYaml(request.vars.postResponse);
  }
  applyExtraKeys(runtime, request.runtime?.extra, YAML_RUNTIME_KEYS);
  if (Object.keys(runtime).length > 0) {
    doc.runtime = runtime;
  }

  // settings section, always written and always complete.
  //
  // Upstream's `.yml` writer is unconditional — it builds all four keys and
  // assigns `ocRequest.settings = settings` for every request, defaulting
  // `encodeUrl` and `followRedirects` to true, `maxRedirects` to 5 and `timeout`
  // to 0 (`bruno-filestore/src/formats/yml/items/stringifyHttpRequest.ts`). This
  // writer used to emit the block only when the model carried one, which left
  // two visible differences from a request Bruno created: the block was missing,
  // and — because the `.yml` reader treats an omitted `encodeUrl` as **true**
  // while a missing block means false — the request went out with its URL raw
  // where Bruno sends it encoded. Same collection, two behaviours, depending on
  // which tool wrote the request.
  //
  // The `.bru` writer deliberately does NOT do this: upstream's `jsonToBru` is a
  // passthrough that writes only the keys the model holds, and 248 of the 275
  // `.bru` files in upstream's own test collection carry no settings block at
  // all. The two dialects differ here, so this server differs with them.
  //
  // `extra` is destructured off rather than left to the skip list, because the
  // whole rest of the object is passed through verbatim and the bag would
  // otherwise be written to the file as a literal `extra:` key.
  const { extra: settingsExtra, ...modelledSettings } = request.settings ?? {};
  const settings = (stripEmpty(modelledSettings) ?? {}) as Record<string, unknown>;

  // Assigned onto whatever the source already had, never rebuilt from these four
  // alone: `settings` also carries `tls` and `proxy`, and a first cut that
  // constructed a fresh object out of the four keys silently dropped both. A key
  // already present keeps its position — assigning to an existing property does
  // not reorder it — so a document Bruno wrote is unchanged, and only the keys it
  // was missing are appended.
  settings.encodeUrl = modelledSettings.encodeUrl ?? true;
  settings.timeout = resolveTimeoutSetting(modelledSettings.timeout);
  settings.followRedirects = modelledSettings.followRedirects ?? true;
  settings.maxRedirects =
    typeof modelledSettings.maxRedirects === 'number' ? modelledSettings.maxRedirects : 5;

  applyExtraKeys(settings, settingsExtra, YAML_SETTINGS_KEYS);
  doc.settings = settings;

  // docs
  if (request.docs) {
    doc.docs = request.docs;
  }

  const cleaned = stripEmpty(doc) as Record<string, unknown>;
  return stringifyYamlDocument(withCarriedBlocks(cleaned, request.extra));
}

/**
 * Put the carried top-level blocks back into a generated document.
 *
 * They go in after `stripEmpty` rather than before, because that pass is about
 * the fields this generator builds: run over carried data it would delete a
 * block whose author left it empty, which is a second way of losing the very
 * keys this is here to keep.
 *
 * Position is not cosmetic either. Bruno's own key order puts `examples` — the
 * realistic occupant of this bag — between `settings` and `docs`, so the blocks
 * are spliced in ahead of `docs` rather than appended after it.
 */
function withCarriedBlocks(
  cleaned: Record<string, unknown>,
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!extra) return cleaned;

  const carried: Record<string, unknown> = {};
  applyExtraKeys(carried, extra, YAML_REQUEST_KEYS);
  if (Object.keys(carried).length === 0) return cleaned;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cleaned)) {
    if (key === 'docs') Object.assign(out, carried);
    out[key] = value;
  }
  if (!('docs' in cleaned)) Object.assign(out, carried);
  return out;
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

  applyExtraKeys(doc, env.extra, ENV_FILE_KEYS);

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
      applyExtraKeys(entry, v.extra, ENV_VARIABLE_KEYS);
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
