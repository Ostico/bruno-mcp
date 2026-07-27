import { TestRunner } from '../../../src/bruno/test-runner';

/**
 * Sandbox escape regression tests.
 *
 * bru.setVar/getVar used to be host-realm closures placed directly on the
 * sandbox. A host-realm function carries host intrinsics on its prototype
 * chain, and codeGeneration.strings:false only restricts the *context* realm,
 * so a sandboxed script could reach the host Function constructor through the
 * closure and run arbitrary host code:
 *
 *   bru.setVar.constructor("return globalThis")().process.env
 *
 * That handed the script the server's real globalThis and let it read
 * process.env. bru is now defined inside the context, so its .constructor is
 * the context's own (blocked) Function. These tests drive the real
 * TestRunner.runScript / runPreRequestScript and assert the hole stays shut.
 */

const res200 = {
  status: 200,
  statusText: 'OK',
  headers: {},
  body: null,
  responseTime: 10,
};

// A sentinel only present on the host process object. If any of these scripts
// managed to reach the host realm it would show up in the extracted variables.
const SECRET = 'sandbox-escape-canary';

describe('TestRunner sandbox escape prevention', () => {
  beforeAll(() => {
    process.env.BRUNO_MCP_ESCAPE_CANARY = SECRET;
  });
  afterAll(() => {
    delete process.env.BRUNO_MCP_ESCAPE_CANARY;
  });

  it('should not expose the host process object to sandboxed scripts', async () => {
    const { variables } = await TestRunner.runScript(
      `bru.setVar("proc", typeof globalThis.process);
       bru.setVar("proc2", typeof process);`,
      res200,
    );

    expect(variables.proc).toBe('undefined');
    expect(variables.proc2).toBe('undefined');
  });

  it('should block reaching the host realm via a bru closure constructor', async () => {
    const result = await TestRunner.runScript(
      `bru.setVar("leak", bru.setVar.constructor("return globalThis")());`,
      res200,
    );

    // The context-realm Function constructor is governed by strings:false, so
    // the call throws inside the sandbox and the script fails outright.
    expect(result.results[0].status).toBe('fail');
    expect(result.results[0].error).toMatch(/code generation from strings/i);
    expect(result.variables.leak).toBeUndefined();
  });

  it('should not let a sandboxed script read process.env', async () => {
    const result = await TestRunner.runScript(
      `bru.setVar("secret", bru.getVar.constructor("return process.env.BRUNO_MCP_ESCAPE_CANARY")());`,
      res200,
    );

    // Security property first: the canary must never reach the extracted vars.
    expect(JSON.stringify(result.variables)).not.toContain(SECRET);
    expect(result.results[0].status).toBe('fail');
  });

  it('should block the same escape in the pre-request sandbox', async () => {
    const result = await TestRunner.runPreRequestScript(
      `bru.setVar("leak", bru.setVar.constructor("return process.env.BRUNO_MCP_ESCAPE_CANARY")());`,
      { url: 'https://api.example.com', method: 'GET', headers: {}, body: null },
    );

    expect(JSON.stringify(result.variables)).not.toContain(SECRET);
    expect(result.error).toMatch(/code generation from strings/i);
  });

  it('should still round-trip variables through the in-context bru store', async () => {
    const { variables } = await TestRunner.runScript(
      `bru.setVar("token", "abc");
       bru.setVar("echo", bru.getVar("token"));
       bru.setVar("num", 42);`,
      res200,
    );

    expect(variables).toEqual({ token: 'abc', echo: 'abc', num: 42 });
  });

  describe('a sabotaged variable store degrades to empty', () => {
    // Every one of these is reachable: __bruDump is a plain global a script can
    // overwrite. None may throw out of runScript or return a non-plain object.
    it.each([
      ['a dump that throws', 'function() { throw new Error("sabotage"); }'],
      ['a dump returning a non-string', 'function() { return 42; }'],
      ['a dump returning invalid JSON', 'function() { return "not json"; }'],
      ['a dump returning a JSON array', 'function() { return "[1,2,3]"; }'],
      ['a dump returning JSON null', 'function() { return "null"; }'],
      ['a non-function dump', '"clobbered"'],
    ])('should return {} for %s', async (_label, expr) => {
      const result = await TestRunner.runScript(`__bruDump = ${expr};`, res200);

      expect(result.variables).toEqual({});
      expect(result.results).toEqual([]);
    });
  });

  // The timeout is the only thing bounding a hostile script. Any work the host
  // performs on a script-controlled value AFTER runInContext returns escapes
  // it, because the V8 interrupt is no longer armed. These tests pin that
  // nothing a script can reach buys it unbounded host time.
  describe('no script can outlive its timeout', () => {
    const SPIN = 'var __e = Date.now() + 4000; while (Date.now() < __e) {}';
    const BUDGET = 200;

    // Generous ceiling: we are distinguishing "bounded" from "hung", not
    // measuring scheduler precision.
    const CEILING = 3000;

    it('should bound a spinning dump function', async () => {
      const started = Date.now();
      const result = await TestRunner.runScript(
        `__bruDump = function() { ${SPIN} };`,
        res200,
        { timeout: BUDGET },
      );

      expect(Date.now() - started).toBeLessThan(CEILING);
      expect(result.variables).toEqual({});
    });

    it('should bound a spinning toJSON on a stored value', async () => {
      const started = Date.now();
      await TestRunner.runScript(
        `bru.setVar("evil", { toJSON: function() { ${SPIN} } });`,
        res200,
        { timeout: BUDGET },
      );

      expect(Date.now() - started).toBeLessThan(CEILING);
    });

    it('should bound a spinning getter on a stored value', async () => {
      const started = Date.now();
      await TestRunner.runScript(
        `bru.setVar("evil", Object.defineProperty({}, "x", {
           enumerable: true,
           get: function() { ${SPIN} }
         }));`,
        res200,
        { timeout: BUDGET },
      );

      expect(Date.now() - started).toBeLessThan(CEILING);
    });

    it('should bound deferred microtask work in the pre-request sandbox', async () => {
      const started = Date.now();
      const result = await TestRunner.runPreRequestScript(
        `Promise.resolve().then(function() { ${SPIN} });`,
        { url: 'https://api.example.com', method: 'GET', headers: {}, body: null },
        { timeout: BUDGET },
      );

      expect(Date.now() - started).toBeLessThan(CEILING);
      expect(result.error).toContain('timed out');
    });
  });

  describe('hostile thrown values cannot break the error handler', () => {
    // Reporting an error must not hand control back to the script. A thrown
    // object whose toString or constructor getter throws would otherwise take
    // out the handler trying to describe it.
    const HOSTILE = [
      ['throwing toString', '{ toString: function() { throw new Error("ts"); } }'],
      ['throwing constructor getter', '{ get constructor() { throw new Error("ctor"); } }'],
      [
        'throwing Symbol.toPrimitive',
        '{ get [Symbol.toPrimitive]() { throw new Error("prim"); } }',
      ],
    ] as const;

    it.each(HOSTILE)('should survive a %s', async (_label, expr) => {
      const result = await TestRunner.runScript(`throw ${expr};`, res200);

      expect(result.results).toHaveLength(1);
      expect(result.results[0].status).toBe('fail');
      expect(typeof result.results[0].error).toBe('string');
    });

    it.each(HOSTILE)('should survive a %s in the pre-request sandbox', async (_label, expr) => {
      const result = await TestRunner.runPreRequestScript(
        `throw ${expr};`,
        { url: 'https://api.example.com', method: 'GET', headers: {}, body: null },
      );

      expect(typeof result.error).toBe('string');
    });
  });

  describe('injected identifiers do not collide with user declarations', () => {
    // bru is installed by assignment, so it is a configurable global property
    // that user code can shadow with a lexical declaration — as it was when bru
    // was a sandbox property. (test/expect remain var declarations and are not
    // shadowable; that predates this change and is unaltered by it.)
    it.each(['let bru = 1;', 'const bru = 1;', 'class bru {}'])(
      'should allow user script to declare: %s',
      async decl => {
        const result = await TestRunner.runScript(decl, res200);

        expect(result.results).toEqual([]);
      },
    );

    it('should allow a user script to shadow bru in the pre-request sandbox', async () => {
      const result = await TestRunner.runPreRequestScript(
        `let bru = 1;`,
        { url: 'https://api.example.com', method: 'GET', headers: {}, body: null },
      );

      expect(result.error).toBeUndefined();
    });
  });

  describe('extracted variables are inert data', () => {
    it('should drop a __proto__ key rather than return it', async () => {
      const { variables } = await TestRunner.runScript(
        `bru.setVar("__proto__", { polluted: true });
         bru.setVar("safe", 1);`,
        res200,
      );

      expect(Object.keys(variables)).toEqual(['safe']);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('should reduce values to plain JSON data with no live accessors', async () => {
      const { variables } = await TestRunner.runScript(
        `bru.setVar("fn", function() { return 1; });
         bru.setVar("obj", { nested: { n: 1 } });
         bru.setVar("str", "plain");`,
        res200,
      );

      // A function is not JSON-representable, so it does not survive at all —
      // nothing the caller does with the result can re-enter the sandbox.
      expect(variables.fn).toBeUndefined();
      expect(variables.obj).toEqual({ nested: { n: 1 } });
      expect(variables.str).toBe('plain');
    });
  });

  it('should fail the script rather than reject when the body cannot be serialised', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const result = await TestRunner.runScript(`test("t", function() {});`, {
      ...res200,
      body: circular,
    });

    expect(result.results[0].status).toBe('fail');
  });

  it('should not leak host intrinsics through an in-context Function either', async () => {
    // [].constructor.constructor is the context realm's Function; strings:false
    // must block it too, proving the fix does not depend on which object the
    // script starts from.
    const result = await TestRunner.runScript(
      `bru.setVar("leak", [].constructor.constructor("return typeof process")());`,
      res200,
    );

    expect(result.results[0].status).toBe('fail');
    expect(result.results[0].error).toMatch(/code generation from strings/i);
  });
});
