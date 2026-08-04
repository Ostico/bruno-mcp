import { mockDataFunctions } from '@usebruno/common';

/**
 * `{{$guid}}`, `{{$randomEmail}}` and the rest of Bruno's generators.
 *
 * These are not variable references: nothing declares them, and each occurrence
 * produces a fresh value. They are expanded from the same table Bruno's app and
 * CLI use, so a request that works there works here.
 */
const DYNAMIC_PATTERN = /\{\{\$(\w+)\}\}/g;

/** The characters that have to be escaped to survive inside a JSON string. */
const JSON_SPECIAL_CHARS = /[\\\n\r\t"]/;

function escapeJSONString(value: string): string {
  if (!JSON_SPECIAL_CHARS.test(value)) {
    return value;
  }

  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/"/g, '\\"');
}

/**
 * Whether `name` — a placeholder name as it appears between the braces — names a
 * generator rather than a variable. Used to keep generators out of the
 * unresolved-variable warnings: `{{$guid}}` resolves, just not from a variable.
 *
 * A typo like `{{$gid}}` is deliberately NOT dynamic, so it still gets reported.
 */
export function isDynamicVariable(name: string): boolean {
  if (!name.startsWith('$')) {
    return false;
  }

  const keyword = name.slice(1);
  return typeof mockDataFunctions[keyword as keyof typeof mockDataFunctions] === 'function';
}

/**
 * Replace every `{{$keyword}}` in `text` with a freshly generated value.
 *
 * An unknown keyword is left exactly as written, the way upstream leaves it:
 * `{{$nope}}` reaches the wire literally rather than becoming `undefined`.
 *
 * `escapeForJson` is for text that is about to be read as JSON — a JSON request
 * body, or the GraphQL variables block. `{{$randomLoremParagraphs}}` generates
 * newlines, and a raw newline inside a JSON string is a parse error, so the
 * generated value is escaped before it lands in the document. Everywhere else
 * (URLs, headers, form fields) the value goes in as generated.
 */
export function expandDynamicVariables(text: string, escapeForJson = false): string {
  if (text.length === 0) {
    return text;
  }

  return text.replace(DYNAMIC_PATTERN, (match, keyword: string) => {
    const generated = mockDataFunctions[keyword as keyof typeof mockDataFunctions]?.();
    if (generated === undefined) {
      return match;
    }

    const value = String(generated);
    return escapeForJson ? escapeJSONString(value) : value;
  });
}
