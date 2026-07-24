/**
 * Tests for the "assertion outside test()" detector.
 *
 * Only assertions inside a test(description, callback) block are pushed into
 * __results, so a *passing* bare expect() at the top level silently vanishes
 * from the report. These tests pin the warning that surfaces that case.
 */

import { TestRunner, detectUnreportedAssertions } from '../../../src/bruno/test-runner';
import type { MockResponseData } from '../../../src/bruno/types';

const response: MockResponseData = {
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json' },
  body: { ok: true },
  responseTime: 12,
};

describe('detectUnreportedAssertions', () => {
  it('returns no warning for a script with no assertions', () => {
    expect(detectUnreportedAssertions('bru.setVar("id", 1);', 0)).toEqual([]);
  });

  it('returns no warning when every assertion lives inside a test() block', () => {
    const script = `
      test("status is 200", function() {
        expect(res.getStatus()).to.equal(200);
        expect(res.getBody()).to.have.property("ok", true);
      });
    `;
    expect(detectUnreportedAssertions(script, 1)).toEqual([]);
  });

  it('warns when a single bare assertion produced no result at all', () => {
    const warnings = detectUnreportedAssertions('expect(res.getStatus()).to.equal(200);', 0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('1 assertion ran outside a test() block');
    expect(warnings[0]).toContain('was not recorded');
    expect(warnings[0]).toContain('reports zero assertions');
    expect(warnings[0]).toContain('test("descriptive name"');
  });

  it('pluralizes when several bare assertions were dropped', () => {
    const script = [
      'expect(res.getStatus()).to.equal(200);',
      'expect(res.getBody()).to.be.an("object");',
    ].join('\n');
    const warnings = detectUnreportedAssertions(script, 0);
    expect(warnings[0]).toContain('2 assertions ran outside a test() block');
    expect(warnings[0]).toContain('were not recorded');
  });

  it('reports how many test() blocks are covered when some results exist', () => {
    const script = `
      test("covered", function() { expect(1).to.equal(1); });
      expect(res.getStatus()).to.equal(200);
    `;
    const warnings = detectUnreportedAssertions(script, 1);
    expect(warnings[0]).toContain('Only the 1 test() block in this script');
  });

  it('pluralizes the covered-block count', () => {
    const script = `
      test("a", function() { expect(1).to.equal(1); });
      test("b", function() { expect(2).to.equal(2); });
      expect(res.getStatus()).to.equal(200);
    `;
    const warnings = detectUnreportedAssertions(script, 2);
    expect(warnings[0]).toContain('Only the 2 test() blocks in this script');
  });

  it('ignores assertions in a line comment', () => {
    expect(
      detectUnreportedAssertions('// expect(res.getStatus()).to.equal(200);', 0),
    ).toEqual([]);
  });

  it('ignores assertions in a block comment', () => {
    const script = '/* expect(1).to.equal(1);\n   expect(2).to.equal(2); */';
    expect(detectUnreportedAssertions(script, 0)).toEqual([]);
  });

  it('ignores an unterminated block comment', () => {
    expect(detectUnreportedAssertions('/* expect(1).to.equal(1);', 0)).toEqual([]);
  });

  it('ignores assertions inside string and template literals', () => {
    const script = [
      'bru.setVar("a", "expect(1).to.equal(1)");',
      "bru.setVar('b', 'expect(2)');",
      'bru.setVar("c", `expect(3)`);',
    ].join('\n');
    expect(detectUnreportedAssertions(script, 0)).toEqual([]);
  });

  it('handles escaped quotes inside strings without losing track', () => {
    const script = 'bru.setVar("a", "he said \\"expect(1)\\"");\nexpect(res.getStatus()).to.equal(200);';
    const warnings = detectUnreportedAssertions(script, 0);
    expect(warnings[0]).toContain('1 assertion ran outside');
  });

  it('tolerates an unterminated string literal', () => {
    expect(detectUnreportedAssertions('bru.setVar("a", "expect(1)', 0)).toEqual([]);
  });

  it('tolerates a trailing backslash at end of input', () => {
    expect(detectUnreportedAssertions('bru.setVar("a", "x\\', 0)).toEqual([]);
  });

  it('does not count identifiers that merely end in expect', () => {
    expect(detectUnreportedAssertions('myexpect(1); obj.expect(2); _expect(3);', 0)).toEqual([]);
  });

  it('counts an assertion written with whitespace before the paren', () => {
    const warnings = detectUnreportedAssertions('expect  (res.getStatus()).to.equal(200);', 0);
    expect(warnings[0]).toContain('1 assertion ran outside');
  });

  it('does not count the word expect without a call', () => {
    expect(detectUnreportedAssertions('var expect2 = 1; expect;', 0)).toEqual([]);
  });

  it('does not treat an assertion nested in a block as top level', () => {
    const script = 'if (true) { expect(res.getStatus()).to.equal(200); }';
    expect(detectUnreportedAssertions(script, 0)).toEqual([]);
  });

  it('recovers from unbalanced closing braces', () => {
    const script = '}\n]\n)\nexpect(res.getStatus()).to.equal(200);';
    const warnings = detectUnreportedAssertions(script, 0);
    expect(warnings[0]).toContain('1 assertion ran outside');
  });

  it('counts a bare assertion that starts at offset zero', () => {
    const warnings = detectUnreportedAssertions('expect(1).to.equal(1)', 0);
    expect(warnings[0]).toContain('1 assertion ran outside');
  });
});

describe('TestRunner.runScript warning propagation', () => {
  it('attaches a warning when a passing assertion sits outside test()', async () => {
    const result = await TestRunner.runScript(
      'expect(res.getStatus()).to.equal(200);',
      response,
    );
    expect(result.results).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0]).toContain('outside a test() block');
  });

  it('omits warnings when assertions are properly wrapped', async () => {
    const result = await TestRunner.runScript(
      'test("status", function() { expect(res.getStatus()).to.equal(200); });',
      response,
    );
    expect(result.results).toEqual([{ description: 'status', status: 'pass' }]);
    expect(result.warnings).toBeUndefined();
  });

  it('omits warnings for a script that only sets variables', async () => {
    const result = await TestRunner.runScript('bru.setVar("id", 7);', response);
    expect(result.warnings).toBeUndefined();
    expect(result.variables).toEqual({ id: 7 });
  });

  it('does not warn when a bare assertion throws (it is already reported)', async () => {
    const result = await TestRunner.runScript(
      'expect(res.getStatus()).to.equal(500);',
      response,
    );
    // The throw escapes the script, so the outer catch reports it as a failure
    expect(result.results[0].status).toBe('fail');
    expect(result.warnings).toBeUndefined();
  });
});
