import { runTestJob } from '../../../src/bruno/sandbox-worker';

const res200 = {
  status: 200,
  statusText: 'OK',
  headers: {},
  body: null,
  responseTime: 10,
};

/**
 * Run a single assertion inside a test() block and return its result. Calls the
 * sandbox job directly rather than going through TestRunner so the matcher
 * library is exercised without forking a child per assertion.
 */
function runOne(body: string) {
  const { results } = runTestJob(
    `test("t", function() { ${body} });`,
    res200,
    5000,
  );
  return results[0];
}

/**
 * The chains asserted here are the ones Bruno's own assert-runtime emits for its
 * declarative `assert` operators (packages/bruno-js/src/runtime/assert-runtime.js):
 *
 *   gt          -> .to.be.greaterThan(x)        lt      -> .to.be.lessThan(x)
 *   gte         -> .to.be.greaterThanOrEqual(x) lte     -> .to.be.lessThanOrEqual(x)
 *   in          -> .to.be.oneOf(arr)            notIn   -> .to.not.be.oneOf(arr)
 *   matches     -> .to.match(re)                notMatches -> .to.not.match(re)
 *   startsWith  -> .to.startWith(s)             endsWith   -> .to.endWith(s)
 *   between     -> .to.be.within(min, max)      isJson  -> .to.be.json
 *   isNotEmpty  -> .to.not.be.empty             isDefined -> .to.not.be.undefined
 *
 * so a script that a real Bruno collection would accept must not hit the
 * "unknown matcher" guard here.
 */
