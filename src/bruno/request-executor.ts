import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename, relative, dirname, resolve, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { parseYamlRequest } from './yaml-parser.js';
import { parseBruRequest } from './bru-parser.js';
import { loadEnvironment, substitute, findUnresolvedPlaceholders } from './env-loader.js';
import { TestRunner } from './test-runner.js';
import type { ScriptRunner } from './sandbox-host.js';
import { wrapFetchResponse } from './response-wrapper.js';
import { validateUrl, ssrfRemediation } from './url-validator.js';
import { VariableStore } from './variable-store.js';
import { buildDispatcher, type DispatcherResult } from './fetch-dispatcher.js';
import { describeNetworkError } from './network-error.js';
import type {
  BruFile,
  YamlRequest,
  YamlAuth,
  MockRequestData,
  CollectionRunResult,
  RequestExecutionResult,
  TestResult,
  MultipartFormPart,
} from './types.js';

interface ExecutionOptions {
  environment?: string;
  collectionRoot?: string;
  requestPath?: string;
  parallel?: boolean;
  includeResponseBody?: boolean;
  maxResponseBodyBytes?: number;
  /**
   * How scripts are run. Defaults to the in-process TestRunner so the test
   * suite runs without forking; production (server.ts) injects the forking
   * runner so untrusted scripts execute behind a process boundary.
   */
  scriptRunner?: ScriptRunner;
}

const DEFAULT_MAX_RESPONSE_BODY_BYTES = 10240;

interface BodyCaptureOptions {
  includeResponseBody: boolean;
  maxResponseBodyBytes: number;
}

interface ParsedRequest {
  yaml: YamlRequest;
  filePath: string;
}

interface DiscoveryResult {
  requests: ParsedRequest[];
  parseErrors: number;
}

const EXCLUDED_FILES = new Set([
  'folder.yml',
  'opencollection.yml',
  'bruno.json',
]);

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'environments',
]);

async function findYmlFilesRecursive(dirPath: string, results: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory() && !EXCLUDED_DIRS.has(entry.name)) {
      await findYmlFilesRecursive(fullPath, results);
    } else if (entry.isFile() && (entry.name.endsWith('.yml') || entry.name.endsWith('.bru'))) {
      if (!EXCLUDED_FILES.has(entry.name.toLowerCase())) {
        results.push(fullPath);
      }
    }
  }
}

/**
 * Translate a parsed .bru file into the YamlRequest the executor works in.
 * Exported for tests, matching bruAuthToYamlAuth alongside it; the executor is
 * still the only production caller.
 */
export function bruFileToYamlRequest(bru: BruFile): YamlRequest {
  const scripts: YamlRequest['runtime'] = { scripts: [] };
  if (bru.script?.['pre-request']?.exec) {
    scripts.scripts.push({ type: 'before-request', code: bru.script['pre-request'].exec.join('\n') });
  }
  if (bru.script?.['post-response']?.exec) {
    scripts.scripts.push({ type: 'after-response', code: bru.script['post-response'].exec.join('\n') });
  }
  if (bru.tests?.exec) {
    scripts.scripts.push({ type: 'after-response', code: bru.tests.exec.join('\n') });
  }

  // Prefer headersList: it is the parser's order-preserving record of every
  // authored header, duplicates and disabled flags included. `bru.headers` is
  // the flat Record kept for lookups, so building from it collapsed repeated
  // names before the model even existed (finding D4) and dropped the disabled
  // flag that buildFetchOptions needs to honour (D13). Fall back to the Record
  // only for a BruFile that carries no headersList.
  const headers = bru.headersList
    ? bru.headersList.map((h) => ({
        name: h.name,
        value: h.value,
        ...(h.enabled === false ? { disabled: true } : {}),
      }))
    : bru.headers
      ? Object.entries(bru.headers).map(([name, value]) => ({ name, value }))
      : undefined;

  let body: YamlRequest['http']['body'];
  if (bru.body?.formData && bru.body.formData.length > 0) {
    body = {
      type: 'multipart-form',
      data: bru.body.formData.map((part): MultipartFormPart => {
        const item: MultipartFormPart = {
          name: part.name,
          value: part.value,
          type: part.type ?? 'text',
        };
        if (part.contentType) item.contentType = part.contentType;
        // Carry the enabled flag through so a part disabled in the .bru file is
        // not silently re-enabled by the converter (finding X13). Only an
        // explicit `false` is recorded; `undefined`/`true` stay enabled.
        if (part.enabled === false) item.enabled = false;
        return item;
      }),
    };
  } else if (bru.body?.content) {
    body = { type: bru.body.type, data: bru.body.content };
  }

  return {
    info: { name: bru.meta.name, type: bru.meta.type, seq: bru.meta.seq },
    http: {
      method: bru.http.method,
      url: bru.http.url,
      headers,
      body,
      auth: bruAuthToYamlAuth(bru.auth),
    },
    runtime: scripts.scripts.length > 0 ? scripts : undefined,
    docs: bru.docs,
  };
}

/**
 * Flatten a parsed .bru auth block into the shape the executor applies.
 *
 * .bru stores auth nested by scheme (auth.bearer.token, auth.basic.username);
 * the executor and the .yml path both consume the flat form ({type, token} /
 * {type, username, password} / {type, key, value, in}). Without this, auth
 * authored in a .bru file was dropped here — before the request even reached
 * buildFetchOptions — which is the first half of finding A7.
 */
