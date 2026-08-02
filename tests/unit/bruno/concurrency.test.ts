/**
 * Cap derivation is tested against injected readings rather than the host, so
 * the suite asserts the same numbers on a laptop and in CI. Reading the real
 * machine is a separate, thinner test.
 */
import {
  deriveMaxConcurrency,
  readMachine,
  createSemaphore,
  PER_CHILD_MB,
  SAFETY_MARGIN,
} from '../../../src/bruno/concurrency';

const MB = 1024 * 1024;

describe('deriving the concurrency ceiling', () => {
  it('takes cores x 2 when memory is plentiful', () => {
    // 18 cores, 64 GB: cores*2 = 36 is the binding constraint, 0.9 * 36 = 32.
    expect(deriveMaxConcurrency({ cores: 18, totalMemBytes: 65536 * MB })).toBe(32);
  });

  it('takes the memory budget when memory is the binding constraint', () => {
    // 16 cores would allow 32, but 512 MB / 64 MB = 8 children; 0.9 * 8 = 7.
    expect(deriveMaxConcurrency({ cores: 16, totalMemBytes: 512 * MB })).toBe(7);
  });

  it('never returns less than 1, however small the machine', () => {
    expect(deriveMaxConcurrency({ cores: 1, totalMemBytes: 32 * MB })).toBe(1);
  });

  it('prefers a cgroup limit below total memory', () => {
    // The container is what will OOM-kill us, not the host.
    const readings = { cores: 16, totalMemBytes: 65536 * MB, cgroupLimitBytes: 512 * MB };

    expect(deriveMaxConcurrency(readings)).toBe(7);
  });

  it('ignores a cgroup limit above total memory', () => {
    const readings = { cores: 2, totalMemBytes: 1024 * MB, cgroupLimitBytes: 65536 * MB };

    expect(deriveMaxConcurrency(readings)).toBe(3);
  });

  it('applies the safety margin rather than using the raw ceiling', () => {
    // Pinning the margin: without it this is 20, and a cap equal to capacity
    // leaves nothing for the parent process.
    expect(SAFETY_MARGIN).toBeLessThan(1);
    expect(deriveMaxConcurrency({ cores: 10, totalMemBytes: 65536 * MB })).toBe(18);
  });

  it('budgets PER_CHILD_MB per forked worker', () => {
    expect(PER_CHILD_MB).toBe(64);
  });
});

describe('reading the machine', () => {
  const enoent = (): Promise<string> =>
    Promise.reject(Object.assign(new Error('no such file'), { code: 'ENOENT' }));

  it('reports no cgroup limit when neither cgroup file exists', async () => {
    // Absence is rejected explicitly: a jest.fn() resolving undefined would
    // read as an existing, empty file and derive a limit of NaN.
    const readings = await readMachine(enoent as never);

    expect(readings.cgroupLimitBytes).toBeUndefined();
    expect(readings.cores).toBeGreaterThanOrEqual(1);
    expect(readings.totalMemBytes).toBeGreaterThan(0);
  });

  it('reads a cgroup v2 limit', async () => {
    const readFileImpl = jest.fn().mockResolvedValue('536870912\n');

    const readings = await readMachine(readFileImpl as never);

    expect(readings.cgroupLimitBytes).toBe(536870912);
  });

  it('treats the cgroup v2 sentinel "max" as no limit', async () => {
    const readFileImpl = jest.fn().mockResolvedValue('max\n');

    expect((await readMachine(readFileImpl as never)).cgroupLimitBytes).toBeUndefined();
  });

  it('ignores an implausibly large cgroup v1 value', async () => {
    // Unlimited under v1 is a huge sentinel rather than a word; treating it as
    // a real budget derives a cap from memory no machine has.
    const readFileImpl = jest.fn().mockResolvedValue('9223372036854771712\n');

    expect((await readMachine(readFileImpl as never)).cgroupLimitBytes).toBeUndefined();
  });

  it('falls through to cgroup v1 when v2 is absent', async () => {
    const readFileImpl = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('no such file'), { code: 'ENOENT' }))
      .mockResolvedValueOnce('268435456\n');

    expect((await readMachine(readFileImpl as never)).cgroupLimitBytes).toBe(268435456);
  });
});

describe('the run-wide semaphore', () => {
  const peakOf = async (limit: number, tasks: number): Promise<number> => {
    const semaphore = createSemaphore(limit);
    let active = 0;
    let peak = 0;

    const task = async (): Promise<void> => {
      const release = await semaphore.acquire();
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      release();
    };

    await Promise.all(Array.from({ length: tasks }, task));
    return peak;
  };

  it('runs at most `limit` tasks at once', async () => {
    expect(await peakOf(2, 5)).toBe(2);
  });

  it('treats a limit of 0 as unbounded', async () => {
    expect(await peakOf(0, 4)).toBe(4);
  });

  it('releases the slot when the holder releases, not on a timer', async () => {
    const semaphore = createSemaphore(1);
    const release = await semaphore.acquire();
    let second = false;

    const waiter = semaphore.acquire().then(() => {
      second = true;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(second).toBe(false);

    release();
    await waiter;
    expect(second).toBe(true);
  });

  it('does not double-release when a holder calls release twice', async () => {
    // A release that credits the pool twice lets `limit + 1` tasks run.
    const semaphore = createSemaphore(1);
    const release = await semaphore.acquire();
    release();
    release();

    expect(await peakOf(1, 2)).toBe(1);
  });

  it('hands the slot to waiters in the order they asked', async () => {
    // Not merely tidy: a LIFO queue starves the first caller under sustained
    // load, which reads as one request hanging rather than as a queue policy.
    const semaphore = createSemaphore(1);
    const first = await semaphore.acquire();
    const order: number[] = [];

    const waiters = [1, 2, 3].map((n) =>
      semaphore.acquire().then((release) => {
        order.push(n);
        release();
      }),
    );

    first();
    await Promise.all(waiters);

    expect(order).toEqual([1, 2, 3]);
  });
});
