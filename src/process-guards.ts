/**
 * Process-level safety guards for the long-lived MCP server.
 */

import { types } from 'node:util';

/**
 * Text logged in place of a rejection value we refuse to inspect.
 */
export const UNINSPECTABLE_REASON =
  'non-Error value (not inspected: reading it could execute sandbox-supplied code)';

/**
 * Describe a rejection reason without letting it run code on the host.
 *
 * A rejection can originate inside the script sandbox, where the value is
 * entirely attacker-controlled. Calling String(reason), or even touching a
 * property, may invoke a getter, a Proxy trap, or a toString that throws or
 * spins — and by this point no vm timeout is armed to stop it. So the value is
 * only inspected when it is a genuine Error object.
 *
 * types.isNativeError is used rather than `instanceof Error` on purpose: it
 * recognises Errors created in another realm (every error thrown by a sandbox
 * script is one) while `instanceof` does not, and it reads an internal slot
 * rather than walking a prototype chain, so a Proxy cannot intercept it.
 */
export function describeRejectionReason(reason: unknown): string {
  if (!types.isNativeError(reason)) {
    return UNINSPECTABLE_REASON;
  }

  try {
    const name = typeof reason.name === 'string' ? reason.name : 'Error';
    const message = typeof reason.message === 'string' ? reason.message : '';
    return message.length > 0 ? `${name}: ${message}` : name;
  } catch {
    // name/message can be redefined as throwing accessors even on a real Error.
    return 'Error (message unavailable)';
  }
}

/**
 * Keep an unhandled promise rejection from terminating the server.
 *
 * Node's default policy since v15 is to terminate the process, and a rejection
 * that nothing handles is trivially reachable from a user-supplied script: a
 * bare `Promise.reject(1)` in a .bru test script is enough to take the server
 * down between requests. That cannot be contained inside the sandbox, because
 * Node exposes no per-context or per-Script rejection hook — the process-wide
 * handler is the only place this can be caught.
 *
 * Install once at startup. Installing and removing it around each script run
 * would race with concurrent requests: a rejection does not surface until a
 * later turn of the event loop, by which time the handler would be gone.
 *
 * @returns a function that removes the handler again, for tests and shutdown.
 */
export function installUnhandledRejectionGuard(
  emitter: NodeJS.EventEmitter = process,
  log: (message: string) => void = message => {
    // stderr, never stdout: stdout carries the MCP JSON-RPC stream.
    console.error(message);
  },
): () => void {
  const handler = (reason: unknown): void => {
    log(
      `[bruno-mcp] unhandled promise rejection ignored so the server can keep running: ${describeRejectionReason(reason)}`,
    );
  };

  emitter.on('unhandledRejection', handler);

  return () => {
    emitter.off('unhandledRejection', handler);
  };
}