export function bruAuthToYamlAuth(auth: BruFile['auth']): YamlAuth | undefined {
  if (!auth || auth.type === 'none') {
    return undefined;
  }
  switch (auth.type) {
    case 'bearer':
      return { type: 'bearer', token: auth.bearer?.token ?? '' };
    case 'basic':
      return {
        type: 'basic',
        username: auth.basic?.username ?? '',
        password: auth.basic?.password ?? '',
      };
    case 'api-key':
      return {
        type: 'api-key',
        key: auth.apikey?.key ?? '',
        value: auth.apikey?.value ?? '',
        in: auth.apikey?.in ?? 'header',
      };
    default:
      // oauth2, digest: carried by type only so buildFetchOptions can warn
      // rather than have the scheme vanish silently.
      return { type: auth.type };
  }
}

async function discoverRequests(dirPath: string): Promise<DiscoveryResult> {
  const requestFiles: string[] = [];
  await findYmlFilesRecursive(dirPath, requestFiles);

  const requests: ParsedRequest[] = [];
  let parseErrors = 0;

  for (const filePath of requestFiles) {
    try {
      const content = await readFile(filePath, 'utf-8');
      let yaml: YamlRequest;
      if (filePath.endsWith('.yml')) {
        yaml = parseYamlRequest(content);
      } else if (filePath.endsWith('.bru')) {
        yaml = bruFileToYamlRequest(parseBruRequest(content));
      } else {
        /* istanbul ignore next -- unreachable: findYmlFilesRecursive only yields .yml/.bru paths, so this defensive else is dead code */
        continue;
      }
      requests.push({ yaml, filePath });
    } catch {
      parseErrors++;
    }
  }

  requests.sort((a, b) => {
    const seqA = a.yaml.info.seq ?? Number.MAX_SAFE_INTEGER;
    const seqB = b.yaml.info.seq ?? Number.MAX_SAFE_INTEGER;
    return seqA - seqB;
  });

  return { requests, parseErrors };
}

function isMultipartBody(body: YamlRequest['http']['body']): boolean {
  return (
    !!body &&
    (body.type === 'multipart-form' || body.type === 'form-data') &&
    Array.isArray(body.data)
  );
}

let uploadDirsCache: string[] | null = null;

/**
 * Extra upload directories the operator trusts, from BRUNO_UPLOAD_DIRS
 * (comma-separated absolute paths). Read once and cached.
 */
function operatorUploadDirs(): string[] {
  if (uploadDirsCache === null) {
    uploadDirsCache = (process.env.BRUNO_UPLOAD_DIRS ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => resolve(s));
  }
  return uploadDirsCache;
}

/** Reset the cached BRUNO_UPLOAD_DIRS. Exported for testing. */
export function resetUploadDirsCache(): void {
  uploadDirsCache = null;
}

/** True if `p` is within `root` (lexically; `root` itself does not count). */
function isWithin(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Resolve a multipart file-part path and confine it to a trusted upload
 * location.
 *
 * The path comes from the (untrusted) collection, so without confinement a
 * collection could name `/etc/passwd`, `~/.ssh/id_rsa`, an env file, etc. and
 * have its contents POSTed to any host — arbitrary file read + exfiltration
 * (finding S05).
 *
 * The read is allowed only when the resolved path sits under one of: the
 * collection root, the user's home directory, the OS temp dir (and `/tmp`), or
 * an operator-configured `BRUNO_UPLOAD_DIRS` entry. On top of that, ANY path
 * component starting with `.` is refused — so even though home is allowed,
 * dotfiles and dot-directories (`~/.ssh`, `.aws`, `.env`, `.git`, …) are not
 * readable. Relative paths resolve against the collection root; a file part
 * with no known collection root is refused (no trusted base).
 */
function confineUploadPath(filePath: string, collectionRoot: string | undefined): string {
  if (!collectionRoot) {
    throw new Error(
      `Refusing to read multipart file part "${basename(filePath)}": no collection root to confine it to`,
    );
  }
  const root = resolve(collectionRoot);
  const resolved = resolve(root, filePath);

  const allowedRoots = [root, resolve(homedir()), resolve(tmpdir()), resolve('/tmp'), ...operatorUploadDirs()];
  // Match against the most specific (longest) allowed root, so the hidden-segment
  // check runs only below that root — a collection legitimately nested under a
  // hidden ancestor (e.g. ~/.config/bruno/coll) still works.
  const matched = allowedRoots
    .filter(r => isWithin(r, resolved))
    .sort((a, b) => b.length - a.length)[0];
  if (!matched) {
    throw new Error(
      `Refusing to read multipart file part outside the allowed upload directories: "${filePath}"`,
    );
  }

  const belowRoot = relative(matched, resolved).split(/[\\/]+/);
  if (belowRoot.some(seg => seg.startsWith('.'))) {
    throw new Error(
      `Refusing to read a hidden file or directory as a multipart file part: "${filePath}"`,
    );
  }
  return resolved;
}

/** Query-parameter names whose values are masked before a URL is shown to the caller (finding S22). */
const SECRET_QUERY_PARAMS = new Set([
  'key', 'api-key', 'apikey', 'api_key', 'x-api-key',
  'token', 'access_token', 'refresh_token', 'id_token', 'api_token', 'apitoken',
  'secret', 'client_secret', 'password', 'pwd', 'passwd',
  'auth', 'authorization', 'sig', 'signature', 'session', 'sessionid',
]);

/**
 * Redact secrets from a URL before it is returned to the caller or embedded in
 * an error message (finding S22). A query api-key or userinfo
 * (`https://user:pass@host`) substituted from an env file must not cross back
 * over the MCP boundary. Userinfo is always stripped; the values of known
 * secret-bearing query parameters are masked. When there is nothing sensitive
 * the input is returned byte-for-byte (so ordinary reported URLs are unchanged),
 * and a URL that cannot be parsed is returned as-is (it already passed SSRF
 * validation, which parses it).
 */
export function redactUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  const secretNames = [...u.searchParams.keys()].filter(n =>
    SECRET_QUERY_PARAMS.has(n.toLowerCase()),
  );
  if (!u.username && !u.password && secretNames.length === 0) {
    return raw;
  }
  u.username = '';
  u.password = '';
  for (const name of secretNames) {
    u.searchParams.set(name, 'REDACTED');
  }
  return u.toString();
}

