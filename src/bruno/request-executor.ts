import { loadEnvironment } from './env-loader.js';
import { resetUploadDirsCache } from './upload-path.js';
import { forkingScriptRunner, type ScriptRunner } from './sandbox-host.js';
import { wrapFetchResponse } from './response-wrapper.js';
import { validateUrl, ssrfRemediation } from './url-validator.js';
import { VariableStore } from './variable-store.js';
import { prepareVariables } from './variable-preparation.js';
import { collectCapturedVariables } from './captured-variables.js';
import {
  mergePreRequest,
  mergePostResponse,
  ownPreRequestScript,
  ownPostScripts,
} from './script-merge.js';
import { digestRetryHeader } from './auth-digest.js';
import { createTokenCache, resolveOAuth2, type TokenCache } from './auth-oauth2.js';
import { buildDispatcher, type DispatcherResult } from './fetch-dispatcher.js';
import { describeNetworkError } from './network-error.js';
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
import { redactUrl, stripCredentialHeaders } from './request-redaction.js';
import { encodeRequestUrl, shouldEncodeUrl, hasExplicitScheme } from './url-encoder.js';
import { scriptTimeoutMs } from './script-timeout.js';
import { buildFetchOptions } from './fetch-options.js';
import { executeGrpcRequest } from './grpc-transport.js';
import type { TransportOutcome } from './transport-verification.js';
import { executeWebsocketRequest, type WebsocketRunOptions } from './ws-transport.js';

// Re-exported from its new home so existing importers keep working. The move was
// made to free `max-lines` headroom in this file, not to change its surface.
export { buildFetchOptions } from './fetch-options.js';
import type {
  YamlRequest,
  MockRequestData,
  CollectionRunResult,
  GroupRunResult,
  CollectionRunSummary,
  RequestExecutionResult,
  TestResult,
  MockResponseData,
} from './types.js';

// The .bru -> YamlRequest translation, the credential-redaction helpers and the
// upload-path confinement moved to their own modules when this file hit the
// repo-wide max-lines ceiling. Re-exported because tests (and any future caller)
// import these names from here.
export { bruFileToYamlRequest, bruAuthToYamlAuth };
export { redactUrl, stripCredentialHeaders };
export { resetUploadDirsCache };

const DEFAULT_MAX_RESPONSE_BODY_BYTES = 10240;

interface BodyCaptureOptions {
  includeResponseBody: boolean;
  maxResponseBodyBytes: number;
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

/** What a request's post-response work produced. */
interface VerificationOutcome {
  tests: TestResult[];
  warnings?: string[];
  /** Set when declared assertions were handed over and nothing came back. */
  droppedAssertions?: string;
}

/**
 * Run a request's post-response script, its `test()` blocks and its assertions.
 *
 * Extracted so the three transports share one copy. It began as HTTP's alone, and
 * the gRPC and WebSocket paths returned before reaching it — which is why neither
 * could fail an assertion. Two copies would have drifted; the accumulated rules
 * below are exactly the kind that only get fixed once.
 */
async function runVerification(params: {
  yaml: YamlRequest;
  rootChain?: RootChain;
  scriptRunner: ScriptRunner;
  variableStore?: VariableStore;
  baseVars: Map<string, string>;
  response: MockResponseData;
}): Promise<VerificationOutcome> {
  const { yaml, rootChain, scriptRunner, variableStore, baseVars, response } = params;

  const testScript = mergePostResponse(
    rootChain?.scripts ?? [],
    ownPostScripts(yaml),
    rootChain?.scriptFlow ?? 'sandwich',
  );
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
  if (!testScript && assertions.length === 0 && postResponseVars.length === 0) {
    return { tests: [] };
  }

  const scriptResult = await scriptRunner.runScript(testScript ?? '', response, {
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
      variableStore ? variableStore.merge(baseVars) : prepareVariables(baseVars, new Map()),
    ),
    assertions,
    postResponseVars,
  });

  // An enabled assertion always yields one result. Handing the sandbox N of
  // them and getting nothing back therefore means the evaluation was lost
  // somewhere between here and the result, and the caller must not be told
  // the request was fine: with no results to fail, the request would
  // otherwise be counted as passed precisely because nothing was checked.
  const droppedAssertions = assertions.length > 0 && scriptResult.results.length === 0
    ? `${assertions.length} declared assertion(s) produced no result; `
      + 'they were not evaluated, so this request was not verified'
    : undefined;

  // Feed extracted variables into the store for cross-request propagation
  if (variableStore) {
    for (const [k, v] of Object.entries(scriptResult.variables)) {
      variableStore.set(k, v as string | number | boolean);
    }
  }

  return {
    tests: scriptResult.results,
    ...(scriptResult.warnings && scriptResult.warnings.length > 0
      ? { warnings: scriptResult.warnings }
      : {}),
    ...(droppedAssertions ? { droppedAssertions } : {}),
  };
}

/**
 * Attach a transport's verification outcome to its result.
 *
 * The transports report a session that happened; a failed assertion about it is a
 * separate fact, and `status` stays the refusal sentinel either way. `error` is
 * only taken over when the transport itself did not already fail — its own failure
 * is the earlier and more specific cause, exactly as a pre-request script error
 * outranks a dropped assertion on the HTTP path.
 */
