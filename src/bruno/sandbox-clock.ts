/**
 * Time inside the sandbox: bru.sleep, setTimeout, and top-level await.
 *
 * Scripts used to run as a bare vm.Script evaluated synchronously, which meant
 * `await` at the top level was a SyntaxError and there was no way to wait at
 * all — the sandbox exposes no timers, so even a hand-rolled
 * `new Promise(r => setTimeout(r, ms))` had nothing to resolve it. Upstream has
 * both: it wraps every script in `(async function(){ ... })()`
 * (bruno-js/src/utils/sandbox.js:12-18) and lists setTimeout/setInterval among
 * its safe globals (sandbox/node-vm/constants.js:29-30), so `bru.sleep`
 * (bruno-js/src/bru.js:416) is just a promise around a real timer.
 *
 * We cannot copy that shape directly, for one reason that governs this whole
 * file: **the timers must not be host functions.** Placing the host's
 * setTimeout on the sandbox would hand script a host-realm function, whose
 * .constructor is the host Function — the exact escape SANDBOX_BRU_LIB exists
 * to avoid. And awaiting a host timer would break the other invariant the
 * worker relies on: the context is created with microtaskMode 'afterEvaluate',
 * so its microtask queue is drained only at the end of a runInContext call. A
 * continuation resumed by a host timer would enqueue onto a queue nothing
 * drains, and the script would hang until the parent killed the child.
 *
 * So the clock is virtual and lives entirely in-context. Script schedules onto
 * an in-context queue; the worker pumps it: read what is due next, sleep that
 * long on the host with Atomics.wait, then call __advanceClock in-context to
 * fire the due timers. Firing them inside runInContext means their callbacks
 * AND the microtask drain that follows both stay under the V8 interrupt, which
 * is the property the existing comments call load-bearing. Nothing about the
 * timeout story is weakened, and no host object crosses the realm boundary —
 * only JSON strings, as everywhere else in this sandbox.
 *
 * The clock advances by real elapsed time, so a sleep spends the script's
 * timeout budget. `bru.sleep(10000)` under the default 5000ms budget reports a
 * timeout rather than sleeping; that is honest, and the alternative — a clock
 * that jumps — would let a script claim to have waited for something it did
 * not wait for.
 */
import vm from 'node:vm';
import { describeSandboxError, isTimeoutMessage } from './sandbox-errors.js';

/**
 * How many timers one __advanceClock call will fire before handing control back
 * to the pump. A callback may schedule another timer that is already due, so
 * the drain is a loop and needs a bound; the pump simply calls again, and the
 * budget is what actually ends a runaway.
 */
const MAX_TIMERS_PER_DRAIN = 1000;

/**
 * The virtual clock, defined INSIDE the sandbox realm.
 *
 * Emitted after SANDBOX_BRU_LIB, which it extends with sleep, and before the
 * user script, which uses all of it.
 *
 * Every global it defines is a plain assignment rather than a `var` for the
 * same reason `bru` is: a top-level var creates a non-configurable binding, and
 * a user-level `let setTimeout` would then be a redeclaration SyntaxError.
 *
 * No backticks below — this is a template literal, and one would end it.
 */
