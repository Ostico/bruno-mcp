# Execution Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace directory-derived execution with caller-defined **groups** — each owning its own request list, environment, variables, `VariableStore` and cookie jar — and replace the hardcoded sandbox concurrency cap with one derived from the machine.

**Architecture:** Two new pure modules (`concurrency.ts`, `run-plan.ts`) absorb the decision-making; `request-executor.ts` keeps orchestration only. A run becomes an ordered list of groups gathered with `Promise.allSettled`; results become group-shaped. Phase 1 (Tasks 1–3) is shippable on its own and does not touch the tool surface. Phase 2 (Tasks 4–10) is the 2.0.0 break.

**Tech Stack:** TypeScript (ESM, `target: ES2022`), Node 22+, Jest via ts-jest, tsup for builds, zod for tool schemas.

**Spec:** `docs/superpowers/specs/2026-08-02-execution-groups-design.md`. Read it before Task 4 — the tool schema and result shape are specified there in full and are not repeated in every task here.

## Global Constraints

- **Node floor is `>=22.0.0`.** Use `os.availableParallelism()` unconditionally; never add an `os.cpus().length` fallback.
- **Build and install with `npm`, never `yarn`.** `yarn.lock` is stale and a yarn tree makes `tsc` OOM. CI is `npm ci`.
- **No `Co-Authored-By` trailers in commit messages.** (`CLAUDE.md`)
- **`src/bruno/request-executor.ts` has a `max-lines: 1300` ESLint ceiling** and sits at ~1178. Every task that adds to it must remove at least as much. Check with `npx eslint src/bruno/request-executor.ts`.
- **Tests are not type-checked.** `tsconfig.json` excludes `tests/`, and ts-jest runs with diagnostics off. A type-only change has no test that can go red — assert runtime behaviour, never types alone.
- **CI gate set is five checks**, including a Test-Guard enforcing **95% diff coverage on changed `src/` lines** plus a name-matching test file per changed source file. A new `src/bruno/foo.ts` needs `tests/unit/bruno/foo.test.ts`.
- **Never open a real socket in tests.** Mock `fetch`. A loopback server passes locally and fails CI on undici state another test file owns.
- **Mock file absence explicitly.** `jest.fn()` resolving `undefined` reads as an existing empty file to code that tests existence by reading. Reject with `ENOENT`.
- **Code comments must be self-contained.** Never cite this plan, a task number, or a tracker ID in source — the plan is worktree-local and stale on landing.
- Commands: `npx jest <path>`, `npm run typecheck`, `npm run lint`, `npm run build`.

## File Structure

| File | Responsibility |
|---|---|
| `src/bruno/concurrency.ts` *(new)* | Derive the concurrency ceiling from injectable machine readings; read cgroup limits; provide the run-wide semaphore. No knowledge of requests or groups. |
| `src/bruno/run-plan.ts` *(new)* | Turn `requests`/`groups` input plus discovery into an ordered list of resolved groups. Pure apart from directory listing. No execution. |
| `src/bruno/sandbox-host.ts` | Keeps its fork semaphore; its default becomes the derived value instead of `8`. |
| `src/bruno/request-executor.ts` | Orchestration only: build groups, acquire slots, run, gather. |
| `src/bruno/captured-variables.ts` | Simplified — captures are per-group, so the cross-store reconciliation goes. |
| `src/bruno/types.ts` | `GroupRunResult`; reshaped `CollectionRunResult`. |
| `src/bruno/execution-options.ts` | `groups`, `requests`, `maxConcurrency`; `requestPath` removed. |
| `src/tools/run-tools.ts` | New zod schema; both-inputs validation error. |
| `src/tools/run-target.ts` | Deleted — `requestPath`/`folder` resolution folds into `run-plan.ts`. |

---

# Phase 1 — machine-derived concurrency

Shippable without Phase 2. Does not change the tool surface. Whether it releases as `1.3.0` or waits for `2.0.0` is the maintainer's call — Task 1 raises `engines`, which is conventionally a major, though the floor it replaces was never tested by CI.

## Task 1: Raise the Node floor to 22

**Files:**
- Modify: `package.json` (`engines.node`, `devDependencies.@types/node`)
- Test: `tests/unit/meta/engines-match-ci.test.ts` *(create)*

