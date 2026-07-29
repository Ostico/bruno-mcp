/**
 * Bruno's assertion-operator vocabulary, ported as data.
 *
 * A declared `assert` block is a list of `name: value` pairs where the value
 * carries its own operator: `res.status: eq 200`, `res.body.id: isDefined`,
 * `res.status: in 200, 201`. Bruno parses that value string in
 * packages/bruno-js/src/runtime/assert-runtime.js and then runs a `switch` over
 * 28 operators, each arm calling a different chai chain. This module is the
 * parsing half of that, and a description of the chains rather than a
 * reimplementation of them.
 *
 * The chains are a DATA structure on purpose. The half that actually asserts
 * runs inside the sandbox against the sandbox's own expect implementation; if
 * this module contained the switch, the operator vocabulary would exist twice
 * and drift. Here the vocabulary is declared once, and the sandbox walks the
 * chain it is handed.
 *
 * Everything here is pure and deterministic: no I/O, no sandbox, no executor.
 * The one thing deliberately NOT ported is operand evaluation. Bruno resolves an
 * operand through `{{variable}}` interpolation and a JS template-literal
 * evaluation that coerces 'true'/'false'/'null'/'undefined'/numbers to real
 * values — that needs the request's variable context and a JS evaluator, so it
 * belongs on the sandbox side. What is ported is the context-free syntax around
 * it: which operators split their operand on commas, which unwrap brackets or
 * regex slashes, and which take no operand at all.
 *
 * Faithfulness beats tidiness throughout. Bruno's quirks (an operand keeping
 * interior whitespace, `isTruthy` meaning strictly `true`, an unrecognised
 * operator silently becoming `eq`) are reproduced, because a collection that
 * passes in Bruno has to pass here.
 */

/**
 * The operator names, in Bruno's own declaration order.
 *
 * Order is not decorative: the first token of an assertion value is matched
 * against this list, and anything not in it becomes an `eq` against the whole
 * string. Adding a name here changes what stops being an implicit equality
 * check, so the list stays a transcription of Bruno's rather than a superset.
 */
const OPERATOR_NAMES = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'notIn',
  'contains',
  'notContains',
  'length',
  'matches',
  'notMatches',
  'startsWith',
  'endsWith',
  'between',
  'isEmpty',
  'isNotEmpty',
  'isNull',
  'isUndefined',
  'isDefined',
  'isTruthy',
  'isFalsy',
  'isJson',
  'isNumber',
  'isString',
  'isBoolean',
  'isArray',
] as const;

/**
 * The operators that assert something about the left-hand side alone.
 *
 * Bruno checks this set BEFORE the general one while parsing, and a match
 * discards whatever followed the operator. So `isEmpty something` asserts
 * emptiness and the word `something` is dropped rather than reported as a
 * mistake in the collection.
 */
const UNARY_OPERATOR_NAMES = [
  'isEmpty',
  'isNotEmpty',
  'isNull',
  'isUndefined',
  'isDefined',
  'isTruthy',
  'isFalsy',
  'isJson',
  'isNumber',
  'isString',
  'isBoolean',
  'isArray',
] as const;

/** Any operator Bruno recognises in an assertion value. */
export type AssertOperator = (typeof OPERATOR_NAMES)[number];

/** An operator that takes no operand. */
export type UnaryAssertOperator = (typeof UNARY_OPERATOR_NAMES)[number];

/**
 * The unions are derived from the tuples above rather than declared separately,
 * so the compiler — not a comment — is what keeps the runtime lists and the
 * types in agreement. The annotations here are the subset checks: a name in
 * UNARY_OPERATOR_NAMES that is missing from OPERATOR_NAMES fails to compile.
 */
export const ASSERT_OPERATORS: readonly AssertOperator[] = OPERATOR_NAMES;
export const UNARY_ASSERT_OPERATORS: readonly AssertOperator[] = UNARY_OPERATOR_NAMES;

