import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import {
  classifyRejectionOrigin,
  describeRejectionReason,
  installUncaughtExceptionGuard,
  installUnhandledRejectionGuard,
  isBenignStreamError,
  UNINSPECTABLE_REASON,
} from '../../src/process-guards';

describe('describeRejectionReason', () => {
  it('should describe a plain host Error', () => {
    expect(describeRejectionReason(new TypeError('boom'))).toBe('TypeError: boom');
  });

  it('should fall back to the name when the message is empty', () => {
    expect(describeRejectionReason(new RangeError(''))).toBe('RangeError');
  });

  it('should describe an Error created in another realm', () => {
    // Every error a sandbox script throws is one of these. `instanceof Error`
    // is false for them, which is exactly why isNativeError is used instead.
    const context = vm.createContext(Object.create(null));
    const crossRealm = vm.runInContext('new Error("from sandbox")', context);

    expect(crossRealm instanceof Error).toBe(false);
    expect(describeRejectionReason(crossRealm)).toBe('Error: from sandbox');
  });

  it.each([
    ['a string', 'just a string'],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['a plain object', { message: 'looks like an error' }],
  ])('should refuse to inspect %s', (_label, reason) => {
    expect(describeRejectionReason(reason)).toBe(UNINSPECTABLE_REASON);
  });

  it('should not invoke a proxy trap while classifying the reason', () => {
    let trapRan = false;
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          trapRan = true;
          throw new Error('trap ran');
        },
        get() {
          trapRan = true;
          throw new Error('trap ran');
        },
      },
    );

    expect(describeRejectionReason(hostile)).toBe(UNINSPECTABLE_REASON);
    expect(trapRan).toBe(false);
  });

  it('should not invoke a hostile toString', () => {
    let called = false;
    const reason = {
      toString() {
        called = true;
        return 'should never be called';
      },
    };

    expect(describeRejectionReason(reason)).toBe(UNINSPECTABLE_REASON);
    expect(called).toBe(false);
  });

  it('should ignore a non-string name and message on a real Error', () => {
    // Both are writable on an Error instance, so a script can set them to
    // anything; neither may end up interpolated into the log as an object.
    const error = new Error('original');
    Object.defineProperty(error, 'name', { value: 123 });
    Object.defineProperty(error, 'message', { value: { toString: () => 'NOPE' } });

    expect(describeRejectionReason(error)).toBe('Error');
  });

  it('should refuse an accessor rather than invoking it', () => {
    // isNativeError guarantees the internal slot, NOT that name and message are
    // data properties. A genuine Error can carry a hostile getter.
    const error = new Error('original');
    let getterRan = false;
    Object.defineProperty(error, 'message', {
      get() {
        getterRan = true;
        throw new Error('hostile accessor');
      },
    });

    expect(describeRejectionReason(error)).toBe('Error');
    expect(getterRan).toBe(false);
  });

  it('should not run a getter on a cross-realm Error from the sandbox', () => {
    // The realistic shape: three lines of .bru script produce this.
    const context = vm.createContext(Object.create(null));
    const hostile = vm.runInContext(
      `var e = new Error("real message");
       Object.defineProperty(e, "name", { get: function() { globalThis.__ran = true; return "PWN"; } });
       e;`,
      context,
    );

    expect(describeRejectionReason(hostile)).toBe('Error: real message');
    expect(vm.runInContext('typeof __ran', context)).toBe('undefined');
  });

  it('should return promptly instead of hanging on a spinning accessor', () => {
    // A getter that spins cannot be escaped once it runs on the host stack: no
    // vm timeout covers this code. The spin is finite so the test terminates
    // either way — without the descriptor-based read this takes ~3s.
    const error = new Error('x');
    Object.defineProperty(error, 'name', {
      get() {
        const until = Date.now() + 3000;
        while (Date.now() < until) {
          /* spin */
        }
        return 'never';
      },
    });

    const started = Date.now();
    expect(describeRejectionReason(error)).toBe('Error: x');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('should not consult a Proxy planted in the prototype chain', () => {
    const error = new Error('pp');
    let trapRan = false;
    Object.setPrototypeOf(
      error,
      new Proxy(Error.prototype, {
        getOwnPropertyDescriptor(target, key) {
          trapRan = true;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        get(target, key, receiver) {
          trapRan = true;
          return Reflect.get(target, key, receiver);
        },
      }),
    );

    expect(describeRejectionReason(error)).toBe('Error: pp');
    expect(trapRan).toBe(false);
  });

  it('should give up on a prototype chain deeper than the cap', () => {
    // A sandbox can build an arbitrarily long chain; the walk must be bounded
    // rather than following it. Both name and message end up unreadable, so
    // this degrades to the default rather than hanging or recursing.
    let deep: object = Object.create(null);
    for (let i = 0; i < 5000; i++) {
      deep = Object.create(deep);
    }
    const error = new Error('deep');
    Object.defineProperty(error, 'message', { get: () => 'unreachable' });
    Object.setPrototypeOf(error, deep);

    expect(describeRejectionReason(error)).toBe('Error');
  });

  it('should truncate an attacker-sized message', () => {
    // The attacker picks the length, and this goes to stderr on every rejection.
    const described = describeRejectionReason(new Error('X'.repeat(100_000)));

    expect(described.length).toBeLessThan(600);
    expect(described).toMatch(/truncated/);
  });

  it('should keep full detail for ordinary errors', () => {
    class CustomError extends Error {
      override name = 'CustomError';
    }

    expect(describeRejectionReason(new TypeError('te'))).toBe('TypeError: te');
    expect(describeRejectionReason(new CustomError('ce'))).toBe('CustomError: ce');
  });
});

describe('classifyRejectionOrigin', () => {
  it.each([
    ['a plain Error', new Error('x')],
    ['a TypeError', new TypeError('x')],
    ['a subclassed Error', new (class extends Error {})('x')],
  ])('should classify %s as a server bug', (_label, reason) => {
    expect(classifyRejectionOrigin(reason)).toBe('server');
  });

  it('should classify a cross-realm Error as script-originated', () => {
    const context = vm.createContext(Object.create(null));
    const crossRealm = vm.runInContext('new Error("from sandbox")', context);

    expect(classifyRejectionOrigin(crossRealm)).toBe('script');
  });

  // A non-Error carries no realm evidence. Calling it 'script' would file a
  // genuine server bug as sandbox noise, and Promise.reject('...') /
  // Promise.reject({code}) / Promise.reject(undefined) are all ordinary in
  // dependency code.
  it.each([
    ['a string', 'nope'],
    ['a plain object', { code: 'ENOENT' }],
    ['null', null],
    ['undefined', undefined],
  ])('should refuse to guess an origin for %s', (_label, reason) => {
    expect(classifyRejectionOrigin(reason)).toBe('unknown');
  });

  it('should not consult a Proxy in the prototype chain while classifying', () => {
    const error = new Error('pp');
    let trapRan = false;
    Object.setPrototypeOf(
      error,
      new Proxy(Error.prototype, {
        getPrototypeOf(target) {
          trapRan = true;
          return Reflect.getPrototypeOf(target);
        },
      }),
    );

    expect(classifyRejectionOrigin(error)).toBe('script');
    expect(trapRan).toBe(false);
  });

  it('should terminate on a deep prototype chain', () => {
    let deep: object = Object.create(null);
    for (let i = 0; i < 5000; i++) {
      deep = Object.create(deep);
    }
    const error = new Error('deep');
    Object.setPrototypeOf(error, deep);

    expect(classifyRejectionOrigin(error)).toBe('script');
  });
});

describe('installUnhandledRejectionGuard', () => {
  it('should mark a server-originated rejection loudly', () => {
    const emitter = new EventEmitter();
    const logged: string[] = [];

    installUnhandledRejectionGuard(emitter, message => logged.push(message));
    emitter.emit('unhandledRejection', new Error('real bug'));

    expect(logged[0]).toContain('SERVER BUG');
    expect(logged[0]).toContain('Error: real bug');
  });

  it('should mark a script-originated rejection as sandbox noise', () => {
    const emitter = new EventEmitter();
    const logged: string[] = [];
    const context = vm.createContext(Object.create(null));

    installUnhandledRejectionGuard(emitter, message => logged.push(message));
    emitter.emit('unhandledRejection', vm.runInContext('new Error("script")', context));

    expect(logged[0]).toContain('from a script sandbox');
    expect(logged[0]).not.toContain('SERVER BUG');
  });

  it('should not file a non-Error rejection as sandbox noise', () => {
    // The failure mode this guards against: a real server bug rejecting with a
    // bare string, logged as script noise and effectively lost.
    const emitter = new EventEmitter();
    const logged: string[] = [];

    installUnhandledRejectionGuard(emitter, message => logged.push(message));
    emitter.emit('unhandledRejection', 'something broke');

    expect(logged[0]).toContain('origin undetermined');
    expect(logged[0]).not.toContain('from a script sandbox');
  });

  it('should log the reason instead of letting the process die', () => {
    const emitter = new EventEmitter();
    const logged: string[] = [];

    installUnhandledRejectionGuard(emitter, message => logged.push(message));
    emitter.emit('unhandledRejection', new Error('boom'));

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('unhandled promise rejection ignored');
    expect(logged[0]).toContain('Error: boom');
  });

  it('should not leak a hostile reason into the log', () => {
    const emitter = new EventEmitter();
    const logged: string[] = [];

    installUnhandledRejectionGuard(emitter, message => logged.push(message));
    emitter.emit('unhandledRejection', { toString: () => 'SHOULD-NOT-APPEAR' });

    expect(logged[0]).not.toContain('SHOULD-NOT-APPEAR');
    expect(logged[0]).toContain(UNINSPECTABLE_REASON);
  });

  it('should remove the handler when the returned function is called', () => {
    const emitter = new EventEmitter();
    const logged: string[] = [];

    const uninstall = installUnhandledRejectionGuard(emitter, m => logged.push(m));
    expect(emitter.listenerCount('unhandledRejection')).toBe(1);

    uninstall();

    expect(emitter.listenerCount('unhandledRejection')).toBe(0);
    emitter.emit('unhandledRejection', new Error('ignored'));
    expect(logged).toHaveLength(0);
  });

  it('should default to the real process and log to stderr', () => {
    // stdout carries the MCP JSON-RPC stream, so the default sink must be
    // console.error. Called with no arguments to exercise both defaults.
    const before = process.listenerCount('unhandledRejection');
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const uninstall = installUnhandledRejectionGuard();
    try {
      expect(process.listenerCount('unhandledRejection')).toBe(before + 1);

      process.emit('unhandledRejection', new Error('defaulted'), Promise.resolve());

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toContain('Error: defaulted');
    } finally {
      uninstall();
      spy.mockRestore();
    }

    expect(process.listenerCount('unhandledRejection')).toBe(before);
  });

  it('should attach to the real process object by default', () => {
    const before = process.listenerCount('unhandledRejection');

    const uninstall = installUnhandledRejectionGuard(process, () => {});
    expect(process.listenerCount('unhandledRejection')).toBe(before + 1);

    uninstall();
    expect(process.listenerCount('unhandledRejection')).toBe(before);
  });
});

describe('isBenignStreamError', () => {
  it.each(['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'])(
    'should treat %s as benign',
    code => {
      const error = Object.assign(new Error('write failed'), { code });

      expect(isBenignStreamError(error)).toBe(true);
    },
  );

  it.each([
    ['a different code', Object.assign(new Error('x'), { code: 'ENOENT' })],
    ['no code at all', new Error('plain')],
    ['a non-string code', Object.assign(new Error('x'), { code: 42 })],
    ['a non-Error', { code: 'EPIPE' }],
  ])('should not treat %s as benign', (_label, error) => {
    expect(isBenignStreamError(error)).toBe(false);
  });

  it('should not invoke an accessor while reading the code', () => {
    let getterRan = false;
    const error = new Error('x');
    Object.defineProperty(error, 'code', {
      get() {
        getterRan = true;
        return 'EPIPE';
      },
    });

    expect(isBenignStreamError(error)).toBe(false);
    expect(getterRan).toBe(false);
  });
});

describe('installUncaughtExceptionGuard', () => {
  function harness() {
    const emitter = new EventEmitter();
    const logged: string[] = [];
    const exitCodes: number[] = [];
    let fatalCalls = 0;

    const uninstall = installUncaughtExceptionGuard({
      emitter,
      log: message => logged.push(message),
      exit: code => exitCodes.push(code),
      onFatal: () => {
        fatalCalls += 1;
      },
    });

    return { emitter, logged, exitCodes, uninstall, fatal: () => fatalCalls };
  }

  it('should log, close the transport and exit non-zero on a real exception', () => {
    const h = harness();

    h.emitter.emit('uncaughtException', new Error('kaboom'));

    expect(h.logged[0]).toContain('fatal uncaught exception');
    expect(h.logged[0]).toContain('SERVER BUG');
    expect(h.logged[0]).toContain('Error: kaboom');
    expect(h.fatal()).toBe(1);
    expect(h.exitCodes).toEqual([1]);
    h.uninstall();
  });

  it('should ignore a broken-pipe write and keep running', () => {
    const h = harness();

    h.emitter.emit('uncaughtException', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

    expect(h.exitCodes).toEqual([]);
    expect(h.fatal()).toBe(0);
    expect(h.logged).toEqual([]);
    h.uninstall();
  });

  it('should tag a sandbox-raised exception as script-originated', () => {
    const h = harness();
    const context = vm.createContext(Object.create(null));

    h.emitter.emit('uncaughtException', vm.runInContext('new Error("scripty")', context));

    expect(h.logged[0]).toContain('from a script sandbox');
    expect(h.logged[0]).not.toContain('SERVER BUG');
    expect(h.exitCodes).toEqual([1]);
    h.uninstall();
  });

  it('should not file a non-Error exception as sandbox noise', () => {
    const h = harness();

    h.emitter.emit('uncaughtException', 'bare string');

    expect(h.logged[0]).toContain('origin undetermined');
    expect(h.exitCodes).toEqual([1]);
    h.uninstall();
  });

  it('should still exit when logging throws', () => {
    // stderr may be the very thing that broke.
    const emitter = new EventEmitter();
    const exitCodes: number[] = [];
    const uninstall = installUncaughtExceptionGuard({
      emitter,
      log: () => {
        throw new Error('stderr gone');
      },
      exit: code => exitCodes.push(code),
    });

    expect(() => emitter.emit('uncaughtException', new Error('x'))).not.toThrow();
    expect(exitCodes).toEqual([1]);
    uninstall();
  });

  it('should still exit when the shutdown hook throws', () => {
    const emitter = new EventEmitter();
    const exitCodes: number[] = [];
    const uninstall = installUncaughtExceptionGuard({
      emitter,
      log: () => {},
      exit: code => exitCodes.push(code),
      onFatal: () => {
        throw new Error('close failed');
      },
    });

    expect(() => emitter.emit('uncaughtException', new Error('x'))).not.toThrow();
    expect(exitCodes).toEqual([1]);
    uninstall();
  });

  it('should remove the handler when uninstalled', () => {
    const emitter = new EventEmitter();
    const uninstall = installUncaughtExceptionGuard({
      emitter,
      log: () => {},
      exit: () => {},
    });
    expect(emitter.listenerCount('uncaughtException')).toBe(1);

    uninstall();

    expect(emitter.listenerCount('uncaughtException')).toBe(0);
  });

  it('should default to terminating the real process', () => {
    // The default exit really is process.exit, so it has to be stubbed rather
    // than called — otherwise this test would take the test runner down.
    const exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const uninstall = installUncaughtExceptionGuard();
    try {
      process.emit('uncaughtException', new Error('fatal'));

      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      uninstall();
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('should default to the real process and stderr', () => {
    const before = process.listenerCount('uncaughtException');
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitCodes: number[] = [];

    const uninstall = installUncaughtExceptionGuard({
      exit: code => exitCodes.push(code),
    });
    try {
      expect(process.listenerCount('uncaughtException')).toBe(before + 1);

      process.emit('uncaughtException', new Error('defaulted'));

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toContain('Error: defaulted');
      expect(exitCodes).toEqual([1]);
    } finally {
      uninstall();
      spy.mockRestore();
    }

    expect(process.listenerCount('uncaughtException')).toBe(before);
  });
});

describe('end-to-end process survival', () => {
  // The unit tests above use a fake emitter, which cannot show the thing that
  // actually matters: Node terminating the process. These spawn a real node
  // process that IMPORTS THIS MODULE, so the only difference between the two
  // cases is whether installUnhandledRejectionGuard() was called. Inlining the
  // policy instead would test Node's default behaviour rather than this code,
  // and would still pass if src/process-guards.ts were deleted.
  //
  // The child imports the TypeScript source directly, which needs Node's type
  // stripping (>= 22.6). It is only ON BY DEFAULT from 22.18, so the flag is
  // passed explicitly — without it, 22.6–22.17 fails with
  // ERR_UNKNOWN_FILE_EXTENSION instead of skipping, and the "process dies"
  // case would pass for the wrong reason (dying on the import, not on the
  // rejection). package.json allows Node >= 18, so older runtimes skip.
  const [major, minor] = process.versions.node.split('.').map(Number);
  const stripsTypes = major > 22 || (major === 22 && minor >= 6);
  const itIfStripping = stripsTypes ? it : it.skip;
  const NODE_ARGS = ['--experimental-strip-types', '--input-type=module', '-e'];

  const guardModule = pathToFileURL(
    resolve(__dirname, '../../src/process-guards.ts'),
  ).href;

  function runChild(body: string): { status: number | null; stdout: string } {
    const source = `
      import { installUnhandledRejectionGuard } from ${JSON.stringify(guardModule)};
      ${body}
      Promise.reject(new Error("floating"));
      setTimeout(() => console.log("SURVIVED"), 10);
    `;

    try {
      const stdout = execFileSync(process.execPath, [...NODE_ARGS, source], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, stdout };
    } catch (error) {
      const err = error as { status?: number | null; stdout?: string };
      return { status: err.status ?? null, stdout: err.stdout ?? '' };
    }
  }

  itIfStripping('should let node kill the process when the guard is not installed', () => {
    const result = runChild('void installUnhandledRejectionGuard;');

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('SURVIVED');
  });

  itIfStripping('should keep the process alive once the guard is installed', () => {
    const result = runChild('installUnhandledRejectionGuard(process, () => {});');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SURVIVED');
  });

  // The carve-out exists because the rejection guard writes to stderr, so a
  // client that closes that pipe could otherwise kill the server through the
  // guard protecting it. This drives the real thing: stderr is destroyed while
  // the child logs, and the child must survive to print on stdout.
  itIfStripping('should survive a client closing stderr while diagnostics are written', done => {
    const source = `
      import { installUnhandledRejectionGuard, installUncaughtExceptionGuard }
        from ${JSON.stringify(guardModule)};
      installUncaughtExceptionGuard();
      installUnhandledRejectionGuard();
      let n = 0;
      const timer = setInterval(() => {
        console.error('x'.repeat(10000));
        if (++n > 500) {
          clearInterval(timer);
          process.stdout.write('SURVIVED-BROKEN-STDERR');
          process.exit(0);
        }
      }, 0);
    `;

    const child = spawn(process.execPath, [...NODE_ARGS, source], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', () => {});
    setTimeout(() => child.stderr.destroy(), 30);

    child.on('exit', code => {
      try {
        expect(code).toBe(0);
        expect(stdout).toContain('SURVIVED-BROKEN-STDERR');
        done();
      } catch (error) {
        done(error as Error);
      }
    });
  }, 30000);
});
