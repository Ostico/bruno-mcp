import vm from 'node:vm';
import { TestResult, TestRunnerOptions, MockResponseData, MockRequestData, ScriptResult, PreRequestScriptResult, RequestMutations } from './types.js';

export type { TestResult, ScriptResult, PreRequestScriptResult } from './types.js';

const DEFAULT_TIMEOUT = 5000;

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
 * Minimal expect() assertion library as a pure JS string.
 * This is prepended to user scripts and runs entirely inside the VM sandbox.
 * No references to the main Node.js realm — all functions are defined as source.
 */
const SANDBOX_EXPECT_LIB = `
var expect = (function() {
  function AssertionError(message) {
    this.message = message;
    this.name = 'AssertionError';
  }
  AssertionError.prototype = Object.create(null);
  AssertionError.prototype.constructor = AssertionError;
  AssertionError.prototype.toString = function() { return 'AssertionError: ' + this.message; };

  function typeOf(val) {
    if (val === null) return 'null';
    if (Array.isArray(val)) return 'array';
    return typeof val;
  }

  function stringify(val) {
    if (val === null) return 'null';
    if (val === undefined) return 'undefined';
    if (typeof val === 'string') return '"' + val + '"';
    if (Array.isArray(val)) return 'Array(' + val.length + ')';
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  }

  function Assertion(val) {
    this._val = val;
  }

  var toProto = Object.create(null);
  var beProto = Object.create(null);
  var haveProto = Object.create(null);

  // --- .equal(expected) ---
  toProto.equal = function(expected) {
    if (this._val !== expected) {
      throw new AssertionError('expected ' + stringify(this._val) + ' to equal ' + stringify(expected));
    }
  };

  // --- .contain(item) / .include(item) ---
  function containCheck(actual, item) {
    if (Array.isArray(actual)) {
      var found = false;
      for (var i = 0; i < actual.length; i++) {
        if (actual[i] === item) { found = true; break; }
      }
      if (!found) {
        throw new AssertionError('expected ' + stringify(actual) + ' to contain ' + stringify(item));
      }
    } else if (typeof actual === 'string') {
      if (actual.indexOf(item) === -1) {
        throw new AssertionError('expected ' + stringify(actual) + ' to include ' + stringify(item));
      }
    } else {
      throw new AssertionError('expected ' + stringify(actual) + ' to be an array or string for contain/include');
    }
  }
  toProto.contain = function(item) { containCheck(this._val, item); };
  toProto.include = function(item) { containCheck(this._val, item); };

  // --- .property(name [, value]) ---
  haveProto.property = function(name, value) {
    var obj = this._val;
    if (obj === null || obj === undefined || !(name in Object(obj))) {
      throw new AssertionError('expected ' + stringify(obj) + ' to have property "' + name + '"');
    }
    if (arguments.length > 1 && obj[name] !== value) {
      throw new AssertionError(
        'expected property "' + name + '" to equal ' + stringify(value) +
        ', but got ' + stringify(obj[name])
      );
    }
  };

  // --- .lengthOf(n) ---
  haveProto.lengthOf = function(n) {
    var actual = this._val;
    var len = actual && actual.length !== undefined ? actual.length : undefined;
    if (len === undefined || len !== n) {
      throw new AssertionError(
        'expected ' + stringify(actual) + ' to have length ' + n +
        (len !== undefined ? ', but got ' + len : '')
      );
    }
  };

  // --- .a(type) / .an(type) ---
  function typeCheck(actual, expectedType) {
    var t = typeOf(actual);
    if (t !== expectedType) {
      throw new AssertionError('expected ' + stringify(actual) + ' to be a(n) ' + expectedType + ', but got ' + t);
    }
  }
  beProto.a = function(type) { typeCheck(this._val, type); };
  beProto.an = function(type) { typeCheck(this._val, type); };

  // --- .below(n) / .above(n) ---
  beProto.below = function(n) {
    if (typeof this._val !== 'number' || this._val >= n) {
      throw new AssertionError('expected ' + stringify(this._val) + ' to be below ' + n);
    }
  };
  beProto.above = function(n) {
    if (typeof this._val !== 'number' || this._val <= n) {
      throw new AssertionError('expected ' + stringify(this._val) + ' to be above ' + n);
    }
  };

  // --- property-style matchers: .true/.false/.null/.undefined/.ok/.empty ---
  // These are read as properties rather than called as methods, so they have to
  // assert from a getter. They used to be absent entirely, which meant
  // expect(false).to.be.true evaluated to undefined, threw nothing, and was
  // reported as a PASS.
  function isEmptyVal(v) {
    if (typeof v === 'string' || Array.isArray(v)) return v.length === 0;
    if (v !== null && typeof v === 'object') return Object.keys(v).length === 0;
    return false;
  }
  var propertyMatchers = {
    'true': function(v) { return v === true; },
    'false': function(v) { return v === false; },
    'null': function(v) { return v === null; },
    'undefined': function(v) { return v === undefined; },
    'ok': function(v) { return !!v; },
    'empty': isEmptyVal
  };
  function definePropertyMatchers(target, getVal, negated) {
    Object.keys(propertyMatchers).forEach(function(name) {
      Object.defineProperty(target, name, {
        enumerable: true,
        get: function() {
          var v = getVal();
          var holds = propertyMatchers[name](v);
          if (negated ? holds : !holds) {
            throw new AssertionError(
              'expected ' + stringify(v) + (negated ? ' to not be ' : ' to be ') + name
            );
          }
          return undefined;
        }
      });
    });
  }

  // Any accessor we do not implement must fail loudly. Returning undefined for an
  // unrecognised matcher is what turned an entire class of typos and unsupported
  // matchers into silent passes, so guard the chain objects rather than only adding
  // the specific names that were missing.
  function guardChain(target, label) {
    return new Proxy(target, {
      get: function(obj, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'then' || prop === 'inspect' || prop === 'constructor') return undefined;
        if (prop in obj) return obj[prop];
        throw new AssertionError(
          'unknown matcher "' + label + '.' + String(prop) + '" is not supported; ' +
          'failing instead of passing silently'
        );
      }
    });
  }

  // Wire up the chain: expect(val).to.be.X / .to.have.X / .to.X
  // Each chain accessor creates a new context sharing _val
  Object.defineProperty(Assertion.prototype, 'to', {
    get: function() {
      var self = this;
      var chain = Object.create(null);
      // direct methods on .to
      chain.equal = function(e) { toProto.equal.call(self, e); };
      chain.contain = function(i) { toProto.contain.call(self, i); };
      chain.include = function(i) { toProto.include.call(self, i); };
      // .to.be
      Object.defineProperty(chain, 'be', {
        get: function() {
          var be = Object.create(null);
          be.a = function(t) { beProto.a.call(self, t); };
          be.an = function(t) { beProto.an.call(self, t); };
          be.below = function(n) { beProto.below.call(self, n); };
          be.above = function(n) { beProto.above.call(self, n); };
          definePropertyMatchers(be, function() { return self._val; }, false);
          return guardChain(be, 'to.be');
        }
      });
      // .to.exist / .to.not.exist
      Object.defineProperty(chain, 'exist', {
        get: function() {
          if (self._val === null || self._val === undefined) {
            throw new AssertionError('expected ' + stringify(self._val) + ' to exist');
          }
          return undefined;
        }
      });
      // .to.have
      Object.defineProperty(chain, 'have', {
        get: function() {
          var have = Object.create(null);
          have.property = function(n, v) {
            if (arguments.length > 1) haveProto.property.call(self, n, v);
            else haveProto.property.call(self, n);
          };
          have.lengthOf = function(n) { haveProto.lengthOf.call(self, n); };
          return guardChain(have, 'to.have');
        }
      });
      // .to.not — negating chain
      Object.defineProperty(chain, 'not', {
        get: function() {
          var not = Object.create(null);
          // .to.not.equal(expected)
          not.equal = function(expected) {
            if (self._val === expected) {
              throw new AssertionError('expected ' + stringify(self._val) + ' to not equal ' + stringify(expected));
            }
          };
          // .to.not.include(item) / .to.not.contain(item)
          function notContainCheck(actual, item) {
            if (Array.isArray(actual)) {
              var found = false;
              for (var i = 0; i < actual.length; i++) {
                if (actual[i] === item) { found = true; break; }
              }
              if (found) {
                throw new AssertionError('expected ' + stringify(actual) + ' to not contain ' + stringify(item));
              }
            } else if (typeof actual === 'string') {
              if (actual.indexOf(item) !== -1) {
                throw new AssertionError('expected ' + stringify(actual) + ' to not include ' + stringify(item));
              }
            } else {
              throw new AssertionError('expected ' + stringify(actual) + ' to be an array or string for not.contain/include');
            }
          }
          not.include = function(item) { notContainCheck(self._val, item); };
          not.contain = function(item) { notContainCheck(self._val, item); };
          // .to.not.have
          Object.defineProperty(not, 'have', {
            get: function() {
              var notHave = Object.create(null);
              notHave.property = function(name) {
                var obj = self._val;
                if (obj !== null && obj !== undefined && name in Object(obj)) {
                  throw new AssertionError('expected ' + stringify(obj) + ' to not have property "' + name + '"');
                }
              };
              return notHave;
            }
          });
          // .to.not.be
          Object.defineProperty(not, 'be', {
            get: function() {
              var notBe = Object.create(null);
              notBe.a = function(type) {
                var t = typeOf(self._val);
                if (t === type) {
                  throw new AssertionError('expected ' + stringify(self._val) + ' to not be a(n) ' + type);
                }
              };
              notBe.an = notBe.a;
              definePropertyMatchers(notBe, function() { return self._val; }, true);
              return guardChain(notBe, 'to.not.be');
            }
          });
          // .to.not.exist
          Object.defineProperty(not, 'exist', {
            get: function() {
              if (self._val !== null && self._val !== undefined) {
                throw new AssertionError('expected ' + stringify(self._val) + ' to not exist');
              }
              return undefined;
            }
          });
          return guardChain(not, 'to.not');
        }
      });
      return guardChain(chain, 'to');
    }
  });

  return function expect(val) {
    return new Assertion(val);
  };
})();
`;

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
  });

  return `
var __results = [];
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
 * Blank out comments and string/template literals so brace-depth scanning is
 * not confused by braces or the word "expect" appearing inside them.
 * Characters are replaced with spaces to keep offsets stable.
 */
function blankCommentsAndStrings(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      out[i++] = ' ';
      out[i++] = ' ';
      while (i < n) {
        if (src[i] === '*' && src[i + 1] === '/') {
          out[i++] = ' ';
          out[i++] = ' ';
          break;
        }
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out[i++] = ' ';
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          out[i++] = ' ';
          if (i < n && src[i] !== '\n') out[i++] = ' ';
          continue;
        }
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) out[i++] = ' ';
      continue;
    }
    i++;
  }

  return out.join('');
}

/**
 * Count `expect(...)` calls that sit at brace depth 0 — i.e. outside any
 * test(description, callback) body. Only test() callbacks push into __results,
 * so a top-level assertion that passes is silently dropped from the report.
 */
function countTopLevelAssertions(script: string): number {
  const src = blankCommentsAndStrings(script);
  let depth = 0;
  let count = 0;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '{' || c === '(' || c === '[') {
      depth++;
      continue;
    }
    if (c === '}' || c === ')' || c === ']') {
      if (depth > 0) depth--;
      continue;
    }
    if (depth !== 0) continue;

    // Match the identifier `expect` followed by an opening paren
    if (c === 'e' && src.startsWith('expect', i)) {
      const before = i === 0 ? '' : src[i - 1];
      if (before !== '' && /[A-Za-z0-9_$.]/.test(before)) continue;
      let j = i + 'expect'.length;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === '(') {
        count++;
        // Step to just before the paren so it is still depth-counted below
        i = j - 1;
      }
    }
  }

  return count;
}

/**
 * Build non-fatal warnings about assertions the report cannot show.
 *
 * @param script       The user script source
 * @param resultCount  How many test() blocks registered a result
 */
export function detectUnreportedAssertions(
  script: string,
  resultCount: number,
): string[] {
  const bare = countTopLevelAssertions(script);
  if (bare === 0) return [];

  const plural = bare === 1 ? '' : 's';
  const scope =
    resultCount === 0
      ? 'This run therefore reports zero assertions even though the request itself succeeded.'
      : `Only the ${resultCount} test() block${resultCount === 1 ? '' : 's'} in this script are reported.`;

  return [
    `${bare} assertion${plural} ran outside a test() block and ${bare === 1 ? 'was' : 'were'} not recorded. ` +
      `${scope} Wrap assertions so they appear in results: ` +
      'test("descriptive name", function() { expect(res.getStatus()).to.equal(200); });',
  ];
}

/**
 * Turn the SyntaxError from JSON.parse(res.getBody()) into an actionable hint.
 *
 * res.getBody() already returns parsed JSON (see ResponseWrapper), so parsing
 * it again stringifies the object to "[object Object]" first. The raw error
 * names neither getBody nor the double parse, so the cause is not guessable
 * from the message alone.
 *
 * @param message  The thrown error's message
 */
export function detectDoubleParse(message: string): string[] {
  const doubleParsed =
    // Node 20+
    message.includes('"[object Object]" is not valid JSON') ||
    // Node 18
    message.includes('Unexpected token o in JSON at position 1');

  if (!doubleParsed) return [];

  return [
    'res.getBody() already returns parsed JSON when the response Content-Type is JSON, ' +
      'so JSON.parse(res.getBody()) parses the string "[object Object]" and throws. ' +
      'Access fields directly: res.getBody().field. If the endpoint can also return non-JSON, use: ' +
      'const b = res.getBody(); const j = typeof b === "string" ? JSON.parse(b) : b;',
  ];
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
  var store = Object.create(null);
  var api = Object.create(null);
  api.setVar = function(name, value) { store[name] = value; };
  api.getVar = function(name) { return store[name]; };
  // Plain assignment, deliberately not "var". A top-level var creates a
  // non-configurable global binding, which makes a user-level "let bru" a
  // redeclaration SyntaxError; assignment creates a configurable property that
  // user code can shadow, matching how bru behaved as a sandbox property.
  bru = api;
  __bruDump = function() { return JSON.stringify(store); };
})();
`;

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
 * Turn a thrown value into a message without letting it run code on the host.
 *
 * A sandbox script can throw an object whose toString, Symbol.toPrimitive or
 * constructor getter throws, which would otherwise take out the error handler
 * that is trying to report it. Every access is guarded.
 *
 * Note the residual limit: a *spinning* getter still runs unbounded here,
 * because by this point the value is already on the host stack and no vm
 * timeout covers it. Only in-context capture could close that, which would
 * change the reported error format; it is tracked separately.
 */
