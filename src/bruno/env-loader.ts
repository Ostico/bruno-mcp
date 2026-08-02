import { readFile } from 'node:fs/promises';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import type { EnvFile, EnvVariable } from './types.js';
import { parseBruEnvironmentRaw } from './bru-parser.js';

/**
 * Whether this variable is a secret with no value available to bind.
 *
 * Neither on-disk format persists a secret's VALUE: `.bru` lists the bare name
 * in `vars:secret [...]`, `.yml` writes `secret: true` with no `value` key. So
 * a secret read back off disk usually has nothing to bind, and binding it to
 * `''` is worse than leaving it out. Empty string is a RESOLVED value here:
 * `substitute` expands `{{token}}` to nothing and puts `Authorization: Bearer `
 * on the wire, and `findUnresolvedPlaceholders` applies the same `undefined`
 * test, so it reports nothing wrong. The run then fails on a 401 with no
 * diagnostic pointing at the missing secret. Leaving the name unbound keeps the
 * placeholder literal and gets it named in the run's unresolved warnings.
 *
 * Which arm fires depends on the format: `.yml` reaches here with `value`
 * absent, while `parseBruEnvironmentRaw` already coerces a secret's value to
 * `''`, so `.bru` cannot be told apart by absence alone.
 *
 * A secret that DOES carry a value is bound to it — the file wins over the
 * assumption that secrets are never value-bearing.
 */
function isUnavailableSecret(entry: EnvVariable): boolean {
  if (entry.secret !== true) {
    return false;
  }
  return entry.value === undefined || entry.value === null || String(entry.value) === '';
}

/**
 * An environment name indexes `environments/<name>` inside the collection. It
 * is a name, never a path, and this is where that is enforced.
 *
 * The name arrives from the caller — `run_collection` takes one per run and one
 * per group — and `join` will happily follow `../..` out of the collection. The
 * file it lands on becomes the run's variables, so a name that escapes reads
 * any YAML on the host the process can open and substitutes its values into
 * outbound requests. That is a read primitive with a delivery mechanism
 * attached, not a mis-resolved path.
 *
 * Refused rather than sanitised: a caller who wrote a separator meant something
 * this tool does not do, and quietly running a different environment than the
 * one they named is its own failure.
 */
export function assertPlainEnvironmentName(envName: string): void {
  if (envName.includes('/') || envName.includes('\\') || envName.includes('\0')) {
    throw new Error(
      `Invalid environment name "${envName}": an environment name is a name, not a path. ` +
        'Environments live in the collection\'s environments/ directory and are named ' +
        'without separators.',
    );
  }
  // Caught by the separator test on every real traversal, but a bare `..` names
  // the environments directory itself and is still not an environment.
  if (envName === '.' || envName === '..') {
    throw new Error(`Invalid environment name "${envName}": that is a directory, not an environment.`);
  }
}

export async function loadEnvironment(
  collectionPath: string,
  envName: string,
): Promise<Map<string, string>> {
  assertPlainEnvironmentName(envName);
  const envFilePath = join(collectionPath, 'environments', `${envName}.yml`);

  let content: string;
  try {
    content = await readFile(envFilePath, 'utf-8');
  } catch {
    // No YAML environment — fall back to a native Bruno `.bru` environment file
    //. Native collections store environments as `.bru`, not `.yml`.
    return loadBruEnvironment(collectionPath, envName);
  }

  let parsed: EnvFile;
  try {
    parsed = parseYaml(content) as EnvFile;
  } catch {
    return new Map();
  }

  if (!parsed || !Array.isArray(parsed.variables)) {
    return new Map();
  }

  const vars = new Map<string, string>();

  for (const entry of parsed.variables) {
    if (!entry || typeof entry.name !== 'string') {
      continue;
    }

    if (entry.disabled === true) {
      continue;
    }

    if (isUnavailableSecret(entry)) {
      continue;
    }

    const value = entry.value === undefined || entry.value === null
      ? ''
      : String(entry.value);

    vars.set(entry.name, value);
  }

  return vars;
}

/**
 * Load a native Bruno `.bru` environment file. Reuses
 * `parseBruEnvironmentRaw` and maps its output to the same `name -> value`
 * shape the `.yml` loader returns: disabled variables are dropped, as are
 * secrets with no value to bind (see `isUnavailableSecret`), and every other
 * enabled variable is kept with its value. Precedence lives in
 * `loadEnvironment`: `.yml` wins when present, `.bru` is the fallback.
 */
async function loadBruEnvironment(
  collectionPath: string,
  envName: string,
): Promise<Map<string, string>> {
  const bruFilePath = join(collectionPath, 'environments', `${envName}.bru`);

  let content: string;
  try {
    content = await readFile(bruFilePath, 'utf-8');
  } catch {
    return new Map();
  }

  let variables;
  try {
    variables = parseBruEnvironmentRaw(content);
  } catch {
    return new Map();
  }

  const vars = new Map<string, string>();
  for (const entry of variables) {
    if (entry.disabled === true) {
      continue;
    }
    if (isUnavailableSecret(entry)) {
      continue;
    }
    vars.set(entry.name, String(entry.value ?? ''));
  }

  return vars;
}

export function substitute(
  template: string,
  vars: Map<string, string>,
): string {
  if (template.length === 0 || vars.size === 0) {
    return template;
  }

  return template.replace(/\{\{([^}]+)\}\}/g, (match, name: string) => {
    const value = vars.get(name);
    return value !== undefined ? value : match;
  });
}

/**
 * Report the distinct `{{name}}` placeholders in `template` that `vars` does
 * not resolve.
 *
 * Detection runs against the ORIGINAL template and mirrors `substitute`'s rule
 * exactly: a placeholder is unresolved when `vars.get(name)` is `undefined`. It
 * deliberately does NOT scan substituted output — substitution is single-pass
 * (a template-injection mitigation), so a resolved value that itself contains
 * `{{...}}` is never re-expanded and must not be mis-reported as unresolved.
 * Names are de-duplicated, preserving first-seen order.
 */
export function findUnresolvedPlaceholders(
  template: string,
  vars: Map<string, string>,
): string[] {
  if (template.length === 0) {
    return [];
  }

  const unresolved: string[] = [];
  const seen = new Set<string>();
  const pattern = /\{\{([^}]+)\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(template)) !== null) {
    const name = match[1];
    if (vars.get(name) === undefined && !seen.has(name)) {
      seen.add(name);
      unresolved.push(name);
    }
  }
  return unresolved;
}
