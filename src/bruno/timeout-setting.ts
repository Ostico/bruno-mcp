import type { TimeoutSetting } from './types.js';

/**
 * Read an authored `settings.timeout` off a parsed file.
 *
 * Shared by both dialect parsers because both dialects carry the same two forms.
 * `.bru` arrives here already converted — `bruToJsonV2` turns the digits into a
 * number and passes the word `inherit` through as a string — and `.yml` arrives
 * as whatever the YAML scalar parsed to.
 *
 * An unreadable value is dropped rather than refused, which is what upstream
 * does with it too: `bruToJsonV2` leaves the key off when it is neither
 * `inherit` nor a parseable integer. Refusing here would reject a file Bruno
 * itself opens.
 *
 * NaN and Infinity survive as numbers on purpose. They are legal YAML scalars
 * (`.nan`, `.inf`) and `typeof` calls them numbers, so this is not the place to
 * judge them; the consumer that has to arm a timer is, and
 * `request-executor.ts` warns and falls back there.
 */
export function readTimeoutSetting(raw: unknown): TimeoutSetting | undefined {
  if (typeof raw === 'number') return raw;
  return raw === 'inherit' ? 'inherit' : undefined;
}
