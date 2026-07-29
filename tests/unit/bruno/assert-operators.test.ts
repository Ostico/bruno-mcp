/**
 * These tests are a behavioural transcription of Bruno's own
 * packages/bruno-js/src/runtime/assert-runtime.js, not a specification of what
 * an assertion parser "should" do. Several expectations below look wrong in
 * isolation (whitespace surviving inside an operand, `isTruthy` meaning
 * strictly `true`, a trailing operand being discarded rather than rejected);
 * they are asserted deliberately, because a collection written against Bruno
 * has to keep passing here. Where Bruno's behaviour is surprising, the test
 * name says so.
 */

import {
  ASSERT_CHAINS,
  ASSERT_OPERATORS,
  UNARY_ASSERT_OPERATORS,
  assertChainPath,
  chainForOperator,
  isAssertOperator,
  isUnaryOperator,
  operandKindForOperator,
  parseAssertionOperator,
  splitOperandList,
  stripRegexDelimiters,
  type AssertOperator,
} from '../../../src/bruno/assert-operators';

/** The 16 operators that consume an operand, in Bruno's declaration order. */
const BINARY_OPERATORS: readonly AssertOperator[] = [
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
];

/** The 6 operators Bruno expresses as a negation of another operator's chain. */
const NEGATED_OPERATORS: readonly AssertOperator[] = [
  'neq',
  'notIn',
  'notContains',
  'notMatches',
  'isNotEmpty',
  'isDefined',
];

describe('operator inventory', () => {
  it('declares exactly the 28 operators Bruno accepts', () => {
    expect(ASSERT_OPERATORS).toHaveLength(28);
    expect([...ASSERT_OPERATORS]).toEqual([
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
    ]);
  });

  it('declares exactly the 12 unary operators Bruno accepts', () => {
    expect(UNARY_ASSERT_OPERATORS).toHaveLength(12);
    expect([...UNARY_ASSERT_OPERATORS]).toEqual([
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
    ]);
  });

  it('partitions the operators into unary and binary with no overlap or gap', () => {
    const union = [...UNARY_ASSERT_OPERATORS, ...BINARY_OPERATORS];
    expect(new Set(union).size).toBe(union.length);
    expect(new Set(union)).toEqual(new Set(ASSERT_OPERATORS));
  });
});

describe('isAssertOperator', () => {
  it.each([...ASSERT_OPERATORS])('recognises %s', (operator) => {
    expect(isAssertOperator(operator)).toBe(true);
  });

  it.each([
    ['', 'the empty string'],
    ['EQ', 'a differently cased operator'],
    ['equals', 'a word that merely resembles an operator'],
    ['isempty', 'a lowercased unary operator'],
    ['200', 'a bare value'],
    ['toString', 'an Object.prototype key'],
    ['constructor', 'another Object.prototype key'],
  ])('rejects %s (%s)', (candidate) => {
    expect(isAssertOperator(candidate)).toBe(false);
  });
});

describe('isUnaryOperator', () => {
  it.each([...UNARY_ASSERT_OPERATORS])('reports %s as unary', (operator) => {
    expect(isUnaryOperator(operator)).toBe(true);
  });

  it.each([...BINARY_OPERATORS])('reports %s as not unary', (operator) => {
    expect(isUnaryOperator(operator)).toBe(false);
  });

  it.each(['', 'IsEmpty', 'isBlank', 'constructor'])(
    'reports the unrecognised %p as not unary',
    (candidate) => {
      expect(isUnaryOperator(candidate)).toBe(false);
    },
  );
});

