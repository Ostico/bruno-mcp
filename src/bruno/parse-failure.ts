import type { ParseFailure } from './types.js';

/** Cap on a reported parse message, so one pathological error cannot dominate the run result. */
const MAX_PARSE_MESSAGE_LENGTH = 300;

/**
 * Describe a file that failed to parse, for the run result.
 *
 * Keeps the first line only. `yaml` appends a code frame after a blank line
 * that echoes the offending source back; the reason plus its line and column
 * are already in the first line, so the frame adds nothing a caller cannot get
 * by reading the file it is now told the name of — and not copying file
 * content into a run result is how a literal credential in a request body
 * stays out of somewhere nobody expected it. Truncation is marked, never
 * silent.
 *
 * Lives in its own module because `request-executor.ts` sits on the repo-wide
 * max-lines ceiling.
 */
export function describeParseFailure(filePath: string, error: unknown): ParseFailure {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split('\n', 1)[0].trim();
  const message = firstLine.length > MAX_PARSE_MESSAGE_LENGTH
    ? `${firstLine.slice(0, MAX_PARSE_MESSAGE_LENGTH)}…`
    : firstLine;

  return {
    file: filePath,
    // An Error whose message is empty would otherwise report a named file and
    // no reason, which is the half of this defect worth fixing least.
    message: message.length > 0 ? message : 'Unknown parse error',
  };
}
