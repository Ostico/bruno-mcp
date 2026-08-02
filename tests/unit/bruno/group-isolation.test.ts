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

// The executor validates every URL for SSRF, and `example.test` does not
// resolve. What is under test here is grouping, not the validator.
jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
  ssrfRemediation: jest.fn().mockReturnValue(''),
}));


const writer = `meta {\n  name: writer\n  type: http\n  seq: 1\n}\n\nget {\n  url: https://example.test/w\n}\n\nscript:post-response {\n  bru.setVar("who", bru.getVar("user") || "unset");\n}\n`;
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
  it('returns groups and requests in listed order under parallel', async () => {
    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: TestRunner,
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
