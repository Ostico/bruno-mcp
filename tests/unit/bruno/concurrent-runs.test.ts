/**
 * Two runs in flight at once.
 *
 * The documented claim this pins: simultaneity is per call. Groups plus
 * `parallel` are the only way to make two things happen at the same moment, and
 * the reason is not that this server serialises separate calls — it does not,
 * and that is asserted here — but that nothing on this side decides when a
 * second call starts. A client that issues tool calls one at a time produces
 * runs seconds apart, and no single run's result shows the gap.
 *
 * Written as a deadlock detector rather than as a timing comparison: neither
 * run's request can finish until both have been sent. If anything ever
 * serialised the two, whichever went first would sit until the escape hatch
 * fired, and the assertion is on that hatch. The barrier is symmetric on
 * purpose — a one-sided wait would still be satisfied by serialisation in the
 * lucky order. A wall-clock comparison would have measured machine load
 * instead.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestExecutor } from '../../../src/bruno/request-executor';
import { TestRunner } from '../../../src/bruno/test-runner';

// `example.test` does not resolve, and what is under test here is overlap, not
// the SSRF validator.
jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
  ssrfRemediation: jest.fn().mockReturnValue(''),
}));

/** Long enough that a machine under load does not trip it; short enough to fail fast. */
const ESCAPE_MS = 5000;

function request(name: string, path: string): string {
  return `meta {\n  name: ${name}\n  type: http\n  seq: 1\n}\n\nget {\n  url: https://example.test/${path}\n}\n`;
}

async function collection(label: string, path: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `concurrent-${label}-`));
  await writeFile(join(root, `${label}.bru`), request(label, path));
  return root;
}

it('runs two collections at the same time rather than queueing the second', async () => {
  const firstRoot = await collection('first', 'first');
  const secondRoot = await collection('second', 'second');

  let releaseBarrier = (): void => {};
  const bothSent = new Promise<void>((resolve) => { releaseBarrier = resolve; });
  const arrived = new Set<string>();
  let escaped = false;

  global.fetch = jest.fn().mockImplementation(async (target: unknown) => {
    arrived.add(String(target));
    if (arrived.size === 2) {
      releaseBarrier();
    }
    // Neither request completes until both have been sent. Serialised runs
    // never satisfy that in either order, so the escape hatch is what the
    // assertion reads.
    await Promise.race([
      bothSent,
      new Promise<void>((resolve) => {
        setTimeout(() => { escaped = true; resolve(); }, ESCAPE_MS);
      }),
    ]);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as never;

  const [first, second] = await Promise.all([
    RequestExecutor.executeCollection(firstRoot, { scriptRunner: TestRunner }),
    RequestExecutor.executeCollection(secondRoot, { scriptRunner: TestRunner }),
  ]);

  expect(escaped).toBe(false);
  expect(first.summary.total).toBe(1);
  expect(second.summary.total).toBe(1);
  expect(first.summary.failed).toBe(0);
  expect(second.summary.failed).toBe(0);
}, ESCAPE_MS * 3);