describe('parseAssertionOperator: recognised operators', () => {
  it.each([...BINARY_OPERATORS])('parses "%s <operand>" keeping the operand', (operator) => {
    expect(parseAssertionOperator(`${operator} 200`)).toEqual({ operator, operand: '200' });
  });

  it.each([...UNARY_ASSERT_OPERATORS])('parses the bare unary %s', (operator) => {
    expect(parseAssertionOperator(operator)).toEqual({ operator, operand: '' });
  });

  it.each([...UNARY_ASSERT_OPERATORS])(
    'discards trailing text after the unary %s rather than rejecting it',
    (operator) => {
      expect(parseAssertionOperator(`${operator} ignored text here`)).toEqual({
        operator,
        operand: '',
      });
    },
  );

  it.each([...BINARY_OPERATORS])('yields an empty operand for a bare %s', (operator) => {
    expect(parseAssertionOperator(operator)).toEqual({ operator, operand: '' });
  });

  it('keeps a multi-word operand as one operand', () => {
    expect(parseAssertionOperator('contains hello world')).toEqual({
      operator: 'contains',
      operand: 'hello world',
    });
  });

  it('parses the comma-separated operand of in as a single raw string', () => {
    expect(parseAssertionOperator('in 200, 201, 204')).toEqual({
      operator: 'in',
      operand: '200, 201, 204',
    });
  });

  it('parses a bracketed in operand without unwrapping it', () => {
    // Unwrapping is the operand stage's job, not the parser's: Bruno strips the
    // brackets in evaluateRhsOperand, after parsing. splitOperandList covers it.
    expect(parseAssertionOperator('in [200, 201]')).toEqual({
      operator: 'in',
      operand: '[200, 201]',
    });
  });

  it('parses a between operand as a single raw string', () => {
    expect(parseAssertionOperator('between 200, 299')).toEqual({
      operator: 'between',
      operand: '200, 299',
    });
  });

  it('parses a slash-delimited matches operand without unwrapping it', () => {
    // Same split of responsibilities as the bracketed list above: the delimiters
    // survive parsing and are removed by stripRegexDelimiters.
    expect(parseAssertionOperator('matches /^ab+c$/')).toEqual({
      operator: 'matches',
      operand: '/^ab+c$/',
    });
  });
});

describe('stripRegexDelimiters', () => {
  it('removes a matched pair of slashes', () => {
    expect(stripRegexDelimiters('/^ab+c$/')).toBe('^ab+c$');
  });

  it('leaves an undelimited source alone', () => {
    expect(stripRegexDelimiters('^ab+c$')).toBe('^ab+c$');
  });

  it('leaves a source with only a leading slash alone', () => {
    expect(stripRegexDelimiters('/^ab+c$')).toBe('/^ab+c$');
  });

  it('leaves a source with only a trailing slash alone', () => {
    expect(stripRegexDelimiters('^ab+c$/')).toBe('^ab+c$/');
  });

  it('does not mistake a lone slash for a delimited empty pattern', () => {
    // A single "/" satisfies both startsWith and endsWith, and Bruno's
    // substring(1, length - 1) would turn it into "" — a regex matching
    // everything. Guarded here because that silently passes any assertion.
    expect(stripRegexDelimiters('/')).toBe('/');
  });

  it('keeps interior slashes', () => {
    expect(stripRegexDelimiters('/a\\/b/')).toBe('a\\/b');
  });

  it('leaves the empty string alone', () => {
    expect(stripRegexDelimiters('')).toBe('');
  });
});

describe('splitOperandList', () => {
  it('splits a bare comma-separated list and trims each element', () => {
    expect(splitOperandList('200, 201, 204')).toEqual(['200', '201', '204']);
  });

  it('unwraps a bracketed list before splitting', () => {
    expect(splitOperandList('[200, 201]')).toEqual(['200', '201']);
  });

  it('requires both brackets to unwrap', () => {
    expect(splitOperandList('[200')).toEqual(['[200']);
    expect(splitOperandList('200]')).toEqual(['200]']);
  });

  it('yields a single element for a list without commas', () => {
    expect(splitOperandList('200')).toEqual(['200']);
  });

  it('keeps empty elements produced by adjacent commas', () => {
    // Bruno maps over every split result, so "a,,b" is three operands and the
    // empty one becomes an operand in its own right rather than disappearing.
    expect(splitOperandList('a,,b')).toEqual(['a', '', 'b']);
  });

  it('yields one empty element for an empty list', () => {
    expect(splitOperandList('')).toEqual(['']);
    expect(splitOperandList('[]')).toEqual(['']);
  });

  it('does not mistake a lone bracket for an empty list', () => {
    expect(splitOperandList('[')).toEqual(['[']);
  });
});

describe('parseAssertionOperator: whitespace', () => {
  it('trims the input before looking for the operator', () => {
    expect(parseAssertionOperator('   eq 200   ')).toEqual({ operator: 'eq', operand: '200' });
  });

  it('preserves a run of spaces inside the operand', () => {
    expect(parseAssertionOperator('contains hello   world')).toEqual({
      operator: 'contains',
      operand: 'hello   world',
    });
  });

  it('leaves a leading space on the operand when the operator is followed by two spaces', () => {
    // Surprising but faithful: Bruno splits on the single space character and
    // rejoins the remainder, so the extra separator becomes part of the operand.
    expect(parseAssertionOperator('eq  200')).toEqual({ operator: 'eq', operand: ' 200' });
  });

  it('treats a tab after the operator as part of an unrecognised first token', () => {
    // split(' ') does not split on tabs, so "eq\t200" is one token, matches no
    // operator, and falls through to the eq default carrying the whole string.
    expect(parseAssertionOperator('eq\t200')).toEqual({ operator: 'eq', operand: 'eq\t200' });
  });

  it('treats a newline after the operator the same way', () => {
    expect(parseAssertionOperator('eq\n200')).toEqual({ operator: 'eq', operand: 'eq\n200' });
  });
});

