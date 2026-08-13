/**
 * The barrier between parallel groups.
 *
 * What a caller could not express before: a listener that must be connected
 * before a trigger fires. The only tool available was `bru.sleep`, tuned to
 * whatever the latency was the day it was written, so the test either passed by
 * luck or slept for longer than it needed. `startAfter` names a position in
 * another group instead — "once the listener has run two requests" — which is a
 * fact about the run rather than about the network.
 *
 * The order assertions here read a log of send order rather than timestamps: a
 * clock comparison would measure machine load, and the claim is about ordering.
 */
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestExecutor } from '../../../src/bruno/request-executor';
import { TestRunner } from '../../../src/bruno/test-runner';

jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
  ssrfRemediation: jest.fn().mockReturnValue(''),
}));

function request(name: string, seq: number, path: string): string {
  return `meta {\n  name: ${name}\n  type: http\n  seq: ${seq}\n}\n\nget {\n  url: https://example.test/${path}\n}\n`;
}

/** A collection whose folders each hold two requests, named for their path. */
async function collection(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'start-after-'));
  for (const folder of ['listener', 'trigger', 'third']) {
    await mkdir(join(root, folder));
    await writeFile(join(root, folder, 'first.bru'), request('first', 1, `${folder}-first`));
    await writeFile(join(root, folder, 'second.bru'), request('second', 2, `${folder}-second`));
  }
  return root;
}

let sent: string[];
let release: Map<string, () => void>;

/**
 * Every request records the moment it was sent and then waits to be released, so
 * a test decides the interleaving rather than the event loop.
 */