export const SANDBOX_CLOCK_LIB = `
(function() {
  // Virtual now, in milliseconds. Only __advanceClock moves it, and only by
  // time that really elapsed on the host.
  var now = 0;
  var seq = 0;
  var timers = [];
  var settled = false;
  var failureName = null;
  var failureMessage = null;

  function schedule(fn, delay, repeating) {
    if (typeof fn !== 'function') { return 0; }
    var ms = Number(delay);
    if (!isFinite(ms) || ms < 0) { ms = 0; }
    seq = seq + 1;
    timers.push({
      id: seq,
      dueAt: now + ms,
      fn: fn,
      // A repeating timer is floored at 1ms so it cannot fire twice at the same
      // virtual instant: setInterval(fn, 0) would otherwise spin inside a
      // single drain instead of costing budget like every other wait.
      every: repeating ? Math.max(1, ms) : 0
    });
    return seq;
  }

  function cancel(id) {
    for (var i = 0; i < timers.length; i++) {
      if (timers[i].id === id) { timers.splice(i, 1); return; }
    }
  }

  function recordFailure(e) {
    // First failure wins: a later one cannot overwrite the error the author is
    // most likely looking for.
    if (failureMessage !== null) { return; }
    settled = true;
    try {
      failureName = (e && e.name) ? String(e.name) : 'Error';
    } catch (ignored) {
      failureName = 'Error';
    }
    try {
      failureMessage = (e && e.message) ? String(e.message) : String(e);
    } catch (ignored) {
      failureMessage = 'unknown sandbox error';
    }
  }

  setTimeout = function(fn, delay) { return schedule(fn, delay, false); };
  setInterval = function(fn, delay) { return schedule(fn, delay, true); };
  clearTimeout = function(id) { cancel(id); };
  clearInterval = function(id) { cancel(id); };

  // Upstream's own implementation, over this clock instead of the host's.
  bru.sleep = function(ms) {
    return new Promise(function(resolve) { schedule(resolve, ms, false); });
  };

  // Called by the wrapper around the user script. The .then runs in-context, so
  // a rejection is never a host-stack callback: the host only ever reads the
  // recorded strings back through __clockStateJson.
  __setScriptPromise = function(value) {
    Promise.resolve(value).then(
      function() { settled = true; },
      function(e) { recordFailure(e); }
    );
  };

  __clockStateJson = function() {
    var next = -1;
    for (var i = 0; i < timers.length; i++) {
      var due = timers[i].dueAt - now;
      if (due < 0) { due = 0; }
      if (next < 0 || due < next) { next = due; }
    }
    // Async test() callbacks that have reserved a slot but not settled. Only
    // the test prelude defines this; typeof keeps the pre-request path, which
    // has no test(), from throwing on an undeclared name.
    var awaiting = (typeof __pending === 'number' && __pending > 0) ? __pending : 0;
    return JSON.stringify({
      settled: settled,
      name: failureName,
      message: failureMessage,
      nextDelay: next,
      awaiting: awaiting
    });
  };

  __advanceClock = function(ms) {
    var step = Number(ms);
    if (!isFinite(step) || step < 0) { step = 0; }
    now = now + step;
    var fired = 0;
    while (fired < ${MAX_TIMERS_PER_DRAIN}) {
      var idx = -1;
      for (var i = 0; i < timers.length; i++) {
        if (timers[i].dueAt <= now && (idx < 0 || timers[i].dueAt < timers[idx].dueAt)) {
          idx = i;
        }
      }
      if (idx < 0) { break; }
      var timer = timers[idx];
      // Rescheduled or removed BEFORE the callback runs, so a callback that
      // throws cannot leave a one-shot timer queued to fire again forever.
      if (timer.every > 0) { timer.dueAt = now + timer.every; } else { timers.splice(idx, 1); }
      fired = fired + 1;
      try {
        timer.fn();
      } catch (e) {
        // Nobody is awaiting a bare setTimeout callback, so a throw inside one
        // has no promise to reject. Node would crash the process; swallowing it
        // silently is the other extreme. Recorded like a script rejection, so
        // the author hears about it exactly once.
        recordFailure(e);
      }
    }
    return fired;
  };
})();
`;

/**
 * Wrap a user script so `await` works at its top level.
 *
 * The prefix carries NO trailing newline on purpose: the user's first line
 * shares line 1 with the wrapper, so every line number in a stack trace still
 * matches the script the author wrote. Upstream instead prefixes whole lines
 * and carries a NODEVM_SCRIPT_WRAPPER_OFFSET to subtract afterwards; keeping
 * the offset at zero means nothing downstream has to know the wrapper exists.
 *
 * `__setScriptPromise` is resolved as the callee before the async function body
 * begins, so a script that reassigns the name inside itself cannot intercept
 * the registration of its own promise.
 */
export function wrapAsyncScript(script: string): string {
  return `__setScriptPromise((async function(){${script}\n})());`;
}

/** What the in-context clock reports about its own state. */
interface ClockState {
  /** The top-level script promise has settled, one way or the other. */
  settled: boolean;
  /** Constructor name of a rejection or uncaught timer error, if any. */
  name: string | null;
  /** Message of that failure. Null while there has been none. */
  message: string | null;
  /** Milliseconds until the earliest pending timer, or -1 when there is none. */
  nextDelay: number;
  /** Async test() callbacks still unsettled. */
  awaiting: number;
}

/**
 * The standard error constructors, by name.
 *
 * A rejection is read back as two strings, never as an object — the whole point
 * of the in-context capture. Rebuilding a same-named host error is what lets
 * describeSandboxError report "TypeError: x is not a function" rather than a
 * flat "Error". A custom error class degrades to Error, which costs the label
 * and keeps the message.
 */
