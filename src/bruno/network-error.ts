/**
 * Turn a low-level fetch failure into something the caller can act on.
 *
 * Round 4 of the blind discoverability test lost a whole run to the bare text
 * `The operation was aborted due to timeout`. It names no target, no limit and
 * no elapsed time, so the agent read it as "the address must be wrong",
 * switched the URL scheme, failed differently, and only then retried the
 * original request unchanged — which passed. A timeout carries no evidence
 * about the address at all, and the message now says so outright.
 *
 * `fetch failed` has the same problem from the other side: undici hides the
 * real reason (ECONNREFUSED, ENOTFOUND, a TLS rejection) one level down in
 * `error.cause`, which never reaches the caller. Those causes are the ones
 * that *do* justify changing the URL, so they are worth surfacing precisely.
 */

export interface NetworkErrorContext {
  /** The URL that was being requested. */
  url: string;
  /** The configured limit in ms, as resolved from settings.timeout. 0 means no limit. */
  timeoutMs: number;
  /** Wall-clock ms actually spent before the failure surfaced. */
  elapsedMs: number;
}

interface ErrorLike {
  name?: string;
  message?: string;
  code?: string;
  cause?: unknown;
}

function asErrorLike(value: unknown): ErrorLike | null {
  return typeof value === 'object' && value !== null ? (value as ErrorLike) : null;
}

/**
 * Pull the most specific cause out of a fetch failure. undici nests the real
 * socket error under `cause`, sometimes more than one level down.
 */
function rootCause(error: unknown): ErrorLike | null {
  let current = asErrorLike(error);
  let deepest: ErrorLike | null = null;

  // Bounded rather than while(true): a malformed cause chain must not hang.
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current.code || (current !== asErrorLike(error) && current.message)) {
      deepest = current;
    }
    current = asErrorLike(current.cause);
  }

  return deepest;
}

function isTimeout(error: unknown): boolean {
  const err = asErrorLike(error);
  if (!err) return false;

  return (
    err.name === 'TimeoutError' ||
    (typeof err.message === 'string' && err.message.includes('aborted due to timeout'))
  );
}

/** What a given socket-level code actually tells the caller to do next. */
function hintForCode(code: string): string {
  switch (code) {
    case 'ECONNREFUSED':
      return 'Nothing accepted the connection on that host and port. Check the scheme and port — an https:// URL against a plain-HTTP listener fails this way.';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'The hostname did not resolve. Check the spelling, or whether the name is only resolvable from inside the target network.';
    case 'ECONNRESET':
    case 'EPIPE':
      return 'The connection was closed mid-flight. This is usually transient — retrying the same request may succeed.';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'CERT_HAS_EXPIRED':
      return 'The TLS certificate was rejected. The address is reachable; it is the certificate that failed validation.';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'No route to that address from this host.';
    default:
      return '';
  }
}

/**
 * Build the message stored in `result.error` for a failed request.
 *
 * Every branch states the target and the elapsed time, because "which request,
 * and how long did it try" is the part a caller cannot reconstruct afterwards.
 */
export function describeNetworkError(error: unknown, ctx: NetworkErrorContext): string {
  const { url, timeoutMs, elapsedMs } = ctx;

  if (isTimeout(error)) {
    const limit =
      timeoutMs > 0
        ? `The limit is settings.timeout = ${timeoutMs}ms; raise it for slow endpoints, or set it to 0 to remove the limit.`
        : 'No limit was configured via settings.timeout, so this abort came from elsewhere.';

    // Elapsed well past the configured limit is worth reporting rather than
    // rounding away: it means the abort did not take effect when it should
    // have, which is a different problem from a genuinely slow endpoint.
    const overrun =
      timeoutMs > 0 && elapsedMs > timeoutMs * 1.5
        ? ` Note: the request ran ${elapsedMs}ms, well past that limit, which can happen when setup work done before the request's timeout is armed — DNS resolution and connection establishment — runs long, since that phase is not bounded by settings.timeout.`
        : '';

    return (
      `Request to ${url} timed out after ${elapsedMs}ms. ${limit}${overrun} ` +
      'A timeout means no response arrived in time. It is not evidence that the URL, scheme or host is wrong, ' +
      'so changing those is unlikely to help; if the target is known to be reachable, retrying the same request may succeed.'
    );
  }

  const cause = rootCause(error);
  const code = typeof cause?.code === 'string' ? cause.code : '';
  const base = error instanceof Error ? error.message : String(error);

  if (code) {
    const hint = hintForCode(code);
    return `Request to ${url} failed after ${elapsedMs}ms: ${base} (${code}).${hint ? ` ${hint}` : ''}`;
  }

  const detail = cause?.message && cause.message !== base ? ` (${cause.message})` : '';
  return `Request to ${url} failed after ${elapsedMs}ms: ${base}${detail}`;
}
