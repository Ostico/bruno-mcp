/**
 * base64, inside the sandbox.
 *
 * A fresh `vm` context carries the ECMAScript intrinsics and nothing else, so
 * `atob`, `btoa` and `Buffer` were all absent. A test that wanted the `uid` out
 * of a JWT the login had just returned could not read it, and the workaround was
 * an extra HTTP request for a value already in hand.
 *
 * The assertions here are mostly parity assertions, against Node's own `atob`
 * and `btoa`: a reimplementation that is subtly wrong about padding or about
 * whitespace is worse than none, because it returns a plausible string rather
 * than failing. The last block is the one that matters most — these are the
 * first globals added to the realm in a while, and a global installed as a host
 * function is the classic way a sandbox grows an escape.
 */
import { runPreRequestJob, runTestJob, DEFAULT_TIMEOUT } from '../../../src/bruno/sandbox-worker';
import { MockRequestData, MockResponseData } from '../../../src/bruno/types';

const request: MockRequestData = {
  url: 'https://example.test/api',
  method: 'POST',
  headers: {},
  body: {},
};

const response: MockResponseData = {
  status: 200,
  statusText: 'OK',
  headers: {},
  body: { ok: true },
  responseTime: 1,
};

/** Runs `expression` in a post-response script and returns what it evaluated to. */
function evaluate(expression: string): unknown {
  const result = runTestJob(
    `bru.setVar("out", ${expression});`,
    response,
    DEFAULT_TIMEOUT,
  );
  // A throw in a post-response script is reported as a failed test rather than
  // as a job-level error, so a helper that only read `variables` would report
  // `undefined` for a script that blew up.
  expect(result.results.filter((r) => r.status === 'fail')).toEqual([]);
  return result.variables.out;
}

/** Runs `expression` and returns the error the script reported, if any. */
function errorFrom(expression: string): string | undefined {
  const { results } = runTestJob(`bru.setVar("out", ${expression});`, response, DEFAULT_TIMEOUT);
  return results.find((r) => r.status === 'fail')?.error;
}

describe('reading a value out of a token', () => {
  it('decodes a JWT payload, which is what this exists for', () => {
    // The motivating case: base64url, unpadded, with the `-`/`_` alphabet the
    // JWT spec uses — so the script has to translate before decoding, exactly as
    // it would in the Bruno app.
    const payload = Buffer.from(JSON.stringify({ uid: 4211, sub: 'alice' })).toString('base64url');
    const token = `header.${payload}.signature`;

    const out = evaluate(
      `JSON.parse(atob("${token}".split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).uid`,
    );

    expect(out).toBe(4211);
  });

  it('builds a Basic credential in a pre-request script', async () => {
    // btoa is needed on the way out as much as atob is on the way in, and the
    // pre-request phase is where a header gets built.
    const result = await runPreRequestJob(
      'bru.setVar("header", "Basic " + btoa("alice:s3cret"));',
      request,
      DEFAULT_TIMEOUT,
    );

    expect(result.error).toBeUndefined();
    expect(result.variables.header).toBe(`Basic ${Buffer.from('alice:s3cret').toString('base64')}`);
  });
});