const ERROR_CONSTRUCTORS: Record<string, ErrorConstructor> = {
  Error,
  EvalError,
  RangeError,
  ReferenceError,
  SyntaxError,
  TypeError,
  URIError,
};

function toHostError(name: string | null, message: string): Error {
  const ctor = (name && ERROR_CONSTRUCTORS[name]) || Error;
  return new ctor(message);
}

/**
 * A shared buffer nothing ever notifies, so Atomics.wait always waits out its
 * full timeout. One buffer for the module: the wait is not reentrant, because
 * the worker process runs exactly one job.
 */
const SLEEP_SIGNAL = new Int32Array(new SharedArrayBuffer(4));

/**
 * Block the worker for `ms`, without a host timer or an event-loop turn.
 *
 * A real setTimeout would need the loop to turn, and the loop cannot turn while
 * the synchronous job runs. Blocking is safe here in a way it never is on a
 * server: sandbox-host forks one child per job (runInWorker), so the only thing
 * stalled is the script that asked to wait, and the parent's deadline plus its
 * SIGTERM/SIGKILL escalation still bounds it from outside.
 */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(SLEEP_SIGNAL, 0, 0, ms);
}

/** Read the clock's state, or undefined if the script has broken the clock. */
function readClockState(context: vm.Context, budget: number): ClockState | undefined {
  try {
    return JSON.parse(
      vm.runInContext('__clockStateJson()', context, { timeout: budget }) as string,
    ) as ClockState;
  } catch (error: unknown) {
    // A timeout is NOT a broken clock and must not be swallowed. This read runs
    // under whatever budget is left, which can be the 1ms floor, so on a loaded
    // machine the interrupt can fire here rather than anywhere interesting —
    // and reporting that as "no clock, stop pumping" turns a script that timed
    // out into a script that succeeded. CI found exactly that.
    if (isTimeoutMessage(describeSandboxError(error).message)) {
      throw error;
    }
    // __clockStateJson is a plain global, so a script can overwrite it with
    // something that does not return JSON. Losing the clock that way is not
    // fatal: the caller stops pumping and reads back whatever the script did
    // manage to do, exactly as it would for a script that scheduled nothing.
    return undefined;
  }
}

/**
 * Run a user script under the virtual clock and return once it can make no
 * further progress.
 *
 * Throws what the script threw — including a rejection from an async body,
 * rebuilt as a host error of the same name — or a timeout error whose message
 * isTimeoutMessage recognises, so both call sites keep the error handling they
 * already had for synchronous scripts.
 *
 * Returns normally, without waiting, when the script has settled and no async
 * test() callback is outstanding. Pending timers at that point are deliberately
 * abandoned: an uncleared setInterval must not hold a finished run open until
 * its budget expires.
 *
 * Returns normally too when nothing is scheduled and the promise is still
 * unsettled — a script awaiting something the sandbox cannot resolve, which the
 * test path already reports per test() slot as PENDING_NEVER_SETTLED.
 */
export function runScriptWithClock(
  context: vm.Context,
  script: string,
  filename: string,
  deadlineAt: number,
): void {
  const remaining = (): number => deadlineAt - Date.now();
  const budget = (): number => Math.max(1, remaining());

  const compiled = new vm.Script(wrapAsyncScript(script), { filename });
  compiled.runInContext(context, { timeout: budget() });

  for (;;) {
    const state = readClockState(context, budget());
    if (!state) return;
    if (state.message !== null && state.message !== undefined) {
      throw toHostError(state.name, state.message);
    }
    if (state.settled && state.awaiting === 0) return;
    if (state.nextDelay < 0) return;
    // Checked here rather than only before sleeping: a script still waiting on
    // a timer it will never reach has timed out, whether or not there is time
    // left to sleep for.
    if (remaining() <= 0) {
      // Worded to match the V8 interrupt so isTimeoutMessage catches it and the
      // callers report a timeout the same way whether the script spun or slept.
      // No duration here: the callers know the budget and restate it.
      throw new Error('Script execution timed out');
    }
    const step = Math.min(state.nextDelay, remaining());
    sleepSync(step);
    vm.runInContext(`__advanceClock(${step})`, context, { timeout: budget() });
  }
}
