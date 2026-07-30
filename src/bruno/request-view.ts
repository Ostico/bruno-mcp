/**
 * A single read-back shape for a request, built from either on-disk format.
 *
 * The two parsers return different models — `BruFile` splits `meta`/`http` and
 * keeps scripts under `script`, `YamlRequest` splits `info`/`http` and keeps
 * scripts in a `runtime.scripts` array — so returning either one raw would put
 * the format difference back in front of the caller, which is exactly what the
 * read tools exist to hide. Everything here is normalized to the vocabulary the
 * write tools already use, so a read result can be edited and handed straight
 * back to `modify_request`.
 */

import type {
  BruFile,
  BruParam,
  EnvFile,
  MultipartFormPart,
  BruFilePart,
  BruGraphql,
  FormUrlEncodedPart,
  YamlRequest,
  YamlParam,
} from './types.js';
import type { CollectionFormat } from './format-detector.js';

/** A header, query/path parameter, assertion or variable as read back. */
export interface RequestViewEntry {
  name: string;
  value: string;
  /** Present only when the entry is switched off on disk. */
  disabled?: boolean;
}

export interface RequestViewVar extends RequestViewEntry {
  local?: boolean;
}

/**
 * One multipart or form-urlencoded pair as read back.
 *
 * Deliberately not the parsers' own part types: those disagree on how a
 * switched-off pair is spelled and on whether a multipart part carries an
 * explicit kind, so passing either through would let the on-disk format show
 * through the body of an otherwise format-neutral view.
 */
export interface RequestViewPart {
  name: string;
  value: string | string[];
  /** `text` or `file`, for multipart parts only. */
  type?: string;
  contentType?: string;
  disabled?: boolean;
}

export interface RequestViewBody {
  type: string;
  content?: string;
  formData?: RequestViewPart[];
  formUrlEncoded?: RequestViewPart[];
  graphql?: BruGraphql;
  file?: BruFilePart[];
}

export interface RequestViewAuth {
  mode: string;
  config?: Record<string, unknown>;
}

export interface RequestView {
  filePath: string;
  format: CollectionFormat;
  name: string;
  type?: string;
  seq?: number;
  method: string;
  url: string;
  headers: RequestViewEntry[];
  params: { query: RequestViewEntry[]; path: RequestViewEntry[] };
  body?: RequestViewBody;
  auth?: RequestViewAuth;
  scripts: Record<string, string>;
  assert: RequestViewEntry[];
  vars: { preRequest: RequestViewVar[]; postResponse: RequestViewVar[] };
  settings?: Record<string, unknown>;
  docs?: string;
  /**
   * What the file says that the runner will not act on. A read tool that showed
   * an `oauth2` block without saying it is never applied would read as a
   * working credential, so the gap is reported rather than left to be inferred
   * from a run that quietly goes out unauthenticated.
   */
  notes: string[];
}

/** Auth modes stored faithfully but never turned into a credential on the wire. */
const UNAPPLIED_AUTH_MODES = new Set(['oauth2', 'digest']);

function entry(name: string, value: string, disabled?: boolean): RequestViewEntry {
  return disabled ? { name, value, disabled: true } : { name, value };
}

function authNotes(mode: string | undefined): string[] {
  if (!mode || mode === 'none') return [];
  if (mode === 'inherit') {
    return ['auth mode "inherit" is stored, but collection and folder auth are not resolved at run time, so the request is sent unauthenticated'];
  }
  if (UNAPPLIED_AUTH_MODES.has(mode)) {
    return [`auth mode "${mode}" is stored in the file but not applied at run time; the request is sent without that credential`];
  }
  return [];
}

/**
 * Drop the empty containers so a request without a body, auth or docs reads as
 * absent rather than as an empty one. `headers`, `params`, `assert`, `vars` and
 * `scripts` always appear: an empty list there is a fact about the request, and
 * an agent checking "does this send an Authorization header" should not have to
 * distinguish a missing key from an empty one.
 */
function compact(view: RequestView): RequestView {
  if (view.body && view.body.type === 'none') delete view.body;
  if (view.settings && Object.keys(view.settings).length === 0) delete view.settings;
  if (view.docs === undefined || view.docs === '') delete view.docs;
  if (view.type === undefined) delete view.type;
  if (view.seq === undefined) delete view.seq;
  return view;
}

function bruAuthConfig(bru: BruFile): Record<string, unknown> | undefined {
  const auth = bru.auth;
  if (!auth) return undefined;
  // The mode names its own sub-object; anything else on the block belongs to a
  // different mode and would be misleading to report as this one's config.
  const config = (auth as unknown as Record<string, unknown>)[
    auth.type === 'api-key' ? 'apikey' : auth.type
  ];
  return config && typeof config === 'object' ? (config as Record<string, unknown>) : undefined;
}

