/**
 * `vars:post-response`, evaluated in the sandbox.
 *
 * The asymmetry with `vars:pre-request` is the thing to hold on to: pre-request
 * values are RAW text folded into interpolation before the request is built
 * (covered in request-vars-interpolation.test.ts), while these are JS
 * EXPRESSIONS evaluated against the response. Upstream's VarsRuntime does
 * `bru.setVar(name, evaluate(value))` with res in scope.
 *
 * Ordering is the other load-bearing part: upstream runs these BEFORE the
 * post-response script and before the declared assertions, so both can read what
 * they set.
 */

import { runTestJob } from '../../../src/bruno/sandbox-worker';
import type { MockResponseData } from '../../../src/bruno/types';

const OK_BODY = { id: 7, name: 'widget', token: 'abc123', items: [1, 2, 3] };

function response(overrides: Partial<MockResponseData> = {}): MockResponseData {
  return {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    body: OK_BODY,
    responseTime: 12,
    ...overrides,
  };
}

describe('vars:post-response — evaluation', () => {
  it('evaluates the value as an expression and stores the result', () => {
    const { variables } = runTestJob('', response(), 5000, undefined, undefined, [
      { name: 'userId', value: 'res.body.id' },
    ]);
    expect(variables.userId).toBe(7);
  });

  it('runs with no script and no assertions at all', () => {
    // The gate has to admit a request whose only sandbox work is a var, or the
    // var is parsed, written back and never evaluated — the whole defect class.
    const { variables, results } = runTestJob('', response(), 5000, undefined, undefined, [
      { name: 'token', value: 'res.body.token' },
    ]);
    expect(variables.token).toBe('abc123');
    expect(results).toEqual([]);
  });

  it('evaluates a real expression, not just a property read', () => {
    const { variables } = runTestJob('', response(), 5000, undefined, undefined, [
      { name: 'total', value: 'res.body.items.length * 10' },
      { name: 'ok', value: 'res.status === 200' },
      { name: 'greeting', value: '"hi " + res.body.name' },
    ]);
    expect(variables.total).toBe(30);
    expect(variables.ok).toBe(true);
    expect(variables.greeting).toBe('hi widget');
  });

  it('can read a variable seeded from the environment', () => {
    const { variables } = runTestJob(
      '', response(), 5000, { prefix: 'v1' }, undefined,
      [{ name: 'path', value: 'bru.getVar("prefix") + "/users"' }],
    );
    expect(variables.path).toBe('v1/users');
  });

  it('sees an earlier var, because they evaluate in declaration order', () => {
    const { variables } = runTestJob('', response(), 5000, undefined, undefined, [
      { name: 'base', value: 'res.body.id' },
      { name: 'doubled', value: 'bru.getVar("base") * 2' },
    ]);
    expect(variables.doubled).toBe(14);
  });
});

describe('vars:post-response — ordering against the script and the assertions', () => {
  it('is visible to the post-response script', () => {
    const { variables } = runTestJob(
      'bru.setVar("echo", bru.getVar("userId"));',
      response(), 5000, undefined, undefined,
      [{ name: 'userId', value: 'res.body.id' }],
    );
    expect(variables.echo).toBe(7);
  });

  it('is visible to a declared assertion', () => {
    // This is the observable reason the order matters. If vars ran after the
    // assertions, this assertion would read undefined and fail.
    const { results } = runTestJob(
      '', response(), 5000, undefined,
      [{ name: 'bru.getVar("userId")', value: 'eq 7' }],
      [{ name: 'userId', value: 'res.body.id' }],
    );
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('pass');
  });

  it('is visible to a {{var}} operand in a declared assertion', () => {
    // Interpolation of assertion operands happens host-side before the sandbox
    // runs, so a var set in the sandbox CANNOT reach it. Pinned deliberately:
    // this is a real limit, not an oversight, and it should fail loudly rather
    // than silently comparing against literal text if it ever changes.
    const { results } = runTestJob(
      '', response(), 5000, undefined,
      [{ name: 'res.body.id', value: 'eq {{userId}}' }],
      [{ name: 'userId', value: 'res.body.id' }],
    );
    expect(results[0].status).toBe('fail');
    expect(results[0].error).toMatch(/\{\{userId\}\}/);
  });
});

describe('vars:post-response — failures are warnings, not test results', () => {
  it('reports a var whose expression throws without inventing a test result', () => {
    const { results, warnings } = runTestJob('', response(), 5000, undefined, undefined, [
      { name: 'broken', value: 'res.body.missing.deeper' },
    ]);
    expect(results).toEqual([]);
    expect(warnings?.join('\n')).toMatch(/vars:post-response "broken" failed to evaluate/);
  });

  it('does not stop the vars after it', () => {
    const { variables, warnings } = runTestJob('', response(), 5000, undefined, undefined, [
      { name: 'broken', value: 'res.body.missing.deeper' },
      { name: 'fine', value: 'res.body.id' },
    ]);
    expect(variables.fine).toBe(7);
    expect(warnings?.join('\n')).toMatch(/"broken"/);
  });

  it('does not stop the script or the assertions', () => {
    const { results, variables } = runTestJob(
      'bru.setVar("scriptRan", true);',
      response(), 5000, undefined,
      [{ name: 'res.status', value: 'eq 200' }],
      [{ name: 'broken', value: 'res.body.missing.deeper' }],
    );
    expect(variables.scriptRan).toBe(true);
    expect(results.find(r => r.description === 'res.status eq 200')?.status).toBe('pass');
  });

  it('rejects a value that is not a single expression', () => {
    const { warnings, variables } = runTestJob('', response(), 5000, undefined, undefined, [
      { name: 'sneaky', value: '0); bru.setVar("forged", true); (0' },
    ]);
    expect(variables.forged).toBeUndefined();
    expect(warnings?.join('\n')).toMatch(/"sneaky"/);
  });

  it('reports the run as timed out when a var never finishes', () => {
    // A var's value is arbitrary JS from the collection, so a loop is reachable.
    // The V8 interrupt force-terminates the whole context, so this is the run's
    // timeout and not one var's failure — it must escape rather than be
    // collected as a warning, or everything after it evaluates in a dead context.
    const { results } = runTestJob('', response(), 50, undefined, undefined, [
      { name: 'spin', value: '(function () { while (true) {} })()' },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('fail');
    expect(results[0].error).toMatch(/timed out/i);
  });

  it('never lets a var NAME become code', () => {
    // The name crosses as JSON data; only the value is source.
    const { warnings, variables } = runTestJob('', response(), 5000, undefined, undefined, [
      { name: '"); bru.setVar("forged", true); ("', value: 'res.body.id' },
    ]);
    expect(variables.forged).toBeUndefined();
    expect(variables['"); bru.setVar("forged", true); ("']).toBe(7);
    expect(warnings ?? []).toEqual([]);
  });
});
