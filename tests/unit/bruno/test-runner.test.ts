import { TestRunner, TestResult, ScriptResult, PreRequestScriptResult } from '../../../src/bruno/test-runner';

describe('TestRunner', () => {
  describe('runScript', () => {
    it('should execute a passing test and collect results', async () => {
      const script = `test("status ok", function() { expect(res.getStatus()).to.equal(200); });`;
      const mockResponse = { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: { success: true }, responseTime: 42 };
      const { results } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ description: 'status ok', status: 'pass' });
    });

    it('should execute a failing test and include error message', async () => {
      const script = `test("status should be 200", function() { expect(res.getStatus()).to.equal(200); });`;
      const mockResponse = { status: 500, statusText: 'Internal Server Error', headers: {}, body: null, responseTime: 100 };
      const { results } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(1);
      expect(results[0].description).toBe('status should be 200');
      expect(results[0].status).toBe('fail');
      expect(results[0].error).toContain('expected 500 to equal 200');
    });

    it('should handle multiple tests in one script', async () => {
      const script = `
        test("status ok", function() { expect(res.getStatus()).to.equal(200); });
        test("has body", function() { expect(res.getBody()).to.have.property("name"); });
        test("response time", function() { expect(res.getResponseTime()).to.be.below(1000); });
      `;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: { name: 'test' }, responseTime: 42 };
      const { results } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({ description: 'status ok', status: 'pass' });
      expect(results[1]).toEqual({ description: 'has body', status: 'pass' });
      expect(results[2]).toEqual({ description: 'response time', status: 'pass' });
    });

    it('should handle mixed pass and fail results', async () => {
      const script = `
        test("passes", function() { expect(1).to.equal(1); });
        test("fails", function() { expect(1).to.equal(2); });
      `;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(2);
      expect(results[0].status).toBe('pass');
      expect(results[1].status).toBe('fail');
    });

    it('should catch script syntax errors gracefully', async () => {
      const script = `test("bad", function() { const = })`;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(1);
      expect(results[0].description).toBe('Script error');
      expect(results[0].status).toBe('fail');
      expect(results[0].error).toContain('SyntaxError');
    });

    it('should enforce script timeout', async () => {
      const script = `test("infinite loop", function() { while(true) {} });`;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results } = await TestRunner.runScript(script, mockResponse, { timeout: 100 });
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('fail');
      expect(results[0].error!.toLowerCase()).toContain('timed out');
    }, 10000);

    it('should report an out-of-range timeout as a failing script error', async () => {
      // An out-of-range timeout makes vm.runInContext throw; the runner reports it
      // as a script error rather than crashing.
      const script = `test("noop", function() {});`;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results } = await TestRunner.runScript(script, mockResponse, { timeout: -1 });
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('fail');
      expect(results[0].error).toContain('out of range');
    });

    it('should fall back to empty results when the script nullifies __results', async () => {
      // A script can reassign the internal results accumulator to a falsy value;
      // the runner must defensively return [] rather than null.
      const script = `__results = null;`;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results } = await TestRunner.runScript(script, mockResponse);
      expect(results).toEqual([]);
    });

    it('should label a thrown value whose constructor has no name as a generic Error', async () => {
      // Top-level throw of a non-Error object whose constructor exposes no name
      // exercises the String(error) and `?? "Error"` fallback branches.
      const script = `throw { constructor: {} };`;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('fail');
      expect(results[0].description).toBe('Script error');
      expect(results[0].error).toContain('Error:');
      expect(results[0].error!.toLowerCase()).not.toContain('timed out');
    });

    it('preserves results recorded before a top-level throw', async () => {
      // A script that records real results and then throws at the top level
      // must not have those results discarded. Before this fix the outer catch
      // replaced the whole run with a single synthetic "Script error", so two
      // passing tests followed by a throw reported as if nothing had passed.
      // The report has to show the tests that genuinely ran, with the script
      // error alongside them.
      const script = `
        test("first passes", function() { expect(1).to.equal(1); });
        test("second passes", function() { expect(2).to.equal(2); });
        throw new Error("boom after the tests ran");
      `;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results } = await TestRunner.runScript(script, mockResponse);

      expect(results).toHaveLength(3);
      const first = results.find(r => r.description === 'first passes');
      const second = results.find(r => r.description === 'second passes');
      const scriptError = results.find(r => r.description === 'Script error');
      expect(first?.status).toBe('pass');
      expect(second?.status).toBe('pass');
      expect(scriptError?.status).toBe('fail');
      expect(scriptError?.error).toContain('boom after the tests ran');
    });

    it('preserves a genuine failure recorded before a top-level throw', async () => {
      // A real assertion failure recorded before the throw must survive as its
      // own failure rather than being collapsed into a generic script error —
      // otherwise the specific reason a test failed is lost.
      const script = `
        test("real failure", function() { expect(1).to.equal(2); });
        throw new Error("boom");
      `;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results } = await TestRunner.runScript(script, mockResponse);

      expect(results).toHaveLength(2);
      const realFailure = results.find(r => r.description === 'real failure');
      expect(realFailure?.status).toBe('fail');
      expect(realFailure?.error).toContain('expected');
      expect(results.some(r => r.description === 'Script error')).toBe(true);
    });

    it('recovers a pending async result before a throw as a failure', async () => {
      // An async test() that registered a pending slot and then a top-level
      // throw before it could settle must be recovered and mapped to a failure
      // (never-settled), the same as on the success path.
      const script = `
        test("never settles", async function () { await new Promise(function () {}); });
        throw new Error("boom");
      `;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results } = await TestRunner.runScript(script, mockResponse);

      const pending = results.find(r => r.description === 'never settles');
      expect(pending?.status).toBe('fail');
      expect(pending?.error).toContain('never settled');
      expect(results.some(r => r.description === 'Script error')).toBe(true);
    });

    it('collapses to a single failure when a throw follows a nullified accumulator', async () => {
      // Recovery is defensive: a script that nullifies the results accumulator
      // and then throws leaves nothing to recover, so the run reports just the
      // single script error rather than crashing while trying to read it.
      const script = `__results = null; throw new Error("boom");`;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results } = await TestRunner.runScript(script, mockResponse);

      expect(results).toHaveLength(1);
      expect(results[0].description).toBe('Script error');
      expect(results[0].error).toContain('boom');
    });

    it('should provide res.getBody() in VM context', async () => {
      const script = `test("body check", function() { var body = res.getBody(); expect(body.items).to.be.an("array"); expect(body.items).to.have.lengthOf(2); });`;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: { items: [1, 2] }, responseTime: 10 };
      const { results } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('pass');
    });

    it('should provide res.getHeaders() in VM context', async () => {
      const script = `test("header check", function() { var headers = res.getHeaders(); expect(headers["content-type"]).to.equal("application/json"); });`;
      const mockResponse = { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: null, responseTime: 10 };
      const { results } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('pass');
    });

    it('should provide res.getHeader() for individual header lookup', async () => {
      const script = `test("single header", function() { expect(res.getHeader("content-type")).to.equal("application/json"); });`;
      const mockResponse = { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' }, body: null, responseTime: 10 };
      const { results } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('pass');
    });

    it('should provide res.getStatusText() in VM context', async () => {
      const script = `test("status text", function() { expect(res.getStatusText()).to.equal("OK"); });`;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('pass');
    });

    it('should provide the session outcome of a websocket response', async () => {
      const script = `test("session", function() {
        expect(res.getStopReason()).to.equal("timeout");
        expect(res.getCloseCode()).to.equal(1008);
        expect(res.getSessionTruncated()).to.equal(true);
        expect(res.stopReason).to.equal("timeout");
        expect(res.sessionTruncated).to.equal(true);
      });`;
      const mockResponse = {
        status: 0,
        statusText: 'timeout',
        headers: {},
        body: [],
        responseTime: 10,
        session: { stopReason: 'timeout' as const, closeCode: 1008, truncated: true },
      };

      const { results } = await TestRunner.runScript(script, mockResponse);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('pass');
    });

    it('should answer the session accessors emptily on an HTTP response', async () => {
      // An exchange with no session did not stop for a reason, so 'closed' would
      // answer a question that was never asked.
      const script = `test("no session", function() {
        expect(res.getStopReason()).to.equal(null);
        expect(res.getCloseCode()).to.equal(null);
        expect(res.getSessionTruncated()).to.equal(false);
      });`;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };

      const { results } = await TestRunner.runScript(script, mockResponse);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('pass');
    });

    it('should report no close code for a session that ended without one', async () => {
      const script = `test("no close", function() {
        expect(res.getCloseCode()).to.equal(null);
        expect(res.getStopReason()).to.equal("count");
        expect(res.getSessionTruncated()).to.equal(true);
      });`;
      const mockResponse = {
        status: 0,
        statusText: 'count',
        headers: {},
        body: [],
        responseTime: 10,
        session: { stopReason: 'count' as const, truncated: true },
      };

      const { results } = await TestRunner.runScript(script, mockResponse);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('pass');
    });

    it('should provide res.getSetCookies() with each Set-Cookie value intact', async () => {
      // Headers.forEach comma-joins Set-Cookie, and a cookie value may itself
      // contain a comma, so getHeader('set-cookie') cannot be split safely.
      // to.eql is deliberately unsupported by this sandbox's expect — it fails
      // an unknown matcher rather than passing silently — so assert by length
      // and membership, which also proves the comma-bearing value survived.
      const script = `test("cookies", function() {
        expect(res.getSetCookies()).to.have.lengthOf(2);
        expect(res.getSetCookies()).to.include("sid=abc; Path=/");
        expect(res.getSetCookies()).to.include("pref=a,b; Path=/");
      });`;
      const mockResponse = {
        status: 200,
        statusText: 'OK',
        headers: {},
        body: null,
        responseTime: 10,
        setCookies: ['sid=abc; Path=/', 'pref=a,b; Path=/'],
      };

      const { results } = await TestRunner.runScript(script, mockResponse);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('pass');
    });

    it('should provide res.getSetCookies() as [] when the response set none', async () => {
      // Always an array, so a script can iterate without guarding.
      const script = `test("no cookies", function() {
        expect(res.getSetCookies()).to.be.an('array');
        expect(res.getSetCookies()).to.have.lengthOf(0);
      });`;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };

      const { results } = await TestRunner.runScript(script, mockResponse);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('pass');
    });

    it('should provide res.getResponseTime() in VM context', async () => {
      const script = `test("timing", function() { expect(res.getResponseTime()).to.be.a("number"); expect(res.getResponseTime()).to.equal(55); });`;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 55 };
      const { results } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('pass');
    });

    it('should handle runtime errors in test callbacks', async () => {
      const script = `test("runtime error", function() { var x = undefined; x.foo.bar; });`;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('fail');
      expect(results[0].error).toContain('Cannot read');
    });

    it('should handle empty script gracefully', async () => {
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results } = await TestRunner.runScript('', mockResponse);
      expect(results).toHaveLength(0);
    });

    it('should handle script with no test() calls', async () => {
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results } = await TestRunner.runScript('var x = 1 + 1;', mockResponse);
      expect(results).toHaveLength(0);
    });

    it('should use default 5s timeout when not specified', async () => {
      const script = `test("quick", function() { expect(1).to.equal(1); });`;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('pass');
    });

    it('should return empty variables when script has no bru calls', async () => {
      const script = `test("simple", function() { expect(1).to.equal(1); });`;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results, variables } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('pass');
      expect(variables).toEqual({});
    });

    it('should return empty variables for empty script', async () => {
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results, variables } = await TestRunner.runScript('', mockResponse);
      expect(results).toHaveLength(0);
      expect(variables).toEqual({});
    });
  });

  describe('bru.setVar / bru.getVar', () => {
    it('should extract variables set via bru.setVar()', async () => {
      const script = `
        bru.setVar("token", "abc123");
        test("var set", function() { expect(1).to.equal(1); });
      `;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results, variables } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('pass');
      expect(variables).toEqual({ token: 'abc123' });
    });

    it('should support bru.getVar() within the same script', async () => {
      const script = `
        bru.setVar("x", 42);
        test("getVar works", function() {
          expect(bru.getVar("x")).to.equal(42);
        });
      `;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results, variables } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('pass');
      expect(variables).toEqual({ x: 42 });
    });

    it('should handle multiple variable types (string, number, boolean)', async () => {
      const script = `
        bru.setVar("s", "str");
        bru.setVar("n", 42);
        bru.setVar("b", true);
        test("types", function() {
          expect(bru.getVar("s")).to.equal("str");
          expect(bru.getVar("n")).to.equal(42);
          expect(bru.getVar("b")).to.equal(true);
        });
      `;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results, variables } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('pass');
      expect(variables).toEqual({ s: 'str', n: 42, b: true });
    });

    it('should return undefined for unset variable', async () => {
      const script = `
        test("getVar missing", function() {
          var val = bru.getVar("nonexistent");
          expect(val).to.equal(undefined);
        });
      `;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results, variables } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('pass');
      expect(variables).toEqual({});
    });

    it('should preserve variables even when script errors after setVar', async () => {
      const script = `
        bru.setVar("before_error", "saved");
        test("will error", function() {
          var x = undefined;
          x.foo;
        });
      `;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results, variables } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('fail');
      expect(variables).toEqual({ before_error: 'saved' });
    });

    it('should overwrite variable with latest value', async () => {
      const script = `
        bru.setVar("x", "first");
        bru.setVar("x", "second");
        test("overwrite", function() {
          expect(bru.getVar("x")).to.equal("second");
        });
      `;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results, variables } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('pass');
      expect(variables).toEqual({ x: 'second' });
    });
  });

  describe('sandbox security', () => {
    it('should block prototype chain escape via this.constructor.constructor', async () => {
      const script = `
        test("escape attempt", function() {
          var p = this.constructor.constructor('return process')();
          expect(p).to.equal(undefined);
        });
      `;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(1);
      // The escape should fail: either the test passes because p is undefined,
      // or it fails with an error (no access to process). Either way, no RCE.
      // If it somehow got process, expect(process).to.equal(undefined) would fail.
      // We accept pass (p truly undefined) or fail with error not containing 'process.exit'
      if (results[0].status === 'fail') {
        // The error should be about constructor access, not about process mismatch
        expect(results[0].error).not.toContain('expected [object process]');
      }
    });

    it('should not leak process, require, or global Node.js objects', async () => {
      const script = `
        test("no process", function() {
          var hasProcess = typeof process !== 'undefined';
          expect(hasProcess).to.equal(false);
        });
        test("no require", function() {
          var hasRequire = typeof require !== 'undefined';
          expect(hasRequire).to.equal(false);
        });
        test("no global", function() {
          var hasGlobal = typeof global !== 'undefined';
          expect(hasGlobal).to.equal(false);
        });
      `;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(3);
      for (const r of results) {
        expect(r.status).toBe('pass');
      }
    });

    it('should block eval() execution (code generation from strings disabled)', async () => {
      const script = `
        test("eval blocked", function() {
          eval('1+1');
        });
      `;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results } = await TestRunner.runScript(script, mockResponse);
      // eval should throw because codeGeneration.strings is false
      expect(results.length).toBeGreaterThanOrEqual(1);
      const evalResult = results.find(r => r.description === 'eval blocked')
        || results.find(r => r.description === 'Script error');
      expect(evalResult).toBeDefined();
      expect(evalResult!.status).toBe('fail');
      expect(evalResult!.error).toBeDefined();
    });

    it('should block Function constructor (code generation from strings disabled)', async () => {
      const script = `
        test("Function blocked", function() {
          var fn = new Function('return 1');
          fn();
        });
      `;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results } = await TestRunner.runScript(script, mockResponse);
      expect(results.length).toBeGreaterThanOrEqual(1);
      const fnResult = results.find(r => r.description === 'Function blocked')
        || results.find(r => r.description === 'Script error');
      expect(fnResult).toBeDefined();
      expect(fnResult!.status).toBe('fail');
    });

    it('should support expect().to.contain() for arrays', async () => {
      const script = `
        test("array contains", function() {
          expect([1, 2, 3]).to.contain(2);
        });
        test("array not contains", function() {
          expect([1, 2, 3]).to.contain(5);
        });
      `;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(2);
      expect(results[0].status).toBe('pass');
      expect(results[1].status).toBe('fail');
    });

    it('should support expect().to.include() for strings', async () => {
      const script = `
        test("string includes", function() {
          expect("hello world").to.include("world");
        });
        test("string not includes", function() {
          expect("hello world").to.include("xyz");
        });
      `;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(2);
      expect(results[0].status).toBe('pass');
      expect(results[1].status).toBe('fail');
    });

    it('should support expect().to.be.above()', async () => {
      const script = `
        test("above pass", function() { expect(10).to.be.above(5); });
        test("above fail", function() { expect(3).to.be.above(5); });
      `;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(2);
      expect(results[0].status).toBe('pass');
      expect(results[1].status).toBe('fail');
    });

    it('should support expect().to.have.property() with value check', async () => {
      const script = `
        test("property with value", function() {
          expect({ type: "object", name: "test" }).to.have.property("type", "object");
        });
        test("property with wrong value", function() {
          expect({ type: "object" }).to.have.property("type", "array");
        });
      `;
      const mockResponse = { status: 200, statusText: 'OK', headers: {}, body: null, responseTime: 10 };
      const { results } = await TestRunner.runScript(script, mockResponse);
      expect(results).toHaveLength(2);
      expect(results[0].status).toBe('pass');
      expect(results[1].status).toBe('fail');
    });
  });

  describe('runPreRequestScript', () => {
    const mockRequest = {
      url: 'https://api.example.com/users',
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: null,
    };

    it('should return empty result for empty script', async () => {
      const result = await TestRunner.runPreRequestScript('', mockRequest);
      expect(result.variables).toEqual({});
      expect(result.mutations).toEqual({});
      expect(result.error).toBeUndefined();
    });

    it('should read request data via req.getUrl()', async () => {
      const script = `
        var url = req.getUrl();
        bru.setVar("captured_url", url);
      `;
      const result = await TestRunner.runPreRequestScript(script, mockRequest);
      expect(result.variables.captured_url).toBe('https://api.example.com/users');
    });

    it('should read request method via req.getMethod()', async () => {
      const script = `bru.setVar("m", req.getMethod());`;
      const result = await TestRunner.runPreRequestScript(script, mockRequest);
      expect(result.variables.m).toBe('GET');
    });

    it('should read headers via req.getHeaders() and req.getHeader()', async () => {
      const script = `
        bru.setVar("all_headers", JSON.stringify(req.getHeaders()));
        bru.setVar("ct", req.getHeader("Content-Type"));
        bru.setVar("missing", req.getHeader("X-Missing"));
      `;
      const result = await TestRunner.runPreRequestScript(script, mockRequest);
      expect(JSON.parse(result.variables.all_headers as string)).toEqual({ 'Content-Type': 'application/json' });
      expect(result.variables.ct).toBe('application/json');
      expect(result.variables.missing).toBeNull();
    });

    it('should read body via req.getBody()', async () => {
      const script = `bru.setVar("body", req.getBody());`;
      const result = await TestRunner.runPreRequestScript(script, mockRequest);
      expect(result.variables.body).toBeNull();
    });

    it('should capture URL mutation via req.setUrl()', async () => {
      const script = `req.setUrl("https://modified.com/api");`;
      const result = await TestRunner.runPreRequestScript(script, mockRequest);
      expect(result.mutations.url).toBe('https://modified.com/api');
    });

    it('should capture header mutations via req.setHeader()', async () => {
      const script = `
        req.setHeader("Authorization", "Bearer token123");
        req.setHeader("X-Custom", "value");
      `;
      const result = await TestRunner.runPreRequestScript(script, mockRequest);
      expect(result.mutations.headers).toEqual({
        Authorization: 'Bearer token123',
        'X-Custom': 'value',
      });
    });

    it('should capture body mutation via req.setBody()', async () => {
      const script = `req.setBody({ name: "test" });`;
      const result = await TestRunner.runPreRequestScript(script, mockRequest);
      expect(result.mutations.body).toEqual({ name: 'test' });
    });

    it('should capture combined mutations', async () => {
      const script = `
        req.setUrl("https://modified.com");
        req.setHeader("Authorization", "Bearer token123");
        req.setBody({ key: "value" });
      `;
      const result = await TestRunner.runPreRequestScript(script, mockRequest);
      expect(result.mutations).toEqual({
        url: 'https://modified.com',
        headers: { Authorization: 'Bearer token123' },
        body: { key: 'value' },
      });
    });

    it('should reflect mutations in subsequent getter calls', async () => {
      const script = `
        req.setUrl("https://new.com");
        bru.setVar("url_after", req.getUrl());
        req.setHeader("X-New", "yes");
        bru.setVar("header_after", req.getHeader("X-New"));
      `;
      const result = await TestRunner.runPreRequestScript(script, mockRequest);
      expect(result.variables.url_after).toBe('https://new.com');
      expect(result.variables.header_after).toBe('yes');
    });

    it('should support bru.setVar/getVar', async () => {
      const script = `
        bru.setVar("token", "abc123");
        bru.setVar("check", bru.getVar("token"));
      `;
      const result = await TestRunner.runPreRequestScript(script, mockRequest);
      expect(result.variables).toEqual({ token: 'abc123', check: 'abc123' });
    });

    it('should return error for script syntax errors', async () => {
      const script = `var = }`;
      const result = await TestRunner.runPreRequestScript(script, mockRequest);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('SyntaxError');
      expect(result.mutations).toEqual({});
    });

    it('should return error on timeout', async () => {
      const script = `while(true) {}`;
      const result = await TestRunner.runPreRequestScript(script, mockRequest, { timeout: 100 });
      expect(result.error).toBeDefined();
      expect(result.error!.toLowerCase()).toContain('timed out');
    }, 10000);

    it('should preserve variables set before an error', async () => {
      const script = `
        bru.setVar("before", "saved");
        var x = undefined;
        x.foo;
      `;
      const result = await TestRunner.runPreRequestScript(script, mockRequest);
      expect(result.error).toBeDefined();
      expect(result.variables.before).toBe('saved');
    });

    it('should not have test(), expect(), or res in sandbox', async () => {
      const script = `
        bru.setVar("hasTest", typeof test !== 'undefined');
        bru.setVar("hasExpect", typeof expect !== 'undefined');
        bru.setVar("hasRes", typeof res !== 'undefined');
      `;
      const result = await TestRunner.runPreRequestScript(script, mockRequest);
      expect(result.variables.hasTest).toBe(false);
      expect(result.variables.hasExpect).toBe(false);
      expect(result.variables.hasRes).toBe(false);
    });

    it('should report an out-of-range timeout as an error', async () => {
      // An out-of-range timeout makes vm.runInContext throw; the runner reports it
      // as an error rather than crashing.
      const script = `req.setHeader("X-Test", "1");`;
      const result = await TestRunner.runPreRequestScript(script, mockRequest, { timeout: -1 });
      expect(result.error).toBeDefined();
      expect(result.error).toContain('out of range');
    });

    it('should fall back to empty mutations when the script nullifies __reqMutations', async () => {
      // A script can reassign the internal mutations accumulator to a falsy value;
      // the runner must defensively fall back to {} rather than returning null.
      const script = `__reqMutations = null;`;
      const result = await TestRunner.runPreRequestScript(script, mockRequest);
      expect(result.error).toBeUndefined();
      expect(result.mutations).toEqual({});
    });

    it('should label a thrown value whose constructor has no name as a generic Error', async () => {
      // Thrown object is not an Error instance (String(error) branch) and its
      // constructor exposes no name, exercising the `?? "Error"` fallback.
      const script = `throw { constructor: {} };`;
      const result = await TestRunner.runPreRequestScript(script, mockRequest);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Error:');
      expect(result.error!.toLowerCase()).not.toContain('timed out');
    });
  });
});
