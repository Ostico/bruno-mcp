/**
 * Evaluating a declared `assert` block.
 *
 * assert-operators.ts is the parsing half: it turns `eq 200` into an operator, an
 * operand, and a description of the chai chain to walk. This is the other half —
 * it plans each assertion, emits the sandbox-side evaluator that walks those
 * chains on the sandbox's own expect(), and drives one compiled script per
 * assertion so a malformed one fails alone.
 *
 * The split between what becomes source and what stays data is the whole design.
 * The left-hand side is spliced into source because it IS source: the format
 * declares a JS expression (`res.status`, `res.body.items.length`). Everything
 * else — the description, the operand text, the chain path — crosses as JSON, so
 * an operand can only ever be compared as a value and never run.
 */

import vm from 'node:vm';
import type { SandboxAssertion } from './types.js';
import {
  assertChainPath,
  chainForOperator,
  parseAssertionOperator,
  splitOperandList,
  splitOperandRange,
  stripRegexDelimiters,
  type AssertArgument,
  type OperandKind,
} from './assert-operators.js';
import { describeSandboxError, isTimeoutMessage } from './sandbox-errors.js';

/**
 * One declared assertion reduced to what the sandbox needs to evaluate it.
 *
 * `expression` is the only field that becomes source; everything else crosses as
 * JSON data. `operands` are still raw text because coercion is Bruno's
 * template-literal rule, which the sandbox applies (see __coerceOperand) — the
 * splitting around them is context-free and so is done here.
 */
export interface AssertionPlan {
  /** The left-hand side, a JS expression evaluated in the sandbox context. */
  readonly expression: string;
  /** What the results entry is called, e.g. `res.status eq 200`. */
  readonly description: string;
  /** Property path from expect(lhs) to the terminal matcher, negation included. */
  readonly path: readonly string[];
  readonly argument: AssertArgument;
  readonly operandKind: OperandKind;
  readonly operands: readonly string[];
}

/**
 * Turn one declared assertion into a plan.
 *
 * The value string's parse is assert-operators' business and covered there; what
 * this adds is the split between what will become source and what will stay
 * data.
 */
/**
 * Resolve `{{var}}` placeholders in an operand.
 *
 * Bruno wraps every operand branch of its assert runtime in `interpolateString`
 * against the merged env/collection/folder/request/runtime variables, so
 * `eq {{expectedStatus}}` compares against the resolved value. Without this the
 * comparison is against the literal 18 characters and every parameterised
 * assertion reports a failure it should not.
 *
 * Applied to the OPERAND ONLY, and only after the operator has been parsed off.
 * Interpolating the whole `value` first would let a variable's own text be read
 * as the operator: a bare `{{status}}` holding `eq 200` parses upstream as
 * `eq "eq 200"` (unrecognised token, whole string as operand) and would parse
 * here as `eq 200` — a different assertion.
 *
 * An unresolved placeholder is left exactly as written, which is both what
 * `substitute` does for URLs and what upstream does; the resulting comparison
 * against the literal text is the visible symptom of a missing variable.
 */
export function interpolateOperand(
  operand: string,
  variables: Record<string, unknown> | undefined,
): string {
  if (operand.length === 0 || variables === undefined) {
    return operand;
  }
  return operand.replace(/\{\{([^}]+)\}\}/g, (match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(variables, name)) {
      return match;
    }
    const value = variables[name];
    return value === undefined || value === null ? match : String(value);
  });
}

export function planAssertion(
  assertion: SandboxAssertion,
  variables?: Record<string, unknown>,
): AssertionPlan {
  const { operator, operand } = parseAssertionOperator(assertion.value);
  const chain = chainForOperator(operator);
  const resolved = interpolateOperand(operand, variables);

  let operands: readonly string[];
  switch (chain.operandKind) {
    case 'none':
      operands = [];
      break;
    case 'list':
      operands = splitOperandList(resolved);
      break;
    case 'range':
      // Not splitOperandList: the bracket strip is Bruno's `in`/`notIn` branch
      // only, and applying it here turns a Bruno failure into a pass.
      operands = splitOperandRange(resolved);
      break;
    case 'regexSource':
      operands = [stripRegexDelimiters(resolved)];
      break;
    default:
      operands = [resolved];
  }

  return {
    expression: assertion.name,
    // The operator is named even when it was implicit, so a bare `200` reports
    // as `eq 200` and a misspelled operator is visible in the report as the
    // equality check it silently became.
    description:
      operand === ''
        ? `${assertion.name} ${operator}`
        : `${assertion.name} ${operator} ${operand}`,
    path: assertChainPath(chain),
    argument: chain.argument,
    operandKind: chain.operandKind,
    operands,
  };
}