/** Credential headers always dropped on a cross-origin redirect, in addition to the request's own auth headers. */
const CROSS_ORIGIN_STRIP_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

/**
 * Drop credential-bearing headers when a redirect crosses to a different origin
 * (findings S06/S07). Real fetch() strips these on a cross-origin redirect; the
 * manual redirect loop must do the same, or a target that 302s to an attacker
 * hands it the caller's Authorization / api-key / cookies. `authHeaderNames`
 * are the header names auth was actually applied to, so a caller-named api-key
 * header (e.g. X-Api-Key) is stripped too — not just the standard set.
 */
export function stripCredentialHeaders(
  headers: Record<string, string>,
  authHeaderNames: string[],
): Record<string, string> {
  const deny = new Set([
    ...CROSS_ORIGIN_STRIP_HEADERS,
    ...authHeaderNames.map(n => n.toLowerCase()),
  ]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!deny.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/**
 * Request headers whose value is NOT defined as a comma-separated list, so a
 * sender must not repeat them at all (finding D15).
 *
 * RFC 9110 §5.2/§5.3 permit combining repeated field lines only when the field
 * is defined as a list (ABNF `#rule`). Repeating a singleton field and joining
 * with a comma produces a syntactically invalid value — `Content-Type` becomes
 * "application/json, text/plain" — which the origin will usually reject. The
 * combine still happens, because fetch cannot emit two field lines for one
 * name under any input shape; the warning is what keeps that from being a
 * second silent behaviour replacing the first.
 *
 * Deliberately a known set rather than an exhaustive one: warning on "every
 * header not known to be a list" would fire on legitimate custom list headers,
 * and noisy warnings get ignored. Missing an entry only costs a warning.
 *
 * `cookie` is excluded on purpose — repeating it is normal authoring and
 * appendHeader already joins it the way RFC 6265 §5.4 requires.
 */
const SINGLE_VALUE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'content-type',
  'content-length',
  'content-location',
  'host',
  'user-agent',
  'referer',
  'from',
  'date',
  'max-forwards',
  'range',
  'if-range',
  'if-modified-since',
  'if-unmodified-since',
  'origin',
]);

/**
 * Add one authored header to the outgoing set, combining rather than replacing
 * when the name has already been seen (finding D4).
 *
 * A collection may author the same header twice — two Accept values, two Cookie
 * pairs, an X-Forwarded-For chain. The previous `headers[h.name] = value` kept
 * only the last, so every earlier value was silently dropped before the request
 * was ever sent.
 *
 * Combining (rather than carrying a list further down) is what the transport
 * actually does: undici's fetch emits ONE field-line for a repeated request
 * header no matter how it is handed over — an array of pairs and
 * Headers.append both arrive combined. RFC 9110 §5.3 permits exactly that, and
 * RFC 6265 §5.4 makes Cookie the exception that joins with "; ". Building the
 * combined value here therefore produces the same bytes on the wire while
 * keeping the rest of the pipeline — auth application, the pre-request script
 * API, and stripCredentialHeaders — on the simple Record it already expects.
 *
 * Names are matched case-insensitively (RFC 9110 §5.1) but emitted with the
 * first occurrence's casing. Routing through undici's Headers would have been
 * shorter and was rejected because it lowercases every name, changing what a
 * case-sensitive server receives.
 */
function appendHeader(
  headers: Record<string, string>,
  headerKeys: Map<string, string>,
  name: string,
  value: string,
): void {
  const lower = name.toLowerCase();
  const existingKey = headerKeys.get(lower);
  if (existingKey === undefined) {
    headerKeys.set(lower, name);
    headers[name] = value;
    return;
  }
  const separator = lower === 'cookie' ? '; ' : ', ';
  headers[existingKey] = `${headers[existingKey]}${separator}${value}`;
}

