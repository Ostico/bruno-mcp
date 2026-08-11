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

/**
 * The request-level `settings` block, shared by create_request and
 * modify_request. Transport behaviour, not payload.
 *
 * Every field is optional and omitting one writes no key for it, leaving the
 * runtime fallback described in each field below. On modify_request the fields
 * are merged one by one over what the file already had, so setting one does not
 * clear the others.
 */
export const requestSettingsSchema = z.object({
  timeout: z.number().int().nonnegative().optional().describe(
    'Milliseconds, capping two separate things. The HTTP request itself, which ' +
    'defaults to 30000ms when unset. And the per-script budget shared by ' +
    'pre-request, post-response and tests code, including time spent in bru.sleep, ' +
    'setTimeout and setInterval, which defaults to 5000ms when unset — a script ' +
    'that waits longer than its budget is aborted, and setting this is the only way ' +
    'to lift that 5000ms cap. 0 means no timeout at all.'
  ),
  followRedirects: z.boolean().optional().describe(
    'Whether a 3xx Location is followed. REDIRECTS ARE FOLLOWED WHEN THIS IS UNSET. ' +
    'Set false to receive the 3xx response itself. This matters for more than the ' +
    'status code: a Set-Cookie issued on the 3xx is consumed by the redirect hop and ' +
    'is not visible on the final response, so a login or password-reset endpoint that ' +
    'returns its session cookie alongside a 302 looks like it issued no cookie at all, ' +
    'and the following request fails as unauthenticated. Set false whenever you need ' +
    'to read the headers of the redirect itself.'
  ),
  maxRedirects: z.number().int().nonnegative().optional().describe(
    'Maximum redirect hops to follow. Defaults to 5 when unset, as it does in Bruno. Irrelevant once ' +
    'followRedirects is false; 0 likewise stops the first hop being followed.'
  ),
  encodeUrl: z.boolean().optional().describe(
    'Whether the URL and query string are percent-encoded before the request is sent. ' +
    'Read the whole of this before setting any other field here, because the default ' +
    'is two-valued and reproduces upstream Bruno: a request with NO settings block ' +
    'sends its URL raw (off), but a request that HAS a settings block not mentioning ' +
    'encodeUrl encodes it (on). So adding a settings block for some other reason — ' +
    'say to set timeout on a request that had no settings before — turns URL encoding ' +
    'on as a side effect. Pass encodeUrl: false alongside to keep the URL raw.'
  ),
}).optional().describe(
  'Request-level settings: transport behaviour (timeouts, redirects, URL encoding), ' +
  'not payload. What reaches the file depends on the dialect, because Bruno\'s own two ' +
  'writers differ: a .yml request always carries a fully resolved settings block whether ' +
  'or not you pass one, while a .bru request carries only what you supply. On ' +
  'modify_request the fields are merged individually over the existing block, so setting ' +
  'one does not clear the rest. Note the encodeUrl field: in .bru, creating a block at all ' +
  'changes the URL-encoding default.'
);

/**
 * A request body, shared by every tool that accepts one.
 *
 * One definition on purpose. The three tools each carried their own copy and
 * they drifted: `create_test_suite` offered six body types and no parts at all,
 * so a suite request could name a multipart body and then have no way to say
 * what was in it. The type list here is the full `BodyType` union the writers
 * support, not a subset of it.
 */
export const requestBodySchema = z.object({
  type: z.enum([
    'none', 'json', 'text', 'xml', 'sparql', 'graphql',
    'form-data', 'multipart-form', 'form-urlencoded', 'file', 'binary',
  ]),
  content: z.string().optional()
    .describe(
      'The payload as text. For graphql this is the query; for file it is the one-file ' +
      'shorthand for files[0].filePath.',
    ),
  formData: z.array(z.object({
    name: z.string(),
    value: z.union([z.string(), z.array(z.string())]),
    type: z.enum(['text', 'file']).optional(),
    contentType: z.string().optional(),
  })).optional()
    .describe('multipart/form-data parts, for body.type "form-data" or "multipart-form".'),
  variables: z.string().optional()
    .describe(
      'GraphQL variables, as raw JSON text. Kept as text end to end, so a {{placeholder}} ' +
      'inside it survives to substitution time.',
    ),
  files: z.array(z.object({
    filePath: z.string(),
    contentType: z.string().optional(),
    selected: z.boolean().optional(),
  })).optional()
    .describe(
      'File body parts. `content` is the one-file shorthand; use this to set a content ' +
      'type, deselect an entry, or send more than one. Only the first selected entry is ' +
      'sent, which is what Bruno does; an entry defaults to selected, and the flag is ' +
      'always written to the file, because a .yml entry without it is one Bruno sends no ' +
      'body for.',
    ),
}).optional();

/**
 * The WebSocket-only half of an authoring input, shared by the tools that write
 * requests.
 *
 * A nested object rather than more flat arguments, matching `run_collection`:
 * a caller who never authors a WebSocket request never sees a WebSocket field.
 */
export const websocketAuthoringSchema = z.object({
  messages: z.array(z.object({
    title: z.string().optional()
      .describe('Name of the message. Defaults to "message N" by position, as Bruno does.'),
    type: z.string().optional()
      .describe(
        'How Bruno\'s editor should treat the payload: text, json or xml. Nothing validates ' +
        'it, and every frame is sent as text — there is no binary send path.',
      ),
    content: z.string()
      .describe('The payload, sent verbatim after variable substitution.'),
    selected: z.boolean().optional()
      .describe(
        'Whether the message is sent. Defaults to true, and is always written, because a ' +
        '.yml message without it is one Bruno will not send. A false is refused in a .bru ' +
        'collection, which cannot record it.',
      ),
  })).optional()
    .describe('Messages sent in order once the socket is open.'),
}).optional()
  .describe('WebSocket-only fields. Applies to kind "websocket" and is refused otherwise.');

