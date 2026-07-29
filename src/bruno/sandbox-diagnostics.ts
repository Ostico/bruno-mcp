/**
 * Non-fatal diagnostics about a test script: assertions the report cannot show,
 * and error messages whose real cause is not guessable from the text.
 *
 * Pure string analysis, deliberately separate from the sandbox that produces the
 * input — nothing here touches a vm, a context, or a result.
 */

/**
 * Blank out comments and string/template literals so brace-depth scanning is
 * not confused by braces or the word "expect" appearing inside them.
 * Characters are replaced with spaces to keep offsets stable.
 */
function blankCommentsAndStrings(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      out[i++] = ' ';
      out[i++] = ' ';
      while (i < n) {
        if (src[i] === '*' && src[i + 1] === '/') {
          out[i++] = ' ';
          out[i++] = ' ';
          break;
        }
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out[i++] = ' ';
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          out[i++] = ' ';
          if (i < n && src[i] !== '\n') out[i++] = ' ';
          continue;
        }
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) out[i++] = ' ';
      continue;
    }
    i++;
  }

  return out.join('');
}

/**
 * Count `expect(...)` calls that sit at brace depth 0 — i.e. outside any
 * test(description, callback) body. Only test() callbacks push into __results,
 * so a top-level assertion that passes is silently dropped from the report.
 */
function countTopLevelAssertions(script: string): number {
  const src = blankCommentsAndStrings(script);
  let depth = 0;
  let count = 0;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '{' || c === '(' || c === '[') {
      depth++;
      continue;
    }
    if (c === '}' || c === ')' || c === ']') {
      if (depth > 0) depth--;
      continue;
    }
    if (depth !== 0) continue;

    // Match the identifier `expect` followed by an opening paren
    if (c === 'e' && src.startsWith('expect', i)) {
      const before = i === 0 ? '' : src[i - 1];
      if (before !== '' && /[A-Za-z0-9_$.]/.test(before)) continue;
      let j = i + 'expect'.length;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === '(') {
        count++;
        // Step to just before the paren so it is still depth-counted below
        i = j - 1;
      }
    }
  }

  return count;
}

/**
 * Build non-fatal warnings about assertions the report cannot show.
 *
 * @param script       The user script source
 * @param resultCount  How many test() blocks registered a result
 */
export function detectUnreportedAssertions(
  script: string,
  resultCount: number,
): string[] {
  const bare = countTopLevelAssertions(script);
  if (bare === 0) return [];

  const plural = bare === 1 ? '' : 's';
  const scope =
    resultCount === 0
      ? 'This run therefore reports zero assertions even though the request itself succeeded.'
      : `Only the ${resultCount} test() block${resultCount === 1 ? '' : 's'} in this script are reported.`;

  return [
    `${bare} assertion${plural} ran outside a test() block and ${bare === 1 ? 'was' : 'were'} not recorded. ` +
      `${scope} Wrap assertions so they appear in results: ` +
      'test("descriptive name", function() { expect(res.getStatus()).to.equal(200); });',
  ];
}

/**
 * Turn the SyntaxError from JSON.parse(res.getBody()) into an actionable hint.
 *
 * res.getBody() already returns parsed JSON (see ResponseWrapper), so parsing
 * it again stringifies the object to "[object Object]" first. The raw error
 * names neither getBody nor the double parse, so the cause is not guessable
 * from the message alone.
 *
 * @param message  The thrown error's message
 */
export function detectDoubleParse(message: string): string[] {
  const doubleParsed =
    // Node 20+
    message.includes('"[object Object]" is not valid JSON') ||
    // Node 18
    message.includes('Unexpected token o in JSON at position 1');

  if (!doubleParsed) return [];

  return [
    'res.getBody() already returns parsed JSON when the response Content-Type is JSON, ' +
      'so JSON.parse(res.getBody()) parses the string "[object Object]" and throws. ' +
      'Access fields directly: res.getBody().field. If the endpoint can also return non-JSON, use: ' +
      'const b = res.getBody(); const j = typeof b === "string" ? JSON.parse(b) : b;',
  ];
}
