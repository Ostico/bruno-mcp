/**
 * Variables injected into a single run, overriding the environment.
 *
 * Bruno's CLI spells this `--env-var name=value`, and it writes the value into
 * the environment layer *after* the environment file is read
 * (`bruno-cli/src/commands/run.js`). That is the layer this implements: an
 * injected value beats the environment file, and a request-level
 * `vars:pre-request` or a `bru.setVar` still beats the injected value, because
 * upstream's chain is collection < env < folder < request < oauth2 < runtime.
 *
 * Why it has to exist: neither on-disk format stores a secret's value, by
 * design, so there is no correct place on disk for one. Without an in-memory
 * path, a run that needs a credential can only get it by committing it to the
 * collection's own git repository.
 *
 * Nothing here reaches disk. There is no `bru.setEnvVar` in the sandbox and
 * `VariableStore` is not persisted between runs, so an injected value lives in
 * the run's variable map and nowhere else. Upstream needs a separate
 * `envVarOverrides` map to keep an injected value from being written back by
 * the persistence layer; there is no write-back path here to guard.
 */

/** A value shape an override may arrive as, before coercion to a string. */
export type RawVariableValue = string | number | boolean;

export interface NormalizedOverrides {
  variables: Record<string, string>;
  errors: string[];
}

/**
 * A name `substitute` could never match, so an override under it would be
 * accepted and then silently never applied. Braces are the whole problem: the
 * placeholder pattern is `\{\{([^}]+)\}\}`, so a name containing `}` cannot be
 * referenced, and one containing `{` cannot be written as a placeholder either.
 */
function nameFault(name: string): string | null {
  if (name.length === 0) {
    return 'name is empty';
  }
  if (name !== name.trim()) {
    // `{{ tok }}` does not resolve `tok`: substitute captures the spaces.
    return 'name has leading or trailing whitespace';
  }
  if (/[{}]/.test(name)) {
    return 'name contains a brace, so no {{placeholder}} could ever reference it';
  }
  return null;
}

/**
 * Coerce a caller's `variables` input to a string map, rejecting names that
 * could never be referenced.
 *
 * Numbers and booleans are coerced rather than refused: `{{port}}` as `8080` is
 * the natural way to write it, and everything downstream substitutes strings.
 * A bad name is reported instead of dropped — an override that is accepted and
 * never applied is the failure mode this register already tracks under
 * "parsed, persisted, never applied".
 */
export function normalizeVariableOverrides(
  input: Record<string, RawVariableValue> | undefined,
): NormalizedOverrides {
  const variables: Record<string, string> = {};
  const errors: string[] = [];

  if (!input) {
    return { variables, errors };
  }

  for (const [name, value] of Object.entries(input)) {
    const fault = nameFault(name);
    if (fault) {
      errors.push(`${JSON.stringify(name)}: ${fault}`);
      continue;
    }
    variables[name] = String(value);
  }

  return { variables, errors };
}

/**
 * Apply injected variables over an environment map, returning a new map.
 *
 * Copies rather than mutating: the caller's environment map is also what an
 * unresolved-placeholder report is measured against, and an override is scoped
 * to one run.
 */
export function applyVariableOverrides(
  base: Map<string, string>,
  overrides?: Record<string, string>,
): Map<string, string> {
  if (!overrides) {
    return base;
  }

  const entries = Object.entries(overrides);
  if (entries.length === 0) {
    return base;
  }

  const merged = new Map(base);
  for (const [name, value] of entries) {
    merged.set(name, value);
  }
  return merged;
}
