import vm from 'node:vm';
import { TestResult, MockResponseData, MockRequestData, ScriptResult, PreRequestScriptResult, RequestMutations, SandboxAssertion } from './types.js';
import { describeSandboxError, isTimeoutMessage } from './sandbox-errors.js';
import {
  detectDoubleParse,
  detectUnreportedAssertions,
} from './sandbox-diagnostics.js';
import {
  SANDBOX_ASSERT_LIB,
  buildAssertPlansScript,
  planAssertion,
  runAssertionsInContext,
  runPostResponseVarsInContext,
} from './sandbox-assert.js';
import { SANDBOX_EXPECT_LIB } from './sandbox-expect-lib.js';
import { SANDBOX_CLOCK_LIB, runScriptWithClock } from './sandbox-clock.js';

export type { TestResult, ScriptResult, PreRequestScriptResult } from './types.js';
// Re-exported so importers that reach for these through the sandbox keep their
// import path; the implementations live beside the sandbox rather than in it.
export { detectDoubleParse, detectUnreportedAssertions } from './sandbox-diagnostics.js';

export const DEFAULT_TIMEOUT = 5000;

/**
 * What the sandbox actually pushes into __results. Identical to TestResult
 * except that an async callback reserves its slot as 'pending' until the
 * microtask drain settles it; anything still pending when we read the array
 * back is converted to a failure before it reaches a caller.
 */
interface SandboxTestResult {
  description: string;
  status: 'pass' | 'fail' | 'pending';
  error?: string;
}


/**
 * JS source for test() function and res proxy, injected into sandbox.
 * Uses __results array to collect results, extractable after execution.
 */
function buildSandboxSetupScript(responseData: MockResponseData): string {
  // Normalize headers to lowercase for lookup
  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(responseData.headers)) {
    normalizedHeaders[key.toLowerCase()] = value;
  }

  // Serialize response data as JSON for injection into the sandbox
  const resJson = JSON.stringify({
    status: responseData.status,
    statusText: responseData.statusText,
    headers: normalizedHeaders,
    body: responseData.body,
    responseTime: responseData.responseTime,
    // Captured per response since the wrapper was written, but never carried
    // into the sandbox until res.getSetCookies() needed it. An accessor over a
    // field nobody serialised would have returned [] forever.
    setCookies: responseData.setCookies,
  });

  return `
var __results = [];

// Serialised INSIDE the context, for the same reason the variable store is:
// __results is a plain global, so sandboxed code can replace it with objects
// carrying getters. Handing those to the host means the getters run on the host
// stack after runInContext has returned — where the V8 interrupt no longer
// applies, so a spinning getter hangs the host regardless of the timeout.
// Stringifying here runs them under the timeout instead, and the host only ever
// receives inert JSON. An unserialisable accumulator degrades to [] rather than
// taking the run down.
function __resultsJson() {
  try {
    return JSON.stringify(__results);
  } catch (e) {
    return '[]';
  }
}
var __resData = JSON.parse(${JSON.stringify(resJson)});

var res = Object.create(null);
res.getStatus = function() { return __resData.status; };
res.getStatusText = function() { return __resData.statusText; };
res.getHeaders = function() { return __resData.headers; };
res.getHeader = function(name) {
  return __resData.headers[name.toLowerCase()] !== undefined
    ? __resData.headers[name.toLowerCase()]
    : null;
};
res.getBody = function() { return __resData.body; };
res.getResponseTime = function() { return __resData.responseTime; };
// Each Set-Cookie value, unparsed and unjoined. Headers.forEach comma-joins
// them into one lossy string, so res.getHeader('set-cookie') cannot be split
// safely -- a cookie value may contain a comma. Always an array, so a script
// can iterate without a guard. Not a Bruno API: it exposes what the response
// already captured, for scripts that want the raw values even though the run
// now relays cookies on its own.
res.getSetCookies = function() {
  return Array.isArray(__resData.setCookies) ? __resData.setCookies : [];
};

// Bruno's response object carries the same five values as plain properties as
// well as getters, and a declared assert block reaches for the properties:
// "res.status: eq 200", not "res.getStatus(): eq 200". Without these, every
// property-style left-hand side reads undefined and the assertion is judged
// against nothing. Scripts written against Bruno's docs (res.body.field) get
// them too.
res.status = __resData.status;
res.statusText = __resData.statusText;
res.headers = __resData.headers;
res.body = __resData.body;
res.responseTime = __resData.responseTime;

var __pending = 0;

function __errMessage(e) {
  return (e && e.message) ? e.message : String(e);
}

var test = function(description, callback) {
  var slot = __results.length;
  var returned;

  try {
    returned = callback();
  } catch (e) {
    __results.push({ description: description, status: 'fail', error: __errMessage(e) });
    return;
  }

  if (returned === null || returned === undefined || typeof returned.then !== 'function') {
    __results.push({ description: description, status: 'pass' });
    return;
  }

  // Async callback. The body runs synchronously only up to its first await, and
  // a failing assertion rejects the returned promise instead of throwing, so the
  // synchronous path above would record a pass for a test that actually failed.
  // Reserve the slot now to keep results in source order, then let the microtask
  // drain fill it in. The context is created with microtaskMode 'afterEvaluate',
  // so that drain happens inside runInContext and stays under the timeout.
  __results.push({ description: description, status: 'pending' });
  __pending++;
  returned.then(
    function() {
      __results[slot] = { description: description, status: 'pass' };
      __pending--;
    },
    function(e) {
      __results[slot] = { description: description, status: 'fail', error: __errMessage(e) };
      __pending--;
    }
  );
};
`;
}