describe('sandbox expect() chai matchers', () => {
  describe('numeric comparisons', () => {
    const shouldPass: Array<[string, string]> = [
      ['greaterThan', 'expect(10).to.be.greaterThan(5);'],
      ['gt alias', 'expect(10).to.be.gt(5);'],
      ['above alias', 'expect(10).to.be.above(5);'],
      ['lessThan', 'expect(3).to.be.lessThan(5);'],
      ['lt alias', 'expect(3).to.be.lt(5);'],
      ['below alias', 'expect(3).to.be.below(5);'],
      ['greaterThanOrEqual on equal', 'expect(5).to.be.greaterThanOrEqual(5);'],
      ['greaterThanOrEqual on greater', 'expect(6).to.be.greaterThanOrEqual(5);'],
      ['gte alias', 'expect(5).to.be.gte(5);'],
      ['least alias', 'expect(5).to.be.least(5);'],
      ['at.least connector', 'expect(5).to.be.at.least(5);'],
      ['lessThanOrEqual on equal', 'expect(5).to.be.lessThanOrEqual(5);'],
      ['lessThanOrEqual on lesser', 'expect(4).to.be.lessThanOrEqual(5);'],
      ['lte alias', 'expect(5).to.be.lte(5);'],
      ['most alias', 'expect(5).to.be.most(5);'],
      ['at.most connector', 'expect(5).to.be.at.most(5);'],
      ['negated greaterThan', 'expect(3).to.not.be.greaterThan(5);'],
      ['negated at.least', 'expect(3).to.not.be.at.least(5);'],
    ];

    it.each(shouldPass)('passes: %s', (_name, body) => {
      const r = runOne(body);
      expect(r.status).toBe('pass');
    });

    const shouldFail: Array<[string, string, RegExp]> = [
      ['greaterThan on equal', 'expect(5).to.be.greaterThan(5);', /5 to be above 5/],
      ['greaterThan on lesser', 'expect(1).to.be.greaterThan(5);', /1 to be above 5/],
      ['gt alias', 'expect(1).to.be.gt(5);', /1 to be above 5/],
      ['lessThan on equal', 'expect(5).to.be.lessThan(5);', /5 to be below 5/],
      ['lt alias', 'expect(9).to.be.lt(5);', /9 to be below 5/],
      ['greaterThanOrEqual on lesser', 'expect(4).to.be.greaterThanOrEqual(5);', /4 to be at least 5/],
      ['gte alias', 'expect(4).to.be.gte(5);', /4 to be at least 5/],
      ['at.least connector', 'expect(4).to.be.at.least(5);', /4 to be at least 5/],
      ['lessThanOrEqual on greater', 'expect(6).to.be.lessThanOrEqual(5);', /6 to be at most 5/],
      ['lte alias', 'expect(6).to.be.lte(5);', /6 to be at most 5/],
      ['at.most connector', 'expect(6).to.be.at.most(5);', /6 to be at most 5/],
      ['negated greaterThan when greater', 'expect(9).to.not.be.greaterThan(5);', /9 to not be above 5/],
      ['negated at.least when equal', 'expect(5).to.not.be.at.least(5);', /5 to not be at least 5/],
    ];

    it.each(shouldFail)('fails: %s', (_name, body, message) => {
      const r = runOne(body);
      expect(r.status).toBe('fail');
      expect(r.error).toMatch(message);
    });

    // A non-numeric target makes every ordering comparison false, so the negated
    // form would otherwise report a pass for a value that cannot be ordered.
    const nonNumeric: Array<[string, string]> = [
      ['string target', 'expect("5").to.be.greaterThan(4);'],
      ['undefined target', 'expect(undefined).to.be.lessThan(4);'],
      ['null target', 'expect(null).to.be.at.least(0);'],
      ['non-numeric bound', 'expect(5).to.be.greaterThan("4");'],
      ['negated with string target', 'expect("5").to.not.be.greaterThan(4);'],
    ];

    it.each(nonNumeric)('fails on a non-number: %s', (_name, body) => {
      const r = runOne(body);
      expect(r.status).toBe('fail');
      expect(r.error).toMatch(/not a number/);
    });
  });

  describe('.to.be.oneOf(array)', () => {
    it('passes when the value is in the array', () => {
      expect(runOne('expect(200).to.be.oneOf([200, 201, 204]);').status).toBe('pass');
    });

    it('fails when the value is absent, naming the candidates', () => {
      const r = runOne('expect(404).to.be.oneOf([200, 201]);');
      expect(r.status).toBe('fail');
      expect(r.error).toContain('expected 404 to be one of [200, 201]');
    });

    it('matches strictly, so a coercible value is not a member', () => {
      const r = runOne('expect("200").to.be.oneOf([200]);');
      expect(r.status).toBe('fail');
    });

    it('passes the negation when the value is absent', () => {
      expect(runOne('expect(500).to.not.be.oneOf([200, 201]);').status).toBe('pass');
    });

    it('fails the negation when the value is present', () => {
      const r = runOne('expect(200).to.not.be.oneOf([200, 201]);');
      expect(r.status).toBe('fail');
      expect(r.error).toContain('to not be one of');
    });

    it('fails when the argument is not an array', () => {
      const r = runOne('expect(200).to.be.oneOf(200);');
      expect(r.status).toBe('fail');
      expect(r.error).toMatch(/expects an array/);
    });
  });

  describe('.to.match(regexp)', () => {
    it('passes on a match', () => {
      expect(runOne('expect("hello world").to.match(/^hello/);').status).toBe('pass');
    });

    it('fails on a mismatch, naming the pattern', () => {
      const r = runOne('expect("hello").to.match(/^world/);');
      expect(r.status).toBe('fail');
      expect(r.error).toContain('to match /^world/');
    });

    // Bruno's `matches` operator feeds the raw lhs in, which is frequently a
    // status code rather than a string, and chai coerces before matching.
    it('coerces a non-string target the way chai does', () => {
      expect(runOne('expect(200).to.match(/^2/);').status).toBe('pass');
    });

    it('is unaffected by a global flag across repeated calls', () => {
      const r = runOne('var re = /a/g; expect("aa").to.match(re); expect("aa").to.match(re);');
      expect(r.status).toBe('pass');
    });

    it('passes the negation on a mismatch', () => {
      expect(runOne('expect("hello").to.not.match(/^world/);').status).toBe('pass');
    });

    it('fails the negation on a match', () => {
      const r = runOne('expect("hello").to.not.match(/^hell/);');
      expect(r.status).toBe('fail');
      expect(r.error).toContain('to not match');
    });

    it('fails when the argument is not a regular expression', () => {
      const r = runOne('expect("hello").to.match("hello");');
      expect(r.status).toBe('fail');
      expect(r.error).toMatch(/regular expression/);
    });
  });

  describe('.to.startWith / .to.endWith', () => {
    const shouldPass: Array<[string, string]> = [
      ['startWith', 'expect("hello world").to.startWith("hello");'],
      ['startsWith alias', 'expect("hello world").to.startsWith("hello");'],
      ['endWith', 'expect("hello world").to.endWith("world");'],
      ['endsWith alias', 'expect("hello world").to.endsWith("world");'],
      ['whole string', 'expect("abc").to.startWith("abc");'],
      ['negated startWith', 'expect("hello").to.not.startWith("world");'],
      ['negated endWith', 'expect("hello").to.not.endWith("world");'],
    ];

    it.each(shouldPass)('passes: %s', (_name, body) => {
      expect(runOne(body).status).toBe('pass');
    });

    const shouldFail: Array<[string, string, RegExp]> = [
      ['startWith mismatch', 'expect("hello").to.startWith("world");', /to start with "world"/],
      ['endWith mismatch', 'expect("hello").to.endWith("world");', /to end with "world"/],
      ['prefix longer than target', 'expect("ab").to.startWith("abc");', /to start with "abc"/],
      ['suffix longer than target', 'expect("ab").to.endWith("xab");', /to end with "xab"/],
      ['substring is not a prefix', 'expect("hello").to.startWith("ello");', /to start with "ello"/],
      ['negated startWith on a match', 'expect("hello").to.not.startWith("hell");', /to not start with/],
      ['negated endWith on a match', 'expect("hello").to.not.endWith("llo");', /to not end with/],
    ];

    it.each(shouldFail)('fails: %s', (_name, body, message) => {
      const r = runOne(body);
      expect(r.status).toBe('fail');
      expect(r.error).toMatch(message);
    });

    // chai-string asserts the target is a string first; a non-string target here
    // would otherwise compare as "no prefix" and pass the negated form.
    const nonString: Array<[string, string]> = [
      ['number target', 'expect(200).to.startWith("2");'],
      ['null target', 'expect(null).to.endWith("l");'],
      ['negated with number target', 'expect(200).to.not.startWith("2");'],
      ['non-string argument', 'expect("200").to.startWith(2);'],
    ];

    it.each(nonString)('fails on a non-string: %s', (_name, body) => {
      const r = runOne(body);
      expect(r.status).toBe('fail');
      expect(r.error).toMatch(/string/);
    });
  });

  describe('.to.be.within(min, max)', () => {
    const shouldPass: Array<[string, string]> = [
      ['inside the range', 'expect(5).to.be.within(1, 10);'],
      ['on the lower bound', 'expect(1).to.be.within(1, 10);'],
      ['on the upper bound', 'expect(10).to.be.within(1, 10);'],
      ['negated below the range', 'expect(0).to.not.be.within(1, 10);'],
      ['negated above the range', 'expect(11).to.not.be.within(1, 10);'],
    ];

    it.each(shouldPass)('passes: %s', (_name, body) => {
      expect(runOne(body).status).toBe('pass');
    });

    it('fails below the range, naming the bounds', () => {
      const r = runOne('expect(0).to.be.within(1, 10);');
      expect(r.status).toBe('fail');
      expect(r.error).toContain('expected 0 to be within 1..10');
    });

    it('fails above the range', () => {
      const r = runOne('expect(11).to.be.within(1, 10);');
      expect(r.status).toBe('fail');
      expect(r.error).toContain('to be within 1..10');
    });

    it('fails the negation inside the range', () => {
      const r = runOne('expect(5).to.not.be.within(1, 10);');
      expect(r.status).toBe('fail');
      expect(r.error).toContain('to not be within 1..10');
    });

    it('fails on a non-numeric target', () => {
      const r = runOne('expect("5").to.be.within(1, 10);');
      expect(r.status).toBe('fail');
      expect(r.error).toMatch(/not a number/);
    });

    it('fails on non-numeric bounds', () => {
      const r = runOne('expect(5).to.be.within("1", 10);');
      expect(r.status).toBe('fail');
      expect(r.error).toMatch(/not a number/);
    });
  });

  // Bruno's isJson operator does not parse: its custom chai property asserts the
  // value is already a plain object or an array, which is what res.getBody()
  // yields for a JSON response. A JSON *string* is deliberately not JSON.
  describe('.to.be.json', () => {
    const shouldPass: Array<[string, string]> = [
      ['object', 'expect({ a: 1 }).to.be.json;'],
      ['empty object', 'expect({}).to.be.json;'],
      ['array', 'expect([1, 2]).to.be.json;'],
      ['negated on a JSON string', 'expect("{\\"a\\":1}").to.not.be.json;'],
      ['negated on null', 'expect(null).to.not.be.json;'],
      ['negated on a number', 'expect(1).to.not.be.json;'],
    ];

    it.each(shouldPass)('passes: %s', (_name, body) => {
      expect(runOne(body).status).toBe('pass');
    });

    const shouldFail: Array<[string, string]> = [
      ['JSON string', 'expect("{\\"a\\":1}").to.be.json;'],
      ['plain string', 'expect("nope").to.be.json;'],
      ['null', 'expect(null).to.be.json;'],
      ['undefined', 'expect(undefined).to.be.json;'],
      ['number', 'expect(1).to.be.json;'],
      ['negated on an object', 'expect({ a: 1 }).to.not.be.json;'],
      ['negated on an array', 'expect([]).to.not.be.json;'],
    ];

    it.each(shouldFail)('fails: %s', (_name, body) => {
      const r = runOne(body);
      expect(r.status).toBe('fail');
      expect(r.error).toMatch(/json/);
    });
  });

  // Bruno's unary operators isNotEmpty and isDefined lean on these two.
  describe('negations used by Bruno unary operators', () => {
    it('passes .to.not.be.empty on a non-empty value', () => {
      expect(runOne('expect([1]).to.not.be.empty;').status).toBe('pass');
    });

    it('fails .to.not.be.empty on an empty value', () => {
      expect(runOne('expect([]).to.not.be.empty;').status).toBe('fail');
    });

    it('passes .to.not.be.undefined on a defined value', () => {
      expect(runOne('expect(0).to.not.be.undefined;').status).toBe('pass');
    });

    it('fails .to.not.be.undefined on undefined', () => {
      expect(runOne('expect(undefined).to.not.be.undefined;').status).toBe('fail');
    });
  });

  // The guard is the reason unsupported matchers are a limitation rather than a
  // silent pass. Adding matchers must not open a hole in it.
  describe('unknown matchers still fail loudly', () => {
    const unknown: Array<[string, string]> = [
      ['after .to', 'expect(1).to.frobnicated;'],
      ['after .to.be', 'expect(1).to.be.frobnicated;'],
      ['after .to.have', 'expect({}).to.have.frobnicated;'],
      ['after .to.not', 'expect(1).to.not.frobnicated;'],
      ['after .to.not.be', 'expect(1).to.not.be.frobnicated;'],
      ['after .to.be.at', 'expect(1).to.be.at.frobnicated;'],
      ['after .to.not.be.at', 'expect(1).to.not.be.at.frobnicated;'],
      ['near-miss on a real matcher', 'expect(1).to.be.greaterThn(0);'],
      ['near-miss on a real property', 'expect({}).to.be.jsonn;'],
    ];

    it.each(unknown)('fails: %s', (_name, body) => {
      const r = runOne(body);
      expect(r.status).toBe('fail');
      expect(r.error).toMatch(/is not supported/);
    });
  });
});
