/**
 * Tests for the "JSON.parse(res.getBody())" detector.
 *
 * res.getBody() hands back an already-parsed object for JSON responses, so
 * parsing it a second time stringifies it to "[object Object]" and throws a
 * SyntaxError that names neither getBody nor the double parse. These tests pin
 * the warning that turns that dead end into an actionable hint — on both paths
 * the error can take (thrown out of the script, or caught inside a test()).
 */

import { TestRunner, detectDoubleParse } from '../../../src/bruno/test-runner';
import type { MockResponseData } from '../../../src/bruno/types';

const jsonResponse: MockResponseData = {
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json' },
  body: { access_token: 'abc123', items: [1, 2, 3] },
  responseTime: 12,
};

const textResponse: MockResponseData = {
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'text/plain' },
  body: '{"still":"a string"}',
  responseTime: 12,
};

const HINT = /res\.getBody\(\) already returns parsed JSON/;

describe('detectDoubleParse', () => {
  it('flags the Node 20+ SyntaxError message', () => {
    const warnings = detectDoubleParse('"[object Object]" is not valid JSON');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(HINT);
  });

  it('flags the Node 18 SyntaxError message', () => {
    const warnings = detectDoubleParse('Unexpected token o in JSON at position 1');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(HINT);
  });

  it('tells the caller how to read fields without parsing', () => {
    expect(detectDoubleParse('"[object Object]" is not valid JSON')[0]).toContain(
      'res.getBody().field',
    );
  });

  it('offers the defensive idiom for endpoints that may return non-JSON', () => {
    expect(detectDoubleParse('"[object Object]" is not valid JSON')[0]).toContain(
      'typeof b === "string" ? JSON.parse(b) : b',
    );
  });

  it('ignores an unrelated error message', () => {
    expect(detectDoubleParse('ReferenceError: foo is not defined')).toEqual([]);
  });

  it('ignores a genuine malformed-JSON error', () => {
    expect(detectDoubleParse('Unexpected end of JSON input')).toEqual([]);
  });

  it('ignores an empty message', () => {
    expect(detectDoubleParse('')).toEqual([]);
  });
});

describe('TestRunner.runScript double-parse warning', () => {
  it('warns when the double parse is thrown at the top level', async () => {
    const result = await TestRunner.runScript(
      'var data = JSON.parse(res.getBody());',
      jsonResponse,
    );

    expect(result.results[0].status).toBe('fail');
    expect(result.results[0].description).toBe('Script error');
    expect(result.warnings?.some(w => HINT.test(w))).toBe(true);
  });

  it('warns when the double parse is caught inside a test() block', async () => {
    const result = await TestRunner.runScript(
      `test("token is present", function() {
         var body = JSON.parse(res.getBody());
         expect(body.access_token).to.be.a("string");
       });`,
      jsonResponse,
    );

    // test() swallows the throw and records a failure, so the outer catch is
    // never reached — the warning has to come from the recorded results.
    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe('fail');
    expect(result.warnings?.some(w => HINT.test(w))).toBe(true);
  });

  it('does not warn when fields are read directly off the parsed body', async () => {
    const result = await TestRunner.runScript(
      `test("token is present", function() {
         expect(res.getBody().access_token).to.equal("abc123");
       });`,
      jsonResponse,
    );

    expect(result.results[0].status).toBe('pass');
    expect(result.warnings).toBeUndefined();
  });

  it('does not warn for the defensive typeof idiom', async () => {
    const result = await TestRunner.runScript(
      `test("items parsed", function() {
         var b = res.getBody();
         var j = (typeof b === "string") ? JSON.parse(b) : b;
         expect(j.items).to.have.lengthOf(3);
       });`,
      jsonResponse,
    );

    expect(result.results[0].status).toBe('pass');
    expect(result.warnings).toBeUndefined();
  });

  it('does not warn when a non-JSON body is legitimately parsed', async () => {
    const result = await TestRunner.runScript(
      `test("raw text parses", function() {
         expect(JSON.parse(res.getBody()).still).to.equal("a string");
       });`,
      textResponse,
    );

    expect(result.results[0].status).toBe('pass');
    expect(result.warnings).toBeUndefined();
  });

  it('does not warn for an unrelated script error', async () => {
    const result = await TestRunner.runScript('missingGlobal.doThing();', jsonResponse);

    expect(result.results[0].status).toBe('fail');
    expect(result.warnings).toBeUndefined();
  });

  it('does not warn for an unrelated assertion failure', async () => {
    const result = await TestRunner.runScript(
      `test("status is 404", function() {
         expect(res.getStatus()).to.equal(404);
       });`,
      jsonResponse,
    );

    expect(result.results[0].status).toBe('fail');
    expect(result.warnings).toBeUndefined();
  });

  it('reports the double parse alongside the unwrapped-assertion warning', async () => {
    const result = await TestRunner.runScript(
      `test("bad parse", function() {
         JSON.parse(res.getBody());
       });
       expect(res.getStatus()).to.equal(200);`,
      jsonResponse,
    );

    expect(result.warnings).toHaveLength(2);
    expect(result.warnings?.some(w => /Wrap assertions/.test(w))).toBe(true);
    expect(result.warnings?.some(w => HINT.test(w))).toBe(true);
  });
});