function heldFetch(): void {
  global.fetch = jest.fn().mockImplementation(async (target: unknown) => {
    const url = String(target);
    const label = url.slice(url.lastIndexOf('/') + 1);
    sent.push(label);
    const gate = release.get(label);
    if (gate) {
      gate();
    }
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as never;
}

beforeEach(() => {
  sent = [];
  release = new Map();
  heldFetch();
});

const RUN = { scriptRunner: TestRunner, parallel: true } as const;

describe('a gated group', () => {
  it('does not send anything until the group it waits on has got that far', async () => {
    const root = await collection();

    const result = await RequestExecutor.executeCollection(root, {
      ...RUN,
      groups: [
        { name: 'listener', requests: ['listener'] },
        { name: 'trigger', requests: ['trigger'], startAfter: { group: 'listener', requestsCompleted: 2 } },
      ],
    });

    expect(result.summary.failed).toBe(0);
    // Both of the listener's requests precede either of the trigger's, which is
    // the whole guarantee: without the gate the two groups interleave from the
    // first tick.
    expect(sent.indexOf('trigger-first')).toBeGreaterThan(sent.indexOf('listener-second'));
    expect(sent.slice(0, 2)).toEqual(['listener-first', 'listener-second']);
  });

  it('waits for one request by default', async () => {
    const root = await collection();

    // The group waited on runs exactly one request, so a default of anything but
    // one would be refused as unsatisfiable rather than quietly holding longer.
    const result = await RequestExecutor.executeCollection(root, {
      ...RUN,
      groups: [
        { name: 'listener', requests: ['listener/first.bru'] },
        { name: 'trigger', requests: ['trigger'], startAfter: { group: 'listener' } },
      ],
    });

    expect(result.summary.failed).toBe(0);
    expect(sent[0]).toBe('listener-first');
    expect(sent.indexOf('trigger-first')).toBeGreaterThan(sent.indexOf('listener-first'));
  });

  it('holds a chain in order', async () => {
    const root = await collection();

    const result = await RequestExecutor.executeCollection(root, {
      ...RUN,
      groups: [
        { name: 'listener', requests: ['listener'] },
        { name: 'trigger', requests: ['trigger'], startAfter: { group: 'listener', requestsCompleted: 2 } },
        { name: 'third', requests: ['third'], startAfter: { group: 'trigger', requestsCompleted: 2 } },
      ],
    });

    expect(result.summary.failed).toBe(0);
    expect(sent).toEqual([
      'listener-first', 'listener-second',
      'trigger-first', 'trigger-second',
      'third-first', 'third-second',
    ]);
  });

  it('counts a failed request as a position reached', async () => {
    const root = await collection();
    global.fetch = jest.fn().mockImplementation(async (target: unknown) => {
      const url = String(target);
      const label = url.slice(url.lastIndexOf('/') + 1);
      sent.push(label);
      if (label === 'listener-first') {
        throw new Error('connection reset');
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as never;

    const result = await RequestExecutor.executeCollection(root, {
      ...RUN,
      groups: [
        { name: 'listener', requests: ['listener'] },
        { name: 'trigger', requests: ['trigger'], startAfter: { group: 'listener', requestsCompleted: 1 } },
      ],
    });

    // The trigger ran: a gate marks a position, and waiting for a verdict would
    // have hung the run rather than reporting the failure.
    expect(sent).toContain('trigger-first');
    expect(result.summary.failed).toBe(1);
  });
});

describe('a gate that stops being satisfiable', () => {
  it('reports the shortfall as the waiting group\'s error rather than hanging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'start-after-short-'));
    await mkdir(join(root, 'listener'));
    await writeFile(join(root, 'listener', 'first.bru'), request('first', 1, 'listener-first'));
    // Named, and unparseable: naming a file that cannot be read fails the group
    // that named it, so the listener ends having completed nothing.
    await writeFile(join(root, 'listener', 'broken.bru'), 'meta {\n  name: broken\n');
    await mkdir(join(root, 'trigger'));
    await writeFile(join(root, 'trigger', 'first.bru'), request('first', 1, 'trigger-first'));

    const result = await RequestExecutor.executeCollection(root, {
      ...RUN,
      groups: [
        { name: 'listener', requests: ['listener/broken.bru', 'listener/first.bru'] },
        { name: 'trigger', requests: ['trigger'], startAfter: { group: 'listener', requestsCompleted: 1 } },
      ],
    });

    const trigger = result.groups.find((group) => group.name === 'trigger');
    expect(trigger?.error).toContain('Did not start');
    expect(trigger?.error).toContain('group "listener"');
    expect(sent).not.toContain('trigger-first');
  });
});

describe('a gate that could never open', () => {
  async function refusal(groups: unknown[]): Promise<string> {
    const root = await collection();
    try {
      await RequestExecutor.executeCollection(root, {
        ...RUN,
        groups: groups as never,
      });
    } catch (reason) {
      return reason instanceof Error ? reason.message : String(reason);
    }
    return 'no refusal';
  }

  it('is refused when the named group is not in the run', async () => {
    const message = await refusal([
      { name: 'trigger', requests: ['trigger'], startAfter: { group: 'nobody' } },
    ]);
    expect(message).toContain('does not contain');
  });

  it('is refused when a group waits on itself', async () => {
    const message = await refusal([
      { name: 'trigger', requests: ['trigger'], startAfter: { group: 'trigger' } },
    ]);
    expect(message).toContain('waits on itself');
  });

  it('is refused when two groups wait on each other', async () => {
    const message = await refusal([
      { name: 'listener', requests: ['listener'], startAfter: { group: 'trigger' } },
      { name: 'trigger', requests: ['trigger'], startAfter: { group: 'listener' } },
    ]);
    expect(message).toContain('cycle');
  });

  it('is refused when it asks for more requests than the group runs', async () => {
    const message = await refusal([
      { name: 'listener', requests: ['listener'] },
      { name: 'trigger', requests: ['trigger'], startAfter: { group: 'listener', requestsCompleted: 5 } },
    ]);
    expect(message).toContain('can never open');
  });

  it('is refused when the group it names iterates over rows', async () => {
    const message = await refusal([
      { name: 'listener', requests: ['listener'], data: [{ who: 'a' }, { who: 'b' }] },
      { name: 'trigger', requests: ['trigger'], startAfter: { group: 'listener' } },
    ]);
    expect(message).toContain('iterates over rows');
  });

  it('is refused when the run does not fan its groups out', async () => {
    const root = await collection();
    let message = 'no refusal';
    try {
      await RequestExecutor.executeCollection(root, {
        scriptRunner: TestRunner,
        groups: [
          { name: 'listener', requests: ['listener'] },
          { name: 'trigger', requests: ['trigger'], startAfter: { group: 'listener' } },
        ],
      });
    } catch (reason) {
      message = reason instanceof Error ? reason.message : String(reason);
    }
    // Sequential groups make a gate either already satisfied or unsatisfiable,
    // and a caller who asked for a barrier should not get the former silently.
    expect(message).toContain('parallel: true');
  });
});
