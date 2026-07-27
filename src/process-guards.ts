/**
 * Process-level safety guards for the long-lived MCP server.
 */

import { types } from 'node:util';

/**
 * Text logged in place of a rejection value we refuse to inspect.
 */
export const UNINSPECTABLE_REASON =
  'non-Error value (not inspected: reading it could execute sandbox-supplied code)';

/** Bounds the prototype walk: a sandbox can build an arbitrarily long chain. */
const MAX_PROTOTYPE_DEPTH = 100;

/** Bounds the log line: the attacker chooses the message length. */
const MAX_DESCRIPTION_LENGTH = 512;

/**
 * Read a property only if it is a plain data property, without ever invoking
 * an accessor or a Proxy trap.
 *
 * Reading `error.name` normally is not safe here even after isNativeError says
 * the value is a real Error: isNativeError guarantees the internal slot, not
 * that name and message are data properties. A sandbox script can hang a
 * getter off a genuine Error, and a getter that spins cannot be escaped once
 * it is running on the host stack — no vm timeout covers this code.
 *
 * So the chain is walked with getOwnPropertyDescriptor, which reports an
 * accessor without calling it. The walk stops at a Proxy, since consulting one
 * would itself run a trap.
 */
function readDataProperty(target: object, key: string): unknown {
  let current: object | null = target;

  for (let depth = 0; current !== null && depth < MAX_PROTOTYPE_DEPTH; depth++) {
    if (types.isProxy(current)) {
      return undefined;
    }

    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      // An accessor is refused outright rather than invoked.
      return 'value' in descriptor ? descriptor.value : undefined;
    }

    current = Object.getPrototypeOf(current) as object | null;
  }

  return undefined;
}

/**
 * Whether a native Error was created in this realm rather than in a sandbox.
 *
 * Cross-realm errors do not inherit from this realm's Error.prototype, which is
 * the same quirk that makes `instanceof Error` false for them. `instanceof` is
 * not used directly because it walks the prototype chain and a sandbox can
 * plant a Proxy there; this walk refuses proxies and is depth-capped.
 *
 * The distinction matters for triage: a rejection from the sandbox is a script
 * misbehaving and is expected noise, while one from this realm is a bug in the
 * server itself and must not be lost in that noise.
 */
function isHostRealmError(value: object): boolean {
  let current: object | null = value;

  for (let depth = 0; current !== null && depth < MAX_PROTOTYPE_DEPTH; depth++) {
    if (types.isProxy(current)) {
      return false;
    }
    if (current === Error.prototype) {
      return true;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }

  return false;
}

/**
 * Classify where a rejection came from, for log triage. See isHostRealmError.
 */
export function classifyRejectionOrigin(reason: unknown): 'server' | 'script' {
  return types.isNativeError(reason) && isHostRealmError(reason) ? 'server' : 'script';
}

/**
 * Describe a rejection reason without letting it run code on the host.
 *
 * A rejection can originate inside the script sandbox, where the value is
 * entirely attacker-controlled. Calling String(reason), or even touching a
 * property, may invoke a getter, a Proxy trap, or a toString that throws or
 * spins — and by this point no vm timeout is armed to stop it. So the value is
 * only inspected when it is a genuine Error object, and even then only its
 * data properties are read.
 *
 * types.isNativeError is used rather than `instanceof Error` on purpose: it
 * recognises Errors created in another realm (every error thrown by a sandbox
 * script is one) while `instanceof` does not, and it reads an internal slot
 * rather than walking a prototype chain, so a Proxy cannot intercept it.
 *
 * Ordinary errors lose no detail: message is an own data property on an Error
 * instance and name a data property on its prototype, so both read normally. A
 * booby-trapped error degrades to whatever part of it is safe to read.
 */
export function describeRejectionReason(reason: unknown): string {
  if (!types.isNativeError(reason)) {
    return UNINSPECTABLE_REASON;
  }

  const rawName = readDataProperty(reason, 'name');
  const rawMessage = readDataProperty(reason, 'message');

  const name = typeof rawName === 'string' && rawName.length > 0 ? rawName : 'Error';
  const message = typeof rawMessage === 'string' ? rawMessage : '';

  const described = message.length > 0 ? `${name}: ${message}` : name;
  return described.length > MAX_DESCRIPTION_LENGTH
    ? `${described.slice(0, MAX_DESCRIPTION_LENGTH)}… (truncated)`
    : described;
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
    // The origin is tagged rather than filtered: swallowing every rejection
    // equally would let a genuine server bug hide among sandbox noise, and this
    // handler is the reason such a bug no longer announces itself by crashing.
    const origin =
      classifyRejectionOrigin(reason) === 'server'
        ? 'SERVER BUG — rejection originated in the server, not in a script'
        : 'from a script sandbox';

    log(
      `[bruno-mcp] unhandled promise rejection ignored so the server can keep running (${origin}): ${describeRejectionReason(reason)}`,
    );
  };

  emitter.on('unhandledRejection', handler);

  return () => {
    emitter.off('unhandledRejection', handler);
  };
}
