/**
 * Waiting, inside the sandbox.
 *
 * Two things were missing and they are really one thing. Scripts ran as a bare
 * synchronous vm.Script, so `await` at the top level was a SyntaxError; and the
 * sandbox exposed no timers, so even a hand-rolled promise had nothing that
 * could ever resolve it. An agent reaching for upstream's `bru.sleep`
 * (bruno-js/src/bru.js:416) got "bru.sleep is not a function", then hit the
 * SyntaxError on its promise-based fallback, and ended up burning a core on a
 * busy-wait — which is the only reason any of this was discoverable.
 *
 * The clock is virtual and lives in-context, so the assertions here are about
 * observable behaviour rather than implementation: time really passes (a sleep
 * that outruns its budget must report a timeout, not return early), the wait is
 * bounded, and none of the existing isolation guarantees moved. The last one
 * matters most: timers are the classic way a sandbox grows a host-realm
 * function, and the escape test below is the one that would catch it.
 */
import {
  runPreRequestJob,
  runTestJob,
  DEFAULT_TIMEOUT,
} from '../../../src/bruno/sandbox-worker';
import { wrapAsyncScript } from '../../../src/bruno/sandbox-clock';
import vm from 'node:vm';
import { MockRequestData, MockResponseData } from '../../../src/bruno/types';

const request: MockRequestData = {
  url: 'https://example.test/api',
  method: 'POST',
  headers: {},
  body: {},
};

const response: MockResponseData = {
  status: 200,
  statusText: 'OK',
  headers: {},
  body: { ok: true },
  responseTime: 1,
};

describe('top-level await', () => {
  it('is no longer a SyntaxError in a pre-request script', () => {
    const result = runPreRequestJob(
      'const token = await Promise.resolve("abc"); bru.setVar("token", token);',
      request,
      DEFAULT_TIMEOUT,
    );

    expect(result.error).toBeUndefined();
    expect(result.variables.token).toBe('abc');
  });

  it('is no longer a SyntaxError in a test script', () => {
    const result = runTestJob(
      'const v = await Promise.resolve(7);\n' +
        'test("awaited", function () { expect(v).to.equal(7); });',
      response,
      DEFAULT_TIMEOUT,
    );

    expect(result.results).toEqual([{ description: 'awaited', status: 'pass' }]);
  });

  it('keeps a rejection reportable, with the thrown error’s own name', () => {
    // Rebuilt host-side from two strings read back out of the context — the
    // rejection value itself never crosses the realm boundary. A flat "Error"
    // here would mean that reconstruction had been lost.
    const result = runPreRequestJob(
      'await Promise.reject(new TypeError("nope"));',
      request,
      DEFAULT_TIMEOUT,
    );

    expect(result.error).toBe('TypeError: nope');
  });

  it('reports a throw after an await, not just before one', () => {
    const result = runPreRequestJob(
      'await Promise.resolve(); throw new RangeError("late");',
      request,
      DEFAULT_TIMEOUT,
    );

    expect(result.error).toBe('RangeError: late');
  });

  it('leaves stack line numbers pointing at the author’s own lines', async () => {
    // The wrapper opens on the same line as the script's first line precisely
    // so this holds. If it ever grows a trailing newline, every reported line
    // number silently shifts by one — read off the stack here, because the
    // error string the job returns carries no position at all.
    const script = '\n\nundefinedFunction();';
    let stack = '';
    // The throw is inside the wrapper's async function, so it arrives as a
    // rejection rather than as a synchronous throw — which is the whole reason
    // the runner captures it in-context instead of catching around the call.
    const context = vm.createContext({
      __setScriptPromise: (promise: Promise<unknown>) => {
        void promise.catch((error: Error) => {
          stack = String(error.stack);
        });
      },
    });
    new vm.Script(wrapAsyncScript(script), { filename: 'author.js' }).runInContext(context);
    await Promise.resolve();

    expect(stack).toContain('author.js:3');

    const result = runPreRequestJob(script, request, DEFAULT_TIMEOUT);
    expect(result.error).toContain('undefinedFunction is not defined');
  });
});