/**
 * JS source for req proxy and __reqMutations tracker, injected into pre-request sandbox.
 * No test(), expect(), or res object — pre-request scripts only mutate the request.
 */
function buildPreRequestSandboxScript(requestData: MockRequestData): string {
  const reqJson = JSON.stringify({
    url: requestData.url,
    method: requestData.method,
    headers: requestData.headers,
    body: requestData.body,
  });

  return `
var __reqData = JSON.parse(${JSON.stringify(reqJson)});
var __reqMutations = {};

// Serialised INSIDE the context, for the same reason the results accumulator and
// the variable store are: __reqMutations is a plain global, so sandboxed code can
// replace it with an object carrying getters, or with a Proxy. Handing that to
// the host means those traps run on the host stack after runInContext has
// returned, where the V8 interrupt implementing the timeout is no longer armed,
// and a spinning getter hangs the process with no timeout able to stop it.
// Stringifying here runs them under the timeout instead, and the host receives
// only inert JSON. An unserialisable tracker degrades to no mutations rather
// than taking the run down.
function __reqMutationsJson() {
  try {
    return JSON.stringify(__reqMutations);
  } catch (e) {
    return '{}';
  }
}

var req = Object.create(null);
req.getUrl = function() { return __reqMutations.url !== undefined ? __reqMutations.url : __reqData.url; };
req.getMethod = function() { return __reqData.method; };
req.getHeaders = function() {
  var h = {};
  for (var k in __reqData.headers) { h[k] = __reqData.headers[k]; }
  if (__reqMutations.headers) {
    for (var k in __reqMutations.headers) { h[k] = __reqMutations.headers[k]; }
  }
  return h;
};
req.getHeader = function(name) {
  if (__reqMutations.headers && __reqMutations.headers[name] !== undefined) {
    return __reqMutations.headers[name];
  }
  return __reqData.headers[name] !== undefined ? __reqData.headers[name] : null;
};
req.getBody = function() { return __reqMutations.body !== undefined ? __reqMutations.body : __reqData.body; };
req.setUrl = function(url) { __reqMutations.url = url; };
req.setHeader = function(name, value) {
  if (!__reqMutations.headers) { __reqMutations.headers = {}; }
  __reqMutations.headers[name] = value;
};
req.setBody = function(body) { __reqMutations.body = body; };
`;
}

/**
 * JS source that defines the `bru` variable store INSIDE the sandbox realm.
 *
 * Security-critical. bru.setVar/getVar must NOT be host-realm closures. A
 * function created in the host realm carries host intrinsics on its prototype
 * chain, so from inside the sandbox `bru.setVar.constructor` is the host
 * Function constructor — and codeGeneration.strings:false only governs the
 * context realm, not the host one. That left a full escape:
 *
 *   bru.setVar.constructor("return globalThis")().process.env
 *
 * would hand sandboxed script the host global and read the server's
 * environment. Defining bru in-context makes its .constructor the context's
 * own Function, which strings:false does block.
 *
 * The store itself stays inside a closure so script cannot name it, and it is
 * read back as a JSON string rather than as an object: see extractBruVars for
 * why handing the host a script-controlled object is its own vulnerability.
 */