/**
 * The assertion evaluator, as pure JS source prepended to the sandbox.
 *
 * It lives here rather than host-side for the same reason SANDBOX_EXPECT_LIB
 * does: it must run against the sandbox's own expect() and intrinsics, and no
 * host-realm function may be reachable from sandboxed code. Requires
 * SANDBOX_EXPECT_LIB (for expect) and buildSandboxSetupScript (for __results and
 * __errMessage) to have been emitted before it.
 */
export const SANDBOX_ASSERT_LIB = `
var __assertPlans = [];
function __assertInit(json) {
  try { __assertPlans = JSON.parse(json); } catch (e) { __assertPlans = []; }
}

// Bruno's operand coercion, ported from evaluateJsTemplateLiteral in
// packages/bruno-js/src/utils.js. The order is load-bearing and so are two
// quirks kept deliberately:
//
//   - the emptiness check precedes the trim, so a whitespace-only operand is NOT
//     returned as-is: it trims to '' and falls through to Number('') === 0.
//   - a number above MAX_SAFE_INTEGER stays a STRING, because Number() would
//     alter its digits and an equality check against the response's own text
//     would then fail for no visible reason.
//   - that guard is one-sided upstream and one-sided here: utils.js:99 tests
//     only "number > Number.MAX_SAFE_INTEGER", so a literal below
//     -MAX_SAFE_INTEGER loses exactly the digits the positive case protects.
//     Left as-is deliberately. Adding the missing half would make this runner
//     report a different comparison than Bruno does for the same file, and
//     reporting what the collection actually does is the property that matters.
//
// Upstream's final branch evaluates the operand as a template literal, which is
// how a bare word becomes a string rather than a ReferenceError. Here the bare
// word is simply returned: the sandbox has code generation disabled, and the
// operand deliberately never becomes source. The results agree for every operand
// without a \${...} placeholder.
//
// {{var}} placeholders are already resolved by then — interpolateOperand runs
// host-side in planAssertion, which is where upstream resolves them too. An
// UNRESOLVED placeholder does reach here, as the literal text, which is what
// makes a missing variable visible in the failure message.
function __coerceOperand(text) {
  if (!text || !text.length || typeof text !== 'string') { return text; }
  var t = text.trim();
  if (t === 'true') { return true; }
  if (t === 'false') { return false; }
  if (t === 'null') { return null; }
  if (t === 'undefined') { return undefined; }
  if (t.charAt(0) === '"' && t.charAt(t.length - 1) === '"') { return t.slice(1, -1); }
  if (t.charAt(0) === "'" && t.charAt(t.length - 1) === "'") { return t.slice(1, -1); }
  if (!isNaN(t)) {
    var n = Number(t);
    return n > Number.MAX_SAFE_INTEGER ? t : n;
  }
  return t;
}

// What the terminal matcher is called with. Returning an empty array means the
// matcher is a property rather than a method — see __assertWalk.
function __assertArgs(plan) {
  if (plan.argument.kind === 'none') { return []; }
  // Comes from the operator, not the operand: the isNumber family all end in
  // .a(<type>).
  if (plan.argument.kind === 'fixed') { return [plan.argument.value]; }
  if (plan.operandKind === 'regexSource') { return [new RegExp(plan.operands[0])]; }
  if (plan.operandKind === 'list') {
    var list = [];
    for (var i = 0; i < plan.operands.length; i++) {
      list.push(__coerceOperand(plan.operands[i]));
    }
    return [list];
  }
  if (plan.argument.kind === 'spreadOperand') {
    // .within takes two arguments, so the bounds are spread. Exactly the first
    // two, whatever the count: upstream destructures [lhs, rhs] and ignores any
    // extras, so rejecting three bounds would fail an assertion Bruno can pass.
    // Fewer than two needs no check either — the missing bound arrives as
    // undefined and requireNumbers fails it, which is what upstream's chai does.
    return [__coerceOperand(plan.operands[0]), __coerceOperand(plan.operands[1])];
  }
  return [__coerceOperand(plan.operands[0])];
}

// Walk the chain descriptor on a real expect() chain. Every intermediate link is
// a guarded chain object, so a path this build does not support throws rather
// than resolving to undefined and passing silently.
function __assertWalk(plan, lhs) {
  var node = expect(lhs);
  for (var i = 0; i < plan.path.length - 1; i++) {
    node = node[plan.path[i]];
  }
  var terminal = plan.path[plan.path.length - 1];
  var args = __assertArgs(plan);
  if (args.length === 0) {
    // .to.be.empty / .true / .null / .undefined / .json assert from a getter, so
    // reading the property IS the call.
    //
    // Checked rather than assumed: this is the one seam guardChain cannot cover.
    // The guard fires when a property is MISSING, but a zero-argument operator
    // pointed at a method would find the property present, read the function
    // object, assert nothing and report a pass. Every such operator maps to a
    // real getter today; this is what keeps that true for the next one added.
    // Read exactly once — the read IS the assertion, so reading twice would run
    // it twice.
    var value = node[terminal];
    if (typeof value === 'function') {
      throw new Error(
        'matcher "' + terminal + '" is a method, not a getter, so reading it ' +
        'would assert nothing'
      );
    }
    return;
  }
  node[terminal].apply(node, args);
}

// One assertion, evaluated in its own try so a broken one fails only itself.
// getLhs is a closure over the spliced expression, so a left-hand side that
// throws (a ReferenceError, a walk through undefined) is caught here too.
function __assertOne(index, getLhs) {
  var plan = __assertPlans[index];
  if (!plan) { return; }
  try {
    __assertWalk(plan, getLhs());
    __results.push({ description: plan.description, status: 'pass' });
  } catch (e) {
    __results.push({ description: plan.description, status: 'fail', error: __errMessage(e) });
  }
}

// Record a failure the sandbox could not record itself — an expression that did
// not compile, so __assertOne was never reached. Called from the host with a
// JSON-encoded message so the results array keeps one entry per assertion, in
// declaration order, whatever went wrong.
function __assertFail(index, message) {
  var plan = __assertPlans[index];
  __results.push({
    description: plan ? plan.description : 'assertion ' + index,
    status: 'fail',
    error: message
  });
}
`;