**Interfaces:**
- Consumes: nothing.
- Produces: a guarantee that `os.availableParallelism()` exists unconditionally, relied on by Task 2.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/meta/engines-match-ci.test.ts`:

```ts
/**
 * The declared Node floor and the versions CI actually runs must agree.
 *
 * They did not: `engines` claimed `>=18.0.0` while the matrix had only run
 * 22.x and 24.x for a long time, so the declared floor was a promise nothing
 * kept. A caller on Node 18 would have been told they were supported.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(__dirname, '..', '..', '..');

const majorOf = (version: string): number => {
  const match = /(\d+)/.exec(version);
  if (!match) throw new Error(`Unparseable version: ${version}`);
  return Number(match[1]);
};

describe('the declared Node floor', () => {
  it('is no lower than the lowest version CI runs', async () => {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const ci = await readFile(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

    const declared = majorOf(pkg.engines.node);
    const matrix = /node-version:\s*\[([^\]]+)\]/.exec(ci);
    expect(matrix).not.toBeNull();

    const tested = matrix![1].split(',').map((v) => majorOf(v.trim()));
    expect(Math.min(...tested)).toBeGreaterThanOrEqual(declared);
  });

  it('is at least 22, since Node 20 is end-of-life', async () => {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    expect(majorOf(pkg.engines.node)).toBeGreaterThanOrEqual(22);
  });

  it('declares an @types/node major no higher than the floor', async () => {
    // A floor of 22 with `@types/node@^20` types away APIs that are present at
    // run time, and admits ones that are not.
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    expect(majorOf(pkg.devDependencies['@types/node'])).toBeGreaterThanOrEqual(
      majorOf(pkg.engines.node),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/meta/engines-match-ci.test.ts`
Expected: FAIL — the floor is `18` against a matrix minimum of `22`, and `@types/node` is `^20`.

- [ ] **Step 3: Make the change**

In `package.json`:

```json
  "engines": {
    "node": ">=22.0.0"
  },
```

and in `devDependencies`:

```json
    "@types/node": "^22.0.0",
```

- [ ] **Step 4: Install and verify**

```bash
npm install
npx jest tests/unit/meta/engines-match-ci.test.ts
npm run typecheck
```

Expected: tests PASS, `tsc --noEmit` clean. If `tsc` reports new errors, they are real — `@types/node@20` was describing a different runtime. Fix them in this task.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tests/unit/meta/engines-match-ci.test.ts
git commit -m "chore: raise the Node floor to 22 and match @types/node

Node 20 reached end of life in April 2026. The floor this replaces was
already false: engines claimed >=18.0.0 while CI has only ever run 22.x
and 24.x, so no run verified 18 or 20. A test now pins the declaration to
the matrix so the two cannot drift apart again."
```

---

## Task 2: Derive the concurrency ceiling from the machine

**Files:**
- Create: `src/bruno/concurrency.ts`
- Test: `tests/unit/bruno/concurrency.test.ts`

**Interfaces:**
- Consumes: Node 22 floor from Task 1.
- Produces:
  - `interface MachineReadings { cores: number; totalMemBytes: number; cgroupLimitBytes?: number }`
  - `deriveMaxConcurrency(readings: MachineReadings): number`
  - `readMachine(readFileImpl?: typeof readFile): Promise<MachineReadings>`
  - `createSemaphore(limit: number): { acquire(): Promise<() => void> }`
  - constants `PER_CHILD_MB = 64`, `SAFETY_MARGIN = 0.9`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/bruno/concurrency.test.ts`:

```ts
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
    // a real budget derives a cap from a number no machine has.
    const readFileImpl = jest.fn().mockResolvedValue('9223372036854771712\n');

    expect((await readMachine(readFileImpl as never)).cgroupLimitBytes).toBeUndefined();
  });
});

describe('the run-wide semaphore', () => {
  it('runs at most `limit` tasks at once', async () => {
    const semaphore = createSemaphore(2);
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

    await Promise.all([task(), task(), task(), task(), task()]);

    expect(peak).toBe(2);
  });

  it('treats a limit of 0 as unbounded', async () => {
    const semaphore = createSemaphore(0);
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

    await Promise.all([task(), task(), task(), task()]);

    expect(peak).toBe(4);
  });

  it('releases the slot even when the holder is slow, not on a timer', async () => {
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

    let active = 0;
    let peak = 0;
    const task = async (): Promise<void> => {
      const done = await semaphore.acquire();
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      done();
    };
    await Promise.all([task(), task()]);

    expect(peak).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/bruno/concurrency.test.ts`
Expected: FAIL — `Cannot find module '../../../src/bruno/concurrency'`.

- [ ] **Step 3: Write the implementation**

Create `src/bruno/concurrency.ts`:

```ts
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
 * Anything above this is a cgroup v1 "unlimited" sentinel rather than a budget.
 * v1 spells unlimited as a huge number instead of a word, and taking it
 * literally derives a cap from memory no machine has.
 */
const IMPLAUSIBLE_CGROUP_BYTES = 2 ** 62;

