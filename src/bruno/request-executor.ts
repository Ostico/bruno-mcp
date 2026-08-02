import { readFile } from 'node:fs/promises';
import { basename, relative, resolve, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { loadEnvironment, substitute, findUnresolvedPlaceholders } from './env-loader.js';
import { forkingScriptRunner, type ScriptRunner } from './sandbox-host.js';
import { wrapFetchResponse } from './response-wrapper.js';
import { validateUrl, ssrfRemediation } from './url-validator.js';
import { VariableStore } from './variable-store.js';
import { collectCapturedVariables } from './captured-variables.js';
import {
  mergePreRequest,
  mergePostResponse,
  ownPreRequestScript,
  ownPostScripts,
} from './script-merge.js';
import { applyAuth } from './auth-apply.js';
import { digestRetryHeader } from './auth-digest.js';
import { createTokenCache, resolveOAuth2, type TokenCache } from './auth-oauth2.js';
import { buildDispatcher, type DispatcherResult } from './fetch-dispatcher.js';
import { describeNetworkError } from './network-error.js';
import { applyParams } from './request-params.js';
import { applyPreRequestVars } from './request-vars.js';
import { bruFileToYamlRequest, bruAuthToYamlAuth } from './bru-to-yaml.js';
import type { ExecutionOptions } from './execution-options.js';
import { type ParsedRequest } from './request-discovery.js';
import { buildRunPlan, type ResolvedGroup } from './run-plan.js';
import { createSemaphore } from './concurrency.js';
import { applyDerivedConcurrency, withReservedConcurrency } from './sandbox-host.js';
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
import { scriptTimeoutMs } from './script-timeout.js';
import {
  SINGLE_VALUE_HEADERS,
  appendHeader,
  BODY_TYPE_CONTENT_TYPES,
  setDefaultContentType,
} from './request-headers.js';
import { buildGraphqlBody, buildFormUrlEncodedBody } from './request-body.js';
import type {
  YamlRequest,
  MockRequestData,
  CollectionRunResult,
  GroupRunResult,
  CollectionRunSummary,
  RequestExecutionResult,
  TestResult,
  MultipartFormPart,
  FormUrlEncodedPart,
  BruGraphql,
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
  /** An oauth2 access token already fetched for this request, if any. */
  oauth2Token?: string,
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
  // failure mode is starkest across groups — a variable set by a script in one
  // group is invisible to every other group's requests, by design — but an
  // unresolved placeholder is a latent bug within one serial group too. Detection
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
    oauth2Token,
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
  tokenCache: TokenCache = createTokenCache(),
): Promise<RequestExecutionResult> {
  // `vars:pre-request` sits between the environment and the runtime store, which
  // is where upstream puts it: collection < env < folder < REQUEST < oauth2 <
  // runtime < process.env. So a request var overrides the environment, and
  // anything bru.setVar wrote still overrides the request var.
  const baseVars = applyPreRequestVars(vars, yaml.vars);

  // Merge env + request vars with runtime vars (runtime takes precedence)
  const effectiveVars = variableStore ? variableStore.merge(baseVars) : baseVars;

  // Before the request is built, because the token becomes one of its headers.
  // Its own fetch, not the pinned dispatcher below: the token endpoint is a
  // different host and gets its own SSRF check inside.
  const oauth = await resolveOAuth2(yaml, rootChain, effectiveVars, tokenCache);


  // eslint-disable-next-line prefer-const -- url is reassigned by pre-request script mutations below
  const built = await buildFetchOptions(yaml, effectiveVars, collectionRoot, rootChain, oauth.token);
  let url = built.url;
  let options = built.options;
  // Reassignable: a pre-request script that sets a variable triggers a
  // re-substitution below, which re-derives auth warnings and the
  // applied auth-header names from the merged vars so they stay consistent.
  let authWarnings = oauth.error ? [...(built.warnings ?? []), oauth.error] : built.warnings;
  let authHeaderNames = built.authHeaderNames ?? [];
  let authQueryNames = built.authQueryNames ?? [];
  const name = yaml.info.name;
  const method = yaml.http.method;

  // Run pre-request scripts (before fetch, may mutate url/headers/body)
  const preScript = mergePreRequest(rootChain?.scripts ?? [], ownPreRequestScript(yaml));
  let preScriptError: string | undefined;
  if (preScript) {
    const mockReqData: MockRequestData = {
      url,
      method: options.method as string,
      headers: { ...(options.headers as Record<string, string>) },
      body: options.body ?? null,
    };
    const preResult = await scriptRunner.runPreRequestScript(preScript, mockReqData, {
      timeout: scriptTimeoutMs(yaml.settings),
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

    // Digest is the one scheme whose credential cannot be computed until the
    // server refuses once: the 401 carries the nonce it must be hashed against.
    // One retry only — a second 401 is a wrong password, not a new challenge,
    // and looping on it would hammer the endpoint.
    const digestRetry = digestRetryHeader(
      yaml, rootChain, response, url, String(currentOpts.method ?? 'GET'), effectiveVars,
    );
    if (digestRetry) {
      currentOpts = {
        ...currentOpts,
        headers: { ...(currentOpts.headers as Record<string, string>), Authorization: digestRetry },
      };
      authHeaderNames = [...authHeaderNames, 'Authorization'];
      response = await fetchFn(url, currentOpts);
    }

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
    const testScript = mergePostResponse(rootChain?.scripts ?? [], ownPostScripts(yaml), rootChain?.scriptFlow ?? 'sandwich');
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
        // Same budget the pre-request script gets. Omitting it here left the
        // post-response and tests scripts pinned to the runner's internal 5000ms
        // default, so a request that raised settings.timeout still had its tests
        // aborted at five seconds — and since tests are the slot most likely to
        // wait on something, the setting looked like it did nothing at all.
        timeout: scriptTimeoutMs(yaml.settings),
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

    // On unless refused, as upstream's `--disable-cookies` is off unless given.
    const cookiesEnabled = options?.cookieJar !== false;

    const plan = await buildRunPlan(collectionPath, {
      requests: options?.requests,
      groups: options?.groups,
      parallel: options?.parallel,
      environment: options?.environment,
      variables: options?.variables,
    });

    // The same ceiling governs both resources a run can exhaust: the forked
    // script workers, which cost memory and a scheduler slot, and the in-flight
    // requests themselves. This semaphore is the run's own; the fork semaphore
    // is shared with every other run in the process, so this run's ceiling is
    // reserved there for the duration of the groups below rather than written
    // into it.
    const machineCeiling = await applyDerivedConcurrency();
    const slots = createSemaphore(options?.maxConcurrency ?? machineCeiling);

    // One loader for the run: its cache holds parsed collection and folder root
    // files, which are read-only, so sharing it across concurrent groups saves
    // the re-parse without letting anything cross between them.
    //
    // The token cache is NOT here. It is per group, below, beside the store and
    // the jar — see the comment there.
    const rootLoader: RootLoader = createRootLoader(options?.collectionRoot ?? collectionPath);

    const runOne = async (
      req: ParsedRequest,
      vars: Map<string, string>,
      store: VariableStore,
      jar: ReturnType<typeof createRunCookieJar> | undefined,
      tokenCache: TokenCache,
    ): Promise<RequestExecutionResult> => {
      const release = await slots.acquire();
      try {
        return await executeSingleRequest(
          req.yaml, vars, scriptRunner, store, bodyCapture, collectionPath,
          jar, await rootLoader.forRequest(req.filePath), tokenCache,
        );
      } finally {
        release();
      }
    };

    const runGroup = async (group: ResolvedGroup): Promise<GroupRunResult> => {
      // Membership could not be resolved at all — a named request file that is
      // there but will not parse. That is a failure preceding every request in
      // the group, which is exactly what group-level `error` means, so it takes
      // the same path as one: reported on this group, counted as one failure,
      // and costing no other group its results.
      if (group.error !== undefined) {
        throw new Error(group.error);
      }

      const groupStart = Date.now();
      // Each group owns these three. That ownership is the whole feature: it is
      // what keeps one identity's session out of another's assertions.
      //
      // The token cache is the third of them, and it did not used to be. It sat
      // beside the root loader as run-wide state, on the reasoning that a token
      // belongs to its credentials — true within one identity, and false the
      // moment two groups exist. Sharing it meant the second group was served
      // the first group's bearer token, never contacted the provider, and
      // reported success under its own name. A token is credential-shaped state
      // exactly like the store and the jar, so it gets their lifetime.
      const store = new VariableStore();
      const jar = cookiesEnabled ? createRunCookieJar() : undefined;
      const tokenCache = createTokenCache();

      let vars = new Map<string, string>();
      if (group.environment) {
        vars = await loadEnvironment(options?.collectionRoot ?? collectionPath, group.environment);
      }
      // Overrides the environment file, and works with no environment at all —
      // the point, since a secret has no correct on-disk home to load from.
      vars = applyVariableOverrides(vars, group.variables);

      // Never rejects, and that is load-bearing rather than defensive.
      //
      // `Promise.all` here used to discard every fulfilled result the moment
      // one request rejected: three requests, one throwing, and the group
      // reported zero results with a group-level error — two real outcomes
      // destroyed to report the third. The serial loop lost the results it had
      // already accumulated the same way. Since a rejection is one request's
      // failure, it is reported as one request's result, and the group keeps
      // its shape. That leaves group-level `error` for what it should mean:
      // a failure that precedes every request, like an environment that will
      // not load.
      const runOneSafely = async (req: ParsedRequest): Promise<RequestExecutionResult> => {
        try {
          return await runOne(req, vars, store, jar, tokenCache);
        } catch (reason) {
          return crashedRequestResult(req, reason);
        }
      };

      const results: RequestExecutionResult[] = [];
      if (group.parallel) {
        results.push(...(await Promise.all(group.requests.map(runOneSafely))));
      } else {
        for (const req of group.requests) {
          results.push(await runOneSafely(req));
        }
      }

      const captured = collectCapturedVariables(store.getAll(), options?.captureVariables);
      return {
        name: group.name,
        index: group.index,
        summary: summarise(results, Date.now() - groupStart),
        results,
        ...(group.missingRequests.length > 0 ? { missingRequests: group.missingRequests } : {}),
        ...(captured.names.length > 0 ? { capturedVariableNames: captured.names } : {}),
        ...(Object.keys(captured.values).length > 0 ? { capturedVariables: captured.values } : {}),
        ...(captured.warnings.length > 0 ? { warnings: captured.warnings } : {}),
      };
    };

    // A group task can genuinely reject: executeSingleRequest only wraps the
    // fetch in a try/catch, so anything that throws before it — buildDispatcher
    // on a malformed `settings.proxy`, for example — escapes as a rejection.
    // Reported as that group's `error` rather than thrown, so one bad group
    // cannot hide the results of every other one.
    const settled = await withReservedConcurrency(options?.maxConcurrency, async () =>
      options?.parallel
        ? await Promise.allSettled(plan.groups.map(runGroup))
        : await runGroupsInOrder(plan.groups, runGroup),
    );

    const groups: GroupRunResult[] = settled.map((outcome, index) =>
      outcome.status === 'fulfilled'
        ? outcome.value
        : {
            name: plan.groups[index]!.name,
            index,
            summary: summarise([], 0),
            results: [],
            ...(plan.groups[index]!.missingRequests.length > 0
              ? { missingRequests: plan.groups[index]!.missingRequests }
              : {}),
            error:
              outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
          },
    );

    const summary = summarise(groups.flatMap((g) => g.results), Date.now() - startTime);
    // A group that crashed ran no requests, so it contributes nothing to the
    // per-request tally and would leave a run with a dead group reading as
    // fully green. Counting it as one failure is what the old rethrowing
    // parallel path was for; the error itself is on the group.
    const crashed = groups.filter((g) => g.error !== undefined).length;
    summary.total += crashed;
    summary.failed += crashed;

    return {
      summary,
      groups,
      // Derived, not tallied in parallel with the list: the count and the
      // detail cannot drift apart if only one of them is maintained.
      parseErrors: plan.parseFailures.length,
      parseFailures: plan.parseFailures,
      ...(plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
    };
  }
}

/**
 * Run groups one after another, settling each so a rejection is reported in
 * place rather than abandoning the groups after it.
 *
 * `Promise.allSettled` cannot be used here: it starts everything at once, which
 * is the opposite of what a serial run asked for.
 */
async function runGroupsInOrder(
  groups: ResolvedGroup[],
  runGroup: (group: ResolvedGroup) => Promise<GroupRunResult>,
): Promise<PromiseSettledResult<GroupRunResult>[]> {
  const settled: PromiseSettledResult<GroupRunResult>[] = [];
  for (const group of groups) {
    try {
      settled.push({ status: 'fulfilled', value: await runGroup(group) });
    } catch (reason) {
      settled.push({ status: 'rejected', reason });
    }
  }
  return settled;
}

/**
 * The result for a request that threw before it could produce one.
 *
 * `executeSingleRequest` turns a network failure into a result, so getting here
 * takes a throw from the setup around it — `rootLoader.forRequest` on a folder
 * root that will not read, or `buildDispatcher` on a malformed `settings.proxy`.
 * Rare, but one request's problem either way, so it is reported as one
 * request's result. `status: 0` matches how an SSRF refusal is already
 * reported: no response was received, rather than one that came back as zero.
 */
function crashedRequestResult(req: ParsedRequest, reason: unknown): RequestExecutionResult {
  return {
    name: req.yaml.info.name,
    method: req.yaml.http.method,
    url: req.yaml.http.url,
    status: 0,
    duration_ms: 0,
    tests: [],
    error: reason instanceof Error ? reason.message : String(reason),
  };
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
