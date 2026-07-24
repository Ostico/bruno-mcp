import vm from 'node:vm';
import { TestResult, TestRunnerOptions, MockResponseData, MockRequestData, ScriptResult, PreRequestScriptResult, RequestMutations } from './types.js';

export type { TestResult, ScriptResult, PreRequestScriptResult } from './types.js';

const DEFAULT_TIMEOUT = 5000;

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
          return be;
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
          return have;
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
              return notBe;
            }
          });
          return not;
        }
      });
      return chain;
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

var test = function(description, callback) {
  try {
    callback();
    __results.push({ description: description, status: 'pass' });
  } catch (e) {
    var message = (e && e.message) ? e.message : String(e);
    __results.push({ description: description, status: 'fail', error: message });
  }
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

    const __bruVars: Record<string, unknown> = {};

    const setupScript = buildPreRequestSandboxScript(request);
    const fullScript = setupScript + '\n' + script;

    const sandbox = Object.create(null);

    sandbox.bru = Object.create(null);
    sandbox.bru.setVar = (name: string, value: unknown): void => {
      __bruVars[name] = value;
    };
    sandbox.bru.getVar = (name: string): unknown => {
      return __bruVars[name];
    };

    try {
      const vmScript = new vm.Script(fullScript, {
        filename: 'bruno-pre-request-script.js',
      });

      const context = vm.createContext(sandbox, {
        codeGeneration: { strings: false, wasm: false },
      });

      vmScript.runInContext(context, { timeout });

      const mutations = vm.runInContext('__reqMutations', context) as RequestMutations;
      return { variables: __bruVars, mutations: mutations || {} };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);

      const isTimeout =
        message.includes('Script execution timed out') ||
        message.includes('execution timed out');

      return {
        variables: __bruVars,
        mutations: {},
        error: isTimeout
          ? `Script execution timed out after ${timeout}ms`
          : `${(error as Error).constructor?.name ?? 'Error'}: ${message}`,
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

    // Host-realm variable store — bru.setVar/getVar closures write here
    const __bruVars: Record<string, unknown> = {};

    // Build the full script: expect lib + sandbox setup + user script
    const setupScript = buildSandboxSetupScript(response);
    const fullScript = SANDBOX_EXPECT_LIB + '\n' + setupScript + '\n' + script;

    // Create a sandbox with NO prototype chain to the main realm
    const sandbox = Object.create(null);

    // Inject bru object — host-realm closures, not sandbox-constructed
    sandbox.bru = Object.create(null);
    sandbox.bru.setVar = (name: string, value: unknown): void => {
      __bruVars[name] = value;
    };
    sandbox.bru.getVar = (name: string): unknown => {
      return __bruVars[name];
    };

    try {
      const vmScript = new vm.Script(fullScript, {
        filename: 'bruno-test-script.js',
      });

      // Create context with code generation disabled (blocks eval/Function)
      const context = vm.createContext(sandbox, {
        codeGeneration: { strings: false, wasm: false },
      });

      vmScript.runInContext(context, { timeout });

      // Extract results from sandbox — the only thing we read back
      const results = vm.runInContext('__results', context) as TestResult[];
      const warnings = detectUnreportedAssertions(script, results?.length ?? 0);
      return {
        results: results || [],
        variables: __bruVars,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);

      const isTimeout =
        message.includes('Script execution timed out') ||
        message.includes('execution timed out');

      return {
        results: [
          {
            description: isTimeout ? 'Script timeout' : 'Script error',
            status: 'fail',
            error: isTimeout
              ? `Script execution timed out after ${timeout}ms`
              : `${(error as Error).constructor?.name ?? 'Error'}: ${message}`,
          },
        ],
        variables: __bruVars,
      };
    }
  }
}