export async function buildFetchOptions(
  yaml: YamlRequest,
  vars: Map<string, string>,
  collectionRoot?: string,
): Promise<{ url: string; options: RequestInit; warnings?: string[]; authHeaderNames?: string[] }> {
  // Finding X8: surface any {{var}} that substitution could not resolve so an
  // unsubstituted placeholder can no longer reach the wire silently. The
  // failure mode is starkest under parallel per-folder isolation — a variable
  // set by a script in one folder is invisible to another folder's requests —
  // but an unresolved placeholder is a latent bug in serial mode too. Detection
  // runs on the ORIGINAL templates below, not the substituted output, so a
  // resolved value that itself contains `{{...}}` is never mis-flagged
  // (substitution is deliberately single-pass). Names accumulate across every
  // substituted surface (url, headers, auth, body).
  const unresolvedNames = new Set<string>();
  const trackUnresolved = (template: string): void => {
    for (const name of findUnresolvedPlaceholders(template, vars)) {
      unresolvedNames.add(name);
    }
  };

  trackUnresolved(yaml.http.url);
  let url = substitute(yaml.http.url, vars);

  const headers: Record<string, string> = {};
  // Maps a lowercased header name to the key actually used in `headers`, so a
  // repeat under different casing lands on the first occurrence's casing
  // instead of creating a second entry.
  const headerKeys = new Map<string, string>();
  // Counted per lowercased name so a singleton header repeated N times warns
  // once, on the transition to the second occurrence, rather than N-1 times.
  const headerCounts = new Map<string, number>();
  const headerWarnings: string[] = [];
  if (yaml.http.headers) {
    for (const h of yaml.http.headers) {
      // A header explicitly disabled in the collection must not be sent (D13).
      // Skip before substituting, so a disabled header's placeholders are not
      // reported as unresolved either.
      if (h.disabled === true) continue;
      trackUnresolved(h.value);
      const lower = h.name.toLowerCase();
      const occurrence = (headerCounts.get(lower) ?? 0) + 1;
      headerCounts.set(lower, occurrence);
      if (occurrence === 2 && SINGLE_VALUE_HEADERS.has(lower)) {
        // Name only, never the value: a repeated Authorization or Cookie
        // carries a credential, and warnings surface to the caller.
        headerWarnings.push(
          `Header "${headerKeys.get(lower) ?? h.name}" is defined by HTTP as a single-value field but is set more than once; the values were combined into one and the server may reject the request. Remove the duplicate.`,
        );
      }
      appendHeader(headers, headerKeys, h.name, substitute(h.value, vars));
    }
  }

  // Apply the request's auth on the wire (finding A7): it was authored and
  // parsed but never sent. Header-based schemes mutate `headers`; a query
  // api-key comes back to be appended to the URL; a scheme we cannot apply
  // automatically is surfaced as a warning rather than dropped in silence.
  const authWarnings: string[] = [];
  const authHeaderNames: string[] = [];
  const queryAuth = applyAuth(
    yaml.http.auth,
    headers,
    s => {
      trackUnresolved(s);
      return substitute(s, vars);
    },
    authWarnings,
    authHeaderNames,
  );
  if (queryAuth) {
    url +=
      (url.includes('?') ? '&' : '?') +
      `${encodeURIComponent(queryAuth.key)}=${encodeURIComponent(queryAuth.value)}`;
  }

  const options: RequestInit = {
    method: yaml.http.method,
    headers,
  };

  const body = yaml.http.body;
  if (isMultipartBody(body)) {
    const form = new FormData();
    const parts = body!.data as MultipartFormPart[];

    for (const part of parts) {
      // A part explicitly disabled in the collection must not be sent (finding
      // X13). Skip before tracking/substituting so a disabled part's
      // placeholders never reach the wire nor raise a warning.
      if (part.enabled === false) continue;
      if (part.contentType) trackUnresolved(part.contentType);
      const contentType = part.contentType
        ? substitute(part.contentType, vars)
        : undefined;

      if (part.type === 'file') {
        const paths = Array.isArray(part.value) ? part.value : [part.value];
        for (const rawPath of paths) {
          trackUnresolved(String(rawPath));
          const filePath = substitute(String(rawPath), vars);
          // A file-part path is collection-controlled; confine the read to the
          // collection root so a collection cannot exfiltrate arbitrary host
          // files (finding S05).
          const resolvedPath = confineUploadPath(filePath, collectionRoot);
          const buf = await readFile(resolvedPath);
          form.append(
            part.name,
            new Blob([buf], { type: contentType || 'application/octet-stream' }),
            basename(resolvedPath),
          );
        }
      } else {
        const values = Array.isArray(part.value) ? part.value : [part.value];
        for (const rawValue of values) {
          trackUnresolved(String(rawValue));
          const value = substitute(String(rawValue), vars);
          if (contentType) {
            form.append(part.name, new Blob([value], { type: contentType }));
          } else {
            form.append(part.name, value);
          }
        }
      }
    }

    options.body = form;

    // undici sets the multipart boundary itself; a user-provided Content-Type
    // header would clobber the boundary, so strip it.
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-type') {
        delete headers[key];
      }
    }
  } else if (typeof body?.data === 'string') {
    trackUnresolved(body.data);
    options.body = substitute(body.data, vars);
  }

  // Name the placeholder (e.g. `{{token}}`) but never a resolved value — the
  // value may be a secret. Ordered by the stage that produced them:
  // headerWarnings (the authored header list is read first), then authWarnings,
  // then the unresolved-variable warnings in first-seen order.
  const unresolvedWarnings = [...unresolvedNames].map(
    name => `unresolved variable: {{${name}}}`,
  );
  const warnings = [...headerWarnings, ...authWarnings, ...unresolvedWarnings];

  return {
    url,
    options,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(authHeaderNames.length > 0 ? { authHeaderNames } : {}),
  };
}