describe('agreeing with the platform', () => {
  // Node's own atob/btoa are the oracle. A hand-rolled encoder that disagrees on
  // padding returns a plausible wrong answer rather than an error, which is the
  // failure mode worth spending assertions on.
  it.each([
    ['', ''],
    ['a', 'one byte, two padding characters'],
    ['ab', 'two bytes, one padding character'],
    ['abc', 'three bytes, no padding'],
    ['abcd', 'a second block'],
    // Escaped rather than literal: a raw NUL in the source makes git treat the
    // whole file as binary, and a test nobody can read a diff of is a test
    // nobody reviews.
    ['\u0000\u0001\u00ff', 'the edges of the byte range'],
    ['{"uid":4211,"sub":"alice"}', 'a JSON payload'],
  ])('encodes %j (%s) the way btoa does', (input) => {
    expect(evaluate(JSON.stringify(input).replace(/^/, 'btoa(') + ')'))
      .toBe(btoa(input));
  });

  it.each([
    'YQ==',
    'YWI=',
    'YWJj',
    'YWJjZA==',
    'eyJ1aWQiOjQyMTF9',
  ])('decodes %s the way atob does', (encoded) => {
    expect(evaluate(`atob("${encoded}")`)).toBe(atob(encoded));
  });

  it('accepts base64 that arrived without its padding', () => {
    // Optional on the way in, and a value pulled out of a JWT or a header often
    // has none. Rejecting it would push every caller into re-padding by hand.
    expect(evaluate('atob("YQ")')).toBe('a');
    expect(evaluate('atob("YWI")')).toBe('ab');
  });

  it('ignores whitespace, so a wrapped value still decodes', () => {
    expect(evaluate('atob("YWJj\\n YWJj")')).toBe('abcabc');
  });
});

describe('refusing what cannot be decoded', () => {
  it('rejects a character outside the alphabet, naming the operation', () => {
    expect(errorFrom('atob("not base64!")')).toContain('Failed to execute atob');
  });

  it('carries the platform\'s error name to a script that catches it', () => {
    // The name is the part of the contract a script can act on: catching by name
    // works here exactly as it does in the Bruno app.
    //
    // It reaches the script but not the reported failure, because an uncaught
    // error is rewrapped on the way out into a host Error chosen from the builtin
    // names — which is why the assertion above is about the message instead.
    expect(evaluate('(function () { try { atob("!!"); } catch (e) { return e.name; } })()'))
      .toBe('InvalidCharacterError');
  });

  it('rejects a length no base64 input can have, and says which fault it is', () => {
    // 4n+1 characters cannot come from any byte sequence. The diagnosis has to
    // be its own: padding such a value up to a multiple of four leaves an '='
    // in the middle of it, so a shared message would blame a stray character
    // the caller never wrote.
    expect(errorFrom('atob("YWJjZA==Y")')).toContain('a length no base64 value can have');
    expect(errorFrom('atob("Y")')).toContain('a length no base64 value can have');
  });

  it('rejects encoding a character that is not a byte', () => {
    // btoa encodes bytes. Truncating a code point above 0xff would return base64
    // that decodes to different text than was passed in.
    expect(errorFrom('btoa("caf\\u00e9 \\u2014 dash")')).toContain('Failed to execute btoa');
  });

  it('still encodes the whole Latin-1 range', () => {
    expect(evaluate('btoa("caf\\u00e9")')).toBe(btoa('café'));
  });
});

describe('what adding a global did not open', () => {
  it('gives no route to the host realm through the new functions', () => {
    // The reason this is written in the realm rather than handed in as a host
    // function: a host function's `constructor` is the host realm's `Function`,
    // and `Function("return globalThis")()` off it reaches the real global.
    const escape = runTestJob(
      'bru.setVar("out", String(atob.constructor("return globalThis")().process));',
      response,
      DEFAULT_TIMEOUT,
    );

    expect(escape.variables.out).toBeUndefined();
    expect(escape.results.some((r) => r.status === 'fail')).toBe(true);
  });

  it('does not list them as user state on the global object', () => {
    // Non-enumerable, like the platform's own. A script that walks globalThis to
    // report what it was given should not see these among its own variables.
    expect(evaluate('Object.keys(globalThis).indexOf("atob")')).toBe(-1);
    expect(evaluate('typeof atob')).toBe('function');
  });

  it('leaves Buffer absent, and says so by name', () => {
    // Deliberate. A faithful Buffer would be a fake typed-array class whose
    // `allocUnsafe` cannot do what its name says; a bare reference instead
    // throws, and the error names the missing thing.
    expect(errorFrom('typeof Buffer === "undefined" ? "absent" : "present"')).toBeUndefined();
    expect(evaluate('typeof Buffer === "undefined" ? "absent" : "present"')).toBe('absent');
    expect(errorFrom('Buffer.from("a")')).toContain('Buffer is not defined');
  });
});
