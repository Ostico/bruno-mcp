/**
 * How many things this machine can do at once, and a semaphore to hold callers
 * to it.
 *
 * The number is derived rather than hardcoded because the resource that
 * actually binds is the forked script worker — a Node child process costing
 * tens of MB and a scheduler slot — not the socket. Sockets are IO-bound and
 * effectively free; the file-descriptor limit that governs them is around a
 * million on a normal host and fails loudly rather than degrading, so nothing
 * here is sized against it.
 */
import { availableParallelism, totalmem } from 'node:os';
import { readFile } from 'node:fs/promises';

/** Conservative resident budget for one forked worker. */
export const PER_CHILD_MB = 64;

/** Leaves headroom for the parent process rather than claiming all capacity. */
export const SAFETY_MARGIN = 0.9;

const MB = 1024 * 1024;

/**
 * Anything at or above this is a cgroup v1 "unlimited" sentinel rather than a
 * budget. v1 spells unlimited as a huge number instead of a word, and taking it
 * literally derives a cap from memory no machine has.
 */
const IMPLAUSIBLE_CGROUP_BYTES = 2 ** 62;

const CGROUP_PATHS = [
  '/sys/fs/cgroup/memory.max',
  '/sys/fs/cgroup/memory/memory.limit_in_bytes',
];

export interface MachineReadings {
  cores: number;
  totalMemBytes: number;
  /** Absent when not containerised, or when the container declares no limit. */
  cgroupLimitBytes?: number;
}

export function deriveMaxConcurrency(readings: MachineReadings): number {
  const memBytes = Math.min(readings.totalMemBytes, readings.cgroupLimitBytes ?? Infinity);
  const byMemory = memBytes / MB / PER_CHILD_MB;
  // Doubled because a forked worker spends most of its life blocked on IO
  // rather than computing, so one per core under-uses the machine.
  const byCores = readings.cores * 2;
  return Math.max(1, Math.floor(SAFETY_MARGIN * Math.min(byCores, byMemory)));
}

async function readCgroupLimit(readFileImpl: typeof readFile): Promise<number | undefined> {
  for (const path of CGROUP_PATHS) {
    let raw: string;
    try {
      raw = (await readFileImpl(path, 'utf8')).toString().trim();
    } catch {
      // Not containerised, or this cgroup version is not the one in use.
      continue;
    }
    if (raw === 'max') return undefined;
    const bytes = Number(raw);
    if (!Number.isFinite(bytes) || bytes <= 0) continue;
    if (bytes >= IMPLAUSIBLE_CGROUP_BYTES) return undefined;
    return bytes;
  }
  return undefined;
}

/**
 * `totalmem()` rather than `freemem()` deliberately. On macOS the kernel counts
 * cached pages as used, so `freemem()` reports a few hundred MB on a machine
 * with tens of GB — measured 2252 MB against 65536 MB — and sizing off it
 * derives a cap of 1 on a perfectly healthy host.
 */
export async function readMachine(
  readFileImpl: typeof readFile = readFile,
): Promise<MachineReadings> {
  return {
    cores: availableParallelism(),
    totalMemBytes: totalmem(),
    cgroupLimitBytes: await readCgroupLimit(readFileImpl),
  };
}

export interface Semaphore {
  /** Resolves when a slot is free; call the returned function to give it back. */
  acquire(): Promise<() => void>;
}

/** `limit` of 0 or less means unbounded, at the caller's risk. */
export function createSemaphore(limit: number): Semaphore {
  if (limit <= 0) {
    return { acquire: (): Promise<() => void> => Promise.resolve(() => undefined) };
  }

  let active = 0;
  const waiting: Array<() => void> = [];

  /**
   * Guarded because a caller that releases twice would credit the pool twice
   * and let `limit + 1` tasks run.
   */
  const releaseOnce = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      // Shift, not pop: a LIFO queue starves the first caller under sustained
      // load, which reads as one request hanging rather than as a queue policy.
      const next = waiting.shift();
      if (next) next();
    };
  };

  return {
    acquire(): Promise<() => void> {
      if (active < limit) {
        active++;
        return Promise.resolve(releaseOnce());
      }
      return new Promise<() => void>((resolve) => {
        waiting.push(() => {
          active++;
          resolve(releaseOnce());
        });
      });
    },
  };
}