describe('parseAssertionOperator: the eq default', () => {
  it('reads a bare number as an equality check against it', () => {
    expect(parseAssertionOperator('200')).toEqual({ operator: 'eq', operand: '200' });
  });

  it('reads a bare multi-word string as an equality check against the whole string', () => {
    expect(parseAssertionOperator('hello world')).toEqual({
      operator: 'eq',
      operand: 'hello world',
    });
  });

  it('does not treat a word that merely resembles an operator as one', () => {
    expect(parseAssertionOperator('equals 200')).toEqual({
      operator: 'eq',
      operand: 'equals 200',
    });
  });

  it('is case sensitive about operator names', () => {
    expect(parseAssertionOperator('EQ 200')).toEqual({ operator: 'eq', operand: 'EQ 200' });
  });

  it('does not accept an inherited Object.prototype key as an operator', () => {
    expect(parseAssertionOperator('constructor 1')).toEqual({
      operator: 'eq',
      operand: 'constructor 1',
    });
  });

  it('returns the ORIGINAL untrimmed string as the operand when falling back', () => {
    // The recognised-operator paths operate on the trimmed string, but the
    // default path returns the input verbatim. Preserved because a collection
    // asserting an operand with meaningful surrounding whitespace depends on it.
    expect(parseAssertionOperator('  hello  ')).toEqual({ operator: 'eq', operand: '  hello  ' });
  });

  it('reads the empty string as an equality check against the empty string', () => {
    expect(parseAssertionOperator('')).toEqual({ operator: 'eq', operand: '' });
  });

  it('reads a whitespace-only input as an equality check against that whitespace', () => {
    expect(parseAssertionOperator('   ')).toEqual({ operator: 'eq', operand: '   ' });
  });
});

describe('ASSERT_CHAINS', () => {
  it('has an entry for every operator and no others', () => {
    expect(Object.keys(ASSERT_CHAINS).sort()).toEqual([...ASSERT_OPERATORS].sort());
  });

  it.each([
    ['eq', ['to', 'equal'], false, 'operand', 'literal'],
    ['neq', ['to', 'equal'], true, 'operand', 'literal'],
    ['gt', ['to', 'be', 'greaterThan'], false, 'operand', 'literal'],
    ['gte', ['to', 'be', 'greaterThanOrEqual'], false, 'operand', 'literal'],
    ['lt', ['to', 'be', 'lessThan'], false, 'operand', 'literal'],
    ['lte', ['to', 'be', 'lessThanOrEqual'], false, 'operand', 'literal'],
    ['in', ['to', 'be', 'oneOf'], false, 'operand', 'list'],
    ['notIn', ['to', 'be', 'oneOf'], true, 'operand', 'list'],
    ['contains', ['to', 'include'], false, 'operand', 'literal'],
    ['notContains', ['to', 'include'], true, 'operand', 'literal'],
    ['length', ['to', 'have', 'lengthOf'], false, 'operand', 'literal'],
    ['matches', ['to', 'match'], false, 'operand', 'regexSource'],
    ['notMatches', ['to', 'match'], true, 'operand', 'regexSource'],
    ['startsWith', ['to', 'startWith'], false, 'operand', 'literal'],
    ['endsWith', ['to', 'endWith'], false, 'operand', 'literal'],
    ['between', ['to', 'be', 'within'], false, 'spreadOperand', 'range'],
    ['isEmpty', ['to', 'be', 'empty'], false, 'none', 'none'],
    ['isNotEmpty', ['to', 'be', 'empty'], true, 'none', 'none'],
    ['isNull', ['to', 'be', 'null'], false, 'none', 'none'],
    ['isUndefined', ['to', 'be', 'undefined'], false, 'none', 'none'],
    ['isDefined', ['to', 'be', 'undefined'], true, 'none', 'none'],
    ['isJson', ['to', 'be', 'json'], false, 'none', 'none'],
  ] as const)(
    'maps %s to the chain Bruno uses for it',
    (operator, path, negated, argumentKind, operandKind) => {
      const chain = chainForOperator(operator);
      expect(chain.path).toEqual(path);
      expect(chain.negated).toBe(negated);
      expect(chain.argument.kind).toBe(argumentKind);
      expect(chain.operandKind).toBe(operandKind);
    },
  );

  it('maps isTruthy to a STRICT true check, not a truthiness check', () => {
    // Bruno compiles `isTruthy` to `expect(lhs).to.be.true`, which fails for 1
    // or "yes". The name promises truthiness; the behaviour is strict equality
    // with `true`. Ported as-is so a collection's results do not change.
    const chain = chainForOperator('isTruthy');
    expect(chain.path).toEqual(['to', 'be', 'true']);
    expect(chain.negated).toBe(false);
    expect(chain.argument.kind).toBe('none');
  });

  it('maps isFalsy to a STRICT false check, not a falsiness check', () => {
    // Same asymmetry as isTruthy: `expect(lhs).to.be.false` fails for 0, "" or
    // null. It is not the negation of isTruthy either — both can fail.
    const chain = chainForOperator('isFalsy');
    expect(chain.path).toEqual(['to', 'be', 'false']);
    expect(chain.negated).toBe(false);
    expect(chain.argument.kind).toBe('none');
  });

  it.each([
    ['isNumber', 'number'],
    ['isString', 'string'],
    ['isBoolean', 'boolean'],
    ['isArray', 'array'],
  ] as const)('maps %s to a fixed-argument type check on %p', (operator, typeName) => {
    const chain = chainForOperator(operator);
    expect(chain.path).toEqual(['to', 'be', 'a']);
    expect(chain.negated).toBe(false);
    expect(chain.operandKind).toBe('none');
    expect(chain.argument).toEqual({ kind: 'fixed', value: typeName });
  });

  it('negates exactly the six operators Bruno spells with .not', () => {
    const negated = [...ASSERT_OPERATORS].filter((operator) => ASSERT_CHAINS[operator].negated);
    expect(negated.sort()).toEqual([...NEGATED_OPERATORS].sort());
  });

  it('gives every chain a path starting at to', () => {
    for (const operator of ASSERT_OPERATORS) {
      expect(ASSERT_CHAINS[operator].path[0]).toBe('to');
    }
  });
});

