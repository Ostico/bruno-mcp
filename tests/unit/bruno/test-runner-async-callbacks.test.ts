import { TestRunner } from '../../../src/bruno/test-runner';

/**
 * test() used to call its callback and immediately record a pass, discarding
 * whatever the callback returned. An async callback's body only runs
 * synchronously up to its first await, and a failing assertion inside one
 * rejects the returned promise rather than throwing, so every async test was
 * recorded as passing no matter what it asserted — and the resulting floating
 * rejection reached the host, where Node's default unhandled-rejection policy
 * kills the process.
 */

const res200 = {
  status: 200,
  statusText: 'OK',
  headers: {},
  body: { value: 1 },
  responseTime: 10,
};

describe('TestRunner async test callbacks', () => {
  describe('result correctness', () => {
    it('should fail an async callback whose assertion fails', async () => {
      const { results } = await TestRunner.runScript(
        `test("async check", async function() {
           expect(res.getStatus()).to.equal(500);
         });`,
        res200,
      );

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('fail');
      expect(results[0].error).toContain('500');
    });

    it('should fail an async callback that fails after an await', async () => {
      const { results } = await TestRunner.runScript(
        `test("after await", async function() {
           await null;
           expect(1).to.equal(2);
         });`,
        res200,
      );

      expect(results[0].status).toBe('fail');
    });

    it('should pass an async callback whose assertions hold', async () => {
      const { results } = await TestRunner.runScript(
        `test("async ok", async function() {
           await null;
           expect(res.getStatus()).to.equal(200);
         });`,
        res200,
      );

      expect(results).toEqual([{ description: 'async ok', status: 'pass' }]);
    });

    it('should fail an async callback that rejects with a non-Error', async () => {
      const { results } = await TestRunner.runScript(
        `test("throws string", async function() {
           throw "plain string rejection";
         });`,
        res200,
      );

      expect(results[0].status).toBe('fail');
      expect(results[0].error).toContain('plain string rejection');
    });

    it('should keep results in source order when sync and async tests are mixed', async () => {
      const { results } = await TestRunner.runScript(
        `test("first sync", function() { expect(1).to.equal(1); });
         test("second async", async function() { await null; expect(1).to.equal(2); });
         test("third sync", function() { expect(1).to.equal(1); });`,
        res200,
      );

      expect(results.map(r => r.description)).toEqual([
        'first sync',
        'second async',
        'third sync',
      ]);
      expect(results.map(r => r.status)).toEqual(['pass', 'fail', 'pass']);
    });

    it('should still pass a sync callback that returns a non-thenable value', async () => {
      const { results } = await TestRunner.runScript(
        `test("returns number", function() { expect(1).to.equal(1); return 42; });
         test("returns string", function() { return "not a promise"; });
         test("returns null", function() { return null; });`,
        res200,
      );

      expect(results.map(r => r.status)).toEqual(['pass', 'pass', 'pass']);
    });
  });

  describe('promises that can never settle', () => {
    // The sandbox exposes no timers and no I/O, so once the microtask queue
    // drains, a promise that is still pending can never settle. Recording it as
    // a pass would be the same always-green bug in a different disguise.
    it('should fail an async callback awaiting a promise nothing can resolve', async () => {
      const { results } = await TestRunner.runScript(
        `test("hangs", async function() {
           await new Promise(function() {});
           expect(1).to.equal(2);
         });`,
        res200,
      );

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('fail');
      expect(results[0].error).toContain('never settled');
    });

    it('should not let a never-settling test hide the tests around it', async () => {
      const { results } = await TestRunner.runScript(
        `test("ok", function() { expect(1).to.equal(1); });
         test("hangs", async function() { await new Promise(function() {}); });
         test("fails", function() { expect(1).to.equal(2); });`,
        res200,
      );

      expect(results.map(r => r.status)).toEqual(['pass', 'fail', 'fail']);
    });
  });

  describe('the timeout still covers async work', () => {
    // Draining the microtask queue outside runInContext would disarm the V8
    // interrupt that implements the timeout, and these two scripts would hang
    // the host forever instead of failing.
    it('should time out a CPU spin that starts after an await', async () => {
      const started = Date.now();
      const { results } = await TestRunner.runScript(
        `test("spin", async function() {
           await null;
           while (true) {}
         });`,
        res200,
        { timeout: 300 },
      );
      const elapsed = Date.now() - started;

      expect(results).toEqual([
        {
          description: 'Script timeout',
          status: 'fail',
          error: 'Script execution timed out after 300ms',
        },
      ]);
      expect(elapsed).toBeLessThan(5000);
    });

    it('should time out a self-requeueing microtask loop', async () => {
      const started = Date.now();
      const { results } = await TestRunner.runScript(
        `test("requeue", async function() {
           while (true) { await null; }
         });`,
        res200,
        { timeout: 300 },
      );
      const elapsed = Date.now() - started;

      expect(results[0].description).toBe('Script timeout');
      expect(results[0].status).toBe('fail');
      expect(elapsed).toBeLessThan(5000);
    });
  });

  describe('host process safety', () => {
    // A rejection with no handler escapes the sandbox and reaches the host,
    // where Node's default policy is to terminate the process. test() now
    // attaches handlers to the promise it gets back, so a failing async test
    // can no longer take the server down with it.
    it('should not emit an unhandled rejection for a failing async test', async () => {
      const seen: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        seen.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);

      try {
        const { results } = await TestRunner.runScript(
          `test("async fail", async function() { expect(1).to.equal(2); });`,
          res200,
        );
        expect(results[0].status).toBe('fail');

        // Unhandled-rejection detection is deferred to the end of a turn of the
        // event loop, so give it one before asserting nothing fired.
        await new Promise(resolve => setImmediate(resolve));
        expect(seen).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });
  });
});
