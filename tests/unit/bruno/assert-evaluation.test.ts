/**
 * Declared `assert` blocks, evaluated inside the sandbox.
 *
 * assert-operators.test.ts covers the parsing half (value string -> operator +
 * operand + chain descriptor). This covers the other half: walking that
 * descriptor on the real expect() chain, coercing the operand the way Bruno's
 * evaluateJsTemplateLiteral does, and reporting one result per assertion.
 *
 * runTestJob is called directly rather than through TestRunner so a whole matrix
 * of operators runs without forking a child per case.
 */

import { runTestJob } from '../../../src/bruno/sandbox-worker';
import type { MockResponseData } from '../../../src/bruno/types';

const OK_BODY = {
  id: 7,
  name: 'widget',
  items: [1, 2, 3],
  empty: '',
  flag: true,
  nothing: null,
};

function response(overrides: Partial<MockResponseData> = {}): MockResponseData {
  return {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    body: OK_BODY,
    responseTime: 12,
    ...overrides,
  };
}

/** Evaluate one declared assertion with no script at all. */
function assertOne(name: string, value: string, res = response()) {
  const { results } = runTestJob('', res, 5000, undefined, [{ name, value }]);
  return results[0];
}

describe('declared assertions — evaluation', () => {
  it('evaluates an assertion when there is no post-response script at all', () => {
    const { results } = runTestJob('', response(), 5000, undefined, [
      { name: 'res.status', value: 'eq 200' },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ description: 'res.status eq 200', status: 'pass' });
  });

  it('reports a failing assertion with the matcher error', () => {
    const r = assertOne('res.status', 'eq 404');

    expect(r.status).toBe('fail');
    expect(r.description).toBe('res.status eq 404');
    expect(r.error).toMatch(/expected 200 to equal 404/);
  });

  it('reports one entry per assertion, in declaration order', () => {
    const { results } = runTestJob('', response(), 5000, undefined, [
      { name: 'res.status', value: 'eq 200' },
      { name: 'res.body.name', value: 'eq widget' },
      { name: 'res.body.id', value: 'eq 999' },
    ]);

    expect(results.map(r => [r.description, r.status])).toEqual([
      ['res.status eq 200', 'pass'],
      ['res.body.name eq widget', 'pass'],
      ['res.body.id eq 999', 'fail'],
    ]);
  });

  it('returns no results when there are neither assertions nor a script', () => {
    expect(runTestJob('', response(), 5000, undefined, [])).toEqual({
      results: [],
      variables: {},
    });
  });

  it('treats a bare operand as eq', () => {
    expect(assertOne('res.status', '200')).toEqual({
      description: 'res.status eq 200',
      status: 'pass',
    });
  });

  it('exposes the Bruno response properties the left-hand side reads', () => {
    const { results } = runTestJob('', response(), 5000, undefined, [
      { name: 'res.status', value: 'eq 200' },
      { name: 'res.statusText', value: 'eq OK' },
      { name: 'res.responseTime', value: 'lt 1000' },
      { name: 'res.headers["content-type"]', value: 'contains json' },
      { name: 'res.body.name', value: 'isString' },
    ]);

    expect(results.every(r => r.status === 'pass')).toBe(true);
  });

  it('still exposes the getter-style response API to scripts', () => {
    const { results } = runTestJob(
      'test("t", function() { expect(res.getStatus()).to.equal(200); });',
      response(),
      5000,
    );

    expect(results[0].status).toBe('pass');
  });
});

