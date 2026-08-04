import { interpolate } from '@usebruno/common';
import { substitute } from './env-loader.js';

/**
 * Resolve the variables a request is built from, by where their values came
 * from rather than by name alone.
 *
 * Bruno expands a placeholder recursively: a variable whose value is
 * `key={{apiKey}}` yields `key=s3cret`, because the value is scanned again
 * after it is inserted. This server used a single pass instead — deliberately,
 * as a template-injection mitigation — and that cost real parity: an
 * environment variable built out of other environment variables came out with
 * the inner placeholder still in it.
 *
 * The distinction that makes both possible is provenance, not syntax:
 *
 * - **Authored** values — environment, collection, folder and request vars —
 *   are written by whoever owns the collection, at the same trust level as its
 *   scripts. They get `interpolate`, Bruno's own function from
 *   `@usebruno/common`, so nesting behaves exactly as it does under `bru run`.
 *
 * - **Runtime** values — whatever `bru.setVar` and post-response variable
 *   capture put in the store — come from a response body, which the collection
 *   does not control. They are inserted verbatim, once, and never scanned
 *   again. A captured value reading `key={{apiKey}}` stays that text instead of
 *   reaching for a secret the response was never given.
 *
 * The order below is what keeps both true at once. Each authored value is first
 * expanded against the other authored values (recursively, upstream's
 * semantics), and only then are runtime values substituted into it in a single
 * pass. So an authored `Bearer {{token}}` picks up a captured token, while a
 * captured value carrying a placeholder is inserted as text and stops there.
 *
 * Precedence is unchanged: a runtime variable wins over an authored one of the
 * same name.
 */
export function prepareVariables(
  authored: Map<string, string>,
  runtime: Map<string, string>,
): Map<string, string> {
  const authoredValues = Object.fromEntries(authored);
  const prepared = new Map<string, string>();

  for (const [name, value] of authored) {
    prepared.set(name, substitute(interpolate(value, authoredValues), runtime));
  }

  // After the authored pass, so a name in both tiers resolves to the runtime
  // value, and so that value is never itself expanded.
  for (const [name, value] of runtime) {
    prepared.set(name, value);
  }

  return prepared;
}
