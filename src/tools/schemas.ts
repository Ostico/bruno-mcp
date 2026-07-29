/**
 * Schema fragments shared by more than one tool.
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
  '.to.have.property/.lengthOf, .to.be.a/.an, ' +
  '.to.be.above/.below/.at.least/.at.most (aliases .gt/.lt/.gte/.lte/.greaterThan/.lessThan), ' +
  '.to.be.within(min, max), .to.be.oneOf([...]), .to.match(/re/), ' +
  '.to.startWith/.endWith, .to.be.true/.false/.null/.undefined/.empty/.json,and .to.not.* negations. ' +
  'RETURN TYPE: res.getBody() returns the response already parsed into a JS object/array when the ' +
  'Content-Type is application/json or a +json type (raw text otherwise). Access fields directly — res.getBody().field — ' +
  'and do NOT JSON.parse() it, which throws SyntaxError: "[object Object]" is not valid JSON.',
);

/**
 * One declared assertion, shared by create_request and modify_request.
 *
 * Declared assertions are evaluated after the post-response script, so they can
 * read anything a script or a `vars:post-response` entry set. Unlike a bare
 * `expect()` in a script, they need no `test()` wrapper to be reported.
 */
export const assertionEntrySchema = z.object({
  name: z.string().min(1).describe(
    'Left-hand expression, evaluated against the response. Examples: res.status, ' +
    'res.body.id, res.body.items.length, res.headers["content-type"], ' +
    'res.responseTime, bru.getVar("token").'
  ),
  value: z.string().min(1).describe(
    'Operator plus operand. 28 operators: eq, neq, gt, gte, lt, lte, in, notIn, ' +
    'contains, notContains, length, matches, notMatches, startsWith, endsWith, ' +
    'between, and 12 that take NO operand: isEmpty, isNotEmpty, isNull, ' +
    'isUndefined, isDefined, isTruthy, isFalsy, isJson, isNumber, isString, ' +
    'isBoolean, isArray. Prefix any with "not " to negate. Examples: "eq 200", ' +
    '"between 200, 299", "matches /^v[0-9]+$/", "isNumber". An unrecognised ' +
    'operator becomes an eq against the whole string, matching Bruno.'
  ),
  disabled: z.boolean().optional().describe('Omit to keep the assertion active.'),
});

/** One declared variable, shared by create_request and modify_request. */
export const varEntrySchema = z.object({
  name: z.string().min(1),
  value: z.string().describe(
    'For preRequest: RAW text, with {{placeholders}} resolved against variables ' +
    'declared earlier. For postResponse: a JS EXPRESSION evaluated against the ' +
    'response, e.g. res.body.id or res.body.items.length * 2.'
  ),
  disabled: z.boolean().optional().describe('Omit to keep the variable active.'),
  local: z.boolean().optional().describe('Pre-request only: keep out of the runtime store.'),
});

/**
 * Declared `vars` blocks. The two halves are asymmetric on purpose, matching
 * Bruno: pre-request values are raw text folded into interpolation BEFORE the
 * request is built, post-response values are expressions evaluated against the
 * response and stored with bru.setVar.
 */
export const requestVarsSchema = z.object({
  preRequest: z.array(varEntrySchema).optional(),
  postResponse: z.array(varEntrySchema).optional(),
}).optional();
