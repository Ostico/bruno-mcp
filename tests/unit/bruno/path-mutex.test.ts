/**
 * Per-path serialization of read-modify-write sequences (finding D8).
 */

import * as path from 'node:path';
import { withPathLock, pendingPathLockCount } from '../../../src/bruno/path-mutex';

/** A promise plus its resolver, so a test can hold an operation open. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const FILE = path.join(path.sep, 'collections', 'orders', 'request.bru');
const OTHER = path.join(path.sep, 'collections', 'orders', 'other.bru');

describe('withPathLock', () => {
  it('returns the operation’s value to its own caller', async () => {
    await expect(withPathLock(FILE, async () => 'written')).resolves.toBe('written');
  });

  it('does not start the second operation until the first has finished', async () => {
    const gate = deferred();
    const events: string[] = [];

    const first = withPathLock(FILE, async () => {
      events.push('first:start');
      await gate.promise;
      events.push('first:end');
    });
    const second = withPathLock(FILE, async () => {
      events.push('second:start');
    });

    // The second must be queued, not merely scheduled later.
    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    gate.resolve();
    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('prevents a lost update between two read-modify-write sequences', async () => {
    // Both callers read, transform, then write the same cell. Unserialised, the
    // second read sees the pre-write value and its write discards the first edit.
    let stored = 'base';
    const readModifyWrite = (suffix: string) =>
      withPathLock(FILE, async () => {
        const current = stored;
        await new Promise((r) => setTimeout(r, 5));
        stored = current + suffix;
      });

    await Promise.all([readModifyWrite('+a'), readModifyWrite('+b')]);

    expect(stored).toMatch(/^base(\+a\+b|\+b\+a)$/);
  });

  it('runs operations on different paths concurrently', async () => {
    const gate = deferred();
    let otherFinished = false;

    const blocked = withPathLock(FILE, () => gate.promise);
    await withPathLock(OTHER, async () => {
      otherFinished = true;
    });

    // A different file was not held up by the one still in flight.
    expect(otherFinished).toBe(true);

    gate.resolve();
    await blocked;
  });

  it('treats different spellings of the same path as one queue', async () => {
    const events: string[] = [];
    const gate = deferred();
    const equivalent = path.join(path.dirname(FILE), '.', path.basename(FILE));

    const first = withPathLock(FILE, async () => {
      events.push('first');
      await gate.promise;
    });
    const second = withPathLock(equivalent, async () => {
      events.push('second');
    });

    await Promise.resolve();
    expect(events).toEqual(['first']);

    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first', 'second']);
  });

  it('reports a failure to its own caller only', async () => {
    const failing = withPathLock(FILE, async () => {
      throw new Error('write failed');
    });
    const following = withPathLock(FILE, async () => 'ok');

    await expect(failing).rejects.toThrow('write failed');
    await expect(following).resolves.toBe('ok');
  });

  it('does not strand the queue when an operation rejects', async () => {
    const order: string[] = [];

    const first = withPathLock(FILE, async () => {
      order.push('first');
      throw new Error('boom');
    });
    const second = withPathLock(FILE, async () => {
      order.push('second');
    });

    await expect(first).rejects.toThrow('boom');
    await second;

    expect(order).toEqual(['first', 'second']);
  });

  it('forgets a path once its queue drains, so the map cannot grow without bound', async () => {
    await withPathLock(FILE, async () => 'done');
    await withPathLock(OTHER, async () => 'done');
    // Allow the cleanup continuation to run.
    await new Promise((r) => setTimeout(r, 0));

    expect(pendingPathLockCount()).toBe(0);
  });
});
