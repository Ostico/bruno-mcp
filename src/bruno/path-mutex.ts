/**
 * Per-path serialization for read-modify-write sequences.
 *
 * Several tools read a file, transform its contents, and write the result back.
 * Two of those running concurrently against the same file both read the original,
 * and the second write silently discards the first one's change — a lost update.
 * The code conceded this in two comments ("read-modify-write is not atomic …
 * multi-client needs locking").
 *
 * Writing atomically does not help here: each write is individually all-or-nothing,
 * but the *pair* of operations still interleaves. This serializes them per file, so
 * a second caller reads only after the first has finished writing.
 *
 * Scope: one process. The MCP server is the single writer in the intended
 * deployment, so an in-process queue is the matching boundary; it does not
 * coordinate with a separate editor or a second server against the same directory.
 */

import * as path from 'node:path';

/**
 * Tail of the queue for each path. Present only while work is outstanding — the
 * entry is dropped once its chain settles, so this cannot grow without bound.
 */
const queues = new Map<string, Promise<void>>();

/**
 * Run `operation` with exclusive access to `filePath` for the lifetime of this
 * process. Callers queue in arrival order; the result and any rejection are
 * passed through to the caller untouched.
 */
export function withPathLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  // Resolve so './a.bru' and an absolute path to the same file share one queue.
  const key = path.resolve(filePath);
  const predecessor = queues.get(key) ?? Promise.resolve();

  // Run after the predecessor settles either way: one caller's failure must not
  // strand everyone queued behind it.
  const result = predecessor.then(operation, operation);

  const settled = result.then(
    () => {},
    () => {},
  );
  queues.set(key, settled);

  void settled.then(() => {
    // Only the current tail may clear the entry; a later arrival owns it now.
    if (queues.get(key) === settled) {
      queues.delete(key);
    }
  });

  return result;
}

/** Number of paths with outstanding work. Exported for testing. */
export function pendingPathLockCount(): number {
  return queues.size;
}
