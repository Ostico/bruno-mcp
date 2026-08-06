/**
 * Shared machinery for the general round-trip fidelity guards.
 *
 * A re-parse gate proves nothing. A writer that drops `docs`, reorders `seq` or
 * loses an oauth2 parameter still emits a file that parses cleanly, so "it
 * parsed" is not evidence of fidelity — every round-trip defect in this
 * codebase was invisible for exactly that reason.
 *
 * What is needed instead is a *deep* comparison that enumerates every piece of
 * data in a document and asserts each one is still there afterwards, and whose
 * failure message names the field that went missing. That is what this module
 * provides.
 *
 * NOTE: this file is deliberately not named `*.test.ts` — jest's `testMatch`
 * is `tests/**\/*.test.ts`, so it is imported by the guards rather than run as
 * a suite of its own.
 *
 * The `*.helper.ts` suffix is the project-wide convention for that: a `.ts`
 * file under `tests/` that is support code, not a suite. It is what keeps the
 * file out of jest's `testMatch` AND out of the test-guard gate's changed-
 * source set — see `extra-exclude-patterns` in `.github/workflows/ci.yml`.
 * Name any future shared test helper the same way.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Deterministic serialisation: key order must not affect a signature. */
export function stable(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/**
 * Every piece of data in `value`, as a list of `"<path> = <json>"` strings.
 *
 * `ordered: true`  — array elements are addressed by index (`params[1].name`),
 *                    so a re-ordered list reports a *different* path and the
 *                    guard treats the original position as lost.
 * `ordered: false` — array elements are addressed positionlessly (`params[].name`)
 *                    and each object element additionally contributes a whole-
 *                    element signature, so an element cannot be silently
 *                    dismantled even though the list may be re-ordered.
 *
 * `undefined`/`null` carry no data and are skipped: the guard only ever asks
 * "did something that was there survive?", never "did something new appear?".
 */
export function fingerprints(value: unknown, ordered: boolean, path = ''): string[] {
  if (value === undefined || value === null) return [];

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      const itemPath = ordered ? `${path}[${index}]` : `${path}[]`;
      const nested = fingerprints(item, ordered, itemPath);
      if (ordered || item === null || typeof item !== 'object') return nested;
      return [`${itemPath} = ${stable(item)}`, ...nested];
    });
  }

  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      fingerprints(child, ordered, path ? `${path}.${key}` : key),
    );
  }

  return [`${path} = ${JSON.stringify(value)}`];
}

/**
 * The data in `before` that `after` does not have, duplicates counted.
 *
 * The returned strings are the whole point of this module: each one names the
 * exact path that was lost, so a failing assertion reads like
 * `["assertions[0].name = \"res.status\""]` rather than `expected true, got false`.
 */
export function lostFields(before: unknown, after: unknown, ordered: boolean): string[] {
  const available = new Map<string, number>();
  for (const fp of fingerprints(after, ordered)) {
    available.set(fp, (available.get(fp) ?? 0) + 1);
  }

  const lost: string[] = [];
  for (const fp of fingerprints(before, ordered)) {
    const remaining = available.get(fp) ?? 0;
    if (remaining === 0) lost.push(fp);
    else available.set(fp, remaining - 1);
  }
  return lost;
}

/** Top-level keys of `obj` that actually carry data (empty list/object = no data). */
export function dataKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const obj = value as Record<string, unknown>;
  return Object.keys(obj)
    .filter((key) => {
      const child = obj[key];
      if (child === undefined || child === null) return false;
      if (Array.isArray(child)) return child.length > 0;
      if (typeof child === 'object') return dataKeys(child).length > 0;
      if (typeof child === 'string') return child.length > 0;
      return true;
    })
    .sort();
}

/** Top-level keys that carried data before the round-trip and carry none after. */
export function lostKeys(before: unknown, after: unknown): string[] {
  const survived = new Set(dataKeys(after));
  return dataKeys(before).filter((key) => !survived.has(key));
}

/**
 * The property names declared directly on a TypeScript interface, read out of
 * the source file at run time.
 *
 * This is what turns the fixture table into a guard against *future* drift:
 * types are erased at run time, so the only way to notice that somebody added a
 * field to `BruFile` and never taught the writer about it is to go and read the
 * declaration. A new key that no fixture exercises fails the coverage guard,
 * which forces either a fixture or an explicit, commented waiver.
 */
export function declaredInterfaceKeys(source: string, interfaceName: string): string[] {
  const marker = `export interface ${interfaceName} {`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`interface ${interfaceName} not found — did it get renamed?`);
  }

  const open = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`interface ${interfaceName} is not closed`);

  const body = source
    .slice(open + 1, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  const keys: string[] = [];
  let nesting = 0;
  for (const line of body.split('\n')) {
    if (nesting === 0) {
      const match = /^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\??\s*:/.exec(line);
      if (match) keys.push(match[1] ?? match[2] ?? match[3]);
    }
    for (const ch of line) {
      if (ch === '{') nesting++;
      else if (ch === '}') nesting--;
    }
  }
  return keys;
}

/**
 * The request model's declarations, read from disk so the guards can inspect
 * them.
 *
 * Two files, concatenated: `types.ts` holds most of the model, and the gRPC and
 * WebSocket request shapes live in `transport-requests.ts` because `types.ts` is
 * within a few dozen lines of its `max-lines` ceiling. `declaredInterfaceKeys`
 * finds an interface by name anywhere in the string it is given, so joining the
 * two keeps a single source argument and means moving an interface between the
 * files cannot quietly drop it out of the coverage guard.
 */
export function readTypesSource(): string {
  const dir = join(__dirname, '..', '..', '..', 'src', 'bruno');
  return [
    readFileSync(join(dir, 'types.ts'), 'utf8'),
    readFileSync(join(dir, 'transport-requests.ts'), 'utf8'),
  ].join('\n');
}

/**
 * Every block header (`headers {`, `auth:oauth2:additional_params:auth_req:body {`,
 * …) in a `.bru` document. Block headers sit at column zero; body payloads are
 * indented, so the anchor keeps `{"a":1}` inside `body:json` from matching.
 */
export function bruBlockHeaders(content: string): string[] {
  return Array.from(content.matchAll(/^([a-z][a-zA-Z0-9:_-]*)\s*\{\s*$/gm), (m) => m[1]).sort();
}
