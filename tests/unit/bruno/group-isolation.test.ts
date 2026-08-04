/**
 * Nothing crosses a group boundary — not variables, not cookies, not captures.
 * These are written as leak detectors: each asserts a reader group sees
 * *nothing* of a writer group, in both orderings and at both parallel settings.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestExecutor } from '../../../src/bruno/request-executor';
import { TestRunner } from '../../../src/bruno/test-runner';

// The executor validates every URL for SSRF, and `example.test` does not
// resolve. What is under test here is grouping, not the validator.
jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
  ssrfRemediation: jest.fn().mockReturnValue(''),
}));


const writer = `meta {\n  name: writer\n  type: http\n  seq: 1\n}\n\nget {\n  url: https://example.test/w\n}\n\nscript:post-response {\n  bru.setVar("who", bru.getVar("user") || "unset");\n}\n`;
const reader = `meta {\n  name: reader\n  type: http\n  seq: 1\n}\n\nget {\n  url: https://example.test/r\n}\n\nscript:post-response {\n  bru.setVar("saw", String(bru.getVar("who")));\n}\n`;

// Answers slowly, and carries a `seq` that puts it after `writer`. Both facts
// exist to be contradicted by a group that lists it first: the listed order has
// to survive a completion order that disagrees with it, and a `seq` agreeing
// with the listed order would prove nothing about `seq` no longer constraining
// execution.
const slow = `meta {\n  name: slow\n  type: http\n  seq: 2\n}\n\nget {\n  url: https://example.test/slow\n}\n`;

// Resolves `{{baseUrl}}` out of whichever environment its group named.
const whoami = `meta {\n  name: whoami\n  type: http\n  seq: 1\n}\n\nget {\n  url: {{baseUrl}}/me\n}\n`;

const environment = (host: string): string => `vars {\n  baseUrl: https://${host}.test\n}\n`;

const SLOW_MS = 40;

let root: string;
let sentCookies: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'groups-'));
  await writeFile(join(root, 'writer.bru'), writer);
  await writeFile(join(root, 'reader.bru'), reader);
  await writeFile(join(root, 'slow.bru'), slow);
  await writeFile(join(root, 'whoami.bru'), whoami);
  await mkdir(join(root, 'environments'));
  await writeFile(join(root, 'environments', 'alice.bru'), environment('alice'));
  await writeFile(join(root, 'environments', 'bob.bru'), environment('bob'));
  sentCookies = [];

  global.fetch = jest.fn().mockImplementation(async (url: string, init: RequestInit) => {
    const headers = new Headers(init?.headers);
    sentCookies.push(headers.get('cookie') ?? '');
    // Turns "reported in listed order" into a claim that can fail. With every
    // response immediate, completion order matched the listed order by accident
    // and the assertion held whether or not anything preserved it.
    if (String(url).endsWith('/slow')) {
      await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
    }
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'set-cookie': 'sid=leaked; Path=/' },
    });
  }) as never;
});

describe('variables do not cross a group boundary', () => {
  it.each([true, false])('with parallel=%s', async (parallel) => {
    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: TestRunner,
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
      scriptRunner: TestRunner,
      captureVariables: ['who', 'saw'],
      groups: [
        { name: 'reader', requests: ['reader.bru'] },
        { name: 'writer', requests: ['writer.bru'], variables: { user: 'alice' } },
      ],
    });

    expect(result.groups.find((g) => g.name === 'reader')!.capturedVariables?.saw).toBe('undefined');
  });
});

describe('cookies do not cross a group boundary', () => {
  it("never sends one group's session cookie on another group's request", async () => {
    await RequestExecutor.executeCollection(root, {
      scriptRunner: TestRunner,
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
  it("reports each group's own value under the same name", async () => {
    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: TestRunner,
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
  // Both listed orders are the reverse of the completion order: the group listed
  // first holds the slow request and therefore finishes last, and within it the
  // slow request is listed first. `seq` disagrees with the listed order too
  // (slow is seq 2, writer seq 1), which is what makes this an assertion about
  // the caller's order rather than about seq or about whichever finished first.
  //
  // Repeated, because one pass of a scheduling assertion says only that one
  // interleaving came out right.
  it.each([1, 2, 3])('returns groups and requests in listed order under parallel (run %i)', async () => {
    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: TestRunner,
      parallel: true,
      groups: [
        { name: 'slowest', requests: ['slow.bru', 'writer.bru'], parallel: true },
        { name: 'quickest', requests: ['writer.bru'] },
      ],
    });

    expect(result.groups.map((g) => g.name)).toEqual(['slowest', 'quickest']);
    expect(result.groups[0]!.results.map((r) => r.name)).toEqual(['slow', 'writer']);
    // Proves the ordering above was not free: the slow request really did
    // outlast the group reported after it.
    // Compared against the other requests rather than against SLOW_MS itself: a
    // 40 ms sleep is regularly measured as 39, and that one millisecond of clock
    // granularity failed this test at random on CI. What the assertion is for is
    // the gap between this request and the ones reported after it, which is two
    // orders of magnitude wider than the rounding.
    const slowDuration = result.groups[0]!.results[0]!.duration_ms;
    expect(slowDuration).toBeGreaterThan(result.groups[0]!.results[1]!.duration_ms);
    expect(slowDuration).toBeGreaterThan(result.groups[1]!.results[0]!.duration_ms);
  });
});

describe('environments do not cross a group boundary', () => {
  it.each([true, false])(
    'resolves each group\'s own {{baseUrl}} for the same request (parallel=%s)',
    async (parallel) => {
      const result = await RequestExecutor.executeCollection(root, {
        scriptRunner: TestRunner,
        parallel,
        groups: [
          { name: 'alice', requests: ['whoami.bru'], environment: 'alice' },
          { name: 'bob', requests: ['whoami.bru'], environment: 'bob' },
        ],
      });

      const urlFor = (name: string): string | undefined =>
        result.groups.find((g) => g.name === name)!.results[0]?.url;

      expect(urlFor('alice')).toBe('https://alice.test/me');
      expect(urlFor('bob')).toBe('https://bob.test/me');
    },
  );

  it('falls back to the run-level environment only for the group that named none', async () => {
    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: TestRunner,
      environment: 'alice',
      groups: [
        { name: 'inherits', requests: ['whoami.bru'] },
        { name: 'overrides', requests: ['whoami.bru'], environment: 'bob' },
      ],
    });

    const urlFor = (name: string): string | undefined =>
      result.groups.find((g) => g.name === name)!.results[0]?.url;

    expect(urlFor('inherits')).toBe('https://alice.test/me');
    expect(urlFor('overrides')).toBe('https://bob.test/me');
  });
});

describe('the race M10 asked for is now reproducible', () => {
  it('lets two requests in one parallel group contend on one setVar', async () => {
    // The point of the finding: with the folder as the isolation boundary,
    // two concurrent requests could never share a store, so this could not be
    // written at all. Both outcomes are legitimate — the assertion is that the
    // run completes and reports one of them, not which one.
    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: TestRunner,
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
      scriptRunner: TestRunner,
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
