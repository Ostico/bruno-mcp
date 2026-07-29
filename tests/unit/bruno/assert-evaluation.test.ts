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

describe('an assertion that never finishes is the run timing out, not one check failing', () => {
  // Assertions are isolated so a broken one fails only itself — but a timeout
  // must NOT be caught that way. A V8 timeout force-terminates the whole
  // context, so nothing further can run in it; swallowing it and moving to the
  // next assertion would mean the remaining ones evaluate in a dead context and
  // the run's own timeout handling never sees the problem. A left-hand
  // expression is arbitrary JS from the collection, so a loop here is reachable.
  const looping = [{ name: '(function () { while (true) {} })()', value: 'isDefined' }];

  it('reports the run as timed out rather than as one failed assertion', () => {
    const { results } = runTestJob('', response(), 50, undefined, looping);

    // The timeout escapes the per-assertion isolation, and the job turns it into
    // a single run-level failure. It is deliberately not attributed to the
    // assertion: once the context is terminated the run is over, not merely one
    // check.
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('fail');
    expect(results[0].error).toMatch(/timed out/i);
  });

  it('never reports the looping assertion as passing', () => {
    // The failure mode that would matter most: a check that never ran counted as
    // green, which is the exact shape of the defect this feature fixes.
    const { results } = runTestJob('', response(), 50, undefined, looping);

    expect(results.some((r) => r.status === 'pass')).toBe(false);
  });
});

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

    // toEqual on the whole array, not results.every(...): `every` answers true
    // for an empty array, so a version of this test that only checked the
    // predicate would still pass with assertion evaluation removed entirely —
    // and this is the only coverage for the res.* properties being defined at
    // all, which every property-style left-hand side depends on.
    expect(results).toEqual([
      { description: 'res.status eq 200', status: 'pass' },
      { description: 'res.statusText eq OK', status: 'pass' },
      { description: 'res.responseTime lt 1000', status: 'pass' },
      { description: 'res.headers["content-type"] contains json', status: 'pass' },
      { description: 'res.body.name isString', status: 'pass' },
    ]);
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
    // Extra bounds are dropped, not rejected: upstream destructures the first
    // two and ignores the rest, so this is within(200, 299) and passes.
    ['between with extra bounds', 'between 200, 299, 999'],
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
    // A number has no notion of emptiness. chai throws for one instead of
    // answering false, and a throw survives negation — so Bruno fails this and
    // so must we. Answering false would report a bare number as "has content".
    ['isNotEmpty on a number', 'isNotEmpty', /non-string primitive 200/],
    // Bruno strips brackets for `in`/`notIn` only, so `between` receives the
    // bounds "[200" and "299]" — both NaN — and fails. Stripping them here
    // would turn a Bruno failure into a pass.
    ['between bracketed', 'between [200, 299]', /is not a number/],
    ['between with one bound', 'between 200', /is not a number/],
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

  // isFalsy's chain path was asserted only in the operator table, which never
  // walks a real expect(). Nothing verified that ['to','be','false'] resolves.
  it('walks isFalsy, strictly', () => {
    const res = response({ body: { ...OK_BODY, off: false, zero: 0 } });
    expect(assertOne('res.body.off', 'isFalsy', res).status).toBe('pass');
    expect(assertOne('res.body.flag', 'isFalsy', res).error).toMatch(/to be false/);
    // Strict, not JS falsiness — 0 is falsy in JS but is not `false`.
    expect(assertOne('res.body.zero', 'isFalsy', res).error).toMatch(/to be false/);
  });

  // isNotEmpty must still pass where the value genuinely has content; the
  // precondition added for the non-collection case must not swallow these.
  it('passes isNotEmpty for values that have a notion of content', () => {
    expect(assertOne('res.body.name', 'isNotEmpty').status).toBe('pass');
    expect(assertOne('res.body.items', 'isNotEmpty').status).toBe('pass');
    expect(assertOne('res.body', 'isNotEmpty').status).toBe('pass');
    expect(assertOne('res.body.empty', 'isNotEmpty').error).toMatch(/to not be empty/);
  });

  // Asserting on the description alone would pass even if the operand leaked
  // into the call, because planAssertion builds the description either way. The
  // outcome assertion is what pins the drop: `isDefined 999` must behave like
  // bare `isDefined`, not like a comparison against 999.
  it('drops a trailing operand a unary operator has no use for', () => {
    const r = assertOne('res.body.id', 'isDefined ignored');
    expect(r.description).toBe('res.body.id isDefined');
    expect(r.status).toBe('pass');
    // res.body.id is 7; a leaked operand reaching a comparison would fail here.
    expect(assertOne('res.body.id', 'isDefined 999').status).toBe('pass');
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

  it('fails a between with a missing bound the way chai does', () => {
    // No arity check of our own: upstream destructures [lhs, rhs] and hands the
    // missing bound to chai as undefined, which rejects it as a non-number. A
    // custom "expected two bounds" error would be clearer but would also be a
    // different failure than the one Bruno reports.
    const r = assertOne('res.status', 'between 200');
    expect(r.status).toBe('fail');
    expect(r.error).toMatch(/undefined is not a number/);
  });
});

