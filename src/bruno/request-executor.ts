import { readFile } from 'node:fs/promises';
import { basename, relative, dirname, resolve, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { loadEnvironment, substitute, findUnresolvedPlaceholders } from './env-loader.js';
import { forkingScriptRunner, type ScriptRunner } from './sandbox-host.js';
import { wrapFetchResponse } from './response-wrapper.js';
import { validateUrl, ssrfRemediation } from './url-validator.js';
import { VariableStore } from './variable-store.js';
import { buildDispatcher, type DispatcherResult } from './fetch-dispatcher.js';
import { describeNetworkError } from './network-error.js';
import { applyParams } from './request-params.js';
import { applyPreRequestVars } from './request-vars.js';
import { bruFileToYamlRequest, bruAuthToYamlAuth } from './bru-to-yaml.js';
import type { ExecutionOptions } from './execution-options.js';
import { resolveRunTargets, type ParsedRequest } from './request-discovery.js';
import { createRootLoader, type RootChain, type RootLoader } from './collection-roots.js';
import { applyVariableOverrides } from './runtime-variables.js';
import {
  applyCookiesToHeaders,
  createRunCookieJar,
  storeResponseCookies,
  shadowedCookieWarning,
  type RunCookieJar,
} from './cookie-jar.js';
import {
  redactUrl,
  stripCredentialHeaders,
  appendQueryCredential,
} from './request-redaction.js';
import { encodeRequestUrl, shouldEncodeUrl, hasExplicitScheme } from './url-encoder.js';
import {
  SINGLE_VALUE_HEADERS,
  appendHeader,
  BODY_TYPE_CONTENT_TYPES,
  setDefaultContentType,
} from './request-headers.js';
import { buildGraphqlBody, buildFormUrlEncodedBody } from './request-body.js';
import type {
  YamlRequest,
  YamlScript,
  YamlAuth,
  MockRequestData,
  CollectionRunResult,
  CollectionRunSummary,
  RequestExecutionResult,
  TestResult,
  MultipartFormPart,
  FormUrlEncodedPart,
  BruGraphql,
  UnappliedAuthType,
} from './types.js';

// The .bru -> YamlRequest translation and the credential-redaction helpers moved
// to their own modules when this file hit the repo-wide max-lines ceiling.
// Re-exported because tests (and any future caller) import these names from here.
export { bruFileToYamlRequest, bruAuthToYamlAuth };
export { redactUrl, stripCredentialHeaders };

const DEFAULT_MAX_RESPONSE_BODY_BYTES = 10240;

interface BodyCaptureOptions {
  includeResponseBody: boolean;
  maxResponseBodyBytes: number;
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
 *.
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

export async function buildFetchOptions(
  yaml: YamlRequest,
  vars: Map<string, string>,
  collectionRoot?: string,
  rootChain?: RootChain,
): Promise<{
  url: string;
  options: RequestInit;
  warnings?: string[];
  authHeaderNames?: string[];
  /**
   * Query-parameter names a credential was placed under. Feeds redactUrl, whose
   * built-in list cannot know a collection-chosen parameter name.
   */
  authQueryNames?: string[];
}> {
  // Surface any {{var}} that substitution could not resolve so an
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

  // Applied here, before validateUrl below, so the URL that is checked is the
  // one actually sent — a parameter must never be able to slip past the check.
  url = applyParams(url, yaml.http.params, (raw) => {
    trackUnresolved(raw);
    return substitute(raw, vars);
  });

  const headers: Record<string, string> = {};
  // Maps a lowercased header name to the key actually used in `headers`, so a
  // repeat under different casing lands on the first occurrence's casing
  // instead of creating a second entry.
  const headerKeys = new Map<string, string>();
  // Counted per lowercased name so a singleton header repeated N times warns
  // once, on the transition to the second occurrence, rather than N-1 times.
  const headerCounts = new Map<string, number>();
  const headerWarnings: string[] = [];

  // Collection/folder root headers go on FIRST, and any name the request sets
  // itself is left out of them entirely. Two reasons for dropping rather than
  // overwriting: appendHeader would otherwise comma-join the two values and send
  // a doubled credential, and upstream's own merge is a Map filled
  // root-then-request, where the later write simply replaces the earlier one.
  // Matched case-insensitively, which upstream does not do — it keys on the name
  // as written, so a collection's `authorization` and a request's
  // `Authorization` both go out. Header names are case-insensitive per HTTP, so
  // that pairing is exactly the doubled-credential case worth avoiding.
  if (rootChain && rootChain.headers.length > 0) {
    const ownNames = new Set(
      (yaml.http.headers ?? [])
        .filter(h => h.disabled !== true)
        .map(h => substitute(h.name, vars).toLowerCase()),
    );
    // Nearest root wins among the roots themselves: the chain arrives
    // collection-first, so a later set() replaces an outer folder's header.
    const nearest = new Map<string, { name: string; value: string }>();
    for (const h of rootChain.headers) {
      const headerName = substitute(h.name, vars);
      nearest.set(headerName.toLowerCase(), { name: headerName, value: h.value });
    }
    for (const [lower, h] of nearest) {
      if (ownNames.has(lower)) {
        continue;
      }
      trackUnresolved(h.name);
      trackUnresolved(h.value);
      appendHeader(headers, headerKeys, h.name, substitute(h.value, vars));
    }
  }

  if (yaml.http.headers) {
    for (const h of yaml.http.headers) {
      // A header explicitly disabled in the collection must not be sent.
      // Skip before substituting, so a disabled header's placeholders are not
      // reported as unresolved either.
      if (h.disabled === true) continue;
      trackUnresolved(h.value);
      // The NAME is substituted and tracked too. A header authored as
      // `{{tokenHeader}}: abc` otherwise went out with the literal
      // `{{tokenHeader}}` as its field name, and the unresolved-variable report
      // — the mechanism that stops an unsubstituted placeholder reaching the
      // wire silently — never mentioned it.
      trackUnresolved(h.name);
      const headerName = substitute(h.name, vars);
      // Keyed off the SUBSTITUTED name: the duplicate and single-value
      // bookkeeping is about the field actually sent, so two different templates
      // resolving to the same field have to collapse onto one entry.
      const lower = headerName.toLowerCase();
      const occurrence = (headerCounts.get(lower) ?? 0) + 1;
      headerCounts.set(lower, occurrence);
      if (occurrence === 2 && SINGLE_VALUE_HEADERS.has(lower)) {
        // Name only, never the value: a repeated Authorization or Cookie
        // carries a credential, and warnings surface to the caller.
        headerWarnings.push(
          `Header "${headerKeys.get(lower) ?? headerName}" is defined by HTTP as a single-value field but is set more than once; the values were combined into one and the server may reject the request. Remove the duplicate.`,
        );
      }
      appendHeader(headers, headerKeys, headerName, substitute(h.value, vars));
    }
  }

  // Apply the request's auth on the wire: it was authored and
  // parsed but never sent. Header-based schemes mutate `headers`; a query
  // api-key comes back to be appended to the URL; a scheme we cannot apply
  // automatically is surfaced as a warning rather than dropped in silence.
  const authWarnings: string[] = [];
  const authHeaderNames: string[] = [];
  const authQueryNames: string[] = [];
  const queryAuth = applyAuth(
    yaml.http.auth,
    headers,
    s => {
      trackUnresolved(s);
      return substitute(s, vars);
    },
    authWarnings,
    authHeaderNames,
    rootChain?.auth,
  );
  if (queryAuth) {
    url = appendQueryCredential(url, queryAuth.key, queryAuth.value);
    // Registered so the redactor can mask this value on the way back out. The
    // header path registers its names for the same reason; a query-placed
    // credential skipping registration meant it was the one credential that
    // reached the caller in the clear, because the reported URL contains it.
    authQueryNames.push(queryAuth.key);
  }

  const options: RequestInit = {
    method: yaml.http.method,
    headers,
  };

  const bodyWarnings: string[] = [];
  const body = yaml.http.body;
  if (isMultipartBody(body)) {
    const form = new FormData();
    const parts = body!.data as MultipartFormPart[];

    for (const part of parts) {
      // A part explicitly disabled in the collection must not be sent.
      // Skip before tracking/substituting so a disabled part's
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
          // files.
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
  } else if (body?.type === 'graphql' && body.data != null && !Array.isArray(body.data)) {
    // Ahead of the plain-string branch on purpose: a graphql query this tool
    // wrote is stored as bare text, and the string branch would claim it and
    // send it with no JSON envelope around it.
    options.body = buildGraphqlBody(body.data as BruGraphql | string, vars, trackUnresolved);
    setDefaultContentType(headers, 'application/json');
  } else if (typeof body?.data === 'string') {
    trackUnresolved(body.data);
    options.body = substitute(body.data, vars);
    const implied = BODY_TYPE_CONTENT_TYPES[body.type];
    if (implied !== undefined) setDefaultContentType(headers, implied);
  } else if (body?.type === 'form-urlencoded' && Array.isArray(body.data)) {
    options.body = buildFormUrlEncodedBody(
      body.data as FormUrlEncodedPart[],
      vars,
      trackUnresolved,
    );
    setDefaultContentType(headers, 'application/x-www-form-urlencoded');
  } else if (body?.data != null) {
    // The branch that used not to exist. Every shape above is one this codebase
    // knows how to put on the wire; anything left is a body the file declares
    // and this build cannot encode. Sending nothing is the only honest option —
    // a guessed encoding is a body the author did not write — but it must not
    // be silent, because the request then returns a perfectly clean 2xx or 4xx
    // and any assertion on it passes for the wrong reason.
    bodyWarnings.push(
      `body of type "${body.type}" was not sent: its data is ${
        Array.isArray(body.data) ? 'a list' : typeof body.data
      }, which no encoder here accepts`,
    );
  }

  // Name the placeholder (e.g. `{{token}}`) but never a resolved value — the
  // value may be a secret. Ordered by the stage that produced them:
  // headerWarnings (the authored header list is read first), then authWarnings,
  // then bodyWarnings, then the unresolved-variable warnings in first-seen order.
  const unresolvedWarnings = [...unresolvedNames].map(
    name => `unresolved variable: {{${name}}}`,
  );
  const warnings = [
    // First: a root setting that exists and is NOT applied explains warnings
    // below it, such as an unresolved variable a root's vars block would define.
    ...(rootChain?.unapplied ?? []),
    ...headerWarnings,
    ...authWarnings,
    ...bodyWarnings,
    ...unresolvedWarnings,
  ];

  return {
    url,
    options,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(authHeaderNames.length > 0 ? { authHeaderNames } : {}),
    ...(authQueryNames.length > 0 ? { authQueryNames } : {}),
  };
}

/**
 * Placement values that put an api-key credential in the query string.
 *
 * Bruno writes `queryparams` (its schema allows only `'header' | 'queryparams'`)
 * while this tool's own surface says `query`, and the field is spelled `in` on
 * one path and `placement` on the other. Reading a single spelling and letting
 * everything else fall through to the header branch meant a request authored in
 * Bruno sent its credential as a HEADER NAMED AFTER THE QUERY PARAMETER — to a
 * server that was never going to look there, while the header went out anyway.
 */
const QUERY_PLACEMENTS = new Set(['query', 'queryparams']);

/**
 * Auth modes the type surface accepts that this executor cannot perform.
 *
 * Typed as UnappliedAuthType so the list cannot drift from the declared split:
 * moving a mode out of UnappliedAuthType (because it was implemented) makes this
 * array fail to type-check until the entry is removed here too.
 */
const UNAPPLIED_AUTH_TYPES: readonly UnappliedAuthType[] = ['oauth2', 'digest'];

/** True when an api-key auth block asks for the credential in the query string. */
function isQueryPlacement(auth: Exclude<YamlAuth, 'inherit'>): boolean {
  const placement = auth.in ?? auth.placement;
  return typeof placement === 'string' && QUERY_PLACEMENTS.has(placement.toLowerCase());
}

/**
 * Apply a request's auth to the outgoing headers.
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
  inheritedAuth?: YamlAuth,
): { key: string; value: string } | undefined {
  if (!auth) {
    return undefined;
  }
  if (auth === 'inherit') {
    // Resolved from the nearest collection/folder root that defines auth. Still
    // warns when no root does: `inherit` from nothing sends no credential, and
    // that has to be said rather than looking like a request without auth.
    if (!inheritedAuth || inheritedAuth === 'inherit') {
      warnings.push(
        'auth is set to "inherit", but no collection or folder root defines auth; no credential was sent',
      );
      return undefined;
    }
    return applyAuth(inheritedAuth, headers, subst, warnings, authHeaderNames);
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
      if (isQueryPlacement(auth)) {
        return { key, value };
      }
      headers[key] = value;
      authHeaderNames.push(key);
      return undefined;
    }

    default: {
      const type = String(auth.type);
      // A KNOWN-but-unimplemented scheme and an unrecognised one are different
      // situations for whoever reads the warning: the first needs a workaround,
      // the second is probably a typo or a Bruno feature this tool has not
      // learned yet.
      warnings.push(
        (UNAPPLIED_AUTH_TYPES as readonly string[]).includes(type)
          ? `auth type "${type}" is not applied: it needs a multi-step exchange with the server that this tool does not perform, so no credential was sent. Obtain the credential in a pre-request script and set the header there.`
          : `auth type "${type}" is not applied because it is not recognised; no credential was sent. Send the credential via a header or a pre-request script.`,
      );
      return undefined;
    }
  }
}

function getBeforeRequestScript(yaml: YamlRequest): string | null {
  if (!yaml.runtime?.scripts) return null;

  const beforeScripts = yaml.runtime.scripts
    .filter(s => s.type === 'before-request')
    .map(s => s.code);

  return beforeScripts.length > 0 ? beforeScripts.join('\n') : null;
}

/**
 * The code to run in the post-response phase.
 *
 * A .yml request keeps its test script in a slot of its own (`type: tests`)
 * separate from the post-response script (`type: after-response`); a .bru
 * request keeps the same split between its `script:post-response` and `tests`
 * blocks. This runner has a single post-response phase, so both are folded into
 * one program here — after-response first, then tests, which is the order Bruno
 * runs them in. Reading only 'after-response' would store an authored test
 * faithfully and never execute it, reporting a run with zero tests as green.
 */
function getAfterResponseScript(yaml: YamlRequest): string | null {
  if (!yaml.runtime?.scripts) return null;

  const afterScripts = yaml.runtime.scripts
    .filter(s => s.type === 'after-response' || s.type === 'tests')
    .sort((a, b) => scriptPhaseOrder(a.type) - scriptPhaseOrder(b.type))
    .map(s => s.code);

  return afterScripts.length > 0 ? afterScripts.join('\n') : null;
}

/** Sort key that puts an 'after-response' entry ahead of a 'tests' entry. */
function scriptPhaseOrder(type: YamlScript['type']): number {
  return type === 'tests' ? 1 : 0;
}

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * The largest delay a timer honours. Above this Node does not refuse the value:
 * it emits a TimeoutOverflowWarning and silently uses 1 ms instead, which turns
 * "wait a very long time" into "fail immediately" — the opposite of what was
 * asked for.
 */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Reduce an authored `settings.timeout` to a delay AbortSignal.timeout will
 * accept, plus a warning when the authored value could not be honoured.
 *
 * The value comes straight from a collection file and nothing upstream of here
 * validates it, while AbortSignal.timeout accepts only a non-negative integer
 * below the timer ceiling. A fractional value, NaN, Infinity or anything past
 * the ceiling makes it throw, and it throws synchronously — so the construction
 * also has to happen inside the request's try/catch, or the RangeError escapes
 * as a rejected run instead of a failed request.
 *
 * Returning 0 means "send no signal": that is already Bruno's meaning for
 * `timeout: 0`, and it is the only honest reading of a delay too large for the
 * platform to represent.
 */
function resolveTimeout(raw: number | undefined): { timeoutMs: number; warning?: string } {
  if (raw === undefined) {
    return { timeoutMs: DEFAULT_TIMEOUT_MS };
  }
  const n = Number(raw);
  if (Number.isNaN(n)) {
    return {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      warning: `settings.timeout is not a number; the default ${DEFAULT_TIMEOUT_MS}ms was used instead`,
    };
  }
  if (n <= 0) {
    return { timeoutMs: 0 };
  }
  if (n > MAX_TIMEOUT_MS) {
    return {
      timeoutMs: 0,
      warning:
        `settings.timeout (${n}) is above the maximum supported ${MAX_TIMEOUT_MS}ms; ` +
        'the request was sent with no timeout',
    };
  }
  // AbortSignal.timeout rejects a fractional delay outright, so truncate rather
  // than let a `timeout: 1500.7` fail the request.
  return { timeoutMs: Math.floor(n) };
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
  cookieJar?: RunCookieJar,
  rootChain?: RootChain,
): Promise<RequestExecutionResult> {
  // `vars:pre-request` sits between the environment and the runtime store, which
  // is where upstream puts it: collection < env < folder < REQUEST < oauth2 <
  // runtime < process.env. So a request var overrides the environment, and
  // anything bru.setVar wrote still overrides the request var.
  const baseVars = applyPreRequestVars(vars, yaml.vars);

  // Merge env + request vars with runtime vars (runtime takes precedence)
  const effectiveVars = variableStore ? variableStore.merge(baseVars) : baseVars;

  // eslint-disable-next-line prefer-const -- url is reassigned by pre-request script mutations below
  const built = await buildFetchOptions(yaml, effectiveVars, collectionRoot, rootChain);
  let url = built.url;
  let options = built.options;
  // Reassignable: a pre-request script that sets a variable triggers a
  // re-substitution below, which re-derives auth warnings and the
  // applied auth-header names from the merged vars so they stay consistent.
  let authWarnings = built.warnings;
  let authHeaderNames = built.authHeaderNames ?? [];
  let authQueryNames = built.authQueryNames ?? [];
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
      // via bru.getVar. effectiveVars is the same set fed to
      // buildFetchOptions, so getVar and {{placeholder}} substitution see one
      // consistent view. Object.fromEntries defines every entry as an OWN data
      // property (so a variable literally named "__proto__" is a plain key, not
      // a prototype write); the sandbox seeder then skips that key.
      variables: Object.fromEntries(effectiveVars),
    });

    // Feed variables the script set into the store FIRST, so they are visible
    // both to later requests and — via the re-substitution below — to THIS
    // request's own {{placeholders}}.
    if (variableStore) {
      for (const [k, v] of Object.entries(preResult.variables)) {
        variableStore.set(k, v as string | number | boolean);
      }
    }

    // Substitution in buildFetchOptions ran BEFORE this script, so a
    // `bru.setVar('x', …)` here could not fill this request's own `{{x}}`. When
    // the script set any variable, re-substitute from the ORIGINAL templates
    // with the now-merged vars. This is still a SINGLE pass over the original
    // template (never a second expansion over already-substituted output), so
    // the template-injection mitigation is unchanged. Re-running the same build
    // logic re-derives auth application, the redaction input, unresolved-var
    // warnings, and the cross-origin strip header names consistently from the
    // new vars, rather than leaving them computed from the stale set.
    if (variableStore && Object.keys(preResult.variables).length > 0) {
      // baseVars, not vars: re-substituting from the environment alone would drop
      // every vars:pre-request entry the moment a pre-request script wrote a
      // variable, which is exactly when this path runs.
      const rebuilt = await buildFetchOptions(yaml, variableStore.merge(baseVars), collectionRoot, rootChain);
      url = rebuilt.url;
      options = rebuilt.options;
      authWarnings = rebuilt.warnings;
      authHeaderNames = rebuilt.authHeaderNames ?? [];
      authQueryNames = rebuilt.authQueryNames ?? [];
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

  // `settings.encodeUrl` is applied here and nowhere else, matching where Bruno
  // applies it: on the finished URL, after interpolation, after path parameters
  // and after any pre-request script rewrite. Doing it earlier would encode a URL
  // a script then replaces, and doing it per-value would send different bytes
  // than Bruno for the same collection.
  if (shouldEncodeUrl(yaml.settings)) {
    // A scheme has to be present first or the port colon in a `host:port`
    // authority is encoded as path data. Confined to this branch so a schemeless
    // URL reaches validateUrl unchanged when the setting is off.
    url = encodeRequestUrl(hasExplicitScheme(url) ? url : `http://${url}`);
  }

  // The URL is finalized here (post pre-request mutation). `url` keeps any
  // substituted secrets and is what we actually fetch; `shownUrl` is the
  // redacted form used everywhere a URL crosses back to the caller — results
  // and error messages.
  // authQueryNames carries the parameter name a query-placed credential was
  // written under, which redactUrl's built-in list cannot know: the collection
  // chooses that name.
  const shownUrl = redactUrl(url, authQueryNames);

  // A failing pre-request script must HALT the request: the HTTP
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

  const { timeoutMs, warning: timeoutWarning } = resolveTimeout(yaml.settings?.timeout);
  const fetchOpts: RequestInit = { ...options, redirect: 'manual' as RequestRedirect };

  // Build a custom dispatcher for TLS/proxy settings and, above all, to pin the
  // addresses validateUrl just approved. The target host gates the operator
  // trust boundary (a collection's TLS-downgrade/CA/proxy overrides are honoured
  // only for allowlisted hosts).
  //
  // A dispatcher is built for every hop, not only when the collection carries
  // TLS/proxy settings: without one the request would go through global fetch(),
  // which re-resolves the hostname and can land on an address the SSRF check
  // never saw. Each hop gets its own, so a socket is never reused for a
  // target it was not validated against.
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
    // Built inside the try on purpose. AbortSignal.timeout throws synchronously
    // for a delay it cannot represent, and resolveTimeout above cannot rule out
    // every future platform limit; a throw here has to surface as this request's
    // error, not as a rejection escaping the whole run.
    let currentOpts = fetchOpts;
    if (timeoutMs > 0) {
      currentOpts = { ...fetchOpts, signal: AbortSignal.timeout(timeoutMs) };
    }
    // Collected across every hop and reported once: a redirect chain to the same
    // host re-applies the jar on each hop, and the same name three times over is
    // one fact, not three warnings.
    const shadowedCookies = new Set<string>();
    if (cookieJar) {
      for (const shadowedName of applyCookiesToHeaders(
        currentOpts.headers as Record<string, string>,
        url,
        cookieJar,
      )) {
        shadowedCookies.add(shadowedName);
      }
    }
    let response = await fetchFn(url, currentOpts);
    // Stored even for a 4XX/5XX, as upstream does: a failed login still sets
    // the cookie the next request needs.
    if (cookieJar) {
      storeResponseCookies(cookieJar, url, response);
    }
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
          error:
            `Redirect to ${redactUrl(redirectUrl, authQueryNames)} blocked: ` +
            redirectCheck.reason,
        };
      }

      // RFC 9110: following a 303 (always) and a 301/302 (near-universal
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

      // Strip credential headers when the hop crosses origin, so a
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
      // After the cross-origin strip above, never before it: the jar decides
      // what this hop's host may receive, which is the whole point of following
      // a login redirect. A hop to another origin gets that origin's cookies,
      // or none.
      if (cookieJar) {
        for (const shadowedName of applyCookiesToHeaders(
          currentOpts.headers as Record<string, string>,
          redirectUrl,
          cookieJar,
        )) {
          shadowedCookies.add(shadowedName);
        }
      }

      const hop = await dispatcherFor(redirectUrl, redirectCheck.addresses);
      currentOpts = { ...currentOpts };
      if (hop) {
        (currentOpts as { dispatcher?: unknown }).dispatcher = hop.dispatcher;
      } else {
        delete (currentOpts as { dispatcher?: unknown }).dispatcher;
      }

      response = await (hop ? hop.fetch : fetch)(redirectUrl, currentOpts);
      if (cookieJar) {
        storeResponseCookies(cookieJar, redirectUrl, response);
      }
      currentUrl = redirectUrl;
      redirectCount++;
    }

    // The cap is only exceeded when the loop stopped at the limit while the
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
    let droppedAssertions: string | undefined;
    const testScript = getAfterResponseScript(yaml);
    // Assertions the author switched off are dropped here rather than carried
    // with a flag, so nothing downstream can evaluate one or report it.
    const assertions = (yaml.assert ?? [])
      .filter((assertion) => assertion.disabled !== true)
      .map((assertion) => ({ name: assertion.name, value: assertion.value }));
    // Same drop-not-flag treatment for vars:post-response. Unlike pre-request
    // vars these values are JS EXPRESSIONS, evaluated in the sandbox with res
    // and bru in scope — which is why they travel with the sandbox job rather
    // than being folded into the interpolation map here.
    const postResponseVars = (yaml.vars?.postResponse ?? [])
      .filter((entry) => entry.disabled !== true)
      .map((entry) => ({ name: entry.name, value: entry.value }));
    // The gate is script OR assertions. Gating on the script alone meant a
    // request that declared assertions but no post-response script never invoked
    // the sandbox, so its declared checks were parsed, written back faithfully,
    // and never evaluated — the run reported zero assertions and looked green.
    // postResponseVars joins the gate for the same reason assertions did: a
    // request that declares only vars still has sandbox work to do, and gating it
    // out would leave those vars parsed, written back and never evaluated.
    if (testScript || assertions.length > 0 || postResponseVars.length > 0) {
      const scriptResult = await scriptRunner.runScript(testScript ?? '', wrappedResponse, {
        // Seed the current merged vars (env/collection/runtime plus anything the
        // pre-request script wrote into the store) so a post-response script can
        // read them via bru.getVar, and so a declared assertion's `{{var}}`
        // operand resolves against the same map the URL was built from.
        variables: Object.fromEntries(
          variableStore ? variableStore.merge(baseVars) : baseVars,
        ),
        assertions,
        postResponseVars,
      });
      tests = scriptResult.results;
      if (scriptResult.warnings && scriptResult.warnings.length > 0) {
        scriptWarnings = scriptResult.warnings;
      }

      // An enabled assertion always yields one result. Handing the sandbox N of
      // them and getting nothing back therefore means the evaluation was lost
      // somewhere between here and the result, and the caller must not be told
      // the request was fine: with no results to fail, the request would
      // otherwise be counted as passed precisely because nothing was checked.
      if (assertions.length > 0 && tests.length === 0) {
        droppedAssertions =
          `${assertions.length} declared assertion(s) produced no result; ` +
          'they were not evaluated, so this request was not verified';
      }

      // Feed extracted variables into the store for cross-request propagation
      if (variableStore) {
        for (const [k, v] of Object.entries(scriptResult.variables)) {
          variableStore.set(k, v as string | number | boolean);
        }
      }
    }

    const combinedWarnings = [
      ...(authWarnings ?? []),
      ...(timeoutWarning ? [timeoutWarning] : []),
      ...(shadowedCookies.size > 0 ? [shadowedCookieWarning([...shadowedCookies])] : []),
      ...(scriptWarnings ?? []),
    ];
    const result: RequestExecutionResult = {
      name,
      method,
      url: shownUrl,
      status: response.status,
      duration_ms: durationMs,
      tests,
      ...(combinedWarnings.length > 0 ? { warnings: combinedWarnings } : {}),
      // preScriptError first: a pre-request failure is the earlier and more
      // specific cause, and it is also why the assertions never ran.
      error: preScriptError ?? droppedAssertions,
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
      error: describeNetworkError(error, { url: shownUrl, timeoutMs, elapsedMs: durationMs }),
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

    // Fails closed: omitting scriptRunner gets the process boundary, not a
    // silent opt-out of it. The in-process runner is reachable only by naming
    // it, and a caller that names it in production is visible in review.
    // Forking needs the built worker, so a caller that omits this in a context
    // without dist/ fails loudly on the first non-empty script rather than
    // quietly running it here.
    const scriptRunner = options?.scriptRunner ?? forkingScriptRunner;

    let vars = new Map<string, string>();
    if (options?.environment) {
      const envRoot = options.collectionRoot ?? collectionPath;
      vars = await loadEnvironment(envRoot, options.environment);
    }
    // Overrides the environment file, and works with no environment at all —
    // the point, since a secret has no correct on-disk home to load from.
    vars = applyVariableOverrides(vars, options?.variables);

    // On unless refused, as upstream's `--disable-cookies` is off unless given.
    const cookiesEnabled = options?.cookieJar !== false;

    // One loader for the run: its cache is read-only, so unlike the cookie jar
    // it is safe to share across parallel folders.
    const rootLoader: RootLoader = createRootLoader(options?.collectionRoot ?? collectionPath);

    const { requests, parseFailures, warnings: discoveryWarnings } =
      await resolveRunTargets(options?.requestPath, collectionPath);

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
          //, so this isolation can no longer let an unsubstituted
          // placeholder reach the wire silently the way serial mode would not.
          const folderStore = new VariableStore();
          // The cookie jar is scoped per folder for the same reason: two
          // folders running concurrently must not share mutable session state.
          const folderJar = cookiesEnabled ? createRunCookieJar() : undefined;
          const folderRes: RequestExecutionResult[] = [];
          for (const req of folderRequests) {
            const result = await executeSingleRequest(req.yaml, vars, scriptRunner, folderStore, bodyCapture, collectionPath, folderJar, await rootLoader.forRequest(req.filePath));
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
      const runJar = cookiesEnabled ? createRunCookieJar() : undefined;
      results = [];
      for (const req of requests) {
        const result = await executeSingleRequest(req.yaml, vars, scriptRunner, variableStore, bodyCapture, collectionPath, runJar, await rootLoader.forRequest(req.filePath));
        results.push(result);
      }
    }

    const totalDuration = Date.now() - startTime;

    return {
      summary: summarise(results, totalDuration),
      results,
      // Derived, not tallied in parallel with the list: the count and the
      // detail cannot drift apart if only one of them is maintained.
      parseErrors: parseFailures.length,
      parseFailures,
      ...(discoveryWarnings.length > 0 ? { warnings: discoveryWarnings } : {}),
    };
  }
}

/**
 * Reduce per-request results to the run summary.
 *
 * Both the request-level and the test-level counts are tallied from the results
 * themselves. `passed` in particular is COUNTED, not derived as
 * `total - failed`: that subtraction made a run in which nothing was ever
 * evaluated arithmetically identical to a run in which everything passed, so a
 * dropped script or an inert feature left the summary green. `tests.total` and
 * `requestsWithoutTests` are what tell those two runs apart.
 */
function summarise(
  results: RequestExecutionResult[],
  durationMs: number,
): CollectionRunSummary {
  let passed = 0;
  let failed = 0;
  const tests = { total: 0, passed: 0, failed: 0 };
  let requestsWithoutTests = 0;

  for (const r of results) {
    let requestFailed = r.error !== undefined;
    for (const t of r.tests) {
      tests.total++;
      if (t.status === 'fail') {
        tests.failed++;
        requestFailed = true;
      } else {
        tests.passed++;
      }
    }
    if (r.tests.length === 0) requestsWithoutTests++;
    if (requestFailed) failed++;
    else passed++;
  }

  return {
    total: results.length,
    passed,
    failed,
    duration_ms: durationMs,
    tests,
    requestsWithoutTests,
  };
}
