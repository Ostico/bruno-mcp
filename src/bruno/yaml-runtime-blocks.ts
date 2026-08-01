/**
 * The `runtime` block of a `.yml` request: variables, post-response actions and
 * assertions.
 *
 * These three blocks used to be written at the top level under names of our own
 * (`vars.preRequest`, `vars.postResponse`, `assert`). Bruno reads none of them —
 * its request grammar is `info`, `http`, `runtime`, `docs`, `settings`,
 * `examples`, and the runtime block holds `{ variables, scripts, assertions,
 * actions }`. So a request written here had its variables and assertions
 * invisible to `bru run`, and a Bruno-authored request had them dropped on the
 * way in: the assertions vanished and the run still reported green.
 *
 * `runtime.scripts` was the one block already in the right place, which is
 * exactly why this survived so long — scripts round-trip, so the dialect looks
 * correct wherever anyone would think to check, and our own files round-trip
 * perfectly because the writer and the parser agreed with each other rather than
 * with Bruno.
 *
 * The shapes are not renames. An assertion's operator is a separate field
 * upstream and is packed into the value string in Bruno's own model; a
 * post-response variable is not a variable at all but a `set-variable` action
 * with a selector. Everything here mirrors
 * `bruno-filestore/src/formats/yml/common/{variables,actions,assertions,datatype}.ts`
 * rather than reimplementing the mapping, and the divergences are called out
 * where they occur.
 *
 * In-memory shapes are deliberately unchanged: this module only moves the
 * on-disk representation, so nothing downstream of the parser had to know.
 */
import { isAssertOperator, isUnaryOperator } from './assert-operators.js';
import { YamlAssertion, YamlVar } from './types.js';

/**
 * Split Bruno's packed `"<operator> <value>"` into upstream's two fields.
 *
 * An unrecognised first word means the string is entirely a value, compared with
 * `eq`. Note the empty string comes back as `value: ''` rather than `undefined`,
 * matching upstream: only a unary operator drops the key.
 */
export function splitAssertionValue(raw: string): { operator: string; value?: string } {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { operator: 'eq', value: raw };
  }

  const [firstWord, ...rest] = raw.trim().split(' ');

  // `assert-operators.ts` already holds this table, verified identical to
  // upstream's list and in the same order — a second copy here would be one
  // more thing to drift.
  if (isUnaryOperator(firstWord)) {
    return { operator: firstWord };
  }
  if (isAssertOperator(firstWord)) {
    return { operator: firstWord, value: rest.join(' ') };
  }
  return { operator: 'eq', value: raw };
}

/**
 * Pack upstream's two fields back into Bruno's single string.
 *
 * Not quite an inverse, deliberately: a bare `200` normalises to `eq 200`, which
 * is what upstream produces too, and what the executor already understands.
 */
export function joinAssertionValue(operator: unknown, value: unknown): string {
  const op = operator === undefined || operator === null ? 'eq' : String(operator);
  if (value === undefined || value === null) return op;
  return `${op} ${String(value)}`;
}

/**
 * A `{ type, data }` value, as upstream writes a variable whose type is not
 * `string`. Reading one with a plain `String()` is what produced the literal
 * `"[object Object]"` on the wire (L11).
 */
function isTypedValue(value: unknown): value is { type: unknown; data: unknown } {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && 'type' in value && 'data' in value
  );
}

/**
 * Render a variable value that is not a typed value. A plain object becomes
 * pretty-printed JSON rather than `String()`; upstream's
 * `serializeVariableValue` does the same, and it is the other half of L11.
 */
function serializeVariableValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

/** `'string'` is the implicit default and is never recorded, as upstream. */
function readVariableValue(raw: unknown): { value: string; dataType?: string } {
  if (!isTypedValue(raw)) return { value: serializeVariableValue(raw) };

  const value = raw.data === undefined || raw.data === null ? '' : String(raw.data);
  const type = typeof raw.type === 'string' ? raw.type : 'string';
  return type === 'string' ? { value } : { value, dataType: type };
}

/**
 * The value side of a variable on the way out. A recorded non-string `dataType`
 * becomes a typed value again; everything else stays a plain scalar, so an
 * ordinary variable is not gratuitously wrapped.
 */
