import { TestRunner } from '../../../src/bruno/test-runner';

const res200 = {
  status: 200,
  statusText: 'OK',
  headers: {},
  body: null,
  responseTime: 10,
};

async function runOne(body: string) {
  const { results } = await TestRunner.runScript(`test("t", function() { ${body} });`, res200);
  return results[0];
}

describe('TestRunner property-style matchers', () => {
  // Regression: `.to.be` exposed only a/an/below/above, so every property-style
  // matcher evaluated to `undefined`, threw nothing, and was reported as a PASS.
  // `expect(false).to.be.true` passing is the headline symptom.
  describe('assert rather than silently pass', () => {
    const shouldFail: Array<[string, string]> = [
      ['true on false', 'expect(false).to.be.true;'],
      ['true on truthy non-boolean', 'expect(1).to.be.true;'],
      ['false on true', 'expect(true).to.be.false;'],
      ['null on non-null', 'expect(0).to.be.null;'],
      ['undefined on defined', 'expect(0).to.be.undefined;'],
      ['ok on falsy', 'expect(0).to.be.ok;'],
      ['empty on non-empty array', 'expect([1]).to.be.empty;'],
      ['empty on non-empty string', 'expect("x").to.be.empty;'],
      ['empty on non-empty object', 'expect({ a: 1 }).to.be.empty;'],
      ['exist on null', 'expect(null).to.exist;'],
      ['exist on undefined', 'expect(undefined).to.exist;'],
    ];

    it.each(shouldFail)('fails: %s', async (_name, body) => {
      const r = await runOne(body);
      expect(r.status).toBe('fail');
      expect(r.error).toBeTruthy();
    });

    const shouldPass: Array<[string, string]> = [
      ['true on true', 'expect(true).to.be.true;'],
      ['false on false', 'expect(false).to.be.false;'],
      ['null on null', 'expect(null).to.be.null;'],
      ['undefined on undefined', 'expect(undefined).to.be.undefined;'],
      ['ok on truthy', 'expect("x").to.be.ok;'],
      ['empty on empty array', 'expect([]).to.be.empty;'],
      ['empty on empty string', 'expect("").to.be.empty;'],
      ['empty on empty object', 'expect({}).to.be.empty;'],
      ['exist on value', 'expect(0).to.exist;'],
    ];

    it.each(shouldPass)('passes: %s', async (_name, body) => {
      const r = await runOne(body);
      expect(r.status).toBe('pass');
    });
  });

  describe('negated property matchers', () => {
    it('fails when .to.not.be.true is used on true', async () => {
      const r = await runOne('expect(true).to.not.be.true;');
      expect(r.status).toBe('fail');
    });

    it('passes when .to.not.be.true is used on false', async () => {
      const r = await runOne('expect(false).to.not.be.true;');
      expect(r.status).toBe('pass');
    });

    it('fails when .to.not.exist is used on a value', async () => {
      const r = await runOne('expect(0).to.not.exist;');
      expect(r.status).toBe('fail');
    });

    it('passes when .to.not.exist is used on null', async () => {
      const r = await runOne('expect(null).to.not.exist;');
      expect(r.status).toBe('pass');
    });
  });

  // The class-level guard: the defect was not "seven names are missing", it was
  // "an unrecognised matcher reads as undefined and reports PASS". Any matcher we
  // do not implement must fail loudly rather than silently succeed.
  describe('unknown matchers fail loudly', () => {
    it('fails on an unknown property matcher after .to.be', async () => {
      const r = await runOne('expect(1).to.be.frobnicated;');
      expect(r.status).toBe('fail');
      expect(r.error).toMatch(/frobnicated/);
    });

    it('fails on an unknown property matcher after .to', async () => {
      const r = await runOne('expect(1).to.frobnicated;');
      expect(r.status).toBe('fail');
      expect(r.error).toMatch(/frobnicated/);
    });

    it('fails on an unknown matcher after .to.have', async () => {
      const r = await runOne('expect({}).to.have.frobnicated;');
      expect(r.status).toBe('fail');
      expect(r.error).toMatch(/frobnicated/);
    });

    it('still reports the assertion error for a known failing matcher', async () => {
      const r = await runOne('expect(1).to.equal(2);');
      expect(r.status).toBe('fail');
      expect(r.error).toContain('expected 1 to equal 2');
    });
  });
});
