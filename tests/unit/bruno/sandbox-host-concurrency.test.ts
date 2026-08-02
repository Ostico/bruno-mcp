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
  reserveConcurrency,
  withReservedConcurrency,
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

  it('derives the same ceiling again rather than keeping whatever a run left', async () => {
    // Idempotent by design: every run re-derives, so no run can move the
    // process ceiling by going first or by going last.
    setMaxConcurrency(3);

    const applied = await applyDerivedConcurrency({ cores: 18, totalMemBytes: 65536 * MB });

    expect(applied).toBe(32);
    expect(currentMaxConcurrency()).toBe(32);
  });
});

describe('a run reserving a ceiling for its own duration', () => {
  beforeEach(async () => {
    await applyDerivedConcurrency({ cores: 18, totalMemBytes: 65536 * MB });
  });

  it('raises the ceiling to what the run asked for', () => {
    const release = reserveConcurrency(64);

    expect(currentMaxConcurrency()).toBe(64);
    release();
  });

  it('gives the machine ceiling back when the run ends', () => {
    // The regression: a run's request was written into process state and stayed
    // there, so every later run in the process inherited a ceiling asked for by
    // a call that had already finished.
    reserveConcurrency(64)();

    expect(currentMaxConcurrency()).toBe(32);
  });

  it('holds the largest reservation while two runs overlap', () => {
    // Last-writer-wins meant the run that started second silently reset the
    // ceiling of the run already in flight, in either direction.
    const releaseSmall = reserveConcurrency(2);
    const releaseLarge = reserveConcurrency(64);

    expect(currentMaxConcurrency()).toBe(64);

    releaseLarge();
    // The smaller run is still going, and its own reservation still holds.
    expect(currentMaxConcurrency()).toBe(2);

    releaseSmall();
    expect(currentMaxConcurrency()).toBe(32);
  });

  it('lets an unbounded run lift the ceiling, but only while it runs', () => {
    const release = reserveConcurrency(0);
    expect(currentMaxConcurrency()).toBe(0);

    release();
    // Before, `maxConcurrency: 0` left the process unbounded for good.
    expect(currentMaxConcurrency()).toBe(32);
  });

  it('keeps unbounded in force while an unbounded run overlaps a bounded one', () => {
    const releaseUnbounded = reserveConcurrency(0);
    const releaseBounded = reserveConcurrency(4);

    // 0 is the largest ceiling there is, not the smallest.
    expect(currentMaxConcurrency()).toBe(0);

    releaseUnbounded();
    expect(currentMaxConcurrency()).toBe(4);
    releaseBounded();
  });

  it('reserves the machine ceiling for a run that asks for nothing', () => {
    const release = reserveConcurrency(undefined);

    expect(currentMaxConcurrency()).toBe(32);
    release();
    expect(currentMaxConcurrency()).toBe(32);
  });

  it('ignores a second release rather than dropping another run\'s reservation', () => {
    // Two runs asking for the same number are two entries; a double release
    // that removed one of them would leave the survivor uncovered.
    const releaseTwice = reserveConcurrency(64);
    const releaseOther = reserveConcurrency(64);

    releaseTwice();
    releaseTwice();

    expect(currentMaxConcurrency()).toBe(64);
    releaseOther();
    expect(currentMaxConcurrency()).toBe(32);
  });

  it('releases the reservation when the run throws', async () => {
    await expect(
      withReservedConcurrency(64, async () => {
        expect(currentMaxConcurrency()).toBe(64);
        throw new Error('run blew up');
      }),
    ).rejects.toThrow('run blew up');

    expect(currentMaxConcurrency()).toBe(32);
  });

  it('returns what the run returned', async () => {
    const value = await withReservedConcurrency(64, async () => 'ran');

    expect(value).toBe('ran');
    expect(currentMaxConcurrency()).toBe(32);
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