const CGROUP_V2 = '/sys/fs/cgroup/memory.max';
const CGROUP_V1 = '/sys/fs/cgroup/memory/memory.limit_in_bytes';

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
  for (const path of [CGROUP_V2, CGROUP_V1]) {
    try {
      const raw = (await readFileImpl(path, 'utf8')).toString().trim();
      if (raw === 'max') return undefined;
      const bytes = Number(raw);
      if (!Number.isFinite(bytes) || bytes <= 0) continue;
      if (bytes >= IMPLAUSIBLE_CGROUP_BYTES) return undefined;
      return bytes;
    } catch {
      // Not containerised, or this cgroup version is not the one in use.
    }
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

/** `limit` of 0 means unbounded, at the caller's risk. */
export function createSemaphore(limit: number): Semaphore {
  if (limit <= 0) {
    return { acquire: () => Promise.resolve(() => undefined) };
  }

  let active = 0;
  const waiting: Array<() => void> = [];

  const releaseOnce = (): (() => void) => {
    // Guarded because a caller that releases twice would credit the pool twice
    // and let `limit + 1` tasks run.
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
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
```

- [ ] **Step 4: Run tests and checks**

```bash
npx jest tests/unit/bruno/concurrency.test.ts
npm run typecheck
npx eslint src/bruno/concurrency.ts
```

Expected: all PASS, no lint output.

- [ ] **Step 5: Commit**

```bash
git add src/bruno/concurrency.ts tests/unit/bruno/concurrency.test.ts
git commit -m "feat: derive a concurrency ceiling from the machine

Sizes against the forked script worker, which is what actually costs
memory and a scheduler slot; sockets are IO-bound and governed by an fd
limit around a million, so nothing is sized against them.

Uses totalmem() rather than freemem(): on macOS the kernel counts cached
pages as used, so freemem() reported 2252 MB on a 65536 MB machine and
would derive a cap of 1. Reads cgroup v2 and v1 limits so a container
budget wins over the host's RAM."
```

---

## Task 3: Use the derived ceiling in the sandbox, and honour an unbound request

**Files:**
- Modify: `src/bruno/sandbox-host.ts:53` (`DEFAULT_MAX_CONCURRENCY`), `:76` (`setMaxConcurrency`)
- Test: `tests/unit/bruno/sandbox-host-concurrency.test.ts` *(create)*

**Interfaces:**
- Consumes: `deriveMaxConcurrency`, `readMachine` from Task 2.
- Produces: `applyDerivedConcurrency(readings?: MachineReadings): Promise<number>` exported from `sandbox-host.ts`, returning the value it applied. Task 6 calls it once per run.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/bruno/sandbox-host-concurrency.test.ts`:

```ts
/**
 * The fork semaphore's ceiling used to be a hardcoded 8 — wrong on a laptop
 * with 18 cores and wrong on a 512 MB container, in opposite directions.
 */
import { applyDerivedConcurrency, setMaxConcurrency, currentMaxConcurrency } from '../../../src/bruno/sandbox-host';

const MB = 1024 * 1024;

describe('applying the derived ceiling to the fork semaphore', () => {
  afterEach(() => {
    setMaxConcurrency(8);
  });

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

  it('lifts the fork semaphore when asked for unbounded', async () => {
    // Otherwise "unbounded" still queues at the fork cap and the flag is a lie.
    const applied = await applyDerivedConcurrency({ cores: 18, totalMemBytes: 65536 * MB }, 0);

    expect(applied).toBe(0);
    expect(currentMaxConcurrency()).toBe(0);
  });

  it('honours an explicit ceiling over the derived one', async () => {
    const applied = await applyDerivedConcurrency({ cores: 18, totalMemBytes: 65536 * MB }, 3);

    expect(applied).toBe(3);
    expect(currentMaxConcurrency()).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/bruno/sandbox-host-concurrency.test.ts`
Expected: FAIL — `applyDerivedConcurrency` and `currentMaxConcurrency` are not exported.

- [ ] **Step 3: Write the implementation**

In `src/bruno/sandbox-host.ts`, add near the existing semaphore state:

```ts
import { deriveMaxConcurrency, readMachine, type MachineReadings } from './concurrency.js';
```

Replace the `DEFAULT_MAX_CONCURRENCY` declaration's role: keep the constant as the pre-derivation starting value, and add:

```ts
/** Reports the ceiling currently in force. Exists so a caller can assert it. */
export function currentMaxConcurrency(): number {
  return maxConcurrency;
}

/**
 * Sizes the fork semaphore for this machine, or to `requested` when the caller
 * names one. A `requested` of 0 lifts the semaphore entirely: an unbounded run
 * that still queued at the fork cap would be unbounded in name only.
 */
export async function applyDerivedConcurrency(
  readings?: MachineReadings,
  requested?: number,
): Promise<number> {
  if (requested !== undefined) {
    setMaxConcurrency(requested);
    return requested;
  }
  const derived = deriveMaxConcurrency(readings ?? (await readMachine()));
  setMaxConcurrency(derived);
  return derived;
}
```

`setMaxConcurrency` currently clamps with `Math.max(1, Math.floor(n))`, which would turn `0` into `1`. Change it to preserve an explicit zero:

```ts
export function setMaxConcurrency(n: number): void {
  // 0 is meaningful — unbounded — so it is not clamped up to 1 like a negative.
  maxConcurrency = n === 0 ? 0 : Math.max(1, Math.floor(n));
  drainWaiters();
}
```

Then make the acquire path treat `maxConcurrency === 0` as "never queue".

- [ ] **Step 4: Run tests and checks**

```bash
npx jest tests/unit/bruno/sandbox-host-concurrency.test.ts tests/unit/bruno/sandbox-host.test.ts
npm run typecheck && npx eslint src/bruno/sandbox-host.ts
```

Expected: PASS. If the existing `sandbox-host` suite has a test pinning `8`, update it to assert the derived value — and read it first: if it pins `8` deliberately, that is a decision to overturn out loud in the commit message, not to quietly edit.

- [ ] **Step 5: Commit**

```bash
git add src/bruno/sandbox-host.ts tests/unit/bruno/sandbox-host-concurrency.test.ts
git commit -m "feat: size the fork semaphore for the machine instead of hardcoding 8

8 was wrong in both directions: too low on a developer laptop, too high
in a 512 MB container. setMaxConcurrency no longer clamps 0 up to 1,
because 0 now means unbounded and an unbounded run that still queued at
the fork cap would be unbounded in name only."
```

---

# Phase 2 — execution groups (2.0.0)

## Task 4: Resolve input into an ordered list of groups

**Files:**
- Create: `src/bruno/run-plan.ts`
- Test: `tests/unit/bruno/run-plan.test.ts`
- Reference: `src/bruno/request-discovery.ts:23` (`ParsedRequest`), `:186` (`resolveRunTargets`)

**Interfaces:**
- Consumes: `resolveRunTargets(requestPath, collectionPath): Promise<DiscoveryResult>`, `ParsedRequest { yaml: YamlRequest; filePath: string }`.
- Produces:
  - `interface GroupInput { name?: string; requests: string[]; environment?: string; variables?: Record<string, string>; parallel?: boolean }`
  - `interface ResolvedGroup { name?: string; index: number; requests: ParsedRequest[]; environment?: string; variables?: Record<string, string>; parallel: boolean; missingRequests: string[] }`
  - `interface RunPlan { groups: ResolvedGroup[]; parseFailures: ParseFailure[]; warnings: string[] }`
  - `buildRunPlan(collectionPath, input): Promise<RunPlan>` where `input` is `{ requests?: string[]; groups?: GroupInput[]; parallel?: boolean; environment?: string; variables?: Record<string, string> }`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/bruno/run-plan.test.ts`:

```ts
/**
 * Turning caller input into groups. Every case here is about the two things a
 * caller can get wrong and the runner must not paper over: naming a request
 * that is not there, and naming the same one twice on purpose.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRunPlan } from '../../../src/bruno/run-plan';

const bru = (name: string, seq: number): string =>
  `meta {\n  name: ${name}\n  type: http\n  seq: ${seq}\n}\n\nget {\n  url: https://example.test/${name}\n}\n`;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'run-plan-'));
  await mkdir(join(root, 'auth'), { recursive: true });
  await mkdir(join(root, 'users'), { recursive: true });
  await writeFile(join(root, 'auth', 'login.bru'), bru('login', 1));
  await writeFile(join(root, 'auth', 'refresh.bru'), bru('refresh', 2));
  await writeFile(join(root, 'users', 'list.bru'), bru('list', 1));
});

describe('with no groups', () => {
  it('produces one implicit group over the whole collection', async () => {
    const plan = await buildRunPlan(root, {});

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]!.index).toBe(0);
    expect(plan.groups[0]!.requests).toHaveLength(3);
  });

  it('the implicit group inherits run-level parallel, environment and variables', async () => {
    const plan = await buildRunPlan(root, {
      parallel: true,
      environment: 'dev',
      variables: { user: 'alice' },
    });

    expect(plan.groups[0]!.parallel).toBe(true);
    expect(plan.groups[0]!.environment).toBe('dev');
    expect(plan.groups[0]!.variables).toEqual({ user: 'alice' });
  });

  it('honours a top-level ordered selection', async () => {
    const plan = await buildRunPlan(root, {
      requests: ['users/list.bru', 'auth/login.bru'],
    });

    expect(plan.groups[0]!.requests.map((r) => r.yaml.meta.name)).toEqual(['list', 'login']);
  });

  it('expands a directory in seq order, not readdir order', async () => {
    const plan = await buildRunPlan(root, { requests: ['auth'] });

    expect(plan.groups[0]!.requests.map((r) => r.yaml.meta.name)).toEqual(['login', 'refresh']);
  });
});

describe('with explicit groups', () => {
  it('keeps groups in the order given and indexes them', async () => {
    const plan = await buildRunPlan(root, {
      groups: [
        { name: 'bob', requests: ['auth/login.bru'] },
        { name: 'alice', requests: ['users/list.bru'] },
      ],
    });

    expect(plan.groups.map((g) => g.name)).toEqual(['bob', 'alice']);
    expect(plan.groups.map((g) => g.index)).toEqual([0, 1]);
  });

  it('lets a group override the run-level environment and variables', async () => {
    const plan = await buildRunPlan(root, {
      environment: 'dev',
      variables: { baseUrl: 'https://dev.test', user: 'default' },
      groups: [
        { requests: ['auth/login.bru'], environment: 'staging', variables: { user: 'alice' } },
      ],
    });

    expect(plan.groups[0]!.environment).toBe('staging');
    // Merged, group wins per key: a run-level default survives an override of
    // one other key.
    expect(plan.groups[0]!.variables).toEqual({ baseUrl: 'https://dev.test', user: 'alice' });
  });

  it('defaults a group to serial even when the run fans groups out', async () => {
    const plan = await buildRunPlan(root, {
      parallel: true,
      groups: [{ requests: ['auth'] }],
    });

    expect(plan.groups[0]!.parallel).toBe(false);
  });

  it('allows the same request in two groups', async () => {
    const plan = await buildRunPlan(root, {
      groups: [
        { name: 'alice', requests: ['auth/login.bru'] },
        { name: 'bob', requests: ['auth/login.bru'] },
      ],
    });

    expect(plan.groups[0]!.requests).toHaveLength(1);
    expect(plan.groups[1]!.requests).toHaveLength(1);
  });

  it('allows the same request twice within one group', async () => {
    const plan = await buildRunPlan(root, {
      groups: [{ requests: ['auth/login.bru', 'auth/login.bru'] }],
    });

    expect(plan.groups[0]!.requests).toHaveLength(2);
  });

  it('records an unresolvable reference instead of throwing', async () => {
    // A caller that cannot see which subset ran cannot bisect.
    const plan = await buildRunPlan(root, {
      groups: [{ requests: ['auth/login.bru', 'auth/nope.bru'] }],
    });

    expect(plan.groups[0]!.requests).toHaveLength(1);
    expect(plan.groups[0]!.missingRequests).toEqual(['auth/nope.bru']);
  });

  it('reports an empty group rather than passing silently', async () => {
    const plan = await buildRunPlan(root, { groups: [{ requests: ['nowhere'] }] });

    expect(plan.groups[0]!.requests).toHaveLength(0);
    expect(plan.warnings.join(' ')).toContain('no requests');
  });
});

describe('rejecting contradictory input', () => {
  it('refuses both a top-level selection and groups', async () => {
    // Two different intentions; silently picking one drops the other.
    await expect(
      buildRunPlan(root, { requests: ['auth'], groups: [{ requests: ['users'] }] }),
    ).rejects.toThrow(/both `requests` and `groups`/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/bruno/run-plan.test.ts`
Expected: FAIL — `Cannot find module '../../../src/bruno/run-plan'`.

- [ ] **Step 3: Write the implementation**

Create `src/bruno/run-plan.ts`. It resolves each reference against the collection root using the existing discovery, preserving list order and duplicates:

```ts
/**
 * Turning caller input into an ordered list of groups.
 *
 * A group is the unit of isolation and of configuration; this module decides
 * only membership and ordering, and knows nothing about running anything. It
 * lives outside request-executor.ts because that file sits on the repo-wide
 * max-lines ceiling and this is the part with no execution state in it.
 */
import { isAbsolute, join, resolve } from 'node:path';
import { resolveRunTargets, type ParsedRequest } from './request-discovery.js';
import type { ParseFailure } from './types.js';

export interface GroupInput {
  name?: string;
  requests: string[];
  environment?: string;
  variables?: Record<string, string>;
  parallel?: boolean;
}

export interface ResolvedGroup {
  name?: string;
  index: number;
  requests: ParsedRequest[];
  environment?: string;
  variables?: Record<string, string>;
  parallel: boolean;
  missingRequests: string[];
}

export interface RunPlanInput {
  requests?: string[];
  groups?: GroupInput[];
  parallel?: boolean;
  environment?: string;
  variables?: Record<string, string>;
}

export interface RunPlan {
  groups: ResolvedGroup[];
  parseFailures: ParseFailure[];
  warnings: string[];
}

export async function buildRunPlan(
  collectionPath: string,
  input: RunPlanInput,
): Promise<RunPlan> {
  if (input.requests?.length && input.groups?.length) {
    throw new Error(
      'Pass either `requests` or `groups`, not both: they express two different ' +
        'intentions and there is no correct way to pick one for you.',
    );
  }

  const parseFailures: ParseFailure[] = [];
  const warnings: string[] = [];

  const groupInputs: GroupInput[] = input.groups?.length
    ? input.groups
    : [{ requests: input.requests ?? [], parallel: input.parallel }];

  const groups: ResolvedGroup[] = [];
  for (const [index, group] of groupInputs.entries()) {
    const requests: ParsedRequest[] = [];
    const missingRequests: string[] = [];

    const references = group.requests.length ? group.requests : [undefined];
    for (const reference of references) {
      const target = reference === undefined
        ? undefined
        : isAbsolute(reference) ? reference : resolve(join(collectionPath, reference));
      try {
        const discovered = await resolveRunTargets(target, collectionPath);
        requests.push(...discovered.requests);
        parseFailures.push(...discovered.parseFailures);
        warnings.push(...discovered.warnings);
      } catch {
        missingRequests.push(reference!);
      }
    }

    if (requests.length === 0) {
      warnings.push(
        `Group ${group.name ?? index} resolved to no requests. ` +
          'An empty group is reported rather than passing silently.',
      );
    }

    groups.push({
      name: group.name,
      index,
      requests,
      environment: group.environment ?? input.environment,
      variables: { ...input.variables, ...group.variables },
      parallel: group.parallel ?? (input.groups?.length ? false : (input.parallel ?? false)),
      missingRequests,
    });
  }

  return { groups, parseFailures, warnings: [...new Set(warnings)] };
}
```

- [ ] **Step 4: Run tests and checks**

```bash
npx jest tests/unit/bruno/run-plan.test.ts
npm run typecheck && npx eslint src/bruno/run-plan.ts
```

Expected: PASS. If `variables` comes back as `{}` where the test expects `undefined`, decide one way and make the test say it — do not let the executor cope with both.

- [ ] **Step 5: Commit**

```bash
git add src/bruno/run-plan.ts tests/unit/bruno/run-plan.test.ts
git commit -m "feat: resolve caller input into an ordered list of groups

Membership and ordering only, no execution. Duplicates are preserved
both within a group and across groups; an unresolvable reference is
recorded rather than thrown, because a caller that cannot see which
subset ran cannot bisect. Passing both a top-level selection and groups
is refused instead of resolved by a silent precedence rule."
```

---

## Task 5: Give results a group shape

**Files:**
- Modify: `src/bruno/types.ts:1093` (`CollectionRunResult`)
- Test: `tests/unit/bruno/collection-run-result-shape.test.ts` *(create)*

**Interfaces:**
- Consumes: `CollectionRunSummary`, `RequestExecutionResult`, `ParseFailure` (existing).
- Produces: `GroupRunResult`; `CollectionRunResult` with `groups: GroupRunResult[]` and **no** top-level `results`.

- [ ] **Step 1: Write the failing test**

Since tests are not type-checked, this must assert runtime shape. Create `tests/unit/bruno/collection-run-result-shape.test.ts`:

```ts
/**
 * The flat `results` array is gone; every caller reads `groups[].results`, in
 * the single-implicit-group case too. Conditional flattening would force every
 * caller to branch on whether they passed groups.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestExecutor } from '../../../src/bruno/request-executor';
import { TestRunner } from '../../../src/bruno/test-runner';

describe('the shape of a run result', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'shape-'));
    await writeFile(
      join(root, 'one.bru'),
      'meta {\n  name: one\n  type: http\n  seq: 1\n}\n\nget {\n  url: https://example.test/one\n}\n',
    );
    global.fetch = jest.fn().mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    ) as never;
  });

  it('always nests results under a group, even with no groups given', async () => {
    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: new TestRunner(),
    });

    expect(result).not.toHaveProperty('results');
    expect(Array.isArray(result.groups)).toBe(true);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.index).toBe(0);
    expect(result.groups[0]!.results).toHaveLength(1);
  });

  it('summarises per group and across the run', async () => {
    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: new TestRunner(),
    });

    expect(result.summary.total).toBe(1);
    expect(result.groups[0]!.summary.total).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/bruno/collection-run-result-shape.test.ts`
Expected: FAIL — `result.groups` is undefined and `results` is still present.

- [ ] **Step 3: Write the type change**

In `src/bruno/types.ts`, add above `CollectionRunResult`:

```ts
/**
 * One group's outcome. A group owns its own store and cookie jar, so its
 * captures are unambiguous in a way a run-wide capture map never was: group
 * A's `token` belongs to group A and to nothing else.
 */
export interface GroupRunResult {
  /** As supplied by the caller. Absent when the group was not named. */
  name?: string;
  /** Position in the run. Always present, so an unnamed group is still addressable. */
  index: number;
  summary: CollectionRunSummary;
  /** In listed order, whatever order they executed in. */
  results: RequestExecutionResult[];
  /** References that resolved to nothing. Absent when everything resolved. */
  missingRequests?: string[];
  capturedVariableNames?: string[];
  capturedVariables?: Record<string, string>;
  warnings?: string[];
  /** Set when the group itself failed, as opposed to a request within it. */
  error?: string;
}
```

and replace `results: RequestExecutionResult[]` on `CollectionRunResult` with `groups: GroupRunResult[]`, moving the capture fields off it.

- [ ] **Step 4: Run typecheck to find every caller**

```bash
npm run typecheck
```

Expected: FAIL, listing every site reading `.results` or the run-level capture fields. That list is the work for Task 6 and Task 8 — read it before starting either.

- [ ] **Step 5: Commit**

Commit the type change together with Task 6, since the tree does not compile in between. Skip the commit here and carry the change forward.

---

## Task 6: Execute groups

**Files:**
- Modify: `src/bruno/request-executor.ts:973` (`executeCollection`) — replace the folder-grouping and both execution branches
- Modify: `src/bruno/execution-options.ts` — add `groups`, `requests`, `maxConcurrency`; remove `requestPath`
- Test: `tests/unit/bruno/group-isolation.test.ts` *(create)*

**Interfaces:**
- Consumes: `buildRunPlan` (Task 4), `GroupRunResult` (Task 5), `createSemaphore` + `applyDerivedConcurrency` (Tasks 2–3), and the existing `executeSingleRequest(yaml, vars, scriptRunner, store, bodyCapture, collectionPath, jar, rootChain, tokenCache)`.
- Produces: `RequestExecutor.executeCollection(collectionPath, options)` returning the group-shaped result.

- [ ] **Step 1: Write the failing test**

Isolation is the headline property, so it gets adversarial tests. Create `tests/unit/bruno/group-isolation.test.ts`:

```ts
/**
 * Nothing crosses a group boundary — not variables, not cookies, not captures.
 * These are written as leak detectors: each asserts a reader group sees
 * *nothing* of a writer group, in both orderings and at both parallel settings.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestExecutor } from '../../../src/bruno/request-executor';
import { TestRunner } from '../../../src/bruno/test-runner';

const writer = `meta {\n  name: writer\n  type: http\n  seq: 1\n}\n\nget {\n  url: https://example.test/w\n}\n\nscript:post-response {\n  bru.setVar("who", bru.getEnvVar("user") || "unset");\n}\n`;
const reader = `meta {\n  name: reader\n  type: http\n  seq: 1\n}\n\nget {\n  url: https://example.test/r\n}\n\nscript:post-response {\n  bru.setVar("saw", String(bru.getVar("who")));\n}\n`;

let root: string;
let sentCookies: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'groups-'));
  await writeFile(join(root, 'writer.bru'), writer);
  await writeFile(join(root, 'reader.bru'), reader);
  sentCookies = [];

  global.fetch = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
    const headers = new Headers(init?.headers);
    sentCookies.push(headers.get('cookie') ?? '');
    return Promise.resolve(
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': 'sid=leaked; Path=/' },
      }),
    );
  }) as never;
});

describe('variables do not cross a group boundary', () => {
  it.each([true, false])('with parallel=%s', async (parallel) => {
    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: new TestRunner(),
      parallel,
      captureVariables: ['who', 'saw'],
      groups: [
        { name: 'writer', requests: ['writer.bru'], variables: { user: 'alice' } },
        { name: 'reader', requests: ['reader.bru'] },
      ],
    });

    const readerGroup = result.groups.find((g) => g.name === 'reader')!;
    expect(readerGroup.capturedVariables?.saw).toBe('undefined');
  });

  it('does not leak in the other direction either', async () => {
    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: new TestRunner(),
      groups: [
        { name: 'reader', requests: ['reader.bru'] },
        { name: 'writer', requests: ['writer.bru'], variables: { user: 'alice' } },
      ],
    });

    expect(result.groups.find((g) => g.name === 'reader')!.capturedVariables?.saw).toBe('undefined');
  });
});

describe('cookies do not cross a group boundary', () => {
  it('never sends one group\'s session cookie on another group\'s request', async () => {
    await RequestExecutor.executeCollection(root, {
      scriptRunner: new TestRunner(),
      groups: [
        { name: 'a', requests: ['writer.bru', 'reader.bru'] },
        { name: 'b', requests: ['writer.bru', 'reader.bru'] },
      ],
    });

    // Four requests. Within a group the jar carries, so the second request of
    // each group may send `sid`. Across groups it must not: exactly two of the
    // four requests can carry a cookie, never three.
    expect(sentCookies.filter((c) => c.includes('sid=leaked'))).toHaveLength(2);
  });
});

describe('captures are per group', () => {
  it('reports each group\'s own value under the same name', async () => {
    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: new TestRunner(),
      captureVariables: ['who'],
      groups: [
        { name: 'alice', requests: ['writer.bru'], variables: { user: 'alice' } },
        { name: 'bob', requests: ['writer.bru'], variables: { user: 'bob' } },
      ],
    });

    expect(result.groups.find((g) => g.name === 'alice')!.capturedVariables?.who).toBe('alice');
    expect(result.groups.find((g) => g.name === 'bob')!.capturedVariables?.who).toBe('bob');
  });
});

describe('reporting order is deterministic even when execution is not', () => {
  it('returns groups and requests in listed order under parallel', async () => {
    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: new TestRunner(),
      parallel: true,
      groups: [
        { name: 'second', requests: ['reader.bru', 'writer.bru'], parallel: true },
        { name: 'first', requests: ['writer.bru'] },
      ],
    });

    expect(result.groups.map((g) => g.name)).toEqual(['second', 'first']);
    expect(result.groups[0]!.results.map((r) => r.name)).toEqual(['reader', 'writer']);
  });
});

describe('the race M10 asked for is now reproducible', () => {
  it('lets two requests in one parallel group contend on one setVar', async () => {
    // The point of the finding: with the folder as the isolation boundary,
    // two concurrent requests could never share a store, so this could not be
    // written at all. Both outcomes are legitimate — the assertion is that the
    // run completes and reports one of them, not which one.
    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: new TestRunner(),
      captureVariables: ['who'],
      groups: [
        {
          name: 'racers',
          requests: ['writer.bru', 'writer.bru'],
          parallel: true,
          variables: { user: 'alice' },
        },
      ],
    });

    const racers = result.groups[0]!;
    expect(racers.results).toHaveLength(2);
    expect(racers.summary.failed).toBe(0);
    expect(racers.capturedVariables?.who).toBe('alice');
  });
});

describe('a failing group does not stop the run', () => {
  it('reports the failure and still runs the others', async () => {
    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: new TestRunner(),
      parallel: true,
      groups: [
        { name: 'bad', requests: ['nope.bru'] },
        { name: 'good', requests: ['writer.bru'] },
      ],
    });

    expect(result.groups.find((g) => g.name === 'bad')!.missingRequests).toEqual(['nope.bru']);
    expect(result.groups.find((g) => g.name === 'good')!.results).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/bruno/group-isolation.test.ts`
Expected: FAIL — `groups` is not a recognised option and the result has no `groups`.

- [ ] **Step 3: Rewrite the execution body**

In `src/bruno/execution-options.ts`, remove `requestPath` and add:

```ts
  /** Ordered selection when no groups are given. Mutually exclusive with `groups`. */
  requests?: string[];
  /** Explicit groups. Each owns its store, jar, environment and variables. */
  groups?: GroupInput[];
  /**
   * In-flight request ceiling for the whole run. Omit to derive it from the
   * machine; 0 is unbounded, at the caller's risk.
   *
   * A cap below the number of contending requests silently serialises them, so
   * a run trying to reproduce a race needs a cap at least as large as the
   * number of racers.
   */
  maxConcurrency?: number;
```

In `executeCollection`, replace everything from `resolveRunTargets` through the parallel/serial branches with:

```ts
    const plan = await buildRunPlan(collectionPath, {
      requests: options?.requests,
      groups: options?.groups,
      parallel: options?.parallel,
      environment: options?.environment,
      variables: options?.variables,
    });

    await applyDerivedConcurrency(undefined, options?.maxConcurrency);
    const slots = createSemaphore(
      options?.maxConcurrency ?? (await applyDerivedConcurrency()),
    );

    // One loader and one token cache for the run. The loader's cache is
    // read-only so it is safe to share; a token belongs to the credentials, so
    // forty requests should not look like forty logins to the provider.
    const rootLoader: RootLoader = createRootLoader(options?.collectionRoot ?? collectionPath);
    const tokenCache = createTokenCache();

    const runOne = async (
      req: ParsedRequest,
      vars: Map<string, string>,
      store: VariableStore,
      jar: ReturnType<typeof createRunCookieJar> | undefined,
    ): Promise<RequestExecutionResult> => {
      const release = await slots.acquire();
      try {
        return await executeSingleRequest(
          req.yaml, vars, scriptRunner, store, bodyCapture, collectionPath,
          jar, await rootLoader.forRequest(req.filePath), tokenCache,
        );
      } finally {
        release();
      }
    };

    const runGroup = async (group: ResolvedGroup): Promise<GroupRunResult> => {
      const groupStart = Date.now();
      // Each group owns these. That ownership is the whole feature: it is what
      // keeps one identity's session out of another's assertions.
      const store = new VariableStore();
      const jar = cookiesEnabled ? createRunCookieJar() : undefined;

      let vars = new Map<string, string>();
      if (group.environment) {
        vars = await loadEnvironment(options?.collectionRoot ?? collectionPath, group.environment);
      }
      vars = applyVariableOverrides(vars, group.variables);

      const results = group.parallel
        ? await Promise.all(group.requests.map((req) => runOne(req, vars, store, jar)))
        : await (async () => {
            const acc: RequestExecutionResult[] = [];
            for (const req of group.requests) acc.push(await runOne(req, vars, store, jar));
            return acc;
          })();

      const captured = collectCapturedVariables(store.getAll(), options?.captureVariables);
      return {
        name: group.name,
        index: group.index,
        summary: summarise(results, Date.now() - groupStart),
        results,
        ...(group.missingRequests.length ? { missingRequests: group.missingRequests } : {}),
        ...(captured.names.length ? { capturedVariableNames: captured.names } : {}),
        ...(captured.values ? { capturedVariables: captured.values } : {}),
        ...(captured.warnings.length ? { warnings: captured.warnings } : {}),
      };
    };

    const settled = options?.parallel
      ? await Promise.allSettled(plan.groups.map(runGroup))
      : await (async () => {
          const acc: PromiseSettledResult<GroupRunResult>[] = [];
          for (const group of plan.groups) {
            try {
              acc.push({ status: 'fulfilled', value: await runGroup(group) });
            } catch (reason) {
              acc.push({ status: 'rejected', reason });
            }
          }
          return acc;
        })();

    const groups: GroupRunResult[] = settled.map((outcome, index) =>
      outcome.status === 'fulfilled'
        ? outcome.value
        : {
            name: plan.groups[index]!.name,
            index,
            summary: summarise([], 0),
            results: [],
            error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
          },
    );
```

Return `{ summary: summarise(groups.flatMap((g) => g.results), Date.now() - startTime), groups, ... }`.

- [ ] **Step 4: Run tests and checks**

```bash
npx jest tests/unit/bruno/group-isolation.test.ts tests/unit/bruno/collection-run-result-shape.test.ts
npm run typecheck && npx eslint src/bruno/request-executor.ts
```

Expected: PASS, and **`max-lines` must not trip**. The deleted folder-grouping block is larger than what replaces it; if the file still exceeds 1300, move `runGroup` into `run-plan.ts` rather than raising the ceiling.

- [ ] **Step 5: Commit**

```bash
git add src/bruno/request-executor.ts src/bruno/execution-options.ts src/bruno/types.ts tests/unit/bruno/group-isolation.test.ts tests/unit/bruno/collection-run-result-shape.test.ts
git commit -m "feat!: execute caller-defined groups instead of folders

A group owns its request list, environment, variables, VariableStore and
cookie jar. Nothing crosses a group boundary, which is what makes running
the same requests as two identities safe in one call.

The folder is no longer an isolation, ordering or concurrency boundary.
seq is demoted to default ordering and reporting order — already true of
folder seq in parallel mode, now true of requests too.

BREAKING CHANGE: results are group-shaped; the flat results array is gone."
```

---

## Task 7: Retire the cross-store capture reconciliation

**Files:**
- Modify: `src/bruno/captured-variables.ts`
- Modify: `tests/unit/bruno/captured-variables.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `collectCapturedVariables(store: Record<string, string>, requested?: string[])` — **one** store, not an array of snapshots.

- [ ] **Step 1: Update the test to the new contract**

The existing suite covers first-folder-wins and its conflict warning. That reconciliation has no meaning once each group reports its own captures, so those cases go. Read the file first and delete only the multi-store cases; keep the ones about requested-but-never-set, which still apply.

Add:

```ts
it('warns when a requested name was never set, rather than reporting an empty string', () => {
  const captured = collectCapturedVariables({ token: 'abc' }, ['token', 'missing']);

  expect(captured.values).toEqual({ token: 'abc' });
  expect(captured.warnings.join(' ')).toContain('missing');
});

it('reports every name a script set, asked for or not', () => {
  const captured = collectCapturedVariables({ token: 'abc', id: '7' });

  expect(captured.names).toEqual(['id', 'token']);
  expect(captured.values).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/bruno/captured-variables.test.ts`
Expected: FAIL — the function still takes an array of snapshots.

- [ ] **Step 3: Simplify the implementation**

Drop the merge loop and the conflict warning. Delete the comment asserting that folders do not share variables — it is false under groups, and a stale comment that confidently explains wrong behaviour is worse than none.

- [ ] **Step 4: Run the full unit lane**

```bash
npx jest --selectProjects unit
npm run typecheck && npm run lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bruno/captured-variables.ts tests/unit/bruno/captured-variables.test.ts
git commit -m "refactor: captures are per group, so drop the cross-store merge

First-folder-wins and its conflict warning existed because a run had many
stores and one capture map. A group has exactly one store and reports its
own captures, so there is no conflict left to reconcile. The comment
claiming folders do not share variables goes with it — it is now false."
```

---

## Task 8: New tool surface

**Files:**
- Modify: `src/tools/run-tools.ts` (schema and the options it builds)
- Delete: `src/tools/run-target.ts` and its test
- Test: `tests/unit/tools/run-collection.test.ts` (existing — update), `tests/unit/tools/run-collection-groups.test.ts` *(create)*

**Interfaces:**
- Consumes: `ExecutionOptions` from Task 6.
- Produces: the `run_collection` schema in the spec's §3, verbatim.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/tools/run-collection-groups.test.ts` asserting: a `groups` array reaches `executeCollection` unchanged; `requests` plus `groups` is rejected with a message naming both; `requestPath` and `folder` are no longer accepted. Mock `RequestExecutor.executeCollection` and assert on its argument — the tool layer's job is translation, and testing it through a real run tests the executor twice.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/tools/run-collection-groups.test.ts`
Expected: FAIL — `groups` is stripped by the schema.

- [ ] **Step 3: Write the schema**

Copy the schema from the spec's §3. Each `describe()` must state behaviour a caller cannot infer: that a group owns its own store and jar, that group `variables` merge over run-level ones while group `environment` replaces, that `parallel` on a group fans out its requests while `parallel` on the run fans out groups, and that `maxConcurrency` below the number of racers silently serialises them.

Delete `src/tools/run-target.ts`; `buildRunPlan` resolves references now.

- [ ] **Step 4: Run tests and checks**

```bash
npx jest --selectProjects unit
npm run typecheck && npm run lint && npm run build
```

Expected: all PASS. Regenerate any tool-description snapshot in the same commit and read the diff — a snapshot updated without being read is a snapshot that stops testing anything.

- [ ] **Step 5: Commit**

```bash
git add src/tools/run-tools.ts tests/unit/tools/
git rm src/tools/run-target.ts tests/unit/tools/run-target.test.ts
git commit -m "feat!: replace requestPath and folder with an ordered requests list

Both were singular — one file, one subdirectory, or one folder — so no
caller could name an arbitrary set, in an order of their choosing. They
fold into requests, which takes files and directories alike.

Passing both requests and groups is a validation error rather than a
silent precedence rule.

BREAKING CHANGE: requestPath and folder are removed."
```

---

## Task 9: Name the fd limit when EMFILE surfaces

**Files:**
- Modify: `src/bruno/request-executor.ts` (the fetch error path)
- Test: `tests/unit/bruno/emfile-message.test.ts` *(create)*

**Interfaces:**
- Consumes: nothing new.
- Produces: no new exports; an error-message change only.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * There is deliberately no fd-derived cap — the soft limit is around a million
 * on a normal host, so pre-capping would be fortune-telling. The honest
 * alternative is to make the failure diagnosable the moment it happens.
 */
import { RequestExecutor } from '../../../src/bruno/request-executor';
import { TestRunner } from '../../../src/bruno/test-runner';

it('names the open-files soft limit when a request dies with EMFILE', async () => {
  global.fetch = jest.fn().mockRejectedValue(
    Object.assign(new Error('connect EMFILE'), { code: 'EMFILE' }),
  ) as never;

  const result = await RequestExecutor.executeCollection(root, {
    scriptRunner: new TestRunner(),
  });

  const soft = String(process.report.getReport().userLimits.open_files.soft);
  expect(result.groups[0]!.results[0]!.error).toContain('EMFILE');
  expect(result.groups[0]!.results[0]!.error).toContain(soft);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/bruno/emfile-message.test.ts`
Expected: FAIL — the error is the bare `connect EMFILE`.

- [ ] **Step 3: Write the implementation**

In the catch around the fetch, when `code === 'EMFILE'`, append the soft limit read from `process.report.getReport().userLimits.open_files.soft`. Read it lazily, inside the handler — `getReport()` is not cheap and this path is rare. On Windows `userLimits` is empty; guard with optional chaining and fall back to the bare message rather than throwing inside an error handler.

- [ ] **Step 4: Run tests and checks**

```bash
npx jest tests/unit/bruno/emfile-message.test.ts
npm run typecheck && npm run lint
```

- [ ] **Step 5: Commit**

```bash
git add src/bruno/request-executor.ts tests/unit/bruno/emfile-message.test.ts
git commit -m "feat: name the open-files limit when a request dies with EMFILE

No fd-derived cap: the soft limit is around a million on a normal host,
so sizing against it would be fortune-telling. Making the rare failure
self-diagnosing is the honest alternative."
```

---

## Task 10: Documentation and the 2.0.0 release note

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `docs/bruno-mcp-defect-report.md` (the M10 section, ~line 686)
- Test: none — prose. The tool-description assertions in Task 8 cover the machine-readable half.

- [ ] **Step 1: Write the CHANGELOG entry**

Under a new `## 2.0.0` heading, with a **Breaking changes** section naming each row of the spec's §12 migration table, and stating the silent-behaviour-change risk explicitly: a caller passing `parallel: true` today and relying on folder isolation gets shared state after upgrading.

- [ ] **Step 2: Update the README**

Replace folder-parallelism with groups. Include the two worked examples from the spec — the same requests as two identities, and the same requests against two environments — since they are the reason the feature exists and neither is guessable from the schema.

- [ ] **Step 3: Resolve M10 in the defect report**

Strike through the M10 entry and write the resolution beneath it, following the convention the other resolved entries use. Say what actually happened: the finding was answered by removing the folder as a boundary rather than by adding a shared-state mode, and the race is now reproducible by grouping. Link the spec.

- [ ] **Step 4: Verify the whole tree**

```bash
npm ci
npm run build
npx jest
npm run typecheck
npm run lint
```

Expected: all green. Check the **suite count**, not just the failure count — a broken build drops whole suites silently, and "0 failures" across 12 suites is not the same as across 140.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md docs/bruno-mcp-defect-report.md
git commit -m "docs: record the 2.0.0 break and resolve M10

M10 asked for a shared-state concurrency mode. What landed instead
removes the folder as an isolation boundary, so the race it wanted is
reproducible by putting the contending requests in one parallel group —
and isolation is still available by putting them in different ones. No
caller is handed nondeterminism they did not ask for."
```

---

## Self-Review

**Spec coverage.** §2 model → Tasks 4, 6. §3 tool surface → Task 8. §4 isolation → Task 6 (per-request isolation needs no code: one request per group). §5 concurrency → Tasks 1–3, 9. §6 results → Tasks 5, 6, 7. §7 error handling → Tasks 4 (missing references, empty groups), 6 (failing group), 9 (EMFILE). §10 implementation notes → Tasks 2, 4 (both extractions). §11 testing → Tasks 4, 6. §12 migration → Task 10.

**Gap found and closed.** §11 asks for a test that the race is reproducible — two requests in one parallel group contending on one `setVar`, asserting the run completes and both outcomes are legitimate. No task had it. Added to Task 6's test file as its own `describe` block, since it needs the same fixture.

**Type consistency.** `collectCapturedVariables` changes arity in Task 7 but is called in Task 6 — Task 6's snippet already passes a single `store.getAll()`, so the tasks must land in that order or the tree will not compile. Noted in Task 7's position. `GroupInput` is defined in Task 4 and imported by `execution-options.ts` in Task 6; `ResolvedGroup` and `RunPlan` likewise. `applyDerivedConcurrency` takes `(readings?, requested?)` in Task 3 and is called that way in Task 6.

**One thing an implementer must not smooth over.** Task 6's snippet calls `applyDerivedConcurrency` twice, which is redundant — derive once, hold the number, pass it to both the sandbox and `createSemaphore`. It is written that way here to keep the two concerns visible; collapse it when implementing, and make sure the sandbox and the run-wide semaphore end up with the *same* value.
