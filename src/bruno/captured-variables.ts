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

import type { ParsedRequest } from './request-discovery.js';

/** Names a group captured, the subset of values asked for, and what it lacked. */
export interface CapturedVariableReport {
  /** Every name set during the group, sorted for a stable result. */
  names: string[];
  /** Values for requested names that were actually set. */
  values: Record<string, string>;
  /**
   * Requested names this group's own store did not hold, sorted.
   *
   * Not a warning, because one group's store is the wrong scope to judge from:
   * groups are isolated by design, so the group that sets a name and the group
   * that does not are both behaving correctly. Warning from here gave a run of
   * three groups three warnings, each listing the names the other two set.
   * `reconcileCapturedVariables` is what turns these into at most one note.
   */
  unresolved: string[];
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
  // A Set, so a caller that repeats a name is not carried twice.
  const missing = new Set<string>();
  for (const name of requested ?? []) {
    const value = store.get(name);
    if (value === undefined) {
      missing.add(name);
    } else {
      values[name] = value;
    }
  }

  return { names: [...store.keys()].sort(), values, unresolved: [...missing].sort() };
}

/**
 * Every name a request's own `vars:preRequest` block sets, across a whole run.
 *
 * Read off the plan rather than recorded while running: the names are declared
 * on disk, so a request that never ran still declares them, and no group has to
 * carry anything extra for `reconcileCapturedVariables` to tell the two
 * explanations apart.
 */
export function authoredPreRequestVarNames(
  groups: readonly { readonly requests: readonly ParsedRequest[] }[],
): Set<string> {
  const authored = new Set<string>();
  for (const group of groups) {
    for (const request of group.requests) {
      for (const entry of request.yaml.vars?.preRequest ?? []) {
        if (entry.disabled !== true) authored.add(entry.name);
      }
    }
  }
  return authored;
}

/**
 * Turn every group's unresolved names into the run's own note about them.
 *
 * A name is only worth reporting when NO group set it: with one store per group,
 * a name missing from one store says nothing on its own. So the run intersects
 * what each group lacked, and what survives is what nothing in the run captured.
 *
 * Two distinct answers come out of that, and telling them apart is the point —
 * the old single warning said "no script set" about both, which is false for the
 * second:
 *
 *   - Set nowhere at all. A typo, or a name only the environment holds.
 *   - Written by a request's own `vars:preRequest` block. That block is applied
 *     for interpolation and is request-scoped by upstream's precedence, so it
 *     never enters the store `captureVariables` reads. The name IS being set;
 *     asking for its value here is what cannot work.
 *
 * `authored` carries the second set — the enabled `vars:preRequest` names across
 * every request the run planned.
 *
 * Called with the reports of the groups that produced one. A run whose every
 * group crashed produces none, and says nothing here: the crash is the finding.
 */
export function reconcileCapturedVariables(
  reports: readonly CapturedVariableReport[],
  authored: ReadonlySet<string>,
): string[] {
  if (reports.length === 0) {
    return [];
  }

  const unresolved = reports
    .slice(1)
    .reduce<string[]>(
      (surviving, report) => surviving.filter((name) => report.unresolved.includes(name)),
      [...reports[0]!.unresolved],
    );

  const warnings: string[] = [];
  const byVarsBlock = unresolved.filter((name) => authored.has(name));
  const nowhere = unresolved.filter((name) => !authored.has(name));

  if (nowhere.length > 0) {
    warnings.push(
      `captureVariables named variables no script set with bru.setVar anywhere in this run: ${list(nowhere)}. Environment variables and the variables you supplied are not captured — only what a script set.`,
    );
  }
  if (byVarsBlock.length > 0) {
    warnings.push(
      `captureVariables named variables a request's own vars:preRequest block sets: ${list(byVarsBlock)}. Those are applied for interpolation and are scoped to the request that declares them, so they never reach the store this returns values from. A post-response vars block, or bru.setVar in a script, does.`,
    );
  }

  return warnings;
}
