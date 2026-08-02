/**
 * The fork semaphore's ceiling used to be a hardcoded 8 — wrong on a laptop
 * with 18 cores and wrong in a 512 MB container, in opposite directions.
 *
 * These tests drive the ceiling directly rather than through `runInWorker`,
 * which needs a built worker on disk; the queueing behaviour itself is already
 * covered in sandbox-host.test.ts.
 */
import {
  applyDerivedConcurrency,
  setMaxConcurrency,
  currentMaxConcurrency,
} from '../../../src/bruno/sandbox-host';

const MB = 1024 * 1024;

afterEach(() => {
  setMaxConcurrency(8);
});

describe('applying the derived ceiling to the fork semaphore', () => {
  it('applies the value derived from the supplied readings', async () => {
    const applied = await applyDerivedConcurrency({ cores: 18, totalMemBytes: 65536 * MB });

    expect(applied).toBe(32);
    expect(currentMaxConcurrency()).toBe(32);
  });

  it('applies a small value on a constrained machine', async () => {
    const applied = await applyDerivedConcurrency({ cores: 1, totalMemBytes: 128 * MB });

    expect(applied).toBe(1);
    expect(currentMaxConcurrency()).toBe(1);
  });

  it('reads the real machine when given no readings', async () => {
    const applied = await applyDerivedConcurrency();

    expect(applied).toBeGreaterThanOrEqual(1);
    expect(currentMaxConcurrency()).toBe(applied);
  });

  it('honours an explicit ceiling over the derived one', async () => {
    const applied = await applyDerivedConcurrency({ cores: 18, totalMemBytes: 65536 * MB }, 3);

    expect(applied).toBe(3);
    expect(currentMaxConcurrency()).toBe(3);
  });

  it('lifts the fork semaphore when asked for unbounded', async () => {
    // Otherwise "unbounded" still queues at the fork cap and the flag is a lie.
    const applied = await applyDerivedConcurrency({ cores: 18, totalMemBytes: 65536 * MB }, 0);

    expect(applied).toBe(0);
    expect(currentMaxConcurrency()).toBe(0);
  });
});

describe('setting the ceiling directly', () => {
  it('keeps 0 as unbounded rather than clamping it up to 1', () => {
    // 0 used to become 1 via Math.max(1, ...), which made unbounded the most
    // serial setting available — the exact opposite of what it says.
    setMaxConcurrency(0);

    expect(currentMaxConcurrency()).toBe(0);
  });

  it('still clamps a negative or fractional value to a usable integer', () => {
    setMaxConcurrency(-5);
    expect(currentMaxConcurrency()).toBe(1);

    setMaxConcurrency(3.7);
    expect(currentMaxConcurrency()).toBe(3);
  });
});
