/**
 * Bruno environment management
 * Handles creation and management of Bruno environment files
 */

import { promises as fs } from 'fs';
import { writeFileAtomic } from './atomic-write.js';
import { withPathLock } from './path-mutex.js';
import { assertPlainEnvironmentName } from './env-loader.js';
import { join } from 'path';
import {
  BrunoEnvironment,
  CreateEnvironmentInput,
  FileOperationResult,
  BrunoError,
  BruFileError,
  EnvFile,
  EnvVariable,
  EnvironmentConflict,
} from './types.js';
import { parse as parseYaml } from 'yaml';
import { detectFormat, type CollectionFormat } from './format-detector.js';
import { generateYamlEnvironment } from './yaml-generator.js';
import { parseBruEnvironment, parseBruEnvironmentFile, generateBruEnvironmentFull } from './bru-parser.js';

/** Top-level .yml environment keys represented by EnvFile's own fields. */
const YAML_ENV_FILE_KEYS = new Set(['name', 'variables']);

/** Per-variable .yml keys represented by EnvVariable's own fields. */
const YAML_ENV_VARIABLE_KEYS = new Set(['name', 'value', 'disabled', 'secret']);

/**
 * Collect the keys the typed model does not name, so a read-modify-write can
 * write them back instead of deleting them. Returns undefined when there are
 * none, keeping the field absent rather than an empty object.
 */
function collectUnmodelledKeys(
  source: Record<string, unknown>,
  modelled: Set<string>,
): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (modelled.has(key)) continue;
    extra[key] = value;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

/**
 * Accept either shape `CreateEnvironmentInput.variables` allows.
 *
 * The array branch is tested first. An array is also an object, so a
 * `Object.entries` branch placed above it would claim the array case and index it
 * by position — writing variables named `0`, `1`, `2` from the very shape the
 * richer callers pass.
 */
function toEnvVariables(
  variables: Record<string, string | number | boolean> | EnvVariable[],
): EnvVariable[] {
  if (Array.isArray(variables)) {
    return variables.filter((v) => typeof v?.name === 'string' && v.name !== '');
  }
  return Object.entries(variables).map(([name, value]): EnvVariable => ({ name, value }));
}

/**
 * Build the refusal for a name that already exists.
 *
 * The three lists are what let a caller decide without reading the file: nothing
 * in `wouldBeLost` means replacing is safe and the caller can retry with
 * `overwrite`, while anything in it means merging through
 * `update_environment` — or a different name — is the correct move.
 */
function refuseExistingEnvironment(
  path: string,
  existingVars: EnvVariable[] | undefined,
  requested: EnvVariable[],
): FileOperationResult {
  const existing = (existingVars ?? []).map((v) => {
    const entry: { name: string; secret?: boolean; disabled?: boolean } = { name: v.name };
    if (v.secret === true) entry.secret = true;
    if (v.disabled === true) entry.disabled = true;
    return entry;
  });

  const existingNames = new Set(existing.map((v) => v.name));
  const requestedNames = new Set(requested.map((v) => v.name));

  const conflict: EnvironmentConflict = {
    path,
    existing,
    alreadyPresent: [...requestedNames].filter((n) => existingNames.has(n)),
    added: [...requestedNames].filter((n) => !existingNames.has(n)),
    wouldBeLost: [...existingNames].filter((n) => !requestedNames.has(n)),
  };

  const lost = conflict.wouldBeLost.length;
  const verdict = lost === 0
    ? 'Replacing it would lose no variables, so retry with overwrite: true if that is what you meant.'
    : `Replacing it would DELETE ${lost} variable(s) not in this request: ${conflict.wouldBeLost.join(', ')}. `
      + 'Merge with update_environment, or create a new environment under a different name.';

  return {
    success: false,
    path,
    error:
      `Environment already exists at ${path}, and create_environment replaces the whole file. `
      + `It currently holds ${existing.length} variable(s): ${describeExistingVars(existing)}. `
      + verdict,
    conflict,
  };
}