/** A form-urlencoded pair, in the view's own vocabulary. */
function pairPart(p: FormUrlEncodedPart): RequestViewPart {
  const part: RequestViewPart = { name: p.name, value: p.value };
  if (p.enabled === false) part.disabled = true;
  return part;
}

/**
 * A multipart part. The kind defaults to `text` because only one of the two
 * parsers fills it in, and a part whose kind is absent in one format and
 * `text` in the other would read as a difference between the requests rather
 * than a difference between the files they came from.
 */
function multipartPart(p: MultipartFormPart): RequestViewPart {
  const part: RequestViewPart = { name: p.name, value: p.value, type: p.type ?? 'text' };
  if (p.contentType !== undefined) part.contentType = p.contentType;
  if (p.enabled === false) part.disabled = true;
  return part;
}

function bruParams(params: BruParam[] | undefined, kind: 'query' | 'path'): RequestViewEntry[] {
  return (params ?? [])
    .filter((p) => p.type === kind)
    .map((p) => entry(p.name, p.value, p.enabled === false));
}

function fromBru(bru: BruFile, filePath: string): RequestView {
  // `headersList` carries the enabled flag; `headers` is the flattened map kept
  // for callers that only want name/value. Preferring the list means a disabled
  // header is reported as disabled instead of as an active one.
  const headers: RequestViewEntry[] = bru.headersList
    ? bru.headersList.map((h) => entry(h.name, h.value, h.enabled === false))
    : Object.entries(bru.headers ?? {}).map(([name, value]) => entry(name, value));

  const scripts: Record<string, string> = {};
  const preRequest = bru.script?.['pre-request']?.exec;
  const postResponse = bru.script?.['post-response']?.exec;
  const tests = bru.tests?.exec;
  if (preRequest?.length) scripts['pre-request'] = preRequest.join('\n');
  if (postResponse?.length) scripts['post-response'] = postResponse.join('\n');
  if (tests?.length) scripts.tests = tests.join('\n');

  const body: RequestViewBody = { type: bru.body?.type ?? bru.http.body ?? 'none' };
  if (bru.body?.content !== undefined) body.content = bru.body.content;
  if (bru.body?.formData) body.formData = bru.body.formData.map(multipartPart);
  if (bru.body?.formUrlEncoded) body.formUrlEncoded = bru.body.formUrlEncoded.map(pairPart);
  if (bru.body?.graphql) body.graphql = bru.body.graphql;
  if (bru.body?.file) body.file = bru.body.file;

  const mode = bru.auth?.type ?? bru.http.auth;

  return compact({
    filePath,
    format: 'bru',
    name: bru.meta.name,
    type: bru.meta.type,
    seq: bru.meta.seq,
    method: bru.http.method,
    url: bru.http.url,
    headers,
    params: {
      query: bruParams(bru.params, 'query'),
      path: bruParams(bru.params, 'path'),
    },
    body,
    auth: mode && mode !== 'none' ? { mode, config: bruAuthConfig(bru) } : undefined,
    scripts,
    assert: (bru.assertions ?? []).map((a) => entry(a.name, a.value, a.enabled === false)),
    vars: {
      preRequest: (bru.varSets?.req ?? []).map((v) => ({
        ...entry(v.name, v.value, v.enabled === false),
        ...(v.local ? { local: true } : {}),
      })),
      postResponse: (bru.varSets?.res ?? []).map((v) => ({
        ...entry(v.name, v.value, v.enabled === false),
        ...(v.local ? { local: true } : {}),
      })),
    },
    settings: bru.settings as Record<string, unknown> | undefined,
    docs: bru.docs,
    notes: authNotes(mode),
  });
}

// The `.yml` runtime slots use the executor's vocabulary; the MCP surface uses
// the `.bru` names, and the write tools already accept both. Reading back under
// one set of names is what keeps a read/edit/write round-trip from renaming a
// script's slot.
const YAML_SCRIPT_SLOTS: Record<string, string> = {
  'before-request': 'pre-request',
  'after-response': 'post-response',
  tests: 'tests',
};

function yamlParams(params: YamlParam[] | undefined, kind: 'query' | 'path'): RequestViewEntry[] {
  return (params ?? [])
    // `type` is optional in the format and defaults to a query parameter.
    .filter((p) => (p.type ?? 'query') === kind)
    .map((p) => entry(p.name, p.value, p.disabled === true));
}

