/**
 * Reporting back the values a group's scripts captured with `bru.setVar`.
 *
 * A `VariableStore` is created inside `executeCollection` and discarded when it
 * returns, so a value a script captured — a token from a login, an id from a
 * create — was usable by later requests in the same group through `{{name}}` and
 * by nothing else. A caller that wanted to see it had to add a request that
 * echoed it back and read the response body, or interpolate it into a test name
 * so it surfaced in the results. The second of those writes a credential into a
 * test title, which is how this got reported.
 *
 * There is no upstream behaviour to port here. Bruno's CLI never puts runtime
 * variables in its JSON reporter, and `bruno-cli/src/utils/persist-variables.js`
 * states outright that runtime vars are intentionally not persisted because they
 * are ephemeral by definition. Its way out is `bru.setEnvVar`, which writes to
 * the environment file on disk; this sandbox has no such function, and nothing
 * here writes anything anywhere.
 *
 * WHAT COMES BACK, AND WHY VALUES ARE OPT-IN BY NAME
 *
 * Names always; values only for the names a caller asked for.
 *
 * A name is already readable in the collection's own script source, so listing
 * the names discloses nothing the caller could not read off disk, and it makes
 * the useful sequence work: run once, see what the scripts set, ask for the one
 * you need next time.
 *
 * Values are withheld until asked for because a run that captures a bearer token
 * would otherwise put it in the result of every run that merely crossed that
 * group, including runs whose caller had no interest in it. Asking by name is
 * the entire policy — no pattern matching on the name, no heuristic about which
 * values look secret. A value you do ask for comes back verbatim. That is not a
 * gap: `run_collection` returns `response_body` by default, and a token a script
 * captured came out of a response body, so suppressing it here while shipping
 * the body it was read from would protect nothing.
 */

/** Names a group captured, the subset of values asked for, and anything odd. */
export interface CapturedVariableReport {
  /** Every name set during the group, sorted for a stable result. */
  names: string[];
  /** Values for requested names that were actually set. */
  values: Record<string, string>;
  /** Group-level notes; empty when there is nothing to say. */
  warnings: string[];
}

function list(names: Iterable<string>): string {
  return [...names].sort().join(', ');
}

/**
 * Reduce a group's variable store to what its result should report.
 *
 * One store, because a group has exactly one and reports its own captures.
 */
export function collectCapturedVariables(
  store: ReadonlyMap<string, string>,
  requested?: readonly string[],
): CapturedVariableReport {
  const values: Record<string, string> = {};
  // A Set, so a caller that repeats a name does not get it warned about twice.
  const neverSet = new Set<string>();
  for (const name of requested ?? []) {
    const value = store.get(name);
    if (value === undefined) {
      neverSet.add(name);
    } else {
      values[name] = value;
    }
  }

  const warnings: string[] = [];
  if (neverSet.size > 0) {
    warnings.push(
      `captureVariables named variables no script set with bru.setVar during this run: ${list(neverSet)}. Environment variables and the variables you supplied are not captured — only what a script set.`,
    );
  }

  return { names: [...store.keys()].sort(), values, warnings };
}