/** Name the existing variables and their flags. Never their values. */
function describeExistingVars(
  existing: Array<{ name: string; secret?: boolean; disabled?: boolean }>,
): string {
  if (existing.length === 0) return '(none readable)';
  return existing
    .map((v) => {
      const flags = [v.secret ? 'secret' : undefined, v.disabled ? 'disabled' : undefined]
        .filter(Boolean)
        .join(', ');
      return flags ? `${v.name} (${flags})` : v.name;
    })
    .join(', ');
}

/**
 * Parse a .yml environment into the full file model.
 *
 * A secret variable has no `value` key on disk — Bruno keeps a secret's value
 * in its own store, never in the file — so it reads back with an empty value
 * and `secret: true`.
 */
function parseYamlEnvironmentFile(content: string, environmentName: string): EnvFile {
  const parsed = (parseYaml(content) ?? {}) as Record<string, unknown>;

  const variables: EnvVariable[] = [];
  if (Array.isArray(parsed.variables)) {
    for (const raw of parsed.variables as Array<Record<string, unknown>>) {
      if (raw?.name == null || String(raw.name) === '') continue;
      const item: EnvVariable = {
        name: String(raw.name),
        value: (raw.value as string | number | boolean) ?? '',
      };
      if (raw.disabled === true) item.disabled = true;
      if (raw.secret === true) item.secret = true;
      const varExtra = collectUnmodelledKeys(raw, YAML_ENV_VARIABLE_KEYS);
      if (varExtra) item.extra = varExtra;
      variables.push(item);
    }
  }

  const envFile: EnvFile = { name: environmentName, variables };
  const fileExtra = collectUnmodelledKeys(parsed, YAML_ENV_FILE_KEYS);
  if (fileExtra) envFile.extra = fileExtra;
  return envFile;
}

/**
 * Lock key identifying one environment.
 *
 * Deliberately extension-free: an environment is a single exclusion domain
 * whether it is stored as .yml or .bru, and this is computable without touching
 * the filesystem, so a caller can take the lock before any format detection.
 */
function environmentLockKey(collectionPath: string, environmentName: string): string {
  // Validated here rather than after: every method that mutates an environment
  // derives this key as its first act, so a name that is really a path is
  // refused before a lock is taken on a key that does not describe the file the
  // rest of the method would go on to write.
  assertPlainEnvironmentName(environmentName);
  return join(collectionPath, 'environments', environmentName);
}

export class EnvironmentManager {

