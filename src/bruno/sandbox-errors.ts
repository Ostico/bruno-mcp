/**
 * Turning a sandbox failure into something reportable, without letting the
 * failure itself run code on the host.
 *
 * Shared by every path that catches out of a vm: the pre-request runner, the test
 * runner, and the declared-assertion evaluator. One implementation so the three
 * cannot disagree about what counts as a timeout — sandbox-assert rethrows on a
 * timeout precisely so the worker's timeout handling sees it, which only works
 * while both ask the same question.
 */

/**
 * Whether a thrown message is the vm's execution-timeout.
 *
 * Matched on the message because a timeout arrives as an ordinary Error: V8's
 * interrupt carries no distinguishing type. Both spellings are accepted because
 * the wording has differed across Node versions.
 */
export function isTimeoutMessage(message: string): boolean {
  return (
    message.includes('Script execution timed out') ||
    message.includes('execution timed out')
  );
}

/**
 * Turn a thrown value into a message without letting it run code on the host.
 *
 * A sandbox script can throw an object whose toString, Symbol.toPrimitive or
 * constructor getter throws, which would otherwise take out the error handler
 * that is trying to report it. Every access is guarded.
 *
 * Note the residual limit: a *spinning* getter still runs unbounded here,
 * because by this point the value is already on the host stack and no vm
 * timeout covers it. Only in-context capture could close that, which would
 * change the reported error format; it is tracked separately.
 */
export function describeSandboxError(error: unknown): { label: string; message: string } {
  let label = 'Error';
  try {
    const name = (error as Error)?.constructor?.name;
    if (typeof name === 'string' && name.length > 0) {
      label = name;
    }
  } catch {
    // keep the default label
  }

  try {
    if (error instanceof Error) {
      return { label, message: error.message };
    }
    return { label, message: String(error) };
  } catch {
    return { label, message: 'unknown sandbox error' };
  }
}
