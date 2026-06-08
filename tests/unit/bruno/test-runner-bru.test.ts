/**
 * Tests for TestRunner — bru object integration.
 *
 * The updated runScript() returns { results: TestResult[], variables: Record<string, unknown> }
 * instead of just TestResult[].
 *
 * A `bru` object is available in test scripts:
 *  - bru.setVar(name, value) — stores a variable
 *  - bru.getVar(name) — retrieves a stored variable
 *
 * Pattern follows tests/unit/bruno/test-runner.test.ts.
 */

import { TestRunner } from '../../../src/bruno/test-runner';

const mockResponse = {
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json' },
  body: { success: true },
  responseTime: 42,
};

describe('TestRunner — bru object integration', () => {
  describe('bru.setVar extracts variables', () => {
    it('extracts a string variable set via bru.setVar', async () => {
      const script = `
        bru.setVar("token", "abc");
        test("passes", function() { expect(1).to.equal(1); });
      `;
      const outcome = await TestRunner.runScript(script, mockResponse);

      // The updated return type is { results, variables }
      // If the implementation still returns a plain array, this will fail —
      // which is a valid signal that the documented change has not been applied.
      if (Array.isArray(outcome)) {
        fail('runScript should return { results, variables }, not a plain array');
      }

      expect(outcome.variables).toBeDefined();
      expect(outcome.variables.token).toBe('abc');
      expect(outcome.results).toHaveLength(1);
      expect(outcome.results[0].status).toBe('pass');
    });

    it('extracts a number variable set via bru.setVar', async () => {
      const script = `bru.setVar("port", 8080);`;
      const outcome = await TestRunner.runScript(script, mockResponse);

      if (Array.isArray(outcome)) {
        fail('runScript should return { results, variables }, not a plain array');
      }

      expect(outcome.variables.port).toBe(8080);
    });

    it('extracts a boolean variable set via bru.setVar', async () => {
      const script = `bru.setVar("debug", true);`;
      const outcome = await TestRunner.runScript(script, mockResponse);

      if (Array.isArray(outcome)) {
        fail('runScript should return { results, variables }, not a plain array');
      }

      expect(outcome.variables.debug).toBe(true);
    });

    it('accumulates multiple setVar calls', async () => {
      const script = `
        bru.setVar("a", "alpha");
        bru.setVar("b", "beta");
        bru.setVar("c", "gamma");
      `;
      const outcome = await TestRunner.runScript(script, mockResponse);

      if (Array.isArray(outcome)) {
        fail('runScript should return { results, variables }, not a plain array');
      }

      expect(outcome.variables).toEqual({ a: 'alpha', b: 'beta', c: 'gamma' });
    });
  });

  describe('bru.getVar retrieves previously set variables', () => {
    it('returns the value set by a prior bru.setVar in the same script', async () => {
      const script = `
        bru.setVar("token", "secret123");
        test("getVar returns set value", function() {
          expect(bru.getVar("token")).to.equal("secret123");
        });
      `;
      const outcome = await TestRunner.runScript(script, mockResponse);

      if (Array.isArray(outcome)) {
        fail('runScript should return { results, variables }, not a plain array');
      }

      expect(outcome.results).toHaveLength(1);
      expect(outcome.results[0].status).toBe('pass');
    });

    it('returns undefined for a key that was never set (no throw)', async () => {
      const script = `
        test("getVar for nonexistent key returns undefined", function() {
          var val = bru.getVar("nonexistent");
          expect(val).to.equal(undefined);
        });
      `;
      const outcome = await TestRunner.runScript(script, mockResponse);

      if (Array.isArray(outcome)) {
        fail('runScript should return { results, variables }, not a plain array');
      }

      expect(outcome.results).toHaveLength(1);
      expect(outcome.results[0].status).toBe('pass');
    });
  });

  describe('scripts without bru usage', () => {
    it('returns empty variables when script does not call bru', async () => {
      const script = `
        test("simple pass", function() { expect(1).to.equal(1); });
      `;
      const outcome = await TestRunner.runScript(script, mockResponse);

      if (Array.isArray(outcome)) {
        fail('runScript should return { results, variables }, not a plain array');
      }

      expect(outcome.variables).toEqual({});
      expect(outcome.results).toHaveLength(1);
      expect(outcome.results[0].status).toBe('pass');
    });

    it('returns empty variables for empty script', async () => {
      const outcome = await TestRunner.runScript('', mockResponse);

      if (Array.isArray(outcome)) {
        fail('runScript should return { results, variables }, not a plain array');
      }

      expect(outcome.variables).toEqual({});
      expect(outcome.results).toHaveLength(0);
    });
  });

  describe('backward compatibility of results field', () => {
    it('preserves test results alongside extracted variables', async () => {
      const script = `
        bru.setVar("token", "abc");
        test("status ok", function() { expect(res.getStatus()).to.equal(200); });
        test("has body", function() { expect(res.getBody()).to.have.property("success"); });
      `;
      const outcome = await TestRunner.runScript(script, mockResponse);

      if (Array.isArray(outcome)) {
        fail('runScript should return { results, variables }, not a plain array');
      }

      expect(outcome.results).toHaveLength(2);
      expect(outcome.results[0].description).toBe('status ok');
      expect(outcome.results[0].status).toBe('pass');
      expect(outcome.results[1].description).toBe('has body');
      expect(outcome.results[1].status).toBe('pass');
      expect(outcome.variables.token).toBe('abc');
    });
  });
});
