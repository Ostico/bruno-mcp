/**
 * The types of the request-level `settings` block, for both dialects and for the
 * tool surface.
 *
 * Split out of `types.ts`, verbatim apart from the one doc correction noted
 * below: these five declarations are a self-contained group with no dependency
 * on anything else in the model, and that file is at its line cap.
 */

/**
 * An authored `settings.timeout`, in milliseconds or as the word `inherit`.
 *
 * Both dialects accept the word: `bruToJsonV2` reads it out of a `.bru` settings
 * block, and `resolveTimeoutSetting` in `bruno-common` carries it through a
 * `.yml` write instead of flattening it to a number. In Bruno's own app it means
 * "use the application-level request-timeout preference"
 * (`bruno-electron/src/utils/collection.js:860`). This server has no preference
 * layer, so what a request inherits here is the runner's own default — the same
 * value an absent timeout already gets.
 *
 * Modelling it as a union rather than narrowing it to a number at the parser is
 * what keeps the word on disk: a modelled key never reaches the passthrough bag,
 * so a parser that dropped the value deleted it on the next write.
 */
export type TimeoutSetting = number | 'inherit';

export interface BruRequestSettings {
  encodeUrl?: boolean;
  timeout?: TimeoutSetting;
  /** The executor honours this; leaving it out of the model dropped it. */
  followRedirects?: boolean;
  maxRedirects?: number;
  /**
   * How often a WebSocket session sends a ping, in milliseconds. 0 is upstream's
   * spelling for "never".
   *
   * Modelled rather than left to the passthrough bag because both dialects name
   * it: `bruToJsonV2` reads it out of a `.bru` settings block, and upstream's
   * `.yml` WebSocket writer emits it beside `timeout` for every WebSocket
   * request. Unmodelled, a value Bruno wrote reached this parser and was
   * dropped, which deleted it on the next write.
   */
  keepAliveInterval?: number;
}

/**
 * The request-level `settings` block as the MCP tools accept it.
 *
 * Unusually for this file there is no polarity or naming difference between the
 * two dialects: `.bru` writes these five as bare `key: value` lines inside a
 * `settings { }` block, `.yml` writes them as a top-level `settings:` mapping,
 * and both spell every key and type the same way. So this shape needs no
 * conversion on either path — it is carried through as-is.
 *
 * Every field is optional, and an omitted field means an absent key rather than
 * a default written down — but only on `.bru`, where a request authored with no
 * settings carries no settings block at all, as Bruno's own writer does. There
 * the executor's fallbacks apply: redirects followed, a 10-hop cap, a 30000ms
 * request deadline. A `.yml` request always carries a resolved block instead, and
 * an unset timeout is resolved to 0 — no request deadline at all — so the 30000ms
 * fallback is unreachable in that dialect. The 5000ms script budget survives
 * either way, because the sandbox cannot be given 0 and treats it as unset.
 */
export interface RequestSettingsInput {
  timeout?: number;
  followRedirects?: boolean;
  maxRedirects?: number;
  encodeUrl?: boolean;
  /** WebSocket only. See `BruRequestSettings.keepAliveInterval`. */
  keepAliveInterval?: number;
}

export interface TlsSettings {
  rejectUnauthorized?: boolean;
  ca?: string;
  cert?: string;
  key?: string;
  /**
   * Unmodelled keys inside the `tls` block, carried through a write.
   *
   * The block needs its own bag because `tls` is a modelled key of
   * `YamlSettings`: an unrecognised field inside it never reaches the settings
   * bag, so without this a `tls` block made of fields we do not name parsed to
   * nothing and was deleted on the next write.
   */
  extra?: Record<string, unknown>;
}

export interface YamlSettings {
  encodeUrl?: boolean;
  timeout?: TimeoutSetting;
  followRedirects?: boolean;
  maxRedirects?: number;
  /** See `BruRequestSettings.keepAliveInterval`. WebSocket requests only. */
  keepAliveInterval?: number;
  tls?: TlsSettings;
  proxy?: string;
  /** Unmodelled `settings` keys, carried through a write. */
  extra?: Record<string, unknown>;
}
