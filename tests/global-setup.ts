/**
 * Builds dist/ exactly once, before any test file runs.
 *
 * `npm run build` is `tsup ... --clean`, i.e. `rm -rf dist` followed by a
 * rebuild. Two integration suites need the build output — sandbox-fork spawns
 * dist/bruno/sandbox-worker.js, mcp-stdio spawns dist/index.js — and jest runs
 * test files in parallel workers. When each suite built in its own `beforeAll`,
 * one suite's `--clean` could land after the other's build had finished but
 * before it spawned, so a suite would spawn a path that had just been deleted
 *. That is a real flake, not a theoretical one; mcp-stdio.test.ts
 * used to carry a snapshot-plus-retry workaround for it.
 *
 * Hoisting the build here removes the race by construction rather than making
 * it less likely: jest awaits globalSetup to completion before it starts any
 * worker, and it invokes a given globalSetup module at most once per run
 * (@jest/core dedupes the hook paths through a Set), so nothing rebuilds — and
 * therefore nothing deletes dist/ — while a suite is running.
 *
 * The build is unconditional on purpose. Skipping it when the artifact merely
 * exists is what once let a stale dist/ keep sandbox-fork.test.ts green after
 * the build script had stopped emitting the worker at all, which is the exact
 * breakage that suite exists to catch.
 */

import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');

/** Left behind by an earlier snapshot workaround in mcp-stdio.test.ts. */
const legacySnapshotDir = path.join(repoRoot, 'tests', 'integration', '.mcp-stdio-dist');

interface ExecError extends Error {
  stdout?: Buffer | string;
  stderr?: Buffer | string;
}

export default function globalSetup(): void {
  rmSync(legacySnapshotDir, { recursive: true, force: true });

  const startedAt = Date.now();
  try {
    // Output is captured rather than inherited so a successful build stays
    // quiet, and surfaced below when it fails — an `stdio: 'ignore'` build that
    // throws reports only a bare exit code, which is useless to debug.
    execSync('npm run build', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const { stdout, stderr } = error as ExecError;
    throw new Error(
      `jest globalSetup: \`npm run build\` failed, so no suite can spawn from dist/.\n` +
        `${String(stdout ?? '')}\n${String(stderr ?? '')}`.trim(),
    );
  }
  process.stderr.write(`[jest globalSetup] built dist/ in ${Date.now() - startedAt}ms\n`);
}
