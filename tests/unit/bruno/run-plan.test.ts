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

    expect(plan.groups[0]!.requests.map((r) => r.yaml.info.name)).toEqual(['list', 'login']);
  });

  it('expands a directory in seq order, not readdir order', async () => {
    const plan = await buildRunPlan(root, { requests: ['auth'] });

    expect(plan.groups[0]!.requests.map((r) => r.yaml.info.name)).toEqual(['login', 'refresh']);
  });

  it('accepts an absolute path as well as a collection-relative one', async () => {
    const plan = await buildRunPlan(root, { requests: [join(root, 'users', 'list.bru')] });

    expect(plan.groups[0]!.requests.map((r) => r.yaml.info.name)).toEqual(['list']);
    expect(plan.groups[0]!.missingRequests).toEqual([]);
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

  it('falls back to the run-level environment for a group that names none', async () => {
    const plan = await buildRunPlan(root, {
      environment: 'dev',
      groups: [{ requests: ['auth/login.bru'] }],
    });

    expect(plan.groups[0]!.environment).toBe('dev');
  });

  it('always gives a group a variables object, so no caller has to branch', async () => {
    const plan = await buildRunPlan(root, { groups: [{ requests: ['auth/login.bru'] }] });

    expect(plan.groups[0]!.variables).toEqual({});
  });

  it('defaults a group to serial even when the run fans groups out', async () => {
    const plan = await buildRunPlan(root, {
      parallel: true,
      groups: [{ requests: ['auth'] }],
    });

    expect(plan.groups[0]!.parallel).toBe(false);
  });

  it('honours a group asking for parallel', async () => {
    const plan = await buildRunPlan(root, { groups: [{ requests: ['auth'], parallel: true }] });

    expect(plan.groups[0]!.parallel).toBe(true);
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

    // By path, not by object identity: two resolutions of one file produce two
    // distinct objects, so a length check alone survives a dedupe.
    expect(plan.groups[0]!.requests.map((r) => r.filePath)).toEqual([
      join(root, 'auth', 'login.bru'),
      join(root, 'auth', 'login.bru'),
    ]);
  });

  it('says the same thing once when two references warn identically', async () => {
    // Naming one unconventional file twice is one fact about the collection,
    // not two.
    await writeFile(
      join(root, 'users', 'legacy.yaml'),
      'info:\n  name: legacy\n  type: http\n  seq: 1\nhttp:\n  method: GET\n  url: https://example.test/legacy\n',
    );
    const plan = await buildRunPlan(root, {
      groups: [{ requests: ['users/legacy.yaml', 'users/legacy.yaml'] }],
    });

    expect(plan.warnings.filter((w) => w.includes('legacy.yaml'))).toHaveLength(1);
  });

  it('records an unresolvable reference instead of throwing', async () => {
    // A caller that cannot see which subset ran cannot bisect.
    const plan = await buildRunPlan(root, {
      groups: [{ requests: ['auth/login.bru', 'auth/nope.bru'] }],
    });

    expect(plan.groups[0]!.requests).toHaveLength(1);
    expect(plan.groups[0]!.missingRequests).toEqual(['auth/nope.bru']);
  });

  it('still throws for a named request that is there but will not parse', async () => {
    // Absence is a missing member; a syntax error is a fact about a file the
    // caller named, and reporting it as "missing" would send them looking for
    // a path that is right there.
    await writeFile(join(root, 'auth', 'broken.bru'), 'meta {\n  name: broken\n');

    await expect(
      buildRunPlan(root, { groups: [{ requests: ['auth/broken.bru'] }] }),
    ).rejects.toThrow(/broken\.bru/);
  });

  it('reports an empty group rather than passing silently', async () => {
    const plan = await buildRunPlan(root, { groups: [{ requests: ['nowhere'] }] });

    expect(plan.groups[0]!.requests).toHaveLength(0);
    expect(plan.warnings.join(' ')).toContain('no requests');
  });

  it('names each empty group separately rather than collapsing them', async () => {
    // Deduplicating warnings must not lose one of two distinct empty groups.
    const plan = await buildRunPlan(root, {
      groups: [{ requests: ['nowhere'] }, { requests: ['elsewhere'] }],
    });

    expect(plan.warnings.filter((w) => w.includes('no requests'))).toHaveLength(2);
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