describe('declared assertions — operator chains', () => {
  const passing: Array<[string, string]> = [
    ['eq', 'eq 200'],
    ['neq', 'neq 500'],
    ['gt', 'gt 199'],
    ['gte', 'gte 200'],
    ['lt', 'lt 201'],
    ['lte', 'lte 200'],
    ['in', 'in 200, 201'],
    ['in bracketed', 'in [200, 201]'],
    ['notIn', 'notIn 500, 503'],
    ['between', 'between 200, 299'],
    ['matches', 'matches ^2'],
    ['matches delimited', 'matches /^2/'],
    ['notMatches', 'notMatches ^5'],
    ['isDefined', 'isDefined'],
    ['isNumber', 'isNumber'],
    ['isNotEmpty', 'isNotEmpty'],
  ];

  it.each(passing)('res.status %s passes', (_label, value) => {
    expect(assertOne('res.status', value).status).toBe('pass');
  });

  const failing: Array<[string, string, RegExp]> = [
    ['eq', 'eq 201', /expected 200 to equal 201/],
    ['neq', 'neq 200', /to not equal 200/],
    ['gt', 'gt 200', /to be above 200/],
    ['lt', 'lt 200', /to be below 200/],
    ['in', 'in 201, 202', /to be one of \[201, 202\]/],
    ['notIn', 'notIn 200, 201', /to not be one of/],
    ['between', 'between 300, 399', /to be within 300\.\.399/],
    ['matches', 'matches ^5', /to match/],
    ['isUndefined', 'isUndefined', /to be undefined/],
    ['isString', 'isString', /to be a\(n\) string/],
    ['isArray', 'isArray', /to be a\(n\) array/],
  ];

  it.each(failing)('res.status %s fails', (_label, value, pattern) => {
    const r = assertOne('res.status', value);
    expect(r.status).toBe('fail');
    expect(r.error).toMatch(pattern);
  });

  it('walks the length chain against an array', () => {
    expect(assertOne('res.body.items', 'length 3').status).toBe('pass');
    expect(assertOne('res.body.items', 'length 4').error).toMatch(/to have length 4/);
  });

  it('walks the string chains', () => {
    expect(assertOne('res.body.name', 'startsWith wid').status).toBe('pass');
    expect(assertOne('res.body.name', 'endsWith get').status).toBe('pass');
    expect(assertOne('res.body.name', 'contains idg').status).toBe('pass');
    expect(assertOne('res.body.name', 'notContains zzz').status).toBe('pass');
  });

  it('walks the property-style unary chains', () => {
    expect(assertOne('res.body.empty', 'isEmpty').status).toBe('pass');
    expect(assertOne('res.body.nothing', 'isNull').status).toBe('pass');
    expect(assertOne('res.body.flag', 'isTruthy').status).toBe('pass');
    expect(assertOne('res.body', 'isJson').status).toBe('pass');
    expect(assertOne('res.body.missing', 'isUndefined').status).toBe('pass');
    expect(assertOne('res.body.flag', 'isBoolean').status).toBe('pass');
  });

  it('drops a trailing operand a unary operator has no use for', () => {
    expect(assertOne('res.body.id', 'isDefined ignored').description).toBe(
      'res.body.id isDefined',
    );
  });
});

describe('declared assertions — operand coercion', () => {
  const coercions: Array<[string, string, 'pass' | 'fail']> = [
    ['numeric string becomes a number', 'eq 200', 'pass'],
    ['quoted number stays a string', 'eq "200"', 'fail'],
    ['single-quoted number stays a string', "eq '200'", 'fail'],
  ];

  it.each(coercions)('%s', (_label, value, expected) => {
    expect(assertOne('res.status', value).status).toBe(expected);
  });

  it('coerces the boolean, null and undefined keywords', () => {
    const res = response();
    expect(assertOne('res.body.flag', 'eq true', res).status).toBe('pass');
    expect(assertOne('res.body.flag', 'eq false', res).status).toBe('fail');
    expect(assertOne('res.body.nothing', 'eq null', res).status).toBe('pass');
    expect(assertOne('res.body.missing', 'eq undefined', res).status).toBe('pass');
  });

  it('keeps a bare word as a string rather than failing to resolve it', () => {
    const r = assertOne('res.body.name', 'eq widget');
    expect(r.status).toBe('pass');
    expect(r.error).toBeUndefined();
  });

  it('unwraps a quoted operand without interpolating it', () => {
    const res = response({ body: { greeting: '{{name}} hi' } });
    expect(assertOne('res.body.greeting', 'eq "{{name}} hi"', res).status).toBe('pass');
  });

  it('keeps a number beyond MAX_SAFE_INTEGER as a string', () => {
    // 9007199254740993 cannot be represented, so Number() would alter it and an
    // equality check against the response's own string would then fail.
    const big = '9007199254740993';
    const res = response({ body: { id: big } });
    expect(assertOne('res.body.id', `eq ${big}`, res).status).toBe('pass');
  });

  it('coerces each element of a list operand', () => {
    const res = response({ body: { flag: true } });
    expect(assertOne('res.body.flag', 'in false, true', res).status).toBe('pass');
    expect(assertOne('res.status', 'in "200", 201').status).toBe('fail');
  });

  it('coerces both bounds of a range operand', () => {
    expect(assertOne('res.status', 'between 200, 200').status).toBe('pass');
    expect(assertOne('res.status', 'between "100", "300"').status).toBe('fail');
  });

  it('fails a between whose operand is not a pair', () => {
    const r = assertOne('res.status', 'between 200');
    expect(r.status).toBe('fail');
    expect(r.error).toMatch(/two/i);
  });
});

