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
export function planAssertion(assertion: SandboxAssertion): AssertionPlan {
  const { operator, operand } = parseAssertionOperator(assertion.value);
  const chain = chainForOperator(operator);

  let operands: readonly string[];
  switch (chain.operandKind) {
    case 'none':
      operands = [];
      break;
    case 'list':
    case 'range':
      operands = splitOperandList(operand);
      break;
    case 'regexSource':
      operands = [stripRegexDelimiters(operand)];
      break;
    default:
      operands = [operand];
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
//
// Upstream's final branch evaluates the operand as a template literal, which is
// how a bare word becomes a string rather than a ReferenceError. Here the bare
// word is simply returned: the sandbox has code generation disabled, and the
// operand deliberately never becomes source. The results agree for every operand
// without a \${...} placeholder — and Bruno resolves {{var}} references before
// this point, so placeholders do not appear in practice.
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
    // .within takes two arguments, so the bounds are spread. A malformed operand
    // is rejected rather than passed through: within(min, undefined) would fail
    // with a confusing "undefined is not a number" instead of naming the cause.
    if (plan.operands.length !== 2) {
      throw new Error(
        'expected two comma-separated bounds, but got ' + plan.operands.length
      );
    }
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
    void node[terminal];
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
  budget: number,
): void {
  try {
    vm.runInContext(
      `__assertFail(${index}, ${JSON.stringify(message)});`,
      context,
      { timeout: Math.max(1, budget) },
    );
  } catch {
    // Nothing further can run in this context.
  }
}

/**
 * Evaluate every planned assertion in a live context, one compiled script each.
 *
 * One script per assertion is the isolation: a left-hand expression that does
 * not parse is a compile error, and compiling all of them together would let one
 * malformed assertion in a collection stop every assertion after it. The
 * expression is spliced into source because it IS source — a JS expression is
 * what the format declares — and parenthesised so it cannot smuggle in extra
 * statements. Everything else about the assertion crossed as JSON data.
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
      new vm.Script(`__assertOne(${i}, function() { return (${plans[i].expression}); });`, {
        filename: `bruno-assertion-${i}.js`,
      }).runInContext(context, { timeout: budget() });
    } catch (error: unknown) {
      const { label, message } = describeSandboxError(error);
      if (isTimeoutMessage(message)) {
        throw error;
      }
      recordAssertionFailure(context, i, `${label}: ${message}`, budget());
    }
  }
}