/**
 * Apply a request's auth to the outgoing headers (finding A7).
 *
 * Header-based schemes (bearer, basic, header api-key) mutate `headers` in
 * place. A query api-key is returned so the caller can append it to the URL.
 * Schemes we cannot honour automatically — oauth2 and digest need a flow,
 * `inherit` needs collection/folder resolution we do not model — are pushed to
 * `warnings` and produce no header, so a run never silently sends an
 * unauthenticated request while claiming the auth was configured.
 */
function applyAuth(
  auth: YamlAuth | undefined,
  headers: Record<string, string>,
  subst: (value: string) => string,
  warnings: string[],
  authHeaderNames: string[],
): { key: string; value: string } | undefined {
  if (!auth) {
    return undefined;
  }
  if (auth === 'inherit') {
    warnings.push(
      'auth is set to "inherit", but collection/folder auth inheritance is not supported; no credential was sent',
    );
    return undefined;
  }

  switch (auth.type) {
    case undefined:
    case 'none':
      return undefined;

    case 'bearer': {
      const token = subst(String(auth.token ?? ''));
      if (token.length === 0) {
        warnings.push('bearer auth has no token; no Authorization header was sent');
        return undefined;
      }
      headers['Authorization'] = `Bearer ${token}`;
      authHeaderNames.push('Authorization');
      return undefined;
    }

    case 'basic': {
      const username = subst(String(auth.username ?? ''));
      const password = subst(String(auth.password ?? ''));
      headers['Authorization'] =
        'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
      authHeaderNames.push('Authorization');
      return undefined;
    }

    case 'api-key':
    case 'apikey': {
      const key = subst(String(auth.key ?? ''));
      const value = subst(String(auth.value ?? ''));
      if (key.length === 0) {
        warnings.push('api-key auth has no key name; no credential was sent');
        return undefined;
      }
      if (auth.in === 'query') {
        return { key, value };
      }
      headers[key] = value;
      authHeaderNames.push(key);
      return undefined;
    }

    default:
      warnings.push(
        `auth type "${String(auth.type)}" is not applied automatically; send the credential via a header or a pre-request script`,
      );
      return undefined;
  }
}

function getBeforeRequestScript(yaml: YamlRequest): string | null {
  if (!yaml.runtime?.scripts) return null;

  const beforeScripts = yaml.runtime.scripts
    .filter(s => s.type === 'before-request')
    .map(s => s.code);

  return beforeScripts.length > 0 ? beforeScripts.join('\n') : null;
}

function getAfterResponseScript(yaml: YamlRequest): string | null {
  if (!yaml.runtime?.scripts) return null;

  const afterScripts = yaml.runtime.scripts
    .filter(s => s.type === 'after-response')
    .map(s => s.code);

  return afterScripts.length > 0 ? afterScripts.join('\n') : null;
}

