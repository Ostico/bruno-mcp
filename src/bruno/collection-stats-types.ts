/**
 * Types for what `get_collection_stats` reports.
 *
 * Their own module because types.ts reached the repo-wide max-lines ceiling,
 * the same reason the run-result types moved to run-results.ts. Re-exported from
 * types.ts, so every existing import keeps working.
 */

export interface RequestDetail {
  name: string;
  method: string;
  seq: number;
  folder: string;
  hasTests: boolean;
  filePath?: string;
  /**
   * The target, taken from whichever transport block carries one: `http`, `grpc`
   * or `ws`. It is the field most wanted when triaging an unfamiliar collection —
   * two requests named "Create" say nothing, their URLs say everything — and
   * without it the only way to learn a URL was to read every file back.
   *
   * Optional because a request whose transport block is missing entirely has no
   * URL to report, and an empty string would read as one.
   */
  url?: string;
}

/**
 * Narrows which requests a stats call reports.
 *
 * The counts always describe the whole collection; this only bounds the
 * per-request array, which is what makes the response large.
 */
export interface RequestDetailFilter {
  /** A folder path relative to the collection root; nested folders match too. */
  folder?: string;
  /** Method or, for a request with none, its kind: `GRPC`, `WS`. Case-insensitive. */
  method?: string;
  /** Case-insensitive substring of the request name. */
  nameContains?: string;
  /** When false, the per-request array is dropped and only the counts remain. */
  includeRequests?: boolean;
}

export interface EnvironmentDetail {
  name: string;
  /**
   * Variable names only. Values are withheld: environments routinely hold
   * tokens, and the caller's need here is to know what exists before merging
   * into it, not to read secrets back out.
   */
  variables: string[];
}

export interface CollectionStats {
  totalRequests: number;
  requestsByMethod: Record<string, number>;
  environments: string[];
  environmentDetails: EnvironmentDetail[];
  folders: string[];
  requests: RequestDetail[];
  /**
   * How many requests the filter matched. Present only when a filter was
   * applied, so an unfiltered call cannot be misread as a filtered one — and a
   * filtered one cannot be misread as the whole collection, since
   * `totalRequests` keeps counting every request on disk.
   */
  matchedRequests?: number;
  /** Present when the caller asked for counts only, so an empty array is not read as no matches. */
  requestsOmitted?: true;
}
