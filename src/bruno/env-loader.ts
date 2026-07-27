import { readFile } from 'node:fs/promises';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import type { EnvFile } from './types.js';
import { parseBruEnvironmentRaw } from './bru-parser.js';

export async function loadEnvironment(
  collectionPath: string,
  envName: string,
): Promise<Map<string, string>> {
  const envFilePath = join(collectionPath, 'environments', `${envName}.yml`);

  let content: string;
  try {
    content = await readFile(envFilePath, 'utf-8');
  } catch {
    // No YAML environment — fall back to a native Bruno `.bru` environment file
    // (finding X11). Native collections store environments as `.bru`, not `.yml`.
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

    const value = entry.value === undefined || entry.value === null
      ? ''
      : String(entry.value);

    vars.set(entry.name, value);
  }

  return vars;
}

/**
 * Load a native Bruno `.bru` environment file (finding X11). Reuses
 * `parseBruEnvironmentRaw` and maps its output to the same `name -> value`
 * shape the `.yml` loader returns: disabled variables are dropped, while
 * enabled variables — including `secret` ones — are kept with their value.
 * Precedence lives in `loadEnvironment`: `.yml` wins when present, `.bru` is
 * the fallback.
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
 * not resolve (finding X8).
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