const SANDBOX_BRU_LIB = `
(function() {
  // Two stores, deliberately separate:
  //   store   - everything the script can READ via getVar: the external
  //             env/collection variables seeded by __bruSeed PLUS the script's
  //             own writes.
  //   written - only what the script itself set via setVar.
  // __bruDump returns 'written', never the seeds, so an external variable a
  // script merely read is not echoed back as if the script had produced it.
  // That keeps a seeded secret out of the propagated result set, and stops a
  // read-only script from silently re-emitting the whole environment.
  var store = Object.create(null);
  var written = Object.create(null);
  var api = Object.create(null);
  api.setVar = function(name, value) { store[name] = value; written[name] = value; };
  api.getVar = function(name) { return store[name]; };
  // Seed external variables the script may read. Populates 'store' only. Values
  // arrive as a JSON string embedded in the per-job prelude source (see
  // buildSeedVarsScript) and are parsed in-context, so no host object crosses
  // the realm boundary. __proto__ is skipped so a hostile key cannot reshape
  // the store's prototype. Malformed input is ignored rather than throwing,
  // matching how the rest of the prelude degrades.
  __bruSeed = function(json) {
    var parsed;
    try { parsed = JSON.parse(json); } catch (e) { return; }
    if (parsed === null || typeof parsed !== 'object') { return; }
    var keys = Object.keys(parsed);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] !== '__proto__') { store[keys[i]] = parsed[keys[i]]; }
    }
  };
  // Plain assignment, deliberately not "var". A top-level var creates a
  // non-configurable global binding, which makes a user-level "let bru" a
  // redeclaration SyntaxError; assignment creates a configurable property that
  // user code can shadow, matching how bru behaved as a sandbox property.
  bru = api;
  __bruDump = function() { return JSON.stringify(written); };
})();
`;

/**
 * Per-job JS source that seeds the sandbox variable store with external
 * (env/collection) variables so a script's bru.getVar can read them.
 * Emitted AFTER SANDBOX_BRU_LIB so __bruSeed is defined, and BEFORE the
 * user script so reads see the values.
 *
 * The variables cross as a JSON string literal, double-encoded: the inner
 * JSON.stringify produces the payload, the outer one turns it into a safely
 * escaped JS string literal. Even a value containing `");evil(` therefore stays
 * inside the string argument rather than becoming source. (Belt and braces: the
 * only realm it could reach is the already-locked sandbox.) Returns '' when
 * there is nothing to seed so the prelude is byte-identical to before for
 * scripts that need no variables.
 *
 * Built by the caller inside its try: JSON.stringify can throw on a BigInt or
 * circular value, which must surface as a failed script, not a rejected call.
 */
function buildSeedVarsScript(variables?: Record<string, unknown>): string {
  if (!variables) {
    return '';
  }
  const keys = Object.keys(variables);
  if (keys.length === 0) {
    return '';
  }
  return `__bruSeed(${JSON.stringify(JSON.stringify(variables))});`;
}

/**
 * Best-effort read of the sandbox variable store.
 *
 * Security-critical, and the reason this does not simply read the object out
 * and spread it: any property access the host performs on a script-controlled
 * object runs script-supplied code — getters and Proxy traps — on the HOST
 * stack, after runInContext has returned and the V8 interrupt that implements
 * the timeout is no longer armed. A one-line spinning getter would hang the
 * process forever, with no timeout able to stop it.
 *
 * So the serialisation happens in-context, under the timeout, where a hostile
 * getter is interruptible; only a JSON string crosses back. JSON.parse then
 * yields plain data with no accessors, so nothing the caller does with the
 * result can execute sandbox code either.
 *
 * Safe on every exit path: a syntax error means the prelude never ran (returns
 * {}), while a runtime error or timeout leaves the store populated with
 * whatever was set before the throw, which the "preserve variables set before
 * an error" contract requires. A script that breaks __bruDump only loses its
 * own variables.
 */
