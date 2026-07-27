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
   * Merge environment variables with runtime variables.
   * Runtime variables take precedence over environment variables.
   * Returns a new Map suitable for passing to substitute().
   */
  merge(envVars: Map<string, string>): Map<string, string> {
    const merged = new Map(envVars);
    for (const [key, value] of this.vars) {
      merged.set(key, value);
    }
    return merged;
  }

  clear(): void {
    this.vars.clear();
  }
}
