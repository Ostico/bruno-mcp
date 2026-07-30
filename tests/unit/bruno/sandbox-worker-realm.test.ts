/**
 * Tests for the realm boundary at the pre-request mutation readback.
 *
 * __reqMutations is an ordinary sandbox global, so a script can replace it with
 * an object whose properties are getters, or with a Proxy. If the host receives
 * that object by reference, the traps run on the HOST stack — after
 * runInContext has returned and the V8 interrupt implementing the vm timeout is
 * no longer armed. A spinning getter there hangs the process outright, which is
 * why the mutations have to be serialised inside the context like the results
 * accumulator and the variable store are.
 *
 * Several of these tests would hang rather than fail if that boundary reopened.
 * The jest timeout is what turns the hang into a reported failure.
 */

import { runPreRequestJob, DEFAULT_TIMEOUT } from '../../../src/bruno/sandbox-worker';
import type { MockRequestData, PreRequestScriptResult } from '../../../src/bruno/types';

const request: MockRequestData = {
  url: 'https://example.test/api',
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: { hello: 'world' },
};

/** Short enough that a spin inside the context is bounded well under jest's. */
const SHORT_TIMEOUT = 250;

function run(script: string, timeout = DEFAULT_TIMEOUT): PreRequestScriptResult {
  return runPreRequestJob(script, request, timeout);
}

describe('pre-request mutations cross the realm boundary as inert data', () => {
  it('hands back a plain object with no accessors', () => {
    const result = run('req.setUrl("https://example.test/other"); req.setHeader("x-a", "1");');

    expect(result.mutations.url).toBe('https://example.test/other');
    expect(Object.getOwnPropertyDescriptor(result.mutations, 'url')?.get).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(result.mutations, 'headers')?.get).toBeUndefined();
  });

  it('does not run a script-installed getter on the host stack', () => {
    // The getter never returns. Reading .url below is the host-side property
    // access that would execute it with no timeout armed.
    const result = run('__reqMutations = { get url() { for (;;) {} } };', SHORT_TIMEOUT);

    // Reaching this line at all is the assertion: the spin was contained inside
    // the context, where the vm timeout could stop it.
    expect(result.mutations.url).toBeUndefined();
  });

  it('does not run a Proxy trap on the host stack', () => {
    const result = run(
      '__reqMutations = new Proxy({}, { get: function () { for (;;) {} } });',
      SHORT_TIMEOUT,
    );

    expect(result.mutations.url).toBeUndefined();
    expect(result.mutations.headers).toBeUndefined();
  });

  it('yields no mutations when a getter throws during serialisation', () => {
    const result = run('__reqMutations = { get url() { throw new Error("nope"); } };');

    expect(result.mutations).toEqual({});
  });

  it('yields no mutations when the tracker cannot be serialised', () => {
    // A circular structure makes JSON.stringify throw inside the context.
    const result = run('__reqMutations = {}; __reqMutations.self = __reqMutations;');

    expect(result.mutations).toEqual({});
  });

  it('yields no mutations when the tracker is replaced with a non-object', () => {
    expect(run('__reqMutations = "url";').mutations).toEqual({});
    expect(run('__reqMutations = 42;').mutations).toEqual({});
    expect(run('__reqMutations = null;').mutations).toEqual({});
    expect(run('__reqMutations = ["https://elsewhere.test/"];').mutations).toEqual({});
  });

  it('stringifies a primitive url and header value, as the transport would', () => {
    const result = run('__reqMutations = { url: 7, headers: { "x-a": 42, "x-b": true } };');

    expect(result.mutations.url).toBe('7');
    expect(result.mutations.headers).toEqual({ 'x-a': '42', 'x-b': 'true' });
  });

  it('drops a headers field that is not an object at all', () => {
    const result = run('__reqMutations = { headers: "x-a: 1" };');

    expect(result.mutations.headers).toBeUndefined();
  });

  it('drops a header value that could only reach the wire as [object Object]', () => {
    const result = run('__reqMutations = { headers: { "x-a": "1", "x-b": { nested: true } } };');

    expect(result.mutations.headers).toEqual({ 'x-a': '1' });
  });

  it('never carries a prototype through the header map', () => {
    const result = run(
      '__reqMutations = { headers: JSON.parse(\'{"__proto__":{"polluted":true},"x-a":"1"}\') };',
    );

    expect(result.mutations.headers).toEqual({ 'x-a': '1' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('still records a body mutation, including an explicit null', () => {
    expect(run('req.setBody({ replaced: true });').mutations.body).toEqual({ replaced: true });
    expect(run('__reqMutations = { body: null };').mutations).toHaveProperty('body', null);
  });

  it('reports no mutations when the script itself times out', () => {
    const result = run('req.setUrl("https://example.test/other"); for (;;) {}', SHORT_TIMEOUT);

    expect(result.error).toMatch(/timed out/i);
    expect(result.mutations).toEqual({});
  });

  it('preserves variables set before an error even though mutations are dropped', () => {
    const result = run('bru.setVar("token", "abc"); throw new Error("boom");');

    expect(result.variables.token).toBe('abc');
    expect(result.mutations).toEqual({});
    expect(result.error).toMatch(/boom/);
  });
});
