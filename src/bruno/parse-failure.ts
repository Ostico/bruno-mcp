import type { ParseFailure } from './types.js';

/** Cap on a reported parse message, so one pathological error cannot dominate the run result. */
const MAX_PARSE_MESSAGE_LENGTH = 300;

const EXPECTED_PREFIX = 'Expected ';

/**
 * A grammar's expected-token list, shortened to one entry per prefix family.
 *
 * The `.bru` grammar accepts more than fifty block names, so its raw list runs
 * past a thousand characters and the token that matters is usually near the
 * end. Collapsing `auth:basic`, `auth:bearer`, … to `auth:*` keeps every family
 * visible inside the cap; a name with no colon is left as it is.
 */
function collapseExpectedTokens(list: string): string[] {
  const collapsed: string[] = [];

  for (const raw of list.split(', ')) {
    const token = raw.replace(/^or /, '').replace(/^"|"$/g, '');
    const colon = token.indexOf(':');
    const family = colon === -1 ? token : `${token.slice(0, colon)}:*`;
    if (!collapsed.includes(family)) collapsed.push(family);
  }

  return collapsed;
}

/**
 * The reason a parser rejected the file, if a later line carries one.
 *
 * `yaml` puts its reason in the first line, but the ohm grammar behind `.bru`
 * puts only a line and column there and its `Expected …` list last — so a
 * first-line-only summary reports a position and no diagnosis, which is how a
 * `websocket {` block that should have been `ws {` came to be read as the
 * format being unable to express the request at all.
 *
 * Code-frame lines cannot be mistaken for this: both libraries prefix every
 * frame line with its line number, so a summary at column zero is the parser's
 * own. What is returned is grammar text either way — a token list cannot carry
 * a value out of a request body the way an echoed source line can.
 */
function findExpectation(lines: string[]): string | undefined {
  const line = lines.slice(1).find((l) => l.startsWith(EXPECTED_PREFIX));
  if (line === undefined) return undefined;

  const families = collapseExpectedTokens(line.slice(EXPECTED_PREFIX.length));
  return `${EXPECTED_PREFIX}${families.join(', ')}`;
}

/**
 * Describe a file that failed to parse, for the run result.
 *
 * Keeps the first line, which carries the position, plus a collapsed
 * expected-token list where the parser supplied one. Everything else is
 * dropped: `yaml` appends a code frame that echoes the offending source back,
 * and not copying file content into a run result is how a literal credential in
 * a request body stays out of somewhere nobody expected it. Truncation is
 * marked, never silent.
 *
 * Lives in its own module because `request-executor.ts` sits on the repo-wide
 * max-lines ceiling.
 */
export function describeParseFailure(filePath: string, error: unknown): ParseFailure {
  const raw = error instanceof Error ? error.message : String(error);
  const lines = raw.split('\n');
  const expectation = findExpectation(lines);
  const summary = [lines[0].trim(), expectation].filter(Boolean).join(' ');
  const message = summary.length > MAX_PARSE_MESSAGE_LENGTH
    ? `${summary.slice(0, MAX_PARSE_MESSAGE_LENGTH)}…`
    : summary;

  return {
    file: filePath,
    // An Error whose message is empty would otherwise report a named file and
    // no reason, which is the half of this defect worth fixing least.
    message: message.length > 0 ? message : 'Unknown parse error',
  };
}