/** Truncate a response body to a maximum byte length (UTF-8). */
function capResponseBody(
  rawBody: string,
  maxBytes: number,
): { body: string; truncated: boolean } {
  const buf = Buffer.from(rawBody, 'utf8');
  if (buf.byteLength <= maxBytes) {
    return { body: rawBody, truncated: false };
  }
  return { body: buf.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

async function executeSingleRequest(
  yaml: YamlRequest,
  vars: Map<string, string>,
  scriptRunner: ScriptRunner,
  variableStore?: VariableStore,
  bodyCapture?: BodyCaptureOptions,
  collectionRoot?: string,
): Promise<RequestExecutionResult> {
  // Merge env vars with runtime vars (runtime takes precedence)
  const effectiveVars = variableStore ? variableStore.merge(vars) : vars;

  // eslint-disable-next-line prefer-const -- url is reassigned by pre-request script mutations below
  const built = await buildFetchOptions(yaml, effectiveVars, collectionRoot);
  let url = built.url;
  let options = built.options;
  // Reassignable: a pre-request script that sets a variable triggers a
  // re-substitution below (finding X12), which re-derives auth warnings and the
  // applied auth-header names from the merged vars so they stay consistent.
  let authWarnings = built.warnings;
  let authHeaderNames = built.authHeaderNames ?? [];
  const name = yaml.info.name;
  const method = yaml.http.method;

  // Run pre-request scripts (before fetch, may mutate url/headers/body)
  const preScript = getBeforeRequestScript(yaml);
  let preScriptError: string | undefined;
  if (preScript) {
    const mockReqData: MockRequestData = {
      url,
      method: options.method as string,
      headers: { ...(options.headers as Record<string, string>) },
      body: options.body ?? null,
    };
    const preResult = await scriptRunner.runPreRequestScript(preScript, mockReqData, {
      timeout: yaml.settings?.timeout ?? 5000,
      // Seed the merged env/collection/runtime vars so the script can read them
      // via bru.getVar (finding X10). effectiveVars is the same set fed to
      // buildFetchOptions, so getVar and {{placeholder}} substitution see one
      // consistent view. Object.fromEntries defines every entry as an OWN data
      // property (so a variable literally named "__proto__" is a plain key, not
      // a prototype write); the sandbox seeder then skips that key.
      variables: Object.fromEntries(effectiveVars),
    });

    // Feed variables the script set into the store FIRST, so they are visible
    // both to later requests and — via the re-substitution below — to THIS
    // request's own {{placeholders}} (finding X12).
    if (variableStore) {
      for (const [k, v] of Object.entries(preResult.variables)) {
        variableStore.set(k, v as string | number | boolean);
      }
    }

    // X12: substitution in buildFetchOptions ran BEFORE this script, so a
    // `bru.setVar('x', …)` here could not fill this request's own `{{x}}`. When
    // the script set any variable, re-substitute from the ORIGINAL templates
    // with the now-merged vars. This is still a SINGLE pass over the original
    // template (never a second expansion over already-substituted output), so
    // the template-injection mitigation is unchanged. Re-running the same build
    // logic re-derives auth application, the redaction input, unresolved-var
    // warnings, and the cross-origin strip header names consistently from the
    // new vars, rather than leaving them computed from the stale set.
    if (variableStore && Object.keys(preResult.variables).length > 0) {
      const rebuilt = await buildFetchOptions(yaml, variableStore.merge(vars), collectionRoot);
      url = rebuilt.url;
      options = rebuilt.options;
      authWarnings = rebuilt.warnings;
      authHeaderNames = rebuilt.authHeaderNames ?? [];
    }

    // Apply the script's req.set* mutations LAST so their precedence over
    // template/variable values is unchanged by the re-substitution above.
    if (preResult.mutations.url) {
      url = preResult.mutations.url;
    }
    if (preResult.mutations.headers) {
      Object.assign(options.headers as Record<string, string>, preResult.mutations.headers);
    }
    if (preResult.mutations.body !== undefined) {
      options.body = typeof preResult.mutations.body === 'string'
        ? preResult.mutations.body
        : JSON.stringify(preResult.mutations.body);
    }

    if (preResult.error) {
      preScriptError = preResult.error;
    }
  }

  // The URL is finalized here (post pre-request mutation). `url` keeps any
  // substituted secrets and is what we actually fetch; `shownUrl` is the
  // redacted form used everywhere a URL crosses back to the caller — results
  // and error messages (finding S22).
  const shownUrl = redactUrl(url);

  // A failing pre-request script must HALT the request (finding X15): the HTTP
  // call must not fire. Return a failed result carrying the script error before
  // the SSRF check and fetch, using the already-redacted URL so no substituted
  // secret crosses back to the caller.
  if (preScriptError) {
    return {
      name,
      method,
      url: shownUrl,
      status: 0,
      duration_ms: 0,
      tests: [],
      error: preScriptError,
    };
  }

  // SSRF protection: validate URL before making the request
  const urlCheck = await validateUrl(url);
  if (!urlCheck.valid) {
    return {
      name,
      method,
      url: shownUrl,
      status: 0,
      duration_ms: 0,
      tests: [],
      error:
        'SSRF blocked: ' +
        urlCheck.reason +
        (urlCheck.allowlistOverridable ? '. ' + ssrfRemediation() : ''),
    };
  }

  // timeout: 0 means "no timeout" in Bruno; omit signal entirely
  const timeout = yaml.settings?.timeout ?? 30000;
  const fetchOpts: RequestInit = { ...options, redirect: 'manual' as RequestRedirect };
  if (timeout > 0) {
    fetchOpts.signal = AbortSignal.timeout(timeout);
  }

  // Build a custom dispatcher for TLS/proxy settings and, above all, to pin the
  // addresses validateUrl just approved. The target host gates the operator
  // trust boundary (a collection's TLS-downgrade/CA/proxy overrides are honoured
  // only for allowlisted hosts).
  //
  // A dispatcher is built for every hop, not only when the collection carries
  // TLS/proxy settings: without one the request would go through global fetch(),
  // which re-resolves the hostname and can land on an address the SSRF check
  // never saw (S20). Each hop gets its own, so a socket is never reused for a
  // target it was not validated against (S21).
  const openDispatchers: DispatcherResult[] = [];
  const dispatcherFor = async (
    target: string,
    addresses: string[] | undefined,
  ): Promise<DispatcherResult | undefined> => {
    // Deciding a target is unusable belongs to validateUrl, not here; an
    // unparseable one simply has no host to check the operator allowlists
    // against, which denies the privileged TLS/proxy overrides.
    let host: string | undefined;
    try {
      host = new URL(target).hostname;
    } catch {
      host = undefined;
    }
    const built = await buildDispatcher(yaml.settings ?? {}, host, addresses);
    if (built) openDispatchers.push(built);
    return built;
  };

  const dispatcherResult = await dispatcherFor(url, urlCheck.addresses);

  const fetchFn = dispatcherResult ? dispatcherResult.fetch : fetch;
  if (dispatcherResult) {
    (fetchOpts as { dispatcher?: unknown }).dispatcher = dispatcherResult.dispatcher;
  }

  const startTime = Date.now();

  // Redirect handling honors request settings:
  //   followRedirects === false -> return the 3xx response as-is (no follow)
  //   maxRedirects -> hop cap (defaults to 10 when unset)
  const followRedirects = yaml.settings?.followRedirects !== false;
  const maxRedirects = yaml.settings?.maxRedirects ?? 10;

  try {
    let currentOpts = fetchOpts;
    let response = await fetchFn(url, currentOpts);
    let currentUrl = url;
    let redirectCount = 0;

    while (
      followRedirects &&
      response.status >= 300 &&
      response.status < 400 &&
      redirectCount < maxRedirects
    ) {
      const location = response.headers.get('location');
      if (!location) break;

      // Resolve relative redirects against current URL
      const redirectUrl = new URL(location, currentUrl).toString();

      // SSRF check on redirect target
      const redirectCheck = await validateUrl(redirectUrl);
      if (!redirectCheck.valid) {
        return {
          name,
          method,
          url: shownUrl,
          status: 0,
          duration_ms: Date.now() - startTime,
          tests: [],
          error: `Redirect to ${redactUrl(redirectUrl)} blocked: ${redirectCheck.reason}`,
        };
      }

      // X2 / RFC 9110: following a 303 (always) and a 301/302 (near-universal
      // browser and fetch behaviour) with a method other than GET/HEAD must
      // switch the method to GET and drop the request body on the redirected
      // hop. 307/308 preserve method and body, so they are left untouched.
      const st = response.status;
      if (st === 301 || st === 302 || st === 303) {
        const m = String(currentOpts.method ?? 'GET').toUpperCase();
        if (m !== 'GET' && m !== 'HEAD') {
          currentOpts = { ...currentOpts, method: 'GET' };
          delete (currentOpts as { body?: unknown }).body;
        }
      }

      // S06/S07: strip credential headers when the hop crosses origin, so a
      // redirect to another host cannot harvest the caller's Authorization,
      // api-key, or cookies. Once stripped they stay stripped for later hops.
      if (new URL(redirectUrl).origin !== new URL(currentUrl).origin) {
        currentOpts = {
          ...currentOpts,
          headers: stripCredentialHeaders(
            currentOpts.headers as Record<string, string>,
            authHeaderNames,
          ),
        };
      }

      // Pin this hop to the addresses redirectCheck approved for it. The
      // previous hop's dispatcher is pinned to a different host's addresses, so
      // it must be replaced — or cleared, when this hop has nothing to pin.
      const hop = await dispatcherFor(redirectUrl, redirectCheck.addresses);
      currentOpts = { ...currentOpts };
      if (hop) {
        (currentOpts as { dispatcher?: unknown }).dispatcher = hop.dispatcher;
      } else {
        delete (currentOpts as { dispatcher?: unknown }).dispatcher;
      }

      response = await (hop ? hop.fetch : fetch)(redirectUrl, currentOpts);
      currentUrl = redirectUrl;
      redirectCount++;
    }

    // X1: the cap is only exceeded when the loop stopped at the limit while the
    // response is STILL a redirect that would need following. A final non-3xx
    // response reached within the cap (including maxRedirects: 0 with no
    // redirect at all) is a success, not a "too many redirects" error.
    if (
      followRedirects &&
      redirectCount >= maxRedirects &&
      response.status >= 300 &&
      response.status < 400
    ) {
      return {
        name,
        method,
        url: shownUrl,
        status: 0,
        duration_ms: Date.now() - startTime,
        tests: [],
        error: `Too many redirects (max ${maxRedirects})`,
      };
    }

    const durationMs = Date.now() - startTime;

    const wrappedResponse = await wrapFetchResponse(response, durationMs);

    let tests: TestResult[] = [];
    let scriptWarnings: string[] | undefined;
    const testScript = getAfterResponseScript(yaml);
    if (testScript) {
      const scriptResult = await scriptRunner.runScript(testScript, wrappedResponse, {
        // Seed the current merged vars (env/collection/runtime plus anything the
        // pre-request script wrote into the store) so a post-response script can
        // read them via bru.getVar (finding X10).
        variables: Object.fromEntries(
          variableStore ? variableStore.merge(vars) : vars,
        ),
      });
      tests = scriptResult.results;
      if (scriptResult.warnings && scriptResult.warnings.length > 0) {
        scriptWarnings = scriptResult.warnings;
      }

      // Feed extracted variables into the store for cross-request propagation
      if (variableStore) {
        for (const [k, v] of Object.entries(scriptResult.variables)) {
          variableStore.set(k, v as string | number | boolean);
        }
      }
    }

    const combinedWarnings = [...(authWarnings ?? []), ...(scriptWarnings ?? [])];
    const result: RequestExecutionResult = {
      name,
      method,
      url: shownUrl,
      status: response.status,
      duration_ms: durationMs,
      tests,
      ...(combinedWarnings.length > 0 ? { warnings: combinedWarnings } : {}),
      error: preScriptError,
    };

    if (bodyCapture?.includeResponseBody) {
      const rawBody = wrappedResponse.rawBody ?? '';
      const { body, truncated } = capResponseBody(rawBody, bodyCapture.maxResponseBodyBytes);
      result.response_body = body;
      result.response_body_truncated = truncated;
      result.response_content_type = wrappedResponse.headers['content-type'] ?? '';
    }

    return result;
  } catch (error: unknown) {
    const durationMs = Date.now() - startTime;

    return {
      name,
      method,
      url: shownUrl,
      status: 0,
      duration_ms: durationMs,
      tests: [],
      error: describeNetworkError(error, { url: shownUrl, timeoutMs: timeout, elapsedMs: durationMs }),
    };
  } finally {
    // The response body is fully materialised by wrapFetchResponse above, so
    // every per-hop dispatcher can be torn down here. Skipping this would leak
    // a socket pool per request now that a dispatcher is always built.
    await Promise.all(openDispatchers.map((d) => d.close()));
  }
}

export class RequestExecutor {
  static async executeCollection(
    collectionPath: string,
    options?: ExecutionOptions,
  ): Promise<CollectionRunResult> {
    const startTime = Date.now();

    const bodyCapture: BodyCaptureOptions = {
      includeResponseBody: options?.includeResponseBody ?? true,
      maxResponseBodyBytes: options?.maxResponseBodyBytes ?? DEFAULT_MAX_RESPONSE_BODY_BYTES,
    };

    // In-process by default (the test suite runs without forking); server.ts
    // injects the forking runner so production executes scripts behind a
    // process boundary.
    const scriptRunner = options?.scriptRunner ?? TestRunner;

    let vars = new Map<string, string>();
    if (options?.environment) {
      const envRoot = options.collectionRoot ?? collectionPath;
      vars = await loadEnvironment(envRoot, options.environment);
    }

    let requests: ParsedRequest[];
    let parseErrors = 0;

    if (options?.requestPath) {
      const isFile = options.requestPath.endsWith('.yml') || options.requestPath.endsWith('.bru');
      if (!isFile) {
        // Not a recognized file extension — check if it's a directory
        const pathStat = await stat(options.requestPath);
        if (pathStat.isDirectory()) {
          const discovery = await discoverRequests(options.requestPath);
          requests = discovery.requests;
          parseErrors = discovery.parseErrors;
        } else {
          throw new Error(`Unsupported request file format: ${options.requestPath}`);
        }
      } else {
        const content = await readFile(options.requestPath, 'utf-8');
        let yaml: YamlRequest;
        if (options.requestPath.endsWith('.yml')) {
          yaml = parseYamlRequest(content);
        } else {
          yaml = bruFileToYamlRequest(parseBruRequest(content));
        }
        requests = [{ yaml, filePath: options.requestPath }];
      }
    } else {
      const discovery = await discoverRequests(collectionPath);
      requests = discovery.requests;
      parseErrors = discovery.parseErrors;
    }

    let results: RequestExecutionResult[];

    if (options?.parallel) {
      // Group requests by folder (derived from file path relative to collectionPath)
      const folderMap = new Map<string, ParsedRequest[]>();
      for (const req of requests) {
        const relPath = relative(collectionPath, req.filePath);
        const folder = dirname(relPath) === '.' ? '' : dirname(relPath);
        if (!folderMap.has(folder)) {
          folderMap.set(folder, []);
        }
        folderMap.get(folder)!.push(req);
      }

      // Sort folder names alphabetically for deterministic merge order
      const sortedFolders = [...folderMap.keys()].sort();

      // Execute folders in parallel, serial within each folder
      const folderResults = await Promise.allSettled(
        sortedFolders.map(async (folder) => {
          const folderRequests = folderMap.get(folder)!;
          // Folders are isolated by design: each gets its own VariableStore so
          // concurrent folder tasks never share a mutable store (which would
          // reintroduce a setVar/getVar race). A variable set by a script in
          // one folder is therefore invisible to another folder's requests. We
          // do NOT bridge stores across folders; instead buildFetchOptions
          // surfaces any {{var}} left unresolved as a per-request warning
          // (finding X8), so this isolation can no longer let an unsubstituted
          // placeholder reach the wire silently the way serial mode would not.
          const folderStore = new VariableStore();
          const folderRes: RequestExecutionResult[] = [];
          for (const req of folderRequests) {
            const result = await executeSingleRequest(req.yaml, vars, scriptRunner, folderStore, bodyCapture, collectionPath);
            folderRes.push(result);
          }
          return folderRes;
        }),
      );

      // Merge results in folder order.
      //
      // A folder task can genuinely reject: executeSingleRequest only wraps the
      // fetch in a try/catch, so anything that throws before it — buildDispatcher
      // on a malformed `settings.proxy`, for example — escapes as a rejection.
      // Dropping those would shrink `total` to the surviving folders and report
      // the run as fully passed, which is the worst possible failure mode for a
      // test runner. Serial execution lets such an error propagate out of
      // executeCollection; parallel must not be quieter than serial.
      results = [];
      const folderFailures: unknown[] = [];
      for (const outcome of folderResults) {
        if (outcome.status === 'fulfilled') {
          results.push(...outcome.value);
        } else {
          folderFailures.push(outcome.reason);
        }
      }

      if (folderFailures.length === 1) {
        // Rethrow the original so the type, stack and message match serial mode.
        throw folderFailures[0];
      }
      if (folderFailures.length > 1) {
        // Callers surface only `.message` (see the run_collection handler), so
        // inline every reason rather than burying them in `.errors`.
        const detail = folderFailures
          .map(reason => (reason instanceof Error ? reason.message : String(reason)))
          .join('; ');
        throw new AggregateError(
          folderFailures,
          `${folderFailures.length} of ${sortedFolders.length} parallel folders failed: ${detail}`,
        );
      }
    } else {
      // Serial execution (default)
      const variableStore = new VariableStore();
      results = [];
      for (const req of requests) {
        const result = await executeSingleRequest(req.yaml, vars, scriptRunner, variableStore, bodyCapture, collectionPath);
        results.push(result);
      }
    }

    const totalDuration = Date.now() - startTime;
    const failed = results.filter(
      r => r.error !== undefined || r.tests.some(t => t.status === 'fail'),
    ).length;

    return {
      summary: {
        total: results.length,
        passed: results.length - failed,
        failed,
        duration_ms: totalDuration,
      },
      results,
      parseErrors,
    };
  }
}
