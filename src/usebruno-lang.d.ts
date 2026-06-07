declare module '@usebruno/lang' {
  export function bruToJsonV2(bru: string): unknown;
  export function jsonToBruV2(json: unknown): string;
  export function bruToEnvJsonV2(bru: string): unknown;
  export function envJsonToBruV2(json: unknown): string;
}