function extractBruVars(
  context: vm.Context,
  timeout: number,
): Record<string, unknown> {
  let json: unknown;
  try {
    json = vm.runInContext(
      'typeof __bruDump === "function" ? __bruDump() : null',
      context,
      { timeout },
    );
  } catch {
    return {};
  }

  if (typeof json !== 'string') {
    return {};
  }

  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    // Copy key by key, skipping __proto__ so the returned object cannot carry a
    // prototype-shaped payload into whatever the caller merges it with.
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(parsed)) {
      if (key !== '__proto__') {
        out[key] = parsed[key];
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * A url or header value as text, or undefined if it has no sensible text form.
 * Numbers and booleans are stringified the way the transport would stringify
 * them; objects and arrays are refused, since "[object Object]" on the wire is
 * never what the script meant.
 */
function asTextValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/**
 * Best-effort read of the request mutations a pre-request script recorded.
 *
 * The sibling of extractBruVars, and security-critical for the same reason:
 * __reqMutations is an ordinary sandbox global, so a script can replace it with
 * an object whose `url` is a getter, or with a Proxy. Reading the object out and
 * touching its properties on the host would run that code on the HOST stack,
 * after runInContext returned and the V8 interrupt behind the timeout was
 * disarmed — a spinning getter would then hang the process with nothing able to
 * stop it. So the serialisation happens in-context, under the timeout, and only
 * a JSON string crosses back.
 *
 * Only the three fields the caller acts on are copied across. A url or header
 * value given as a non-string primitive is stringified, which is what the
 * transport would do with it anyway; anything else is dropped, since it could
 * only reach the wire as "[object Object]". So a script that hands back a
 * hostile shape loses those mutations rather than passing something unexpected
 * to the request builder. Same on every failure path: no tracker, an
 * unserialisable tracker, or a throw all yield no mutations.
 */
function extractReqMutations(context: vm.Context, timeout: number): RequestMutations {
  try {
    const json = vm.runInContext(
      'typeof __reqMutationsJson === "function" ? __reqMutationsJson() : null',
      context,
      { timeout },
    );
    if (typeof json !== 'string') {
      return {};
    }
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const raw = parsed as Record<string, unknown>;
    const mutations: RequestMutations = {};
    const url = asTextValue(raw.url);
    if (url !== undefined) {
      mutations.url = url;
    }
    if (raw.headers !== null && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
      // Rebuilt key by key, skipping __proto__, so the header map handed onward
      // cannot carry a prototype into whatever the caller merges it with.
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw.headers as Record<string, unknown>)) {
        const text = asTextValue(value);
        if (key !== '__proto__' && text !== undefined) {
          headers[key] = text;
        }
      }
      mutations.headers = headers;
    }
    if ('body' in raw) {
      mutations.body = raw.body;
    }
    return mutations;
  } catch {
    return {};
  }
}

/**
 * A unit of sandbox work, shaped so it survives a JSON / structured-clone round
 * trip. This is what will cross the process boundary to the forked worker in the
 * child-process migration (PR-b); the shape is frozen in
 * docs/sandbox-ipc-contract.md so the parent and the worker cannot drift.
 */
export interface SandboxJob {
  kind: 'pre-request' | 'test';
  script: string;
  /** Already resolved to a concrete value — the worker applies no default. */
  timeout: number;
  /** Present when kind is 'pre-request'. */
  request?: MockRequestData;
  /** Present when kind is 'test'. */
  response?: MockResponseData;
  /**
   * External (env/collection) variables to seed into the sandbox so the
   * script's bru.getVar can read them. Plain JSON-serialisable
   * data; the worker never treats it as anything but values to read back.
   */
  variables?: Record<string, unknown>;
  /**
   * Declared assertions to evaluate, present when kind is 'test'. Already
   * filtered to the enabled ones by the caller: a disabled assertion never
   * crosses, so nothing on this side can evaluate or report one.
   */
  assertions?: readonly SandboxAssertion[];
  /**
   * `vars:post-response` entries, present when kind is 'test'. Already filtered
   * to the enabled ones by the caller.
   *
   * Each value is a JS expression evaluated before the script and the
   * assertions, and its result is written to the variable store under its name —
   * upstream's order, so both the script and the assertions can read it.
   */
  postResponseVars?: readonly SandboxAssertion[];
}

/** The worker's reply, discriminated by the same kind the job carried. */
export type SandboxJobResult =
  | { kind: 'pre-request'; result: PreRequestScriptResult }
  | { kind: 'test'; result: ScriptResult };