async function verifyTransport(params: {
  outcome: TransportOutcome;
  yaml: YamlRequest;
  rootChain?: RootChain;
  scriptRunner: ScriptRunner;
  variableStore?: VariableStore;
  baseVars: Map<string, string>;
  extraWarnings: string[];
}): Promise<RequestExecutionResult> {
  const { outcome, extraWarnings, ...rest } = params;
  const { result, response } = outcome;

  // No response means the request never happened — refused, blocked, or a
  // handshake that failed. It already carries its own error, and running the
  // author's assertions against a request that was never sent would report the
  // same single failure a second time in the wrong vocabulary.
  const verification = response
    ? await runVerification({ ...rest, response })
    : { tests: [] as TestResult[] };

  const warnings = [
    ...(result.warnings ?? []),
    ...extraWarnings,
    ...(verification.warnings ?? []),
  ];

  return {
    ...result,
    tests: verification.tests,
    ...(warnings.length > 0 ? { warnings } : {}),
    // The transport's own failure is the earlier and more specific cause, so it
    // outranks a dropped assertion — the same precedence the HTTP path gives a
    // pre-request script error.
    ...(result.error ?? verification.droppedAssertions
      ? { error: result.error ?? verification.droppedAssertions }
      : {}),
  };
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
  websocketOptions?: WebsocketRunOptions,
): Promise<RequestExecutionResult> {
  // A kind with no http block cannot go down this pipeline: every step from the
  // URL onwards is HTTP-shaped. Each such kind either has a transport of its own
  // below, or is refused as a result rather than a throw — so one unsupported
  // request in a collection fails by name and the rest of the group still runs.
  // `status: 0` is this codebase's refusal sentinel.
  if (!yaml.http) {
    if (yaml.grpc) {
      // The same variable and oauth2 preparation the HTTP path does, in the same
      // order, because the transport substitutes into a target and a message the
      // same way a URL and a body are substituted into.
      const grpcVars = variableStore
        ? variableStore.merge(applyPreRequestVars(vars, yaml.vars))
        : prepareVariables(applyPreRequestVars(vars, yaml.vars), new Map());
      const grpcOauth = await resolveOAuth2(yaml, rootChain, grpcVars, tokenCache);
      const { timeoutMs, warning } = resolveTimeout(yaml.settings?.timeout);
      const outcome = await executeGrpcRequest({
        request: yaml,
        vars: grpcVars,
        collectionRoot,
        rootChain,
        timeoutMs,
        oauth2Token: grpcOauth.token,
      });
      return verifyTransport({
        outcome,
        yaml,
        rootChain,
        scriptRunner,
        variableStore,
        baseVars: grpcVars,
        // The token fetch reports its failure as one error string, the same way
        // the http path folds it into that request's warnings — a failed exchange
        // is a request sent without the credential, not a run that stops.
        extraWarnings: [
          ...(grpcOauth.error ? [grpcOauth.error] : []),
          ...(warning ? [warning] : []),
        ],
      });
    }

    if (yaml.websocket) {
      const wsVars = variableStore
        ? variableStore.merge(applyPreRequestVars(vars, yaml.vars))
        : prepareVariables(applyPreRequestVars(vars, yaml.vars), new Map());
      const wsOauth = await resolveOAuth2(yaml, rootChain, wsVars, tokenCache);
      const outcome = await executeWebsocketRequest({
        request: yaml,
        vars: wsVars,
        rootChain,
        oauth2Token: wsOauth.token,
        options: websocketOptions,
      });
      return verifyTransport({
        outcome,
        yaml,
        rootChain,
        scriptRunner,
        variableStore,
        baseVars: wsVars,
        extraWarnings: wsOauth.error ? [wsOauth.error] : [],
      });
    }

    const kind = yaml.info.type ?? 'unknown';
    return {
      name: yaml.info.name,
      method: kind.toUpperCase(),
      url: '',
      status: 0,
      duration_ms: 0,
      tests: [],
      error: `Cannot execute a "${kind}" request: this server runs http, graphql, grpc and `
        + 'websocket requests only',
    };
  }

  // `vars:pre-request` sits between the environment and the runtime store, which
  // is where upstream puts it: collection < env < folder < REQUEST < oauth2 <
  // runtime < process.env. So a request var overrides the environment, and
  // anything bru.setVar wrote still overrides the request var.
  const baseVars = applyPreRequestVars(vars, yaml.vars);

  // Merge env + request vars with runtime vars (runtime takes precedence)
  // Not baseVars as it stands when there is no store: authored values still have
  // to be expanded against each other, which is what prepareVariables does with
  // an empty runtime tier.
  const effectiveVars = variableStore
    ? variableStore.merge(baseVars)
    : prepareVariables(baseVars, new Map());

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
  //   maxRedirects -> hop cap (defaults to 5 when unset)
  //
  // The default and the clamp are Bruno's, not a choice made here: its runner
  // resolves the cap as `settings?.maxRedirects ?? 5`, replaces anything negative
  // with 5, then zeroes it when redirects are not followed, so a chain dies at the
  // same hop under `bru run` as it does here. That last rule is expressed by the
  // `followRedirects &&` guard on the loop below rather than by a value, so a
  // follow-disabled request still reports its cap honestly instead of zero.
  const followRedirects = yaml.settings?.followRedirects !== false;
  const configuredMaxRedirects = yaml.settings?.maxRedirects ?? 5;
  const maxRedirects = configuredMaxRedirects < 0 ? 5 : configuredMaxRedirects;

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

    const verification = await runVerification({
      yaml,
      rootChain,
      scriptRunner,
      variableStore,
      baseVars,
      response: wrappedResponse,
    });
    const tests = verification.tests;
    const scriptWarnings = verification.warnings;
    const droppedAssertions = verification.droppedAssertions;

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
          jar, await rootLoader.forRequest(req.filePath), tokenCache, options?.websocket,
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
    // A kind with no http block reports its kind where the method would go, and
    // no target: it never reached a URL, so claiming one would be a fiction.
    method: req.yaml.http?.method ?? (req.yaml.info.type ?? 'unknown').toUpperCase(),
    url: req.yaml.http?.url ?? '',
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