describe('operandKindForOperator', () => {
  it('classifies an operand kind of none for exactly the unary operators', () => {
    const noneKinded = [...ASSERT_OPERATORS].filter(
      (operator) => operandKindForOperator(operator) === 'none',
    );
    expect(noneKinded.sort()).toEqual([...UNARY_ASSERT_OPERATORS].sort());
  });

  it('never asks a unary operator to consume the operand', () => {
    for (const operator of UNARY_ASSERT_OPERATORS) {
      expect(ASSERT_CHAINS[operator].argument.kind).not.toBe('operand');
      expect(ASSERT_CHAINS[operator].argument.kind).not.toBe('spreadOperand');
    }
  });

  it('asks every binary operator to consume the operand', () => {
    for (const operator of BINARY_OPERATORS) {
      expect(['operand', 'spreadOperand']).toContain(ASSERT_CHAINS[operator].argument.kind);
      expect(operandKindForOperator(operator)).not.toBe('none');
    }
  });

  it.each([
    ['in', 'list'],
    ['notIn', 'list'],
    ['between', 'range'],
    ['matches', 'regexSource'],
    ['notMatches', 'regexSource'],
  ] as const)('classifies the operand of %s as %s', (operator, kind) => {
    expect(operandKindForOperator(operator)).toBe(kind);
  });

  it('classifies every other binary operand as a plain literal', () => {
    const literalKinded = [...BINARY_OPERATORS].filter(
      (operator) => operandKindForOperator(operator) === 'literal',
    );
    expect(literalKinded.sort()).toEqual(
      [
        'contains',
        'endsWith',
        'eq',
        'gt',
        'gte',
        'length',
        'lt',
        'lte',
        'neq',
        'notContains',
        'startsWith',
      ].sort(),
    );
  });
});

describe('assertChainPath', () => {
  it('leaves a non-negated chain untouched', () => {
    expect(assertChainPath(chainForOperator('eq'))).toEqual(['to', 'equal']);
    expect(assertChainPath(chainForOperator('between'))).toEqual(['to', 'be', 'within']);
  });

  it.each([
    ['neq', ['to', 'not', 'equal']],
    ['notIn', ['to', 'not', 'be', 'oneOf']],
    ['notContains', ['to', 'not', 'include']],
    ['notMatches', ['to', 'not', 'match']],
    ['isNotEmpty', ['to', 'not', 'be', 'empty']],
    ['isDefined', ['to', 'not', 'be', 'undefined']],
  ] as const)('inserts not directly after to for %s', (operator, expected) => {
    expect(assertChainPath(chainForOperator(operator))).toEqual(expected);
  });

  it('does not mutate the stored chain', () => {
    const chain = chainForOperator('neq');
    assertChainPath(chain);
    expect(chain.path).toEqual(['to', 'equal']);
  });
});
