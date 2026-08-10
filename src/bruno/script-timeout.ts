/** The runner's own fallback, used when a request declares no script budget. */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 5000;

/**
 * The script budget for a request, in a form the sandbox will accept.
 *
 * `settings.timeout` cannot be handed over as-is. Upstream spells "no limit" as
 * **0**, and `@usebruno/lang` injects `timeout: 0` into *every* `.bru` settings
 * block — so a request whose block says only `encodeUrl: true` arrives here with
 * a zero it never declared. This used to be `settings?.timeout ?? 5000`, and `0`
 * is not nullish, so the zero went straight to the worker, which rejects it:
 *
 *   RangeError [ERR_OUT_OF_RANGE]: The value of "options.timeout" is out of
 *   range. It must be >= 1 && <= 4294967295. Received 0
 *
 * The script did not run and the result read `Script error`, which points at the
 * user's code rather than at a settings block they may not have written.
 *
 * An authored `inherit` lands in the same place, and for the same reason the
 * request deadline does: there is no preference layer here to inherit from, so
 * the default is what inheriting means.
 *
 * A script cannot be given an unbounded budget — the worker has no encoding for
 * it — so "no limit" collapses to the same default an undeclared timeout gets.
 * A negative or non-finite value is treated the same way, since neither is a
 * budget the worker can take either.
 */
export function scriptTimeoutMs(settings: { timeout?: unknown } | undefined): number {
  const declared = settings?.timeout;
  if (typeof declared !== 'number' || !Number.isFinite(declared) || declared <= 0) {
    return DEFAULT_SCRIPT_TIMEOUT_MS;
  }
  return declared;
}
