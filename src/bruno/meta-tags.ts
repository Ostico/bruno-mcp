/**
 * The one rule both formats follow for runner tags.
 *
 * Tags are a list of strings or they are absent. Upstream says so at both ends
 * and in the same words — `Array.isArray(tags) ? tags : []` in
 * `bruno-cli/src/utils/bru.js:80` and in `bruno-filestore`'s `parseApp.ts:22` —
 * and writes the key only when the list has something in it.
 *
 * The consequence worth stating: a single-line `tags: smoke` is not one tag, it
 * is no tags. Bruno's runner reads it as an empty list, so a file carrying that
 * line is already untagged as far as anything that runs it is concerned. It is
 * dropped on rewrite rather than turned into `['smoke']`, because promoting it
 * would change which requests a `--tags` run selects.
 *
 * `.bru` has a second reason: `jsonToBruV2` writes tags by iterating whatever it
 * is handed, so a string reaches the file one character per line. That is the
 * corruption this module exists to make unreachable.
 */

/**
 * Read a `tags` value from a parsed file.
 *
 * Non-strings inside a list are dropped rather than coerced. `tags: [1]` in
 * YAML parses to a number, and a numeric tag matches no `--tags` argument a
 * caller can type, so keeping it would only put a value in the model that the
 * declared type says cannot be there.
 */
export function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = value.filter((tag): tag is string => typeof tag === 'string');
  return tags.length > 0 ? tags : undefined;
}