const OPERATOR_SET: ReadonlySet<string> = new Set<string>(OPERATOR_NAMES);
const UNARY_OPERATOR_SET: ReadonlySet<string> = new Set<string>(UNARY_OPERATOR_NAMES);

/**
 * How an operand should be read before it reaches the assertion.
 *
 * A kind rather than a coercion function, so the sandbox — which owns the
 * variable context and the JS evaluation this needs — decides how to realise
 * each one. `literal` covers everything Bruno passes straight through its
 * template-literal evaluation, which is where a numeric-looking operand becomes
 * a number; `none` means the operator ignores its operand entirely.
 */
export type OperandKind = 'none' | 'literal' | 'list' | 'range' | 'regexSource';

/**
 * What the terminal link of the chain is called with.
 *
 * `spreadOperand` exists for `between` alone: chai's `within` takes two
 * arguments, so the two-element range is spread rather than passed as an array.
 * `fixed` exists for the `isNumber`-style operators, whose chain ends in
 * `.a('number')` — an argument that comes from the operator, not the operand.
 */
export type AssertArgument =
  | { readonly kind: 'none' }
  | { readonly kind: 'operand' }
  | { readonly kind: 'spreadOperand' }
  | { readonly kind: 'fixed'; readonly value: string };

/**
 * One operator's assertion, as a path to walk rather than a call to make.
 *
 * `path` is the property path from the expectation object to the terminal link,
 * with any negation left out — `neq` is `['to', 'equal']` with `negated: true`,
 * not `['to', 'not', 'equal']`. Bruno spells every negation as `.not` directly
 * after `.to`, so where it goes is uniform and does not need storing; keeping it
 * out of the path also makes the pairs visible, since a negated operator and its
 * positive counterpart then share a path.
 */
export interface AssertChain {
  readonly path: readonly string[];
  readonly negated: boolean;
  readonly argument: AssertArgument;
  readonly operandKind: OperandKind;
}

/** The result of splitting an assertion value into its operator and operand. */
export interface ParsedAssertion {
  readonly operator: AssertOperator;
  readonly operand: string;
}

const OPERAND: AssertArgument = { kind: 'operand' };
const NO_ARGUMENT: AssertArgument = { kind: 'none' };

/**
 * Every operator's chain, transcribed from the switch in Bruno's
 * AssertRuntime.runAssertions.
 *
 * Typed as a total Record so a new member of AssertOperator cannot be added
 * without an entry here — the compiler stands in for Bruno's `default:` arm,
 * which would otherwise silently turn a half-added operator into an equality
 * check.
 */
