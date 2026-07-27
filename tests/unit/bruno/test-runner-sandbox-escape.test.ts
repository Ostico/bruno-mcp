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

  it('should not crash when a script sabotages the variable store', async () => {
    // A hostile script can replace __bruVars with a throwing getter. Extraction
    // must swallow that and return an empty set rather than letting the throw
    // bubble out of runScript.
    const result = await TestRunner.runScript(
      `Object.defineProperty(this, "__bruVars", {
         get: function() { throw new Error("sabotage"); },
         configurable: true,
       });`,
      res200,
    );

    expect(result.variables).toEqual({});
    expect(result.results).toEqual([]);
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