/**
 * Per-job source that hands the plans to the sandbox as data.
 *
 * Double-encoded exactly as buildSeedVarsScript is: the inner stringify builds
 * the payload, the outer one makes it a safely escaped JS string literal, so an
 * operand or description containing quotes and parentheses stays an argument
 * instead of becoming source. Returns '' when there is nothing to evaluate, so a
 * scripts-only request gets a byte-identical prelude to before.
 */
export function buildAssertPlansScript(plans: readonly AssertionPlan[]): string {
  if (plans.length === 0) {
    return '';
  }
  return `__assertInit(${JSON.stringify(JSON.stringify(plans))});`;
}

/**
 * Reject a left-hand side that is not a single expression.
 *
 * The wrapper `__assertOne(i, function() { return (<expr>); });` is a template,
 * not a boundary: `0); } ); doSomething(); //` closes the call and comments away
 * the tail, and `0); } ); doSomething(); (function(){ return (0` rebalances it.
 * Both compile, and the statements run.
 *
 * Compiling the expression ALONE first is what makes the template's assumption
 * true. `(\n<expr>\n)` parses only if the text really is one expression — the
 * newlines matter, so a trailing line comment cannot swallow the closing paren.
 * Both payloads above fail this and are recorded as ordinary assertion failures.
 *
 * The privilege gained by escaping was never large: the left-hand side is already
 * arbitrary JS in that context, at the same trust level as the post-response
 * script, and `(a, b)` or an IIFE reaches whatever a statement could. What it did
 * buy is throwing a chosen value OUT of runInContext into the host's catch, past
 * the in-context try in __assertOne — which is the one thing an expression cannot
 * do, and the reason host-side error handling should never see attacker-shaped
 * objects.
 *
 * Compiling twice also fixes a plain authoring case the template breaks on its
 * own: `res.status // why` is a legitimate expression whose comment would
 * otherwise eat the wrapper's `); });`.
 */
function assertExpressionIsAnExpression(expression: string): void {
  // Compiled, never run. A syntax error here is the whole signal.
  new vm.Script(`(\n${expression}\n)`, { filename: 'bruno-assertion-check.js' });
}

/**
 * Record an assertion failure the sandbox could not record for itself.
 *
 * Best-effort: if the context is no longer usable the assertion goes unreported
 * rather than taking down the run, which still leaves every other assertion and
 * the script reported.
 */
