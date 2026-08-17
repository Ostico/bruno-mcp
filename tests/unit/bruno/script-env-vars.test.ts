/**
 * `bru.getEnvVar` and `bru.hasEnvVar` inside the sandbox.
 *
 * Two stores, not one store read twice. Upstream answers `getVar` from what a
 * script set and `getEnvVar` from the environment; this server widens `getVar`
 * to resolve environment and collection variables as well, so the only way
 * `getEnvVar` can keep answering the narrower question is to be seeded
 * separately. Every test here is about that separation: a runtime variable of
 * the same name must not change what `getEnvVar` returns, in either phase.
 *
 * The two phases are tested separately because they are seeded separately —
 * the pre-request prelude and the test prelude each emit their own seed call.
 */

import { TestRunner } from '../../../src/bruno/test-runner';

const request = {
  url: 'https://api.example.com/profile',
  method: 'GET',
  headers: {},
  body: null,
};

const response = {
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json' },
  body: { ok: true },
  responseTime: 7,
};

describe('bru.getEnvVar — pre-request phase', () => {
  it('reads a variable the environment supplied', async () => {
    const script = 'bru.setVar("seen", bru.getEnvVar("base_url"));';

    const outcome = await TestRunner.runPreRequestScript(script, request, {
      variables: { base_url: 'https://from-env.example.com' },
      envVariables: { base_url: 'https://from-env.example.com' },
    });

    expect(outcome.variables.seen).toBe('https://from-env.example.com');
  });

  it('is not shadowed by a runtime variable of the same name', async () => {
    const script = `
      bru.setVar("via_env", bru.getEnvVar("token"));
      bru.setVar("via_any", bru.getVar("token"));
    `;

    const outcome = await TestRunner.runPreRequestScript(script, request, {
      // What the executor hands over: the merged view, plus the environment
      // layer on its own. `token` differs between them, which is the whole
      // point — the merged view has a runtime write over the top.
      variables: { token: 'runtime-token' },
      envVariables: { token: 'env-token' },
    });

    expect(outcome.variables.via_env).toBe('env-token');
    expect(outcome.variables.via_any).toBe('runtime-token');
  });

  it('is not shadowed by a write this very script made', async () => {
    const script = `
      bru.setVar("token", "written-here");
      bru.setVar("via_env", bru.getEnvVar("token"));
      bru.setVar("via_any", bru.getVar("token"));
    `;

    const outcome = await TestRunner.runPreRequestScript(script, request, {
      variables: { token: 'env-token' },
      envVariables: { token: 'env-token' },
    });

    expect(outcome.variables.via_env).toBe('env-token');
    expect(outcome.variables.via_any).toBe('written-here');
  });

  it('returns undefined for a name only the merged view holds', async () => {
    const script = `
      bru.setVar("value_type", typeof bru.getEnvVar("captured"));
      bru.setVar("declared", bru.hasEnvVar("captured"));
    `;

    const outcome = await TestRunner.runPreRequestScript(script, request, {
      variables: { captured: 'from-a-previous-response' },
      envVariables: {},
    });

    expect(outcome.variables.value_type).toBe('undefined');
    expect(outcome.variables.declared).toBe(false);
  });

  it('distinguishes an empty environment value from an absent one', async () => {
    const script = `
      bru.setVar("blank_present", bru.hasEnvVar("blank"));
      bru.setVar("blank_value", bru.getEnvVar("blank"));
      bru.setVar("missing_present", bru.hasEnvVar("missing"));
    `;

    const outcome = await TestRunner.runPreRequestScript(script, request, {
      variables: { blank: '' },
      envVariables: { blank: '' },
    });

    // An environment that declares a name with no value is a different fact
    // from one that never declared it, and a negative control asks exactly
    // that: "was this configured at all".
    expect(outcome.variables.blank_present).toBe(true);
    expect(outcome.variables.blank_value).toBe('');
    expect(outcome.variables.missing_present).toBe(false);
  });

  it('exposes no setEnvVar — nothing here writes an environment file', async () => {
    const script = 'bru.setVar("writer", typeof bru.setEnvVar);';

    const outcome = await TestRunner.runPreRequestScript(script, request, {
      envVariables: { base_url: 'https://from-env.example.com' },
    });

    expect(outcome.variables.writer).toBe('undefined');
  });
});

describe('bru.getEnvVar — post-response and test phase', () => {
  it('reads a variable the environment supplied', async () => {
    const script = `
      test("environment reaches the test phase", function() {
        expect(bru.getEnvVar("base_url")).to.equal("https://from-env.example.com");
      });
    `;

    const outcome = await TestRunner.runScript(script, response, {
      variables: { base_url: 'https://from-env.example.com' },
      envVariables: { base_url: 'https://from-env.example.com' },
    });

    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0].status).toBe('pass');
  });

  it('is not shadowed by a runtime variable of the same name', async () => {
    const script = `
      test("getEnvVar answers from the environment", function() {
        expect(bru.getEnvVar("token")).to.equal("env-token");
      });
      test("getVar answers from the merged view", function() {
        expect(bru.getVar("token")).to.equal("runtime-token");
      });
    `;

    const outcome = await TestRunner.runScript(script, response, {
      variables: { token: 'runtime-token' },
      envVariables: { token: 'env-token' },
    });

    expect(outcome.results.map((r) => r.status)).toEqual(['pass', 'pass']);
  });

  it('distinguishes an empty environment value from an absent one', async () => {
    const script = `
      test("declared but empty", function() {
        expect(bru.hasEnvVar("blank")).to.equal(true);
        expect(bru.getEnvVar("blank")).to.equal("");
      });
      test("never declared", function() {
        expect(bru.hasEnvVar("missing")).to.equal(false);
      });
    `;

    const outcome = await TestRunner.runScript(script, response, {
      variables: { blank: '' },
      envVariables: { blank: '' },
    });

    expect(outcome.results.map((r) => r.status)).toEqual(['pass', 'pass']);
  });

  it('leaves the environment store empty when the job carries none', async () => {
    const script = `
      test("nothing configured", function() {
        expect(bru.hasEnvVar("token")).to.equal(false);
        expect(bru.getEnvVar("token")).to.equal(undefined);
      });
    `;

    const outcome = await TestRunner.runScript(script, response, {
      variables: { token: 'set-by-an-earlier-request' },
    });

    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0].status).toBe('pass');
  });
});
