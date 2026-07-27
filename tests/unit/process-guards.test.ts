import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import {
  classifyRejectionOrigin,
  describeRejectionReason,
  installUnhandledRejectionGuard,
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

  it.each([
    ['a string', 'nope'],
    ['a plain object', {}],
    ['null', null],
  ])('should classify %s as script-originated', (_label, reason) => {
    expect(classifyRejectionOrigin(reason)).toBe('script');
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

describe('end-to-end process survival', () => {
  // The unit tests above use a fake emitter, which cannot show the thing that
  // actually matters: Node terminating the process. These spawn a real node
  // process that IMPORTS THIS MODULE, so the only difference between the two
  // cases is whether installUnhandledRejectionGuard() was called. Inlining the
  // policy instead would test Node's default behaviour rather than this code,
  // and would still pass if src/process-guards.ts were deleted.
  //
  // The child imports the TypeScript source directly, which relies on Node's
  // native type stripping (>= 22.6). package.json allows Node >= 18, so the
  // pair is skipped on older runtimes rather than failing there.
  const [major, minor] = process.versions.node.split('.').map(Number);
  const stripsTypes = major > 22 || (major === 22 && minor >= 6);
  const itIfStripping = stripsTypes ? it : it.skip;

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
      const stdout = execFileSync(
        process.execPath,
        ['--input-type=module', '-e', source],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
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
});