function recordAssertionFailure(
  context: vm.Context,
  index: number,
  message: string,
  // Named for what it is — a millisecond deadline, not the budget() function the
  // caller holds — and already floored at 1 by that function, so not re-clamped.
  timeout: number,
): void {
  try {
    vm.runInContext(
      `__assertFail(${index}, ${JSON.stringify(message)});`,
      context,
      { timeout },
    );
  } catch {
    // Nothing further can run in this context.
  }
}

/**
 * Evaluate `vars:post-response` entries and store each result.
 *
 * A var's value is a JS expression, so it goes through the same treatment an
 * assertion's left-hand side does: pre-validated as a single expression, then
 * compiled on its own so one bad var cannot stop the others. Unlike an assertion
 * it produces no result entry — the outcome is a variable, and a failure is
 * reported as a warning rather than a test result, because upstream collects
 * these errors separately from its assertion results.
 *
 * The write goes through bru.setVar so it lands in the same store the script and
 * the assertions read, and so it is picked up by extractBruVars and returned to
 * the caller as a variable write like any other.
 *
 * Returns one message per var that failed, for the caller to surface as warnings.
 */
export function runPostResponseVarsInContext(
  context: vm.Context,
  vars: readonly SandboxAssertion[],
  budget: () => number,
): string[] {
  const failures: string[] = [];
  for (const entry of vars) {
    try {
      assertExpressionIsAnExpression(entry.value);
      // The NAME crosses as JSON data and the VALUE as source, the same split the
      // assertion path uses: a variable name can never become code.
      const source =
        `bru.setVar(${JSON.stringify(entry.name)}, (\n${entry.value}\n));`;
      new vm.Script(source, {
        filename: `bruno-post-response-var-${entry.name}.js`,
      }).runInContext(context, { timeout: budget() });
    } catch (error: unknown) {
      const { label, message } = describeSandboxError(error);
      // A timeout terminated the context; nothing further can run in it, so it is
      // the run's timeout and must reach the caller's handling.
      if (isTimeoutMessage(message) && budget() <= 1) {
        throw error;
      }
      failures.push(
        `vars:post-response "${entry.name}" failed to evaluate: ${label}: ${message}`,
      );
    }
  }
  return failures;
}

/**
 * Evaluate every planned assertion in a live context, one compiled script each.
 *
 * One script per assertion is the isolation: a left-hand expression that does
 * not parse is a compile error, and compiling all of them together would let one
 * malformed assertion in a collection stop every assertion after it.
 *
 * The expression is spliced into source because it IS source — a JS expression
 * is what the format declares. Parenthesising it is NOT a containment boundary:
 * an expression ending in `);` closes the wrapper and the `__assertOne(` call
 * with it, and a trailing `//` or a rebalancing `(function(){ return (0` absorbs
 * the leftover tail, so statements can follow. assertExpressionIsAnExpression is
 * what actually holds the line. Everything else about the assertion crossed as
 * JSON data and cannot execute at all.
 *
 * Rethrows a timeout: that force-terminates the whole context, so it is the
 * run's timeout rather than one assertion's failure, and the caller's existing
 * timeout handling must see it.
 */
export function runAssertionsInContext(
  context: vm.Context,
  plans: readonly AssertionPlan[],
  budget: () => number,
): void {
  for (let i = 0; i < plans.length; i++) {
    try {
      assertExpressionIsAnExpression(plans[i].expression);
      // The expression goes on its own line, for the same reason the check
      // compiles it that way: on one line a trailing `//` comment in an
      // otherwise valid expression would comment out the wrapper's own tail.
      const source = `__assertOne(${i}, function() { return (\n${plans[i].expression}\n); });`;
      new vm.Script(source, {
        filename: `bruno-assertion-${i}.js`,
      }).runInContext(context, { timeout: budget() });
    } catch (error: unknown) {
      const { label, message } = describeSandboxError(error);
      // Corroborated against the clock, not trusted from the text. The message
      // is the only thing distinguishing a V8 interrupt from an ordinary Error,
      // and a collection author can throw that exact wording — which rethrows,
      // and the run's timeout handling then discards every result already
      // recorded plus every assertion and the script still to come. So one
      // assertion could void the whole report. A real interrupt only fires once
      // the budget it was given is spent, which leaves budget() at its floor.
      if (isTimeoutMessage(message) && budget() <= 1) {
        throw error;
      }
      recordAssertionFailure(context, i, `${label}: ${message}`, budget());
    }
  }
}