describe('declared assertions — operand interpolation', () => {
  // The pre-existing coverage only asserted that an UNRESOLVED placeholder is
  // left alone, which is the one case where interpolating and not interpolating
  // agree. A SET variable is the divergent case, and it was untested.
  it('resolves a {{var}} operand against the seeded variables', () => {
    const { results } = runTestJob('', response(), 5000, { expected: 200 }, [
      { name: 'res.status', value: 'eq {{expected}}' },
    ]);
    expect(results[0].status).toBe('pass');
  });

  it('reports the operand as the author wrote it, not as resolved', () => {
    const { results } = runTestJob('', response(), 5000, { expected: 200 }, [
      { name: 'res.status', value: 'eq {{expected}}' },
    ]);
    expect(results[0].description).toBe('res.status eq {{expected}}');
  });

  it('interpolates every element of a list operand', () => {
    const { results } = runTestJob('', response(), 5000, { ok: 200, alt: 201 }, [
      { name: 'res.status', value: 'in {{ok}}, {{alt}}' },
    ]);
    expect(results[0].status).toBe('pass');
  });

  it('interpolates both bounds of a range operand', () => {
    const { results } = runTestJob('', response(), 5000, { lo: 200, hi: 299 }, [
      { name: 'res.status', value: 'between {{lo}}, {{hi}}' },
    ]);
    expect(results[0].status).toBe('pass');
  });

  it('interpolates a regex operand', () => {
    const { results } = runTestJob('', response(), 5000, { prefix: '^2' }, [
      { name: 'res.status', value: 'matches {{prefix}}' },
    ]);
    expect(results[0].status).toBe('pass');
  });

  it('leaves an unresolved placeholder as written, so the miss is visible', () => {
    const { results } = runTestJob('', response(), 5000, {}, [
      { name: 'res.status', value: 'eq {{nope}}' },
    ]);
    expect(results[0].status).toBe('fail');
    expect(results[0].error).toMatch(/\{\{nope\}\}/);
  });

  // Interpolating the whole value before parsing would read a variable's own
  // text as the operator. Upstream parses first, so a bare {{v}} holding
  // "eq 200" is an equality check against the STRING "eq 200".
  it('never lets a variable value be read as the operator', () => {
    const { results } = runTestJob('', response(), 5000, { v: 'eq 200' }, [
      { name: 'res.status', value: '{{v}}' },
    ]);
    expect(results[0].status).toBe('fail');
    expect(results[0].description).toBe('res.status eq {{v}}');
  });

  it('leaves the placeholder alone for a variable whose value is null', () => {
    // A null-valued variable is not a resolution: substituting "null" as text
    // would silently compare against the four characters n-u-l-l.
    const { results } = runTestJob('', response(), 5000, { nothing: null }, [
      { name: 'res.status', value: 'eq {{nothing}}' },
    ]);
    expect(results[0].status).toBe('fail');
    expect(results[0].error).toMatch(/\{\{nothing\}\}/);
  });

  it('does not resolve inherited property names', () => {
    const { results } = runTestJob('', response(), 5000, {}, [
      { name: 'res.status', value: 'eq {{constructor}}' },
    ]);
    expect(results[0].status).toBe('fail');
    expect(results[0].error).toMatch(/\{\{constructor\}\}/);
  });
});