/**
 * Run a pre-request script in an isolated vm context and return the variable
 * writes and request mutations it produced. Pure and synchronous: all work
 * happens under the vm timeout, and nothing here reads the host realm's
 * process/env/fs. In PR-b this runs inside the forked child.
 */
export function runPreRequestJob(
  script: string,
  request: MockRequestData,
  timeout: number,
  variables?: Record<string, unknown>,
): PreRequestScriptResult {
    if (!script || script.trim().length === 0) {
      return { variables: {}, mutations: {} };
    }

    // A sandbox with NO prototype chain to the main realm and NO host-realm
    // functions placed on it.
    const sandbox = Object.create(null);
    let context: vm.Context | undefined;

    try {
      // Built inside the try: JSON.stringify of a caller-supplied body (or of
      // the seeded variables) can throw (circular structures, BigInt), and that
      // should surface as a failed script rather than rejecting the whole call.
      const preludeScript = new vm.Script(
        SANDBOX_BRU_LIB +
          '\n' +
          // After the bru lib, which it extends with bru.sleep, and before the
          // user script, which may await it.
          SANDBOX_CLOCK_LIB +
          '\n' +
          buildPreRequestSandboxScript(request) +
          '\n' +
          buildSeedVarsScript(variables),
        { filename: 'bruno-sandbox-prelude.js' },
      );

      // microtaskMode 'afterEvaluate' is as load-bearing here as in runScript:
      // without it the context shares the host microtask queue, so a script
      // that defers work with Promise.resolve().then(...) runs that work after
      // runInContext returns, outside the V8 interrupt. A spin there hangs the
      // process with no timeout able to stop it. The virtual clock in
      // SANDBOX_CLOCK_LIB is built around the same rule: it fires timers from
      // inside a runInContext call rather than from a host timer, so a sleeping
      // script stays interruptible.
      context = vm.createContext(sandbox, {
        codeGeneration: { strings: false, wasm: false },
        microtaskMode: 'afterEvaluate',
      });

      // The prelude runs as its own script so its declarations become globals
      // rather than sharing script scope with user code, which would make a
      // user-level "let bru" a redeclaration SyntaxError.
      const started = Date.now();
      preludeScript.runInContext(context, { timeout });
      runScriptWithClock(
        context,
        script,
        'bruno-pre-request-script.js',
        started + timeout,
      );

      return {
        variables: extractBruVars(context, timeout),
        mutations: extractReqMutations(context, Math.max(1, timeout - (Date.now() - started))),
      };
    } catch (error: unknown) {
      const { label, message } = describeSandboxError(error);

      const isTimeout = isTimeoutMessage(message);

      return {
        variables: context ? extractBruVars(context, timeout) : {},
        mutations: {},
        error: isTimeout
          ? `Script execution timed out after ${timeout}ms`
          : `${label}: ${message}`,
      };
    }
  }

/**
 * Error recorded for an async test() callback that registered a pending slot
 * but never settled. Shared verbatim between the success path and the recovery
 * path so the two cannot drift.
 */
const PENDING_NEVER_SETTLED =
  'async test callback never settled: it is still awaiting a promise ' +
  'that nothing in the sandbox can resolve (bru.sleep and setTimeout can ' +
  'resolve one; network and file I/O are not available)';

/**
 * Read back the results the sandbox recorded, mapping any test() callback that
 * registered a pending slot but never settled to a failure.
 *
 * Called from the catch path to preserve results already recorded before a
 * top-level throw: the outer catch used to return a single synthetic failure,
 * discarding every test() result the script had produced before it threw. The
 * success path reads __results with the same shape inline; the two share
 * PENDING_NEVER_SETTLED so the never-settled mapping cannot drift.
 *
 * Its reach narrowed when the post-response script gained its own error
 * boundary: a script that throws is now recorded inline and never reaches the
 * outer catch, so what is left here is a throw from the prelude (where
 * __results does not exist yet, and this yields []) and a rethrown timeout
 * (which the caller deliberately does not recover from). Kept because the read
 * must stay defensive either way, and because it is the only path that can
 * still salvage results if anything else between the prelude and the readback
 * ever throws.
 *
 * The read is defensive: if the context never got far enough to define
 * __results (a compile error, or a throw inside the prelude), or the script
 * corrupted the accumulator, it yields [].
 *
 * Read as JSON serialised in-context, exactly like the variable store, and for
 * the same reason: __results is a plain global that sandboxed code can replace,
 * so it can absolutely carry script-supplied accessors. Reading the array itself
 * would run those getters on the host stack with the timeout already disarmed.
 */
