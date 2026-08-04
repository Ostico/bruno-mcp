/**
 * Comments in a JSON payload, and whether what is left is still JSON.
 *
 * Bruno's editor lets a body carry `//` and slash-star comments, the way
 * `tsconfig.json` does, and Bruno strips them before sending — `decomment` at
 * `bruno-cli/src/runner/prepare-request.js:369` for the JSON body and `:447` for
 * the graphql variables block. Nothing here did, so an annotated body reached the
 * wire with the annotations in it and the server answered 400 on a collection
 * that runs clean under `bru run`.
 *
 * `jsonc-parser` does the reading. It scans the text as JSON — which is the whole
 * point, because the `//` in `"https://example.test"` is four characters inside a
 * string and not the start of a comment — and it has no JavaScript parser, no
 * evaluation, and no dependencies of its own. Upstream's `decomment` reaches the
 * same answer through `esprima`, a full JavaScript parser, which is a great deal
 * of machinery for a payload that is never JavaScript.
 */

import {
  stripComments,
  parse as parseJsonc,
  printParseErrorCode,
  type ParseError,
} from 'jsonc-parser';

/**
 * Remove comments from a JSON payload, leaving the value it describes unchanged.
 *
 * Comment spans come back as spaces rather than being cut out. Whitespace between
 * JSON tokens carries no meaning, so the parsed value matches what upstream's
 * removal produces; keeping the length means a syntax error's offset still points
 * at the same character of the text the author wrote.
 *
 * Not wrapped in a try/catch, where upstream's call is. `decomment` runs a
 * JavaScript parser, which throws on text that is not JavaScript; this is a
 * scanner, and text it cannot classify comes back as it was — a lone `/`, an
 * unterminated string, two hundred thousand open braces all return rather than
 * throw. Catching here would be catching nothing.
 */
export function stripJsonComments(text: string): string {
  return stripComments(text);
}

/**
 * Describe the first syntax error in a JSON payload, or nothing if it is valid.
 *
 * Reported through `jsonc-parser` rather than `JSON.parse`, for the error names:
 * `PropertyNameExpected at offset 8` says which of the two plausible mistakes was
 * made, where a thrown `SyntaxError` says only that a token was unexpected.
 *
 * Comments are accepted here, because this runs on text already stripped of them
 * and a caller passing unstripped text is asking about the JSON, not the notes.
 * Trailing commas are not: a server parsing strict JSON rejects them, so this has
 * to as well or the warning goes quiet on the most common malformation there is.
 */
export function describeJsonSyntaxError(text: string): string | undefined {
  if (text.trim() === '') return undefined;
  const errors: ParseError[] = [];
  parseJsonc(text, errors, { allowTrailingComma: false, disallowComments: false });
  const first = errors[0];
  if (first === undefined) return undefined;
  return `${printParseErrorCode(first.error)} at offset ${first.offset}`;
}
