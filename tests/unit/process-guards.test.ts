import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import {
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

  it('should survive an Error whose message accessor throws', () => {
    const error = new Error('original');
    Object.defineProperty(error, 'message', {
      get() {
        throw new Error('hostile accessor');
      },
    });

    expect(describeRejectionReason(error)).toBe('Error (message unavailable)');
  });
});

describe('installUnhandledRejectionGuard', () => {
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
  // actually matters: Node terminating the process. These run a real node
  // process to prove the default policy kills it and the guard prevents that.
  const FLOATING_REJECTION = 'Promise.reject(new Error("floating"));';

  function runNode(source: string): { status: number | null; stdout: string } {
    try {
      const stdout = execFileSync(process.execPath, ['-e', source], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, stdout };
    } catch (error) {
      const err = error as { status?: number | null; stdout?: string };
      return { status: err.status ?? null, stdout: err.stdout ?? '' };
    }
  }

  it('should confirm node kills the process without the guard', () => {
    const result = runNode(
      `${FLOATING_REJECTION} setTimeout(() => console.log("SURVIVED"), 10);`,
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('SURVIVED');
  });

  it('should keep the process alive with the guard installed', () => {
    // Inlines the same policy the guard applies, exercised in a real process.
    const result = runNode(
      `process.on("unhandledRejection", () => {});
       ${FLOATING_REJECTION}
       setTimeout(() => console.log("SURVIVED"), 10);`,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SURVIVED');
  });
});