describe('declared assertions — order relative to the post-response script', () => {
  // Bruno's bruno-cli finishes the post-response script and only then calls
  // runAssertions, so an assertion can observe what the script wrote.
  it('lets an assertion see a variable the script set', () => {
    const { results } = runTestJob(
      'bru.setVar("token", "abc");',
      response(),
      5000,
      undefined,
      [{ name: 'bru.getVar("token")', value: 'eq abc' }],
    );
    const assertion = results.find(r => r.description.startsWith('bru.getVar'));
    expect(assertion?.status).toBe('pass');
  });

  it('reports script results before assertion results', () => {
    const { results } = runTestJob(
      'test("script ran", function () { expect(1).to.equal(1); });',
      response(),
      5000,
      undefined,
      [{ name: 'res.status', value: 'eq 200' }],
    );
    expect(results.map(r => r.description)).toEqual([
      'script ran',
      'res.status eq 200',
    ]);
  });

  // The isolation the old order bought must survive the reorder: a script that
  // does not even parse must not discard the declared assertions.
  it('still evaluates assertions when the script does not parse', () => {
    const { results } = runTestJob('this is not javascript', response(), 5000, undefined, [
      { name: 'res.status', value: 'eq 200' },
    ]);
    expect(results.find(r => r.description === 'res.status eq 200')?.status).toBe('pass');
    expect(results.find(r => r.description === 'Script error')?.status).toBe('fail');
  });

  it('still evaluates assertions when the script throws at runtime', () => {
    const { results } = runTestJob('throw new Error("boom");', response(), 5000, undefined, [
      { name: 'res.status', value: 'eq 200' },
    ]);
    expect(results.find(r => r.description === 'res.status eq 200')?.status).toBe('pass');
    expect(results.find(r => r.description === 'Script error')?.error).toMatch(/boom/);
  });
});

describe('declared assertions — the left-hand side must be one expression', () => {
  // The wrapper is a template, not a boundary: an expression ending in `);`
  // closes the __assertOne call, and a trailing comment or a rebalancing
  // function expression absorbs the tail. Compiling the expression alone first
  // is what makes the template's assumption true.
  const injections: Array<[string, string]> = [
    ['comment tail', '0); } ); __results.push({description:"forged",status:"pass"}); //'],
    [
      'rebalanced tail',
      '0); } ); __results.push({description:"forged",status:"pass"}); (function(){ return (0',
    ],
    [
      'forged timeout thrown at the host',
      "0); } ); throw new Error('Script execution timed out after 5000ms'); (function(){ return (0",
    ],
  ];

  it.each(injections)('rejects a %s instead of running it', (_label, expression) => {
    const { results } = runTestJob('', response(), 5000, undefined, [
      { name: expression, value: 'eq 200' },
    ]);
    // One result, for the assertion itself, and it failed. Nothing forged.
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('fail');
    expect(results.some(r => r.description === 'forged')).toBe(false);
  });

  // A trailing line comment is legitimate, and the bare template broke on it:
  // the comment ate the wrapper's own `); });`.
  it('accepts an expression with a trailing line comment', () => {
    expect(assertOne('res.status // the status', 'eq 200').status).toBe('pass');
  });

  it('accepts an immediately-invoked function expression', () => {
    expect(assertOne('(function () { return res.status; })()', 'eq 200').status).toBe('pass');
  });
});

describe('declared assertions — results cross back as inert data', () => {
  // __results is a plain sandbox global, so a declarative assertion — no script,
  // no statement injection — can replace it with objects carrying getters. Read
  // as the array itself, those getters run on the HOST stack after
  // runInContext returns, where the V8 interrupt no longer applies: measured
  // >700ms of spinning under a 50ms timeout. Serialising in-context bounds them.
  it('cannot make a planted getter run on the host stack', () => {
    const started = Date.now();
    const { results } = runTestJob('', response(), 200, undefined, [
      {
        name:
          '(__results = [{ description: "forged", get status() { var t = Date.now(); while (Date.now() - t < 5000) {} return "pass"; } }], 200)',
        value: 'eq 200',
      },
    ]);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(Array.isArray(results)).toBe(true);
  });

  it('survives an accumulator that cannot be serialised', () => {
    const { results } = runTestJob('', response(), 5000, undefined, [
      { name: '(__results = [{ description: "a", status: "pass" }], __results[0].self = __results[0], 200)', value: 'eq 200' },
    ]);
    // A circular accumulator degrades to [] rather than taking the run down.
    expect(Array.isArray(results)).toBe(true);
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

    // Script first, then assertions — Bruno's order.
    expect(results.map(r => [r.description, r.status])).toEqual([
      ['script ran', 'pass'],
      ['res.status eq 200', 'pass'],
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

    expect(results.find(r => r.description === 'res.status eq 200')?.status).toBe('pass');
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
