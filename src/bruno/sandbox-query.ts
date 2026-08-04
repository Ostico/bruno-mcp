import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * Bruno's query language, made available inside the sandbox.
 *
 * Upstream's response object is callable: `res('data.pets..name')` runs
 * @usebruno/query's `get` against the response body, which is how a deep
 * descent (`..`), an index (`[0]`) and a filter (`[?]`) reach an assertion at
 * all — none of those three is valid JavaScript on its own, so they can only
 * travel inside a string argument.
 *
 * The implementation is NOT imported and handed to the sandbox. A host-realm
 * function placed in a vm context is an escape: sandboxed code reaches the host
 * realm through `f.constructor`, and from there `process`. Instead the
 * package's own source text is read here and compiled INSIDE the context, so
 * the function the sandbox calls was created by the sandbox's realm and its
 * constructor leads nowhere.
 *
 * That is only safe because the published bundle is self-contained: it neither
 * requires anything nor generates code from strings. A guard test asserts both,
 * so a future release that changes this is caught rather than compiled in.
 */

const QUERY_PACKAGE = '@usebruno/query';

/**
 * Where to resolve @usebruno/query from.
 *
 * The module has to work in two module systems: the shipped build is ESM (so
 * `require` does not exist) and the test run is transpiled to CJS (so
 * `import.meta` does not exist). Neither anchor is our own file for that
 * reason. `process.argv[1]` is the running entry point — the forked sandbox
 * worker in production, the test runner under jest — and resolution walks up
 * from there, which finds both a hoisted install and a nested one. It is
 * `undefined` for `node -e`, hence the working-directory fallback.
 */
export function defaultAnchors(): string[] {
  const anchors: string[] = [];
  if (process.argv[1]) {
    anchors.push(process.argv[1]);
  }
  anchors.push(join(process.cwd(), 'index.js'));
  return anchors;
}

/**
 * Reduce anything thrown to one line of text.
 *
 * Deliberately not `instanceof Error`: this module's failures come from
 * `node:module` and `node:fs`, and under the test runner those are constructed
 * in a different realm, where the check reads false for a genuine Error. The
 * prefix `String()` adds for an Error is dropped so nesting one message inside
 * another does not stack up "Error: Error:".
 */
function describeThrown(thrown: unknown): string {
  return String(thrown).replace(/^Error: /, '');
}

/**
 * Read the query implementation's source text, trying each anchor in turn.
 *
 * Throws when no anchor works, naming the last failure. The caller turns that
 * into a sandbox that reports the loss on use rather than a run that fails
 * before its first request.
 */
export function readQuerySource(
  anchors: readonly string[] = defaultAnchors(),
): string {
  let lastFailure: unknown = 'no anchor to resolve from';
  for (const anchor of anchors) {
    try {
      const resolved = createRequire(anchor).resolve(QUERY_PACKAGE);
      return readFileSync(resolved, 'utf-8');
    } catch (error) {
      lastFailure = error;
    }
  }
  throw new Error(
    `could not load ${QUERY_PACKAGE}: ${describeThrown(lastFailure)}`,
  );
}

/**
 * Wrap the package source as in-context JS defining `__bruno_query_get`.
 *
 * The wrapper is a CJS shim: the bundle assigns to `exports`, so it gets an
 * `exports` and a `module` to assign to. The IIFE is load-bearing rather than
 * cosmetic — the minified bundle declares helpers named `r`, `t` and `e` at its
 * top level, and a user script declaring any of those names as a global would
 * otherwise overwrite one and break every query that follows.
 *
 * A bundle that stops exporting `get` yields a function that throws when used,
 * for the same reason as an unreadable one: losing one accessor should not take
 * the whole script down.
 */
export function buildQueryLib(source: string): string {
  return `
var __bruno_query_get = (function () {
  var module = { exports: {} };
  var exports = module.exports;
${source}
  var get = module.exports.get;
  if (typeof get !== 'function') {
    return function () {
      throw new Error(
        'response query support is unavailable: ${QUERY_PACKAGE} exports no get()'
      );
    };
  }
  return get;
})();
`;
}

/**
 * In-context JS for the case where the implementation could not be loaded.
 *
 * Keeps the response callable so the failure is a message naming the cause at
 * the point of use, not a TypeError saying res is not a function.
 */
export function buildUnavailableQueryLib(reason: string): string {
  return `
var __bruno_query_get = function () {
  throw new Error(${JSON.stringify(
    `response query support is unavailable: ${reason}`,
  )});
};
`;
}

/**
 * Build the prelude from whatever `read` yields, degrading to the stub when it
 * cannot yield anything.
 *
 * A missing or unreadable package costs the query accessor and nothing else: a
 * collection whose scripts never call `res(...)` runs exactly as before.
 */
export function buildLibFromSource(read: () => string): string {
  try {
    return buildQueryLib(read());
  } catch (error) {
    return buildUnavailableQueryLib(describeThrown(error));
  }
}

let cachedLib: string | undefined;

/**
 * The query prelude, read once per process.
 *
 * Cached because every request with a script or a declared assertion builds a
 * prelude, and the source does not change while the process lives.
 */
export function sandboxQueryLib(): string {
  if (cachedLib === undefined) {
    cachedLib = buildLibFromSource(readQuerySource);
  }
  return cachedLib;
}