export const ASSERT_CHAINS: Readonly<Record<AssertOperator, AssertChain>> = {
  eq: { path: ['to', 'equal'], negated: false, argument: OPERAND, operandKind: 'literal' },
  neq: { path: ['to', 'equal'], negated: true, argument: OPERAND, operandKind: 'literal' },
  gt: {
    path: ['to', 'be', 'greaterThan'],
    negated: false,
    argument: OPERAND,
    operandKind: 'literal',
  },
  gte: {
    path: ['to', 'be', 'greaterThanOrEqual'],
    negated: false,
    argument: OPERAND,
    operandKind: 'literal',
  },
  lt: { path: ['to', 'be', 'lessThan'], negated: false, argument: OPERAND, operandKind: 'literal' },
  lte: {
    path: ['to', 'be', 'lessThanOrEqual'],
    negated: false,
    argument: OPERAND,
    operandKind: 'literal',
  },
  in: { path: ['to', 'be', 'oneOf'], negated: false, argument: OPERAND, operandKind: 'list' },
  notIn: { path: ['to', 'be', 'oneOf'], negated: true, argument: OPERAND, operandKind: 'list' },
  contains: { path: ['to', 'include'], negated: false, argument: OPERAND, operandKind: 'literal' },
  notContains: {
    path: ['to', 'include'],
    negated: true,
    argument: OPERAND,
    operandKind: 'literal',
  },
  // Bruno gives `length` no numeric coercion of its own: the operand goes
  // through the same literal evaluation as `eq`, which turns "5" into 5.
  length: {
    path: ['to', 'have', 'lengthOf'],
    negated: false,
    argument: OPERAND,
    operandKind: 'literal',
  },
  matches: { path: ['to', 'match'], negated: false, argument: OPERAND, operandKind: 'regexSource' },
  notMatches: {
    path: ['to', 'match'],
    negated: true,
    argument: OPERAND,
    operandKind: 'regexSource',
  },
  startsWith: {
    path: ['to', 'startWith'],
    negated: false,
    argument: OPERAND,
    operandKind: 'literal',
  },
  endsWith: { path: ['to', 'endWith'], negated: false, argument: OPERAND, operandKind: 'literal' },
  between: {
    path: ['to', 'be', 'within'],
    negated: false,
    argument: { kind: 'spreadOperand' },
    operandKind: 'range',
  },
  isEmpty: {
    path: ['to', 'be', 'empty'],
    negated: false,
    argument: NO_ARGUMENT,
    operandKind: 'none',
  },
  isNotEmpty: {
    path: ['to', 'be', 'empty'],
    negated: true,
    argument: NO_ARGUMENT,
    operandKind: 'none',
  },
  isNull: { path: ['to', 'be', 'null'], negated: false, argument: NO_ARGUMENT, operandKind: 'none' },
  isUndefined: {
    path: ['to', 'be', 'undefined'],
    negated: false,
    argument: NO_ARGUMENT,
    operandKind: 'none',
  },
  isDefined: {
    path: ['to', 'be', 'undefined'],
    negated: true,
    argument: NO_ARGUMENT,
    operandKind: 'none',
  },
  // isTruthy and isFalsy are STRICT boolean checks despite their names: Bruno
  // compiles them to `.to.be.true` and `.to.be.false`, so `isTruthy` fails for
  // 1 or "yes" and `isFalsy` fails for 0 or "". They are not each other's
  // negation either — both fail for a non-boolean. This reads as a bug and is
  // kept anyway: an existing collection's results depend on it, and quietly
  // widening these to JS truthiness would flip passing assertions to failing
  // ones (and vice versa) with no change to the collection.
  isTruthy: {
    path: ['to', 'be', 'true'],
    negated: false,
    argument: NO_ARGUMENT,
    operandKind: 'none',
  },
  isFalsy: {
    path: ['to', 'be', 'false'],
    negated: false,
    argument: NO_ARGUMENT,
    operandKind: 'none',
  },
  isJson: { path: ['to', 'be', 'json'], negated: false, argument: NO_ARGUMENT, operandKind: 'none' },
  isNumber: {
    path: ['to', 'be', 'a'],
    negated: false,
    argument: { kind: 'fixed', value: 'number' },
    operandKind: 'none',
  },
  isString: {
    path: ['to', 'be', 'a'],
    negated: false,
    argument: { kind: 'fixed', value: 'string' },
    operandKind: 'none',
  },
  isBoolean: {
    path: ['to', 'be', 'a'],
    negated: false,
    argument: { kind: 'fixed', value: 'boolean' },
    operandKind: 'none',
  },
  // 'array' rather than 'Array': Bruno passes the lowercase name, which is what
  // chai's type check compares against.
  isArray: {
    path: ['to', 'be', 'a'],
    negated: false,
    argument: { kind: 'fixed', value: 'array' },
    operandKind: 'none',
  },
};

/**
 * Whether a string is one of the operator names.
 *
 * A set membership test rather than a type assertion, so an unrecognised string
 * from a .bru file cannot be waved through as an AssertOperator. The set is
 * built from the same tuple the union is derived from, which is what makes the
 * narrowing honest.
 */
export function isAssertOperator(value: string): value is AssertOperator {
  return OPERATOR_SET.has(value);
}

/** Whether an operator asserts something about the left-hand side alone. */
export function isUnaryOperator(operator: string): operator is UnaryAssertOperator {
  return UNARY_OPERATOR_SET.has(operator);
}

