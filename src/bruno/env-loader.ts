import { readFile } from 'node:fs/promises';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import type { EnvFile } from './types.js';

export async function loadEnvironment(
  collectionPath: string,
  envName: string,
): Promise<Map<string, string>> {
  const envFilePath = join(collectionPath, 'environments', `${envName}.yml`);

  let content: string;
  try {
    content = await readFile(envFilePath, 'utf-8');
  } catch {
    return new Map();
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
