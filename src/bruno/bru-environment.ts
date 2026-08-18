/**
 * Reading and writing `.bru` environment files.
 *
 * Split out of `bru-parser.ts`, verbatim: that file holds the request dialect,
 * these five functions hold the environment dialect, and the two share only the
 * error type. Nothing here is new.
 */
import { bruToEnvJsonV2, envJsonToBruV2 } from '@usebruno/lang';
import {
  BrunoError,
  type BrunoEnvironment,
  type EnvFile,
  type EnvVariable,
} from './types.js';

/** What `bruToEnvJsonV2` returns for an environment file. */
interface BruLangEnvJson {
  variables?: Array<{ name: string; value?: string; enabled?: boolean; secret?: boolean; type?: string }>;
  // The reader also returns a top-level `color` key when the file carries one.
  [key: string]: unknown;
}


export function parseBruEnvironment(content: string, name: string): BrunoEnvironment {
  let json: BruLangEnvJson;
  try {
    json = bruToEnvJsonV2(content) as BruLangEnvJson;
  } catch (err) {
    throw new BrunoError(
      `Failed to parse .bru environment: ${err instanceof Error ? err.message : String(err)}`,
      'PARSE_ERROR',
    );
  }

  const variables: Record<string, string | number | boolean> = {};
  if (json.variables && Array.isArray(json.variables)) {
    for (const v of json.variables) {
      if (v.enabled !== false) {
        variables[v.name] = v.value ?? '';
      }
    }
  }

  return { name, variables };
}

export function generateBruEnvironment(env: BrunoEnvironment): string {
  const variables = Object.entries(env.variables).map(([name, value]) => ({
    name,
    value: String(value),
    enabled: true,
    secret: false,
    type: 'text',
  }));

  try {
    return envJsonToBruV2({ variables });
  } catch (err) {
    /* istanbul ignore next -- defensive: envJsonToBruV2 is handed an internally
       constructed variables[] whose names are object keys / EnvVariable.name and
       whose values are String()-coerced, so the library never throws here */
    throw new BrunoError(
      `Failed to generate .bru environment: ${err instanceof Error ? err.message : String(err)}`,
      'GENERATE_ERROR',
    );
  }
}

/**
 * Parse a .bru environment preserving ALL variables and their enabled/disabled
 * state (unlike parseBruEnvironment, which drops disabled variables). Used by
 * the merge/write path so disabled variables survive edits.
 *
 * A variable listed in the file's `vars:secret [...]` block comes back with
 * `secret: true` and an empty value — the block holds names only, because a
 * secret's value is never stored in the environment file.
 */
export function parseBruEnvironmentRaw(content: string): EnvVariable[] {
  return parseBruEnvironmentFile(content).variables ?? [];
}

/**
 * Top-level .bru environment keys represented by EnvFile's own fields.
 * Everything else the file carries is kept in `EnvFile.extra`.
 */
const BRU_ENV_MODELLED_KEYS = new Set(['variables']);

/**
 * Parse a .bru environment into the full file model: the variables plus any
 * top-level key the model does not name (`color`), so a read-modify-write can
 * write those keys back instead of deleting them.
 */
export function parseBruEnvironmentFile(content: string): EnvFile {
  let json: BruLangEnvJson;
  try {
    json = bruToEnvJsonV2(content) as BruLangEnvJson;
  } catch (err) {
    throw new BrunoError(
      `Failed to parse .bru environment: ${err instanceof Error ? err.message : String(err)}`,
      'PARSE_ERROR',
    );
  }

  const variables: EnvVariable[] = [];
  if (json.variables && Array.isArray(json.variables)) {
    for (const v of json.variables) {
      if (v.name == null || String(v.name) === '') continue;
      const item: EnvVariable = { name: v.name, value: v.value ?? '' };
      if (v.enabled === false) item.disabled = true;
      if ((v as { secret?: boolean }).secret === true) item.secret = true;
      variables.push(item);
    }
  }

  const envFile: EnvFile = { variables };
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
    if (BRU_ENV_MODELLED_KEYS.has(key)) continue;
    extra[key] = value;
  }
  if (Object.keys(extra).length > 0) envFile.extra = extra;

  return envFile;
}

/**
 * Generate a .bru environment from a full variable list, preserving the
 * enabled/disabled state of each variable (disabled === true → enabled: false)
 * and its `secret` flag (writing it unconditionally false
 * downgraded every secret var to plaintext on any env edit).
 *
 * A secret variable is emitted into the `vars:secret [...]` block, which holds
 * bare names — the serializer drops the value, so the credential never reaches
 * the file. `fileExtra` carries back top-level keys read off the same file;
 * only the ones the serializer understands (`color`) survive the round trip.
 */
export function generateBruEnvironmentFull(
  vars: EnvVariable[],
  fileExtra?: Record<string, unknown>,
): string {
  const variables = vars.map((v) => ({
    name: v.name,
    value: String(v.value ?? ''),
    enabled: v.disabled !== true,
    secret: v.secret === true,
    type: 'text',
  }));

  const doc: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fileExtra ?? {})) {
    if (BRU_ENV_MODELLED_KEYS.has(key)) continue;
    doc[key] = value;
  }
  doc.variables = variables;

  try {
    return envJsonToBruV2(doc);
  } catch (err) {
    /* istanbul ignore next -- defensive: envJsonToBruV2 is handed an internally
       constructed variables[] whose names are object keys / EnvVariable.name and
       whose values are String()-coerced, so the library never throws here */
    throw new BrunoError(
      `Failed to generate .bru environment: ${err instanceof Error ? err.message : String(err)}`,
      'GENERATE_ERROR',
    );
  }
}