/** The chain for an operator. Total, because ASSERT_CHAINS is total. */
export function chainForOperator(operator: AssertOperator): AssertChain {
  return ASSERT_CHAINS[operator];
}

/** How an operator's operand should be read. */
export function operandKindForOperator(operator: AssertOperator): OperandKind {
  return ASSERT_CHAINS[operator].operandKind;
}

/**
 * The full property path for a chain, with the negation put back in.
 *
 * Returns a fresh array and never touches the stored chain, which is shared
 * between every assertion using that operator.
 */
export function assertChainPath(chain: AssertChain): readonly string[] {
  if (!chain.negated) {
    return chain.path;
  }
  return [...chain.path.slice(0, 1), 'not', ...chain.path.slice(1)];
}

/**
 * Split an assertion value into its operator and its operand.
 *
 * The value is `<operator> <operand>`, with two consequences worth stating
 * because they look like defects:
 *
 * 1. An unrecognised first token is not an error. The operator becomes `eq` and
 *    the operand becomes the ENTIRE original string, untrimmed — which is what
 *    makes a bare `200` mean `eq 200`, and equally what makes a misspelled
 *    `equals 200` a silently passing-or-failing equality check against the
 *    literal text "equals 200" instead of a reported mistake.
 *
 * 2. Only the plain space character separates the operator from the operand,
 *    and the remainder is rejoined with single spaces. Because each extra space
 *    contributes an empty token, a run of spaces inside the operand survives
 *    intact — but `eq  200` (two spaces) yields the operand " 200" with a
 *    leading space, and a tab instead of a space makes the whole value an
 *    unrecognised token that falls to case 1.
 *
 * Both are Bruno's behaviour and both are load-bearing for existing
 * collections, so neither is corrected here.
 */
export function parseAssertionOperator(value: string): ParsedAssertion {
  if (value === '') {
    return { operator: 'eq', operand: '' };
  }

  // split always yields at least one element, so the first token needs no
  // absent case: a whitespace-only value produces the empty string here, which
  // matches no operator and falls through to the eq default below.
  const tokens = value.trim().split(' ');
  const candidate = tokens[0];
  const remainder = tokens.slice(1).join(' ');

  // Unary first, matching Bruno's order: the operand is dropped rather than
  // kept, so a trailing word cannot reach an assertion that has no use for it.
  if (isUnaryOperator(candidate)) {
    return { operator: candidate, operand: '' };
  }

  if (isAssertOperator(candidate)) {
    return { operator: candidate, operand: remainder };
  }

  return { operator: 'eq', operand: value };
}

/**
 * Remove the optional `/.../` delimiters from a `matches` operand.
 *
 * Bruno accepts both `^ab+c$` and `/^ab+c$/`. Unlike Bruno, a lone `"/"` is
 * left alone: it starts and ends with a slash, so stripping both ends would
 * produce the empty pattern, and an empty pattern matches everything — an
 * assertion that can no longer fail. Returning it unchanged keeps it a regex
 * that means what it says.
 */
export function stripRegexDelimiters(operand: string): string {
  const delimited = operand.length > 1 && operand.startsWith('/') && operand.endsWith('/');
  return delimited ? operand.slice(1, -1) : operand;
}

/**
 * Split an `in`/`notIn`/`between` operand into its elements.
 *
 * Bruno accepts both `a, b` and `[a, b]`, splits on commas and trims each
 * element; the elements still need interpolating and evaluating, which is the
 * sandbox's job. Empty elements are kept, since Bruno maps over every split
 * result and an `a,,b` therefore carries three operands rather than two. As with
 * the regex delimiters, a lone `"["` is not treated as an empty list.
 */
export function splitOperandList(operand: string): readonly string[] {
  const bracketed = operand.length > 1 && operand.startsWith('[') && operand.endsWith(']');
  const inner = bracketed ? operand.slice(1, -1) : operand;
  return inner.split(',').map((element) => element.trim());
}
