/**
 * Applying a request's `vars` blocks.
 *
 * The two halves are asymmetric, and reproducing that asymmetry is the point:
 *
 *   `vars:pre-request`  — RAW text, folded into the variable map used for
 *                         interpolation before the request is built. Handled
 *                         here.
 *   `vars:post-response` — JS EXPRESSIONS evaluated against the response and
 *                         stored via bru.setVar. Handled in sandbox-assert.ts,
 *                         because it needs the sandbox.
 *
 * Extracted from request-executor.ts, which crossed the repo-wide max-lines
 * ceiling.
 */

import { substitute } from './env-loader.js';
import type { BruVar, BruVarSets, YamlVar, YamlVars } from './types.js';

/**
 * Fold `vars:pre-request` into the variable map used for interpolation.
 *
 * Upstream treats these as raw values, not expressions — the JS-expression
 * treatment belongs to `vars:post-response` alone. They become
 * `requestVariables` and are spread into the interpolation context between the
 * environment and the runtime store, so upstream's precedence holds:
 * collection < env < folder < REQUEST < oauth2 < runtime < process.env.
 *
 * A disabled entry is skipped. Upstream filters on `enabled` being truthy while
 * this format carries `disabled`, so the polarity is inverted here; applying a
 * switched-off variable would be invisible in the report, unlike a switched-off
 * assertion.
 *
 * Each value is itself substituted against the variables established so far, so
 * a request var of `{{host}}/v2` resolves. That is one level of resolution, not
 * upstream's repeated pass: entries resolve in declaration order, so a reference
 * to one declared EARLIER works, while a reference to one declared later stays
 * literal.
 */
export function applyPreRequestVars(
  vars: Map<string, string>,
  yamlVars: YamlVars | undefined,
): Map<string, string> {
  const preRequest = yamlVars?.preRequest;
  if (!preRequest || preRequest.length === 0) {
    return vars;
  }
  const merged = new Map(vars);
  for (const entry of preRequest) {
    if (entry.disabled === true) continue;
    merged.set(entry.name, substitute(entry.value, merged));
  }
  return merged;
}

/**
 * Convert parsed `.bru` vars into the shape the executor applies.
 *
 * Inverts the enabled/disabled polarity and renames req/res to
 * preRequest/postResponse. Returns undefined when there is nothing to carry, so
 * a request without vars produces a byte-identical YamlRequest to before.
 */
export function bruVarSetsToYamlVars(
  varSets: BruVarSets | undefined,
): YamlVars | undefined {
  if (!varSets) {
    return undefined;
  }
  const convert = (entries: BruVar[]): YamlVar[] =>
    entries.map((entry) => ({
      name: entry.name,
      value: entry.value,
      ...(entry.enabled === false ? { disabled: true } : {}),
      ...(entry.local === true ? { local: true } : {}),
    }));
  const vars: YamlVars = {};
  if (varSets.req && varSets.req.length > 0) vars.preRequest = convert(varSets.req);
  if (varSets.res && varSets.res.length > 0) vars.postResponse = convert(varSets.res);
  return vars.preRequest || vars.postResponse ? vars : undefined;
}
