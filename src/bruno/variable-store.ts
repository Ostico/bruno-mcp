import { prepareVariables } from './variable-preparation.js';

/**
 * Run-scoped variable store for cross-request variable propagation.
 *
 * Created once per executeCollection() call — variables set by
 * bru.setVar() in one request's after-response script are available
 * to subsequent requests via {{substitution}}.
 *
 * Not persisted between runs.
 */
export class VariableStore {
  private vars: Map<string, string> = new Map();

  set(name: string, value: string | number | boolean | null | undefined): void {
    // An undefined/null value means "unset": scripts routinely do
    // bru.setVar('token', res.body.token) where the field is absent. Coercing
    // via String() would store the literal "undefined"/"null" and ship it on
    // the wire through {{token}}. Delete the key so {{token}} follows the
    // normal unresolved path instead.
    if (value === undefined || value === null) {
      this.vars.delete(name);
      return;
    }
    this.vars.set(name, String(value));
  }

  get(name: string): string | undefined {
    return this.vars.get(name);
  }

  getAll(): Map<string, string> {
    return new Map(this.vars);
  }

  /**
   * Merge authored variables with the runtime ones, resolving both.
   * Runtime variables take precedence over authored variables.
   * Returns a new Map suitable for passing to substitute().
   *
   * The resolution rules — recursive expansion for authored values, one verbatim
   * pass for runtime ones — are prepareVariables', which explains why.
   */
  merge(envVars: Map<string, string>): Map<string, string> {
    return prepareVariables(envVars, this.vars);
  }

  clear(): void {
    this.vars.clear();
  }
}
