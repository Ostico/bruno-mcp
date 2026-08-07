/**
 * A module-resolution recorder, registered into a spawned server with
 * `module.register()`.
 *
 * It exists because the two obvious ways to ask "did this process load
 * @grpc/grpc-js?" from inside the process do not work here. `process.moduleLoadList`
 * was measured on this repo: after `require('yaml')` it holds 108 entries and not
 * one of them names a userland package, so an assertion built on it passes whether
 * the transports load eagerly or not. `require.cache` is unavailable at all, because
 * package.json declares `"type": "module"` and the build emits ESM.
 *
 * A resolve hook sees every specifier the loader is asked for, which is the fact the
 * gate actually needs. Registered from a bootstrap module via `--import`, it runs in
 * the loader thread, so the log is written with a synchronous append rather than
 * anything that would need the main thread to be idle.
 *
 * Only bare specifiers are recorded. A relative path is our own code and a `node:`,
 * `file:` or `data:` URL cannot name a package, so writing them down would only make
 * the log harder to read.
 */
import { appendFileSync } from 'node:fs';

/** Set by `initialize`, from the `data` passed to `module.register()`. */
let logPath;

export function initialize(data) {
  logPath = data?.logPath;
}

/**
 * A bare specifier is one that names a package: no leading `.` or `/`, and no URL
 * scheme. The scheme test covers `node:`, `file:` and `data:` in one rule.
 */
function isBareSpecifier(specifier) {
  return !specifier.startsWith('.')
    && !specifier.startsWith('/')
    && !/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(specifier);
}

export async function resolve(specifier, context, nextResolve) {
  if (logPath !== undefined && isBareSpecifier(specifier)) {
    appendFileSync(logPath, `${specifier}\n`);
  }
  return nextResolve(specifier, context);
}
