/**
 * The gate registry on its own.
 *
 * The two terminal cases — a gate already satisfied when someone asks, and a gate
 * whose group has already ended — cannot be reached through a run, because every
 * group in a parallel run registers its wait in the same tick, before any request
 * has finished. They are still the cases that decide whether the barrier is a
 * counter or a signal, so they are exercised here rather than left to a comment
 * claiming they hold.
 */
import { createGateRegistry } from '../../../src/bruno/group-gates';
import type { ResolvedGroup } from '../../../src/bruno/run-plan';

function group(name: string, gated = false): ResolvedGroup {
  return {
    name,
    index: 0,
    requests: [],
    variables: {},
    parallel: false,
    missingRequests: [],
    // A registry with no gated group at all skips its bookkeeping, so every
    // fixture here has to look like a run that uses gates.
    ...(gated ? { startAfter: { group: 'listener', requestsCompleted: 1 } } : {}),
  } as ResolvedGroup;
}

const listener = group('listener');
const trigger = group('trigger', true);
const registryOver = (): ReturnType<typeof createGateRegistry> =>
  createGateRegistry([listener, trigger]);

describe('a gate asked about a group that has already got there', () => {
  it('opens immediately at exactly the number asked for', async () => {
    const gates = registryOver();
    gates.recordCompletion(listener);

    await expect(gates.waitFor({ group: 'listener', requestsCompleted: 1 })).resolves.toBeUndefined();
  });

  it('opens immediately when the group went further', async () => {
    const gates = registryOver();
    gates.recordCompletion(listener);
    gates.recordCompletion(listener);

    await expect(gates.waitFor({ group: 'listener', requestsCompleted: 1 })).resolves.toBeUndefined();
  });

  it('still waits when the group is one short', async () => {
    const gates = registryOver();
    gates.recordCompletion(listener);

    let opened = false;
    const waiting = gates.waitFor({ group: 'listener', requestsCompleted: 2 })
      .then(() => { opened = true; });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(opened).toBe(false);

    gates.recordCompletion(listener);
    await waiting;
    expect(opened).toBe(true);
  });
});

describe('a gate asked about a group that has ended', () => {
  it('fails rather than waiting for a completion that cannot come', async () => {
    const gates = registryOver();
    gates.recordCompletion(listener);
    gates.recordGroupEnd(listener);

    await expect(gates.waitFor({ group: 'listener', requestsCompleted: 2 }))
      .rejects.toThrow('waiting for 2 requests of group "listener", which ended after 1');
  });

  it('opens anyway when the group got far enough before ending', async () => {
    const gates = registryOver();
    gates.recordCompletion(listener);
    gates.recordGroupEnd(listener);

    await expect(gates.waitFor({ group: 'listener', requestsCompleted: 1 })).resolves.toBeUndefined();
  });

  it('names one request in the singular', async () => {
    const gates = registryOver();
    gates.recordGroupEnd(listener);

    await expect(gates.waitFor({ group: 'listener', requestsCompleted: 1 }))
      .rejects.toThrow('waiting for 1 request of group "listener", which ended after 0');
  });
});

describe('a run with no gates', () => {
  it('does not count completions, since nobody can ask', async () => {
    const gates = createGateRegistry([listener]);
    gates.recordCompletion(listener);
    gates.recordCompletion(listener);

    // Kept honest rather than clever: with the bookkeeping off, a gate that
    // somehow arrived would wait rather than read a count nobody maintained.
    let opened = false;
    void gates.waitFor({ group: 'listener', requestsCompleted: 1 }).then(() => { opened = true; });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(opened).toBe(false);
  });
});
