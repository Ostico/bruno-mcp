declare module '@usebruno/lang' {
  export function bruToJsonV2(bru: string): unknown;
  export function jsonToBruV2(json: unknown): string;
  export function bruToEnvJsonV2(bru: string): unknown;
  export function envJsonToBruV2(json: unknown): string;
  /**
   * Parses a collection.bru / folder.bru root file. A separate grammar from
   * bruToJsonV2: a root file carries a bare `auth { mode: ... }` block, which
   * the request grammar rejects outright.
   */
  export function collectionBruToJson(bru: string): unknown;
}