function writeVariableValue(v: YamlVar): unknown {
  if (v.dataType && v.dataType !== 'string') return { type: v.dataType, data: v.value };
  return v.value;
}

function asRecordArray(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
}

/**
 * `runtime.variables` — pre-request variables.
 *
 * `local` is carried as an extra key, which upstream's `Variable` shape does not
 * model. It is not decoration: `.bru` supports `local` on pre-request vars as
 * well as post-response ones (the `@name` prefix, `bruToJson.js` `varsreq`), so
 * omitting it here would make `.yml` lossy against `.bru` and quietly drop the
 * flag on any `bru-to-yaml` conversion. Upstream ignores keys it does not model,
 * so the cost of keeping it is nothing and the cost of dropping it is an authored
 * flag disappearing — the very class of bug this module exists to fix.
 */
export function variablesToYaml(vars: YamlVar[]): Record<string, unknown>[] {
  return vars.map((v) => ({
    name: v.name,
    value: writeVariableValue(v),
    ...(v.disabled === true ? { disabled: true } : {}),
    ...(v.local === true ? { local: true } : {}),
  }));
}

export function variablesFromYaml(raw: unknown): YamlVar[] {
  return asRecordArray(raw)
    .filter((v) => typeof v.name === 'string')
    .map((v) => {
      const { value, dataType } = readVariableValue(v.value);
      const entry: YamlVar = { name: String(v.name), value };
      if (dataType) entry.dataType = dataType;
      if (v.disabled === true) entry.disabled = true;
      if (v.local === true) entry.local = true;
      return entry;
    });
}

/**
 * `runtime.actions` — post-response variables, which upstream models as
 * `set-variable` actions rather than as variables. The Bruno value is the
 * selector expression, and `local` is the variable's scope.
 */
export function postResponseVarsToYaml(vars: YamlVar[]): Record<string, unknown>[] {
  return vars.map((v) => ({
    type: 'set-variable',
    phase: 'after-response',
    selector: { expression: v.value, method: 'jsonq' },
    variable: { name: v.name, scope: v.local === true ? 'request' : 'runtime' },
    ...(v.disabled === true ? { disabled: true } : {}),
  }));
}

/**
 * Only `set-variable` actions in the `after-response` phase are variables; any
 * other action is somebody else's feature and is left alone rather than
 * mistranslated.
 *
 * One deliberate divergence: `local` is recovered from `variable.scope`.
 * Upstream's own reader hardcodes `local: false` and ignores the scope it just
 * wrote, so a `local` post-response variable does not survive a round-trip
 * through Bruno. Matching that bug would lose the flag on every file we read
 * back, including our own.
 */
export function postResponseVarsFromYaml(raw: unknown): YamlVar[] {
  return asRecordArray(raw)
    .filter((a) => a.type === 'set-variable' && a.phase === 'after-response')
    .map((a) => {
      const selector = (a.selector ?? {}) as Record<string, unknown>;
      const variable = (a.variable ?? {}) as Record<string, unknown>;
      const entry: YamlVar = {
        name: typeof variable.name === 'string' ? variable.name : '',
        value: typeof selector.expression === 'string' ? selector.expression : '',
      };
      if (a.disabled === true) entry.disabled = true;
      if (variable.scope === 'request') entry.local = true;
      return entry;
    })
    .filter((entry) => entry.name.length > 0);
}

/** `runtime.assertions` — with the operator as its own field. */
export function assertionsToYaml(assertions: YamlAssertion[]): Record<string, unknown>[] {
  return assertions.map((a) => {
    const { operator, value } = splitAssertionValue(a.value);
    return {
      expression: a.name,
      operator,
      ...(value !== undefined ? { value } : {}),
      ...(a.disabled === true ? { disabled: true } : {}),
    };
  });
}

export function assertionsFromYaml(raw: unknown): YamlAssertion[] {
  return asRecordArray(raw)
    .filter((a) => typeof a.expression === 'string')
    .map((a) => {
      const entry: YamlAssertion = {
        name: String(a.expression),
        value: joinAssertionValue(a.operator, a.value),
      };
      if (a.disabled === true) entry.disabled = true;
      return entry;
    });
}
