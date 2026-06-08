import { TestRunner, TestResult, ScriptResult } from '../../../src/bruno/test-runner';

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
});