  /**
   * Create a new environment file
   */
  async createEnvironment(input: CreateEnvironmentInput): Promise<FileOperationResult> {
    try {
      // Validate before deriving the lock key, not after: the key is built from
      // the same fields the validator requires, so a missing one would leave
      // path.join to raise a TypeError where callers expect a failed result.
      this.validateEnvironmentInput(input);

      // Same key the variable mutators use, so this write is ordered against them
      // rather than racing them. It has to be environmentLockKey and not the
      // `.yml`/`.bru` path: the mutators queue on the extension-less key, and a
      // second queue keyed by filename would serialize nothing against them.
      return await withPathLock(environmentLockKey(input.collectionPath, input.name), () =>
        this.createEnvironmentLocked(input),
      );
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private async createEnvironmentLocked(
    input: CreateEnvironmentInput,
  ): Promise<FileOperationResult> {
    try {
      // Detect collection format
      const detection = await detectFormat(input.collectionPath);

      // Ensure environments directory exists
      const envDir = join(input.collectionPath, 'environments');
      await this.ensureDirectory(envDir);

      const ext = detection.format === 'yaml' ? '.yml' : '.bru';
      const envFilePath = join(envDir, `${input.name}${ext}`);
      const variables = toEnvVariables(input.variables);

      // This call replaces the whole file, so an existing name is refused rather
      // than overwritten: a variable the caller did not list would be deleted, and
      // a secret could not be put back from the file alone because no format stores
      // a secret's value. The refusal carries the comparison the caller needs to
      // choose between merging and a different name, so deciding costs no extra
      // round-trip.
      const existing = await this.readForConflict(envFilePath, detection.format);
      if (existing && input.overwrite !== true) {
        return refuseExistingEnvironment(envFilePath, existing.variables, variables);
      }

      // Whether replacing or creating, keys the model does not name have to come
      // back: every other write path reads them first, and this one used not to,
      // which deleted them on each overwrite.
      const carriedExtra = existing?.extra;

      if (detection.format === 'yaml') {
        const envFile: EnvFile = { name: input.name, variables };
        if (carriedExtra) envFile.extra = carriedExtra;
        await writeFileAtomic(envFilePath, generateYamlEnvironment(envFile));
        return { success: true, path: envFilePath };
      }

      await writeFileAtomic(envFilePath, generateBruEnvironmentFull(variables, carriedExtra));
      return { success: true, path: envFilePath };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Read an environment that is about to be replaced, for the conflict report and
   * for its unmodelled keys.
   *
   * A file that exists but does not parse still counts as existing — refusing to
   * clobber it is the whole point, and reporting no variables is honest about what
   * could be read. Only a genuinely absent file yields undefined.
   */
  private async readForConflict(
    envFilePath: string,
    format: CollectionFormat,
  ): Promise<EnvFile | undefined> {
    let content: string;
    try {
      content = await fs.readFile(envFilePath, 'utf-8');
    } catch {
      return undefined;
    }

    try {
      return format === 'yaml'
        ? parseYamlEnvironmentFile(content, '')
        : parseBruEnvironmentFile(content);
    } catch {
      return {};
    }
  }

  /**
   * Load an existing environment
   */
  async loadEnvironment(collectionPath: string, environmentName: string): Promise<BrunoEnvironment> {
    // Before the try, so the refusal reaches the caller as itself rather than
    // wrapped in "failed to load", which reads like a missing file.
    assertPlainEnvironmentName(environmentName);
    try {
      const detection = await detectFormat(collectionPath);
      const ext = detection.format === 'yaml' ? '.yml' : '.bru';
      const envFilePath = join(collectionPath, 'environments', `${environmentName}${ext}`);
      const envContent = await fs.readFile(envFilePath, 'utf-8');

      if (detection.format === 'yaml') {
        const parsed = parseYaml(envContent) as Record<string, unknown>;
        const variables: Record<string, string | number | boolean> = {};
        if (Array.isArray(parsed?.variables)) {
          for (const v of parsed.variables as Array<Record<string, unknown>>) {
            if (v.name != null && String(v.name) !== '' && !v.disabled) {
              variables[String(v.name)] = (v.value as string | number | boolean) ?? '';
            }
          }
        }
        return { name: environmentName, variables };
      }

      return this.parseEnvironmentFile(envContent, environmentName);

    } catch (error) {
      throw new BruFileError(
        `Failed to load environment ${environmentName}`,
        { originalError: error }
      );
    }
  }

  /**
   * Load an environment preserving ALL variables including DISABLED ones and
   * their enabled/disabled flag. Unlike loadEnvironment (which returns only the
   * enabled variables as a flat map for the executor), this is the full-fidelity
   * read used by the merge/write path so disabled variables are never dropped.
   */
  async loadEnvironmentRaw(collectionPath: string, environmentName: string): Promise<EnvVariable[]> {
    const envFile = await this.loadEnvironmentFile(collectionPath, environmentName);
    return envFile.variables ?? [];
  }

  /**
   * Load an environment as the full file model: every variable with its
   * disabled and secret flags, plus every key the model does not name — both
   * top-level (`color`) and per-variable (`type`, `description`).
   *
   * This is what the read-modify-write helpers read, because the generators
   * rebuild the file from this model: a key that is not carried here is a key
   * that gets deleted from the file on the next edit.
   */
  async loadEnvironmentFile(collectionPath: string, environmentName: string): Promise<EnvFile> {
    assertPlainEnvironmentName(environmentName);
    try {
      const detection = await detectFormat(collectionPath);
      const ext = detection.format === 'yaml' ? '.yml' : '.bru';
      const envFilePath = join(collectionPath, 'environments', `${environmentName}${ext}`);
      const envContent = await fs.readFile(envFilePath, 'utf-8');

      if (detection.format === 'yaml') {
        return parseYamlEnvironmentFile(envContent, environmentName);
      }

      return { ...parseBruEnvironmentFile(envContent), name: environmentName };

    } catch (error) {
      throw new BruFileError(
        `Failed to load environment ${environmentName}`,
        { originalError: error }
      );
    }
  }

  /**
   * Read the unmodelled top-level keys off an environment that is about to be
   * overwritten, yielding undefined when the file cannot be read or parsed.
   *
   * Swallowing the failure is deliberate: this only feeds key preservation, and
   * the write that follows reports the real problem (a missing environment
   * still fails with NOT_FOUND rather than a parse error from here).
   */
  private async loadFileExtra(
    collectionPath: string,
    environmentName: string,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const envFile = await this.loadEnvironmentFile(collectionPath, environmentName);
      return envFile.extra;
    } catch {
      return undefined;
    }
  }

  /**
   * Write the FULL variable list (including disabled entries and their flags)
   * to an existing environment file. This is the full-fidelity counterpart to
   * updateEnvironment (which takes a flat enabled-only map).
   */
  async updateEnvironmentVariables(
    collectionPath: string,
    environmentName: string,
    variables: EnvVariable[]
  ): Promise<FileOperationResult> {
    return withPathLock(environmentLockKey(collectionPath, environmentName), async () => {
      // Replacing the variable list must not delete the file's other keys.
      const fileExtra = await this.loadFileExtra(collectionPath, environmentName);
      return this.writeEnvironmentVariables(collectionPath, environmentName, variables, fileExtra);
    });
  }

  /**
   * Write the variables without taking the per-environment lock.
   *
   * The read-modify-write helpers below already hold that lock across their own
   * read, so they must not re-enter it — the lock is not re-entrant and would
   * deadlock. Every other caller goes through updateEnvironmentVariables.
   *
   * @param fileExtra  Top-level keys read off the file being replaced, written
   *   back verbatim. Omitting them deletes them, because both generators build
   *   the document from the typed model alone.
   */
  private async writeEnvironmentVariables(
    collectionPath: string,
    environmentName: string,
    variables: EnvVariable[],
    fileExtra?: Record<string, unknown>
  ): Promise<FileOperationResult> {
    try {
      const detection = await detectFormat(collectionPath);
      const envDir = join(collectionPath, 'environments');
      const ext = detection.format === 'yaml' ? '.yml' : '.bru';
      const envFilePath = join(envDir, `${environmentName}${ext}`);

      const exists = await this.fileExists(envFilePath);
      if (!exists) {
        throw new BrunoError(
          `Environment ${environmentName} does not exist`,
          'NOT_FOUND'
        );
      }

      if (detection.format === 'yaml') {
        const envFile: EnvFile = { name: environmentName, variables };
        if (fileExtra) envFile.extra = fileExtra;
        await writeFileAtomic(envFilePath, generateYamlEnvironment(envFile));
      } else {
        await writeFileAtomic(envFilePath, generateBruEnvironmentFull(variables, fileExtra));
      }

      return { success: true, path: envFilePath };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Partially merge the given variables into an existing environment WITHOUT
   * clobbering the others. Pre-existing variables not listed are preserved,
   * INCLUDING disabled ones and their enabled/disabled flag.
   */
  async mergeEnvironment(
    collectionPath: string,
    environmentName: string,
    overrides: Record<string, string | number | boolean>
  ): Promise<FileOperationResult> {
    // Hold the lock across the read and the write so a concurrent edit is not lost.
    return withPathLock(environmentLockKey(collectionPath, environmentName), () =>
      this.mergeEnvironmentLocked(collectionPath, environmentName, overrides),
    );
  }

  private async mergeEnvironmentLocked(
    collectionPath: string,
    environmentName: string,
    overrides: Record<string, string | number | boolean>
  ): Promise<FileOperationResult> {
    try {
      const envFile = await this.loadEnvironmentFile(collectionPath, environmentName);
      const byName = new Map<string, EnvVariable>();
      for (const v of envFile.variables ?? []) byName.set(v.name, v);

      for (const [key, value] of Object.entries(overrides)) {
        // Overlay the new value onto the existing variable rather than
        // rebuilding it from name and value: rebuilding drops every other
        // field, which is how an overridden secret variable used to come back
        // as a plaintext one.
        const prev = byName.get(key);
        byName.set(key, { ...prev, name: key, value });
      }

      return await this.writeEnvironmentVariables(
        collectionPath,
        environmentName,
        [...byName.values()],
        envFile.extra,
      );

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Update an existing environment
   */
  async updateEnvironment(
    collectionPath: string,
    environmentName: string,
    variables: Record<string, string | number | boolean>
  ): Promise<FileOperationResult> {
    // Hold the lock across the read and the write so a concurrent edit is not lost.
    return withPathLock(environmentLockKey(collectionPath, environmentName), () =>
      this.updateEnvironmentLocked(collectionPath, environmentName, variables),
    );
  }

  private async updateEnvironmentLocked(
    collectionPath: string,
    environmentName: string,
    variables: Record<string, string | number | boolean>
  ): Promise<FileOperationResult> {
    try {
      const detection = await detectFormat(collectionPath);
      const envDir = join(collectionPath, 'environments');
      const ext = detection.format === 'yaml' ? '.yml' : '.bru';
      const envFilePath = join(envDir, `${environmentName}${ext}`);

      // Check if environment exists
      const exists = await this.fileExists(envFilePath);
      if (!exists) {
        throw new BrunoError(
          `Environment ${environmentName} does not exist`,
          'NOT_FOUND'
        );
      }

      // Replacing the variable list must not delete the file's other keys.
      const fileExtra = await this.loadFileExtra(collectionPath, environmentName);

      if (detection.format === 'yaml') {
        const envFile: EnvFile = {
          name: environmentName,
          variables: Object.entries(variables).map(([name, value]): EnvVariable => ({ name, value })),
        };
        if (fileExtra) envFile.extra = fileExtra;
        await writeFileAtomic(envFilePath, generateYamlEnvironment(envFile));
      } else {
        const envContent = this.generateEnvironmentFile(variables, fileExtra);
        await writeFileAtomic(envFilePath, envContent);
      }

      return {
        success: true,
        path: envFilePath
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Delete an environment
   */
  async deleteEnvironment(collectionPath: string, environmentName: string): Promise<FileOperationResult> {
    // Deletion is an exists-then-unlink pair, and it competes with the variable
    // mutators over the same file. Unlocked, a mutator that had already read the
    // file could write it back after the unlink and resurrect the environment
    // this call reported as deleted; and two concurrent deletions could both see
    // the file and the second unlink would throw ENOENT instead of returning the
    // "does not exist" result. Both cases are ordered away by taking the mutators'
    // own key.
    return withPathLock(environmentLockKey(collectionPath, environmentName), () =>
      this.deleteEnvironmentLocked(collectionPath, environmentName),
    );
  }

  private async deleteEnvironmentLocked(
    collectionPath: string,
    environmentName: string,
  ): Promise<FileOperationResult> {
    try {
      const detection = await detectFormat(collectionPath);
      const ext = detection.format === 'yaml' ? '.yml' : '.bru';
      const envFilePath = join(collectionPath, 'environments', `${environmentName}${ext}`);

      const exists = await this.fileExists(envFilePath);
      if (!exists) {
        return {
          success: false,
          error: `Environment ${environmentName} does not exist`
        };
      }

      await fs.unlink(envFilePath);

      return {
        success: true,
        path: envFilePath
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * List all environments in a collection
   */
  async listEnvironments(collectionPath: string): Promise<string[]> {
    try {
      const envDir = join(collectionPath, 'environments');
      
      const exists = await this.directoryExists(envDir);
      if (!exists) {
        return [];
      }

      const entries = await fs.readdir(envDir, { withFileTypes: true });

      return entries
        .filter(entry => entry.isFile() && (entry.name.endsWith('.bru') || entry.name.endsWith('.yml')))
        .map(entry => entry.name.replace(/\.(bru|yml)$/, ''))
        .sort();

    } catch (error) {
      throw new BruFileError(
        `Failed to list environments in ${collectionPath}`,
        { originalError: error }
      );
    }
  }

  /**
   * Get environment variables as key-value pairs
   */
  async getEnvironmentVariables(
    collectionPath: string, 
    environmentName: string
  ): Promise<Record<string, string | number | boolean>> {
    const environment = await this.loadEnvironment(collectionPath, environmentName);
    return environment.variables;
  }

  /**
   * Set (add or update) a specific variable in an environment. Reads the FULL
   * variable set so pre-existing variables — including disabled ones and their
   * enabled/disabled flag — are preserved on write.
   *
   * @param enabled  Optional. When provided, persists the variable's
   *   enabled/disabled state (enabled === false → written as disabled).
   *   When omitted, an existing variable keeps its current state and a new
   *   variable defaults to enabled.
   * @param secret   Optional. When provided, persists the variable's secret
   *   state. When omitted, an existing variable keeps its current state and a
   *   new variable defaults to non-secret. Marking a variable secret means its
   *   VALUE IS NOT WRITTEN TO THE FILE — neither on-disk format stores one —
   *   so `value` is only used to decide the non-secret case.
   */
  async setEnvironmentVariable(
    collectionPath: string,
    environmentName: string,
    key: string,
    value: string | number | boolean,
    enabled?: boolean,
    secret?: boolean
  ): Promise<FileOperationResult> {
    // Hold the lock across the read and the write so a concurrent edit is not lost.
    return withPathLock(environmentLockKey(collectionPath, environmentName), () =>
      this.setEnvironmentVariableLocked(collectionPath, environmentName, key, value, enabled, secret),
    );
  }

  private async setEnvironmentVariableLocked(
    collectionPath: string,
    environmentName: string,
    key: string,
    value: string | number | boolean,
    enabled?: boolean,
    secret?: boolean
  ): Promise<FileOperationResult> {
    try {
      const envFile = await this.loadEnvironmentFile(collectionPath, environmentName);
      const variables = envFile.variables ?? [];
      const idx = variables.findIndex(v => v.name === key);
      const prev = idx >= 0 ? variables[idx] : undefined;

      // Resolve the disabled flag: explicit `enabled` wins; otherwise preserve
      // the existing variable's flag (undefined → enabled for a new variable).
      const disabled = enabled === undefined ? prev?.disabled : !enabled;
      // Same rule for secret, so a plain value edit cannot silently demote an
      // existing secret variable to plaintext.
      const isSecret = secret === undefined ? prev?.secret === true : secret;

      // Start from the existing variable so fields neither this method nor the
      // model names — a .yml `description`, say — survive the write.
      const entry: EnvVariable = { ...prev, name: key, value };
      if (disabled === true) entry.disabled = true; else delete entry.disabled;
      if (isSecret) entry.secret = true; else delete entry.secret;

      if (idx >= 0) {
        variables[idx] = entry;
      } else {
        variables.push(entry);
      }

      return await this.writeEnvironmentVariables(
        collectionPath,
        environmentName,
        variables,
        envFile.extra,
      );

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Remove a variable from an environment. Reads the FULL variable set so all
   * other variables — including disabled ones and their flags — are preserved.
   */
  async removeEnvironmentVariable(
    collectionPath: string,
    environmentName: string,
    key: string
  ): Promise<FileOperationResult> {
    // Hold the lock across the read and the write so a concurrent edit is not lost.
    return withPathLock(environmentLockKey(collectionPath, environmentName), () =>
      this.removeEnvironmentVariableLocked(collectionPath, environmentName, key),
    );
  }

  private async removeEnvironmentVariableLocked(
    collectionPath: string,
    environmentName: string,
    key: string
  ): Promise<FileOperationResult> {
    try {
      const envFile = await this.loadEnvironmentFile(collectionPath, environmentName);
      const filtered = (envFile.variables ?? []).filter(v => v.name !== key);

      return await this.writeEnvironmentVariables(
        collectionPath,
        environmentName,
        filtered,
        envFile.extra,
      );

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Generate environment file content in BRU format.
   *
   * Delegates to the same serializer Bruno itself uses. The hand-rolled writer
   * this replaced emitted a `# ...` header and single-quoted every string:
   * the Bruno environment grammar accepts neither, so the files it produced
   * could not be read back — not by this server's own loader, and not by
   * Bruno — and the quotes, where a file did parse, became part of the value.
   */
  private generateEnvironmentFile(
    variables: Record<string, string | number | boolean>,
    fileExtra?: Record<string, unknown>,
  ): string {
    const vars: EnvVariable[] = Object.entries(variables).map(([name, value]) => ({
      name,
      value,
    }));
    return generateBruEnvironmentFull(vars, fileExtra);
  }

  private parseEnvironmentFile(content: string, name: string): BrunoEnvironment {
    return parseBruEnvironment(content, name);
  }

  /**
   * Validate environment input
   */
  private validateEnvironmentInput(input: CreateEnvironmentInput): void {
    if (!input.name || input.name.trim().length === 0) {
      throw new BrunoError('Environment name is required', 'VALIDATION_ERROR');
    }

    if (!input.collectionPath || input.collectionPath.trim().length === 0) {
      throw new BrunoError('Collection path is required', 'VALIDATION_ERROR');
    }

    // Check for invalid characters in environment name
    const invalidChars = /[<>:"/\\|?*\s]/;
    if (invalidChars.test(input.name)) {
      throw new BrunoError(
        'Environment name contains invalid characters or spaces',
        'VALIDATION_ERROR'
      );
    }

    if (!input.variables || typeof input.variables !== 'object') {
      throw new BrunoError('Variables must be an object', 'VALIDATION_ERROR');
    }
  }

  /**
   * Ensure directory exists
   */
  private async ensureDirectory(dirPath: string): Promise<void> {
    try {
      await fs.access(dirPath);
    } catch {
      await fs.mkdir(dirPath, { recursive: true });
    }
  }

  /**
   * Check if file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if directory exists
   */
  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      const stats = await fs.stat(dirPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }
}

/**
 * Create a new environment manager instance
 */
export function createEnvironmentManager(): EnvironmentManager {
  return new EnvironmentManager();
}

/**
 * Create common environment configurations
 */
export const commonEnvironments = {
  development: {
    baseUrl: 'http://localhost:3000',
    apiKey: '{{API_KEY}}',
    timeout: 5000,
    debug: true
  },
  staging: {
    baseUrl: 'https://staging-api.example.com',
    apiKey: '{{API_KEY}}',
    timeout: 10000,
    debug: false
  },
  production: {
    baseUrl: 'https://api.example.com',
    apiKey: '{{API_KEY}}',
    timeout: 30000,
    debug: false
  }
};