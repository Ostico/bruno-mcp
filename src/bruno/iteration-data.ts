/**
 * Where the rows of a data-driven run come from.
 *
 * A row is a set of variable values, and an iteration is one execution group run
 * with one row bound. That equivalence is the whole design: a group already owns
 * its own variable store, cookie jar and OAuth2 token cache, which is exactly
 * what a row needs, because a row commonly *is* a different identity. Anything
 * that gave rows a weaker boundary than groups would let row 2 authenticate as
 * row 1 and report a pass — the failure this server already had once, when the
 * token cache was per run instead of per group.
 *
 * This module turns a caller's `data` or `dataFile` into rows and refuses what
 * it cannot turn into rows. It does not decide what a row means to a run; that
 * is `run-plan.ts`.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { parseCsvRows } from './csv-parser.js';
import { validatePath } from './path-validator.js';

/**
 * Ceiling on rows in one run, whether they came from a file or from the call.
 *
 * Not a performance guess: a run is N rows times the requests in the group, so a
 * spreadsheet handed over by mistake — an export with every customer in it — is
 * an outbound request storm against somebody's API under this server's identity.
 * Refusing names the count and the cap, which an agent can act on by slicing the
 * file; a run that quietly starts 40,000 requests cannot be acted on at all.
 */
export const MAX_ITERATION_ROWS = 1000;

/**
 * Read the rows of a CSV data file.
 *
 * `reference` is taken against the collection root when relative, and must land
 * inside the collection either way. That confinement is the authorization
 * boundary, the same one report files use: a collection path is what the caller
 * has already been trusted with, and `../../.ssh/known_hosts` is not it. A file
 * outside is refused by name rather than read and rejected later, because the
 * read is the part that matters.
 *
 * Every failure here throws. A data file is not like a report file, where a bad
 * path costs a warning and the run still happened: a run whose rows could not be
 * read would execute once, unparameterised, against whatever the collection says
 * — the same shape as success, with none of the meaning.
 */
export async function readDataFile(
  reference: string,
  collectionPath: string,
): Promise<Record<string, string>[]> {
  const target = isAbsolute(reference) ? reference : resolve(join(collectionPath, reference));
  const check = validatePath(target, collectionPath);
  if (!check.valid) {
    throw new Error(
      `Data file "${reference}" is outside the collection: ${check.reason ?? 'path refused'}. `
        + 'A data file must live inside the collection it parameterises.',
    );
  }

  let text: string;
  try {
    text = await readFile(check.resolved, 'utf8');
  } catch (reason) {
    const code = (reason as NodeJS.ErrnoException)?.code;
    throw new Error(
      `Data file "${reference}" could not be read${code ? ` (${code})` : ''}. `
        + 'Nothing was run: a run without its rows would execute once, '
        + 'unparameterised, and look like a pass.',
    );
  }

  // The parser's own refusals are written for whoever has to repair the file and
  // name the line and column, so they are passed through with the path in front
  // of them rather than replaced with a summary of them.
  try {
    return parseCsvRows(text).rows;
  } catch (reason) {
    throw new Error(
      `Data file "${reference}": ${reason instanceof Error ? reason.message : String(reason)}`,
    );
  }
}

/**
 * The rows one scope contributes, from a file, from the call, or neither.
 *
 * `data` and `dataFile` together are refused rather than merged or ranked. Two
 * sources of rows in one scope is a caller who believes something about the
 * merge — appended? overridden per column? — and no answer to that is more
 * obviously right than the others.
 */
export async function resolveRows(
  scope: { data?: Record<string, string>[]; dataFile?: string },
  collectionPath: string,
  label: string,
): Promise<Record<string, string>[] | undefined> {
  if (scope.data !== undefined && scope.dataFile !== undefined) {
    throw new Error(
      `${label} gives both \`data\` and \`dataFile\`. Pass one: rows from two sources `
        + 'have no obvious merge, and picking one for you would silently discard the other.',
    );
  }

  const rows = scope.dataFile !== undefined
    ? await readDataFile(scope.dataFile, collectionPath)
    : scope.data;

  if (rows === undefined) {
    return undefined;
  }

  // An empty `data: []` is refused for the reason an empty `requests: []` is
  // honoured: a caller who computed no requests selected nothing, but a caller
  // who computed no rows has no iterations to run, and running the group once
  // with no row bound would answer a question nobody asked.
  if (rows.length === 0) {
    throw new Error(
      `${label} gives no rows. A data-driven run needs at least one row; `
        + 'omit `data` entirely to run the group once without one.',
    );
  }

  if (rows.length > MAX_ITERATION_ROWS) {
    throw new Error(
      `${label} gives ${rows.length} rows, over the ${MAX_ITERATION_ROWS}-row ceiling. `
        + 'Each row runs every request in the group, so this would be '
        + `${rows.length} times that many outbound requests. Slice the data and run it in parts.`,
    );
  }

  return rows;
}