function readRecordedResults(context: vm.Context, budget: number): TestResult[] {
  try {
    const rawResults = (JSON.parse(
      vm.runInContext('__resultsJson()', context, {
        timeout: Math.max(1, budget),
      }) as string,
    ) as SandboxTestResult[]) || [];
    return rawResults.map(raw =>
      raw.status === 'pending'
        ? {
            description: raw.description,
            status: 'fail',
            error: PENDING_NEVER_SETTLED,
          }
        : (raw as TestResult),
    );
  } catch {
    return [];
  }
}

/**
 * Run a test script in an isolated vm context and return its recorded results,
 * variable writes and non-fatal warnings. Same isolation guarantees as
 * runPreRequestJob. In PR-b this runs inside the forked child.
 */
export function runTestJob(
  script: string,
  response: MockResponseData,
  timeout: number,
  variables?: Record<string, unknown>,
  assertions?: readonly SandboxAssertion[],
  postResponseVars?: readonly SandboxAssertion[],
): ScriptResult {
    // Variables are passed in so an operand's {{var}} resolves the way Bruno's
    // assert runtime resolves it, against the same merged map the URL uses.
    const plans = (assertions ?? []).map(assertion =>
      planAssertion(assertion, variables),
    );
    const varPlans = postResponseVars ?? [];
    const hasScript = Boolean(script) && script.trim().length > 0;
    // Declared assertions and post-response vars are each work of their own: a
    // request with either and no script must still reach the sandbox, or they are
    // never evaluated and the run reports zero assertions while looking green.
    if (!hasScript && plans.length === 0 && varPlans.length === 0) {
      return { results: [], variables: {} };
    }

    // A sandbox with NO prototype chain to the main realm and NO host-realm
    // functions placed on it.
    const sandbox = Object.create(null);
    let context: vm.Context | undefined;

    try {
      // Built inside the try: JSON.stringify of the response body (or of the
      // seeded variables) can throw on a caller-supplied circular structure or
      // BigInt, and that should surface as a failed script rather than
      // rejecting the whole call.
      //
      // The prelude is a separate script so its declarations become globals
      // instead of sharing script scope with user code, where a user-level
      // "let bru" or "let test" would be a redeclaration SyntaxError.
      const preludeScript = new vm.Script(
        SANDBOX_BRU_LIB +
          '\n' +
          SANDBOX_CLOCK_LIB +
          '\n' +
          SANDBOX_EXPECT_LIB +
          '\n' +
          buildSandboxSetupScript(response) +
          '\n' +
          buildSeedVarsScript(variables) +
          '\n' +
          SANDBOX_ASSERT_LIB +
          '\n' +
          buildAssertPlansScript(plans),
        { filename: 'bruno-sandbox-prelude.js' },
      );

      // Create context with code generation disabled (blocks eval/Function).
      //
      // microtaskMode 'afterEvaluate' gives the context its own microtask queue
      // and drains it before runInContext returns, which is what lets test()
      // observe an async callback at all. Draining outside runInContext would
      // instead disarm the timeout: the V8 interrupt only covers work done
      // inside the call, so a CPU spin after an await, or a self-requeueing
      // microtask loop, would hang the host forever. Both stay interruptible
      // this way. The sandbox's only timers are the virtual ones in
      // SANDBOX_CLOCK_LIB, which fire from inside a runInContext call for the
      // same reason, so a promise still unsettled once the queue empties and
      // the clock has nothing scheduled can never settle.
      context = vm.createContext(sandbox, {
        codeGeneration: { strings: false, wasm: false },
        microtaskMode: 'afterEvaluate',
      });

      const started = Date.now();
      preludeScript.runInContext(context, { timeout });
      const budget = (): number => Math.max(1, timeout - (Date.now() - started));

      // Script first, then assertions — Bruno's order (bruno-cli's
      // run-single-request finishes the post-response script before it calls
      // runAssertions). It matters observably: an assertion on a variable the
      // script sets, `bru.getVar("token"): isDefined`, passes in Bruno and would
      // fail here if the assertions ran first.
      //
      // The script gets its own try so the order costs nothing in isolation: a
      // script that does not even parse throws at compile time, and letting that
      // reach the outer catch would discard every declared assertion the request
      // had. Upstream behaves the same way — it records a script-error entry and
      // runs the assertions regardless.
      //
      // A timeout is the exception and is rethrown: it force-terminates the
      // context, so there is nothing left to evaluate assertions in.
      // vars:post-response first of all three. Upstream runs them at
      // run-single-request.js:775, ahead of the script (:855) and the assertions
      // (:860), so both can read what they set — which is the entire point of
      // declaring a variable rather than computing it inline.
      const varFailures = runPostResponseVarsInContext(context, varPlans, budget);

      let scriptError: { label: string; message: string } | undefined;
      if (hasScript) {
        try {
          runScriptWithClock(
            context,
            script,
            'bruno-test-script.js',
            started + timeout,
          );
        } catch (error: unknown) {
          const described = describeSandboxError(error);
          // Corroborated against the clock: a script can throw the interrupt's
          // exact wording, and rethrowing on the text alone would let it discard
          // the declared assertions it is supposed to run alongside.
          if (isTimeoutMessage(described.message) && budget() <= 1) {
            throw error;
          }
          scriptError = described;
        }
      }

      runAssertionsInContext(context, plans, budget);

      // Extract results from sandbox — the only thing we read back. Serialised
      // in-context like the variable store: __results is a writable global, so
      // sandboxed code can leave getters on it, and reading the array directly
      // would run them host-side once the timeout no longer applies.
      const rawResults = (JSON.parse(
        vm.runInContext('__resultsJson()', context, {
          timeout: budget(),
        }) as string,
      ) as SandboxTestResult[]) || [];
      const results: TestResult[] = rawResults.map(raw =>
        raw.status === 'pending'
          ? {
              description: raw.description,
              status: 'fail',
              error: PENDING_NEVER_SETTLED,
            }
          : (raw as TestResult),
      );
      // A script that threw still reports, after whatever it and the assertions
      // recorded. Same entry the outer catch would have produced — the only
      // difference is that getting here means the assertions ran too.
      if (scriptError) {
        results.push({
          description: 'Script error',
          status: 'fail',
          error: `${scriptError.label}: ${scriptError.message}`,
        });
      }
      // A double parse inside a test() block is caught by test() itself, so it
      // never reaches the outer catch — scan the recorded failures too. Only
      // failures carry an error, so filtering on it is the same as filtering
      // on status.
      const failureMessages = results
        .map(r => r.error)
        .filter(Boolean)
        .join('\n');
      // The warning is about the SCRIPT's own test() blocks, so the declared
      // assertions are subtracted back out — one entry each — or the author is
      // told their script reported more blocks than it wrote. Clamped at zero:
      // __results is a writable global, so a script that reassigns it can leave
      // fewer entries than there were plans, and a negative count would reach
      // the warning text as "Only the -1 test() blocks ... are reported".
      const scriptResultCount = Math.max(0, results.length - plans.length);
      // Suppressed when the script threw: a bare assertion that throws IS
      // reported, as the script error above, and telling the author it "ran
      // outside a test() block and was not recorded" on top of that is noise.
      // Before assertions ran after the script, a throwing script left through
      // the outer catch and never reached this scan at all.
      const warnings = [
        // A var that could not be evaluated is reported here rather than as a
        // test result: its outcome is a variable, not a check, and inventing a
        // failing assertion for it would inflate the reported test count.
        ...varFailures,
        ...(scriptError ? [] : detectUnreportedAssertions(script, scriptResultCount)),
        ...detectDoubleParse(failureMessages),
      ];
      return {
        results,
        variables: extractBruVars(context, timeout),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    } catch (error: unknown) {
      const { label, message } = describeSandboxError(error);

      const isTimeout = isTimeoutMessage(message);

      const warnings = detectDoubleParse(message);

      // A top-level throw after one or more test() blocks already recorded
      // results must not discard them. Recover whatever the sandbox managed to
      // record before the throw and report the script error alongside it,
      // rather than replacing the entire run with a single synthetic failure.
      // If the context never reached the point of defining __results (compile
      // error, throw inside the prelude) recovery yields [] and this collapses
      // to the previous single-failure shape.
      //
      // A timeout is deliberately excluded: it force-terminates the context
      // mid-execution, so any half-recorded slot (e.g. a still-pending async
      // test that was the very thing spinning) is noise, and the run's contract
      // is a single clean "Script timeout" result.
      const recovered =
        context && !isTimeout ? readRecordedResults(context, timeout) : [];

      return {
        results: [
          ...recovered,
          {
            description: isTimeout ? 'Script timeout' : 'Script error',
            status: 'fail',
            error: isTimeout
              ? `Script execution timed out after ${timeout}ms`
              : `${label}: ${message}`,
          },
        ],
        variables: context ? extractBruVars(context, timeout) : {},
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }
}

/**
 * The single entry the forked worker invokes per job (PR-b), and the seam the
 * parent's TestRunner delegates to today. Dispatches on kind so the parent and
 * the worker share exactly one code path — there is no second in-process
 * implementation to drift from the forked one.
 */
export function runJob(job: SandboxJob): SandboxJobResult {
  if (job.kind === 'pre-request') {
    return {
      kind: 'pre-request',
      result: runPreRequestJob(
        job.script,
        job.request as MockRequestData,
        job.timeout,
        job.variables,
      ),
    };
  }
  return {
    kind: 'test',
    result: runTestJob(
      job.script,
      job.response as MockResponseData,
      job.timeout,
      job.variables,
      job.assertions,
      job.postResponseVars,
    ),
  };
}

/**
 * A result of the job's own kind that carries a single failure. Used by both
 * sides of the process boundary: the worker returns it if runJob itself throws
 * (a script bug never should, but a boundary must not depend on that), and the
 * host returns it when the child dies, times out, or never replies. Keeping one
 * builder means both paths surface a failure in the exact shape a caller of the
 * in-process path already handles.
 */
export function failingResultFor(
  kind: SandboxJob['kind'],
  message: string,
): SandboxJobResult {
  if (kind === 'pre-request') {
    return {
      kind: 'pre-request',
      result: { variables: {}, mutations: {}, error: message },
    };
  }
  return {
    kind: 'test',
    result: {
      results: [{ description: 'sandbox', status: 'fail', error: message }],
      variables: {},
    },
  };
}

/** argv token the parent sets so a forked child knows to run the worker loop. */
export const WORKER_ARGV_SENTINEL = '__bruno_sandbox_worker__';

/**
 * The minimal slice of the process object the worker loop needs. Narrowed to an
 * interface so the loop is testable without forking a real child.
 */
export interface WorkerChannel {
  on(event: 'message', listener: (job: SandboxJob) => void): void;
  send?(message: unknown, callback?: (error: Error | null) => void): boolean;
  exit(code: number): never;
}

/**
 * Handle exactly one job off the IPC channel, reply, and exit — one job per
 * process, so nothing a script leaves behind (globals, pending microtasks,
 * timers) can reach the next job. runJob is trusted to turn script failures
 * into results rather than throw; the try is only for a catastrophic bug in the
 * boundary itself, which is still reported as a failing result rather than a
 * silent hang.
 */
export function runWorkerLoop(channel: WorkerChannel): void {
  channel.on('message', (job: SandboxJob) => {
    let reply: SandboxJobResult;
    try {
      reply = runJob(job);
    } catch (error) {
      reply = failingResultFor(
        job?.kind === 'pre-request' ? 'pre-request' : 'test',
        `sandbox worker crashed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (channel.send) {
      channel.send(reply, () => channel.exit(0));
    } else {
      channel.exit(0);
    }
  });
}

/**
 * Start the worker loop only when this module was forked as the sandbox child,
 * identified by the argv sentinel. Importing the module (as the parent and the
 * tests do) leaves it dormant. Returns whether the loop was started.
 */
export function maybeStartWorker(argv: string[], channel: WorkerChannel): boolean {
  if (!argv.includes(WORKER_ARGV_SENTINEL)) {
    return false;
  }
  runWorkerLoop(channel);
  return true;
}

/**
 * Adapt a Node process to the narrow WorkerChannel the loop needs. Extracted so
 * the adapter is testable without forking: its arrows would otherwise only ever
 * run inside a real child, where the parent's coverage cannot see them.
 */
export function processWorkerChannel(proc: NodeJS.Process): WorkerChannel {
  return {
    on: (event, listener) => {
      proc.on(event, listener as (...args: unknown[]) => void);
    },
    send: proc.send ? proc.send.bind(proc) : undefined,
    exit: proc.exit.bind(proc),
  };
}

maybeStartWorker(process.argv, processWorkerChannel(process));