function describeSandboxError(error: unknown): { label: string; message: string } {
  let label = 'Error';
  try {
    const name = (error as Error)?.constructor?.name;
    if (typeof name === 'string' && name.length > 0) {
      label = name;
    }
  } catch {
    // keep the default label
  }

  try {
    if (error instanceof Error) {
      return { label, message: error.message };
    }
    return { label, message: String(error) };
  } catch {
    return { label, message: 'unknown sandbox error' };
  }
}

export class TestRunner {
  static async runPreRequestScript(
    script: string,
    request: MockRequestData,
    options?: TestRunnerOptions,
  ): Promise<PreRequestScriptResult> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT;

    if (!script || script.trim().length === 0) {
      return { variables: {}, mutations: {} };
    }

    // A sandbox with NO prototype chain to the main realm and NO host-realm
    // functions placed on it.
    const sandbox = Object.create(null);
    let context: vm.Context | undefined;

    try {
      // Built inside the try: JSON.stringify of a caller-supplied body can throw
      // (circular structures, BigInt), and that should surface as a failed
      // script rather than rejecting the whole call.
      const preludeScript = new vm.Script(
        SANDBOX_BRU_LIB + '\n' + buildPreRequestSandboxScript(request),
        { filename: 'bruno-sandbox-prelude.js' },
      );
      const userScript = new vm.Script(script, {
        filename: 'bruno-pre-request-script.js',
      });

      // microtaskMode 'afterEvaluate' is as load-bearing here as in runScript:
      // without it the context shares the host microtask queue, so a script
      // that defers work with Promise.resolve().then(...) runs that work after
      // runInContext returns, outside the V8 interrupt. A spin there hangs the
      // process with no timeout able to stop it.
      context = vm.createContext(sandbox, {
        codeGeneration: { strings: false, wasm: false },
        microtaskMode: 'afterEvaluate',
      });

      // The prelude runs as its own script so its declarations become globals
      // rather than sharing script scope with user code, which would make a
      // user-level "let bru" a redeclaration SyntaxError.
      const started = Date.now();
      preludeScript.runInContext(context, { timeout });
      const remaining = Math.max(1, timeout - (Date.now() - started));
      userScript.runInContext(context, { timeout: remaining });

      const mutations = vm.runInContext('__reqMutations', context, {
        timeout: Math.max(1, timeout - (Date.now() - started)),
      }) as RequestMutations;
      return {
        variables: extractBruVars(context, timeout),
        mutations: mutations || {},
      };
    } catch (error: unknown) {
      const { label, message } = describeSandboxError(error);

      const isTimeout =
        message.includes('Script execution timed out') ||
        message.includes('execution timed out');

      return {
        variables: context ? extractBruVars(context, timeout) : {},
        mutations: {},
        error: isTimeout
          ? `Script execution timed out after ${timeout}ms`
          : `${label}: ${message}`,
      };
    }
  }

  static async runScript(
    script: string,
    response: MockResponseData,
    options?: TestRunnerOptions,
  ): Promise<ScriptResult> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT;

    if (!script || script.trim().length === 0) {
      return { results: [], variables: {} };
    }

    // A sandbox with NO prototype chain to the main realm and NO host-realm
    // functions placed on it.
    const sandbox = Object.create(null);
    let context: vm.Context | undefined;

    try {
      // Built inside the try: JSON.stringify of the response body can throw on
      // a caller-supplied circular structure or BigInt, and that should surface
      // as a failed script rather than rejecting the whole call.
      //
      // The prelude is a separate script so its declarations become globals
      // instead of sharing script scope with user code, where a user-level
      // "let bru" or "let test" would be a redeclaration SyntaxError.
      const preludeScript = new vm.Script(
        SANDBOX_BRU_LIB +
          '\n' +
          SANDBOX_EXPECT_LIB +
          '\n' +
          buildSandboxSetupScript(response),
        { filename: 'bruno-sandbox-prelude.js' },
      );
      const vmScript = new vm.Script(script, {
        filename: 'bruno-test-script.js',
      });

      // Create context with code generation disabled (blocks eval/Function).
      //
      // microtaskMode 'afterEvaluate' gives the context its own microtask queue
      // and drains it before runInContext returns, which is what lets test()
      // observe an async callback at all. Draining outside runInContext would
      // instead disarm the timeout: the V8 interrupt only covers work done
      // inside the call, so a CPU spin after an await, or a self-requeueing
      // microtask loop, would hang the host forever. Both stay interruptible
      // this way, and the sandbox exposes no timers or I/O, so a promise still
      // unsettled once the queue empties can never settle.
      context = vm.createContext(sandbox, {
        codeGeneration: { strings: false, wasm: false },
        microtaskMode: 'afterEvaluate',
      });

      const started = Date.now();
      preludeScript.runInContext(context, { timeout });
      const remaining = Math.max(1, timeout - (Date.now() - started));
      vmScript.runInContext(context, { timeout: remaining });

      // Extract results from sandbox — the only thing we read back.
      // __results holds only objects this file's own test() built, so unlike
      // the variable store it carries no script-supplied accessors.
      const rawResults =
        (vm.runInContext('__results', context, {
          timeout: Math.max(1, timeout - (Date.now() - started)),
        }) as SandboxTestResult[]) || [];
      const results: TestResult[] = rawResults.map(raw =>
        raw.status === 'pending'
          ? {
              description: raw.description,
              status: 'fail',
              error:
                'async test callback never settled: it is still awaiting a promise ' +
                'that nothing in the sandbox can resolve (no timers or I/O are available)',
            }
          : (raw as TestResult),
      );
      // A double parse inside a test() block is caught by test() itself, so it
      // never reaches the outer catch — scan the recorded failures too. Only
      // failures carry an error, so filtering on it is the same as filtering
      // on status.
      const failureMessages = results
        .map(r => r.error)
        .filter(Boolean)
        .join('\n');
      const warnings = [
        ...detectUnreportedAssertions(script, results.length),
        ...detectDoubleParse(failureMessages),
      ];
      return {
        results,
        variables: extractBruVars(context, timeout),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    } catch (error: unknown) {
      const { label, message } = describeSandboxError(error);

      const isTimeout =
        message.includes('Script execution timed out') ||
        message.includes('execution timed out');

      const warnings = detectDoubleParse(message);

      return {
        results: [
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
}
