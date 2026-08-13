import type { ResolvedGroup, StartAfter } from './run-plan.js';

interface GateWaiter {
  needed: number;
  resolve: () => void;
  reject: (reason: Error) => void;
}

export interface GateRegistry {
  /** Hold until the named group has completed enough requests. */
  waitFor: (gate: StartAfter) => Promise<void>;
  /** One of `group`'s requests finished, whatever its verdict. */
  recordCompletion: (group: ResolvedGroup) => void;
  /** `group` will complete no more requests, for any reason. */
  recordGroupEnd: (group: ResolvedGroup) => void;
}

/**
 * The gates between groups.
 *
 * Counting rather than signalling: a gate names a position in another group —
 * "once the listener has run two requests" — and the group being waited on knows
 * nothing about who waits. That keeps the waiting out of the requests
 * themselves, which is the whole point: a `bru.sleep` tuned to last week's
 * latency is not a barrier.
 *
 * A gate that can never open is refused while the plan is built, so the only
 * failure left here is a group that ends early — a crash, or a bail — and a
 * waiter then fails with what it was still waiting for rather than hanging.
 */
export function createGateRegistry(groups: ResolvedGroup[]): GateRegistry {
  interface GroupProgress {
    completed: number;
    ended: boolean;
    waiters: GateWaiter[];
  }

  const progress = new Map<string, GroupProgress>();
  const of = (name: string): GroupProgress => {
    let entry = progress.get(name);
    if (entry === undefined) {
      entry = { completed: 0, ended: false, waiters: [] };
      progress.set(name, entry);
    }
    return entry;
  };

  const anyGates = groups.some((group) => group.startAfter !== undefined);

  return {
    waitFor(gate: StartAfter): Promise<void> {
      const entry = of(gate.group);
      if (entry.completed >= gate.requestsCompleted) {
        return Promise.resolve();
      }
      if (entry.ended) {
        return Promise.reject(gateNeverOpened(gate, entry.completed));
      }
      return new Promise<void>((resolve, reject) => {
        entry.waiters.push({ needed: gate.requestsCompleted, resolve, reject });
      });
    },

    recordCompletion(group: ResolvedGroup): void {
      // Groups without a name cannot be waited on, and a run with no gates at
      // all should not pay for bookkeeping nobody reads.
      if (!anyGates || group.name === undefined) {
        return;
      }
      const entry = of(group.name);
      entry.completed += 1;
      const ready = entry.waiters.filter((waiter) => waiter.needed <= entry.completed);
      entry.waiters = entry.waiters.filter((waiter) => waiter.needed > entry.completed);
      for (const waiter of ready) {
        waiter.resolve();
      }
    },

    recordGroupEnd(group: ResolvedGroup): void {
      if (!anyGates || group.name === undefined) {
        return;
      }
      const entry = of(group.name);
      entry.ended = true;
      const stranded = entry.waiters;
      entry.waiters = [];
      for (const waiter of stranded) {
        waiter.reject(gateNeverOpened(
          { group: group.name, requestsCompleted: waiter.needed },
          entry.completed,
        ));
      }
    },
  };
}

function gateNeverOpened(gate: StartAfter, completed: number): Error {
  return new Error(
    `Did not start: waiting for ${gate.requestsCompleted} `
    + `${gate.requestsCompleted === 1 ? 'request' : 'requests'} of group "${gate.group}", `
    + `which ended after ${completed}.`,
  );
}