describe('declared assertions — isolation', () => {
  it('fails only itself when the left-hand expression is a syntax error', () => {
    const { results } = runTestJob('', response(), 5000, undefined, [
      { name: 'res.status', value: 'eq 200' },
      { name: 'res.status ===', value: 'eq 200' },
      { name: 'res.body.id', value: 'eq 7' },
    ]);

    expect(results).toHaveLength(3);
    expect(results[0].status).toBe('pass');
    expect(results[1].status).toBe('fail');
    expect(results[1].description).toBe('res.status === eq 200');
    expect(results[2].status).toBe('pass');
  });

  it('fails only itself when the left-hand expression throws', () => {
    const { results } = runTestJob('', response(), 5000, undefined, [
      { name: 'res.body.missing.deeper', value: 'eq 1' },
      { name: 'res.status', value: 'eq 200' },
    ]);

    expect(results[0].status).toBe('fail');
    expect(results[0].error).toBeDefined();
    expect(results[1].status).toBe('pass');
  });

  it('fails only itself when the left-hand expression names an unknown global', () => {
    const { results } = runTestJob('', response(), 5000, undefined, [
      { name: 'notDefinedAnywhere.x', value: 'eq 1' },
      { name: 'res.status', value: 'eq 200' },
    ]);

    expect(results[0].status).toBe('fail');
    expect(results[1].status).toBe('pass');
  });

  it('evaluates assertions and the post-response script in one run', () => {
    const { results } = runTestJob(
      'test("script ran", function() { expect(res.getStatus()).to.equal(200); });',
      response(),
      5000,
      undefined,
      [{ name: 'res.status', value: 'eq 200' }],
    );

    expect(results.map(r => [r.description, r.status])).toEqual([
      ['res.status eq 200', 'pass'],
      ['script ran', 'pass'],
    ]);
  });

  it('still reports assertions when the post-response script throws', () => {
    const { results } = runTestJob(
      'throw new Error("boom");',
      response(),
      5000,
      undefined,
      [{ name: 'res.status', value: 'eq 200' }],
    );

    expect(results[0]).toEqual({ description: 'res.status eq 200', status: 'pass' });
    expect(results[results.length - 1].description).toBe('Script error');
  });

  it('still reports assertions when the post-response script cannot compile', () => {
    const { results } = runTestJob(
      'function ( {',
      response(),
      5000,
      undefined,
      [{ name: 'res.status', value: 'eq 200' }],
    );

    expect(results[0].status).toBe('pass');
    expect(results[results.length - 1].description).toBe('Script error');
  });

  it('lets an assertion read a seeded variable via bru.getVar', () => {
    const { results } = runTestJob(
      '',
      response(),
      5000,
      { expectedStatus: 200 },
      [{ name: 'bru.getVar("expectedStatus")', value: 'eq 200' }],
    );

    expect(results[0].status).toBe('pass');
  });

  it('counts only the script own blocks in the unreported-assertion warning', () => {
    const { warnings } = runTestJob(
      'expect(res.getStatus()).to.equal(200);\ntest("one", function() {});',
      response(),
      5000,
      undefined,
      [{ name: 'res.status', value: 'eq 200' }],
    );

    // One test() block, not two: the declared assertion also produced an entry.
    expect(warnings?.[0]).toMatch(/Only the 1 test\(\) block /);
  });

  it('does not let an assertion operand become executable source', () => {
    // The operand crosses as data, so a quote-and-paren payload can only ever be
    // compared as a string; it must not run and must not break the run.
    const { results } = runTestJob('', response(), 5000, undefined, [
      { name: 'res.body.name', value: 'eq "); __results.length = 0; ("' },
      { name: 'res.status', value: 'eq 200' },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('fail');
    expect(results[1].status).toBe('pass');
  });
});