function fromYaml(yaml: YamlRequest, filePath: string): RequestView {
  const scripts: Record<string, string> = {};
  for (const script of yaml.runtime?.scripts ?? []) {
    const slot = YAML_SCRIPT_SLOTS[script.type];
    if (slot) scripts[slot] = script.code;
  }

  let body: RequestViewBody | undefined;
  const raw = yaml.http.body;
  if (raw) {
    body = { type: raw.type };
    const data = raw.data;
    if (typeof data === 'string') {
      body.content = data;
    } else if (Array.isArray(data)) {
      if (raw.type === 'form-urlencoded') {
        body.formUrlEncoded = (data as FormUrlEncodedPart[]).map(pairPart);
      } else {
        body.formData = (data as MultipartFormPart[]).map(multipartPart);
      }
    } else if (data) {
      body.graphql = data;
    }
  }

  const auth = yaml.http.auth;
  const mode = typeof auth === 'string' ? auth : auth?.type;
  let config: Record<string, unknown> | undefined;
  if (auth && typeof auth !== 'string') {
    const { type: _type, ...rest } = auth;
    if (Object.keys(rest).length > 0) config = rest;
  }

  return compact({
    filePath,
    format: 'yaml',
    name: yaml.info.name,
    type: yaml.info.type,
    seq: yaml.info.seq,
    method: yaml.http.method,
    url: yaml.http.url,
    headers: (yaml.http.headers ?? []).map((h) => entry(h.name, h.value, h.disabled === true)),
    params: {
      query: yamlParams(yaml.http.params, 'query'),
      path: yamlParams(yaml.http.params, 'path'),
    },
    body,
    auth: mode && mode !== 'none' ? { mode, config } : undefined,
    scripts,
    assert: (yaml.assert ?? []).map((a) => entry(a.name, a.value, a.disabled === true)),
    vars: {
      preRequest: (yaml.vars?.preRequest ?? []).map((v) => ({
        ...entry(v.name, v.value, v.disabled === true),
        ...(v.local ? { local: true } : {}),
      })),
      postResponse: (yaml.vars?.postResponse ?? []).map((v) => ({
        ...entry(v.name, v.value, v.disabled === true),
        ...(v.local ? { local: true } : {}),
      })),
    },
    settings: yaml.settings as Record<string, unknown> | undefined,
    docs: yaml.docs,
    notes: authNotes(mode),
  });
}

/**
 * Normalize a parsed request into the shared read-back shape.
 *
 * @param parsed    What the format's reader returned for this file
 * @param format    The collection format the file was parsed as
 * @param filePath  Echoed back so the caller can feed it to modify_request
 */
export function toRequestView(
  parsed: BruFile | YamlRequest,
  format: CollectionFormat,
  filePath: string,
): RequestView {
  return format === 'yaml'
    ? fromYaml(parsed as YamlRequest, filePath)
    : fromBru(parsed as BruFile, filePath);
}

export interface EnvironmentViewVariable {
  name: string;
  /**
   * Absent for a secret. Neither file format stores a secret's value — `.bru`
   * writes the name alone under `vars:secret`, `.yml` writes `secret: true`
   * with no `value` key — so there is no value on disk to return, and emitting
   * an empty string here would read as "the secret is blank".
   */
  value?: string | number | boolean;
  disabled?: boolean;
  secret?: boolean;
}

export interface EnvironmentView {
  collectionPath: string;
  name: string;
  variables: EnvironmentViewVariable[];
  /** Top-level keys the model does not name, e.g. Bruno's `color`. */
  extra?: Record<string, unknown>;
  notes: string[];
}

/**
 * Normalize a parsed environment file into the read-back shape.
 *
 * Values are returned as stored. Only secrets are withheld, and only because
 * nothing was stored for them in the first place.
 */
export function toEnvironmentView(
  envFile: EnvFile,
  collectionPath: string,
  name: string,
): EnvironmentView {
  const variables: EnvironmentViewVariable[] = (envFile.variables ?? []).map((v) => {
    const out: EnvironmentViewVariable = { name: v.name };
    if (v.secret) {
      out.secret = true;
    } else if (v.value !== undefined) {
      out.value = v.value;
    }
    if (v.disabled) out.disabled = true;
    return out;
  });

  const notes: string[] = [];
  const secretCount = variables.filter((v) => v.secret).length;
  if (secretCount > 0) {
    notes.push(
      `${secretCount} variable(s) are marked secret. Bruno stores only the name for a secret, never the value, so no value is available to return.`,
    );
  }

  const view: EnvironmentView = { collectionPath, name, variables, notes };
  if (envFile.extra && Object.keys(envFile.extra).length > 0) view.extra = envFile.extra;
  return view;
}
