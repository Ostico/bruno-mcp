/**
 * Schema fragments shared by more than one tool (finding Q14).
 */

import { z } from 'zod';

export const inlineScriptsSchema = z.object({
  'pre-request': z.string().optional(),
  'post-response': z.string().optional(),
  tests: z.string().optional(),
  'before-request': z.string().optional(),
  'after-response': z.string().optional(),
}).optional().describe(
  'Inline scripts to persist with the request. Keys: pre-request, post-response, tests ' +
  '(aliases before-request/after-response accepted). Avoids a separate add_test_script call. ' +
  'IMPORTANT for tests/post-response: only assertions inside a test() block are reported. ' +
  'Write test("status is 200", function() { expect(res.getStatus()).to.equal(200); }); — a bare ' +
  'expect() at the top level still runs, but a passing one records nothing, so run_collection ' +
  'reports "tests": [] and the request looks green with no assertions. Available in scripts: ' +
  'res.getStatus()/getStatusText()/getHeader(name)/getHeaders()/getBody()/getResponseTime(), ' +
  'bru.setVar(name, value)/getVar(name), and expect(actual) with .to.equal/.contain/.include, ' +
  '.to.have.property/.lengthOf, .to.be.a/.an/.below/.above, and .to.not.* negations. ' +
  'RETURN TYPE: res.getBody() returns the response already parsed into a JS object/array when the ' +
  'Content-Type is application/json or a +json type (raw text otherwise). Access fields directly — res.getBody().field — ' +
  'and do NOT JSON.parse() it, which throws SyntaxError: "[object Object]" is not valid JSON.',
);