describe('bru.sleep', () => {
  it('exists, and resolves after real time has passed', () => {
    const started = Date.now();
    const result = runPreRequestJob(
      'await bru.sleep(120); bru.setVar("slept", "yes");',
      request,
      DEFAULT_TIMEOUT,
    );
    const elapsed = Date.now() - started;

    expect(result.error).toBeUndefined();
    expect(result.variables.slept).toBe('yes');
    // Real elapsed time, not a jumped clock: a script that says it waited must
    // have waited, or every rate-limit and polling script built on this lies.
    expect(elapsed).toBeGreaterThanOrEqual(115);
  });

  it('runs the code after it, in order, across several sleeps', () => {
    const result = runPreRequestJob(
      'const seen = [];\n' +
        'await bru.sleep(5); seen.push("a");\n' +
        'await bru.sleep(5); seen.push("b");\n' +
        'bru.setVar("order", seen.join(","));',
      request,
      DEFAULT_TIMEOUT,
    );

    expect(result.variables.order).toBe('a,b');
  });

  it('spends the script’s timeout budget, and reports a timeout when it runs out', () => {
    const started = Date.now();
    const result = runPreRequestJob('await bru.sleep(5000);', request, 200);
    const elapsed = Date.now() - started;

    expect(result.error).toContain('timed out');
    // Bounded by the budget, not by the requested sleep. Without the clamp this
    // returns five seconds later, and the parent's deadline kills the child
    // instead of us reporting anything useful.
    expect(elapsed).toBeLessThan(2000);
  });

  it('resolves an async test() callback that awaits it', () => {
    // The pump has to keep going while a test callback is outstanding, even
    // though the top-level script settled immediately after registering it.
    const result = runTestJob(
      'test("slow", async function () { await bru.sleep(20); expect(1).to.equal(1); });',
      response,
      DEFAULT_TIMEOUT,
    );

    expect(result.results).toEqual([{ description: 'slow', status: 'pass' }]);
  });

  it('still reports a promise nothing can resolve, rather than hanging', () => {
    const result = runTestJob(
      'test("stuck", function () { return new Promise(function () {}); });',
      response,
      DEFAULT_TIMEOUT,
    );

    expect(result.results[0]?.status).toBe('fail');
    expect(result.results[0]?.error).toContain('never settled');
  });
});

describe('setTimeout and setInterval', () => {
  it('runs a setTimeout callback', () => {
    const result = runPreRequestJob(
      'setTimeout(function () { bru.setVar("fired", "yes"); }, 10);\n' +
        'await bru.sleep(30);',
      request,
      DEFAULT_TIMEOUT,
    );

    expect(result.variables.fired).toBe('yes');
  });

  it('does not run one that was cleared', () => {
    const result = runPreRequestJob(
      'const id = setTimeout(function () { bru.setVar("fired", "yes"); }, 10);\n' +
        'clearTimeout(id);\n' +
        'await bru.sleep(30);',
      request,
      DEFAULT_TIMEOUT,
    );

    expect(result.variables.fired).toBeUndefined();
  });

  it('fires an interval repeatedly while the script waits on it', () => {
    const result = runPreRequestJob(
      'let n = 0;\n' +
        'const id = setInterval(function () { n = n + 1; }, 10);\n' +
        'await bru.sleep(55);\n' +
        'clearInterval(id);\n' +
        'bru.setVar("ticks", String(n >= 3));',
      request,
      DEFAULT_TIMEOUT,
    );

    expect(result.variables.ticks).toBe('true');
  });

  it('does not let an uncleared interval hold a finished script open', () => {
    // Node would keep the process alive here. A script that has finished has
    // finished: the run must not spend its whole budget ticking a timer whose
    // callbacks nobody is waiting for.
    const started = Date.now();
    const result = runPreRequestJob(
      'setInterval(function () {}, 10); bru.setVar("done", "yes");',
      request,
      3000,
    );
    const elapsed = Date.now() - started;

    expect(result.error).toBeUndefined();
    expect(result.variables.done).toBe('yes');
    expect(elapsed).toBeLessThan(1000);
  });

  it('reports a throw from inside a timer callback', () => {
    // No promise rejects for a bare setTimeout callback, so this would
    // otherwise vanish entirely.
    const result = runPreRequestJob(
      'setTimeout(function () { throw new Error("from a timer"); }, 5);\n' +
        'await bru.sleep(20);',
      request,
      DEFAULT_TIMEOUT,
    );

    expect(result.error).toBe('Error: from a timer');
  });
});

describe('the clock does not weaken the sandbox', () => {
  it('does not hand the script a host-realm function to escape through', () => {
    // The reason the timers are virtual. A host setTimeout on the sandbox would
    // make setTimeout.constructor the HOST Function constructor, which
    // codeGeneration.strings:false does not govern — the same escape
    // SANDBOX_BRU_LIB exists to prevent.
    const result = runPreRequestJob(
      'bru.setVar("escaped", String(setTimeout.constructor === Function));',
      request,
      DEFAULT_TIMEOUT,
    );

    expect(result.variables.escaped).toBe('true');

    const escape = runPreRequestJob(
      'const f = setTimeout.constructor("return process");\n' +
        'bru.setVar("env", typeof f().env);',
      request,
      DEFAULT_TIMEOUT,
    );

    expect(escape.variables.env).toBeUndefined();
    expect(escape.error).toBeDefined();
  });

  it('still stops a spinning script, with a timer queued behind it', () => {
    const started = Date.now();
    const result = runPreRequestJob(
      'setTimeout(function () {}, 5);\n' +
        'while (true) {}',
      request,
      300,
    );
    const elapsed = Date.now() - started;

    expect(result.error).toContain('timed out');
    expect(elapsed).toBeLessThan(2000);
  });

  it('survives a script that overwrites the clock’s own globals', () => {
    // Every name the pump reads is a plain global the script can reassign.
    // Losing the clock has to degrade to "no more waiting", never to a crash
    // or a hang.
    const result = runPreRequestJob(
      '__clockStateJson = function () { return "not json"; };\n' +
        'bru.setVar("ran", "yes");',
      request,
      DEFAULT_TIMEOUT,
    );

    expect(result.error).toBeUndefined();
    expect(result.variables.ran).toBe('yes');
  });
});
