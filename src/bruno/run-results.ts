/**
 * The shape of a run’s results.
 *
 * Extracted from types.ts, which sits on the repo-wide max-lines ceiling: the
 * request side of the two new transports and the result side arrived from two
 * different branches, and together they crossed it. Nothing here changed in the
 * move, and types.ts re-exports every name, so no importer had to.
 */

import type { TestResult } from './types.js';
import type { GrpcResultDetail, WebsocketResultDetail } from './transport-results.js';
import type { ResponseHeaders } from './response-headers.js';

export interface RequestExecutionResult {
  name: string;
  method: string;
  url: string;
  /**
   * HTTP status, or 0 for a request that never got an answer.
   *
   * 0 is the refusal sentinel across every kind — SSRF blocked, unsupported kind,
   * a crash before the wire. It is NOT overloaded with a protocol status, which
   * matters most for gRPC: gRPC's OK code is also 0, so mapping it here would make
   * a successful call and a security refusal indistinguishable in the field an
   * agent reads first. gRPC's code lives in `grpc.code`, and the presence of the
   * `grpc` object is what separates "executed" from "refused".
   */
  status: number;
  duration_ms: number;
  tests: TestResult[];
  /**
   * Non-fatal diagnostics for this request — surfaced so a run that recorded
   * zero assertions does not read as an unqualified pass.
   */
  warnings?: string[];
  error?: string;
  response_body?: string;
  response_body_truncated?: boolean;
  response_content_type?: string;
  /**
   * Response headers, credential values masked, for a request that reached the
   * wire. `set-cookie` is a list, and its cookies keep their attributes — see
   * `response-headers.ts` for why that asymmetry is the point of the field.
   *
   * Not gated by `includeResponseBody`: that flag exists to keep a large body
   * out of a result, and headers are neither large nor the thing it names.
   */
  response_headers?: ResponseHeaders;
  /** Present only for a gRPC request that actually reached a server. */
  grpc?: GrpcResultDetail;
  /** Present only for a WebSocket session that actually opened. */
  websocket?: WebsocketResultDetail;
}

/**
 * Test/assertion results actually registered by a run, counted at TEST level.
 *
 * This exists because the request-level counts alone cannot express "nothing
 * was verified". A run of five requests whose scripts were all silently dropped
 * reports the same `total`/`passed`/`failed` as a run in which every assertion
 * passed, so a dropped-script bug leaves the summary green. `total: 0` is the
 * distinguishing signal.
 */
export interface TestLevelCounts {
  total: number;
  passed: number;
  failed: number;
}

export interface CollectionRunSummary {
  /** Requests executed. */
  total: number;
  /**
   * Requests that finished with no error and no failing test. Counted by
   * predicate, never derived as `total - failed`: the subtraction is what let a
   * run that evaluated nothing present as a run in which everything passed.
   */
  passed: number;
  /** Requests that errored or registered at least one failing test. */
  failed: number;
  duration_ms: number;
  /** Test-level counts across the run. */
  tests: TestLevelCounts;
  /**
   * Requests that registered no test result whatsoever. Read alongside
   * `tests.total` to tell "verified and green" from "never verified".
   */
  requestsWithoutTests: number;
}

/**
 * A request file that was discovered but could not be parsed, so it was skipped.
 *
 * `file` is the same path shape `RequestExecutionResult` reports, so it can be
 * handed straight to `read_request`. `message` is the reason, reduced to its
 * first line: every BrunoError message is single-line already, and the only
 * multi-line source is the `yaml` package's code frame, which echoes the
 * offending source line back — the line and column are in the first line
 * anyway, and duplicating file content into a run result is how a literal
 * credential in a request body would end up somewhere nobody expected it.
 */
export interface ParseFailure {
  file: string;
  message: string;
}

/**
 * One group's outcome. A group owns its own store and cookie jar, so its
 * captures are unambiguous in a way a run-wide capture map never was: group
 * A's `token` belongs to group A and to nothing else.
 */
export interface GroupRunResult {
  /** As supplied by the caller. Absent when the group was not named. */
  name?: string;
  /** Position in the run. Always present, so an unnamed group is still addressable. */
  index: number;
  summary: CollectionRunSummary;
  /** In listed order, whatever order they executed in. */
  results: RequestExecutionResult[];
  /** References that resolved to nothing. Absent when everything resolved. */
  missingRequests?: string[];
  /**
   * Every variable name a script set with `bru.setVar` in this group, sorted.
   * Absent when no script set anything.
   *
   * Names come back unasked because they are already readable in the
   * collection's script source; the values behind them are not. Ask for a value
   * by naming it in `captureVariables`.
   */
  capturedVariableNames?: string[];
  /**
   * Values for the names given in `captureVariables`, for those a script in
   * this group actually set. Absent when none were asked for or none matched.
   */
  capturedVariables?: Record<string, string>;
  /** Notes about this group rather than about one request. */
  warnings?: string[];
  /** Set when the group itself failed, as opposed to a request within it. */
  error?: string;
}

export interface CollectionRunResult {
  summary: CollectionRunSummary;
  /**
   * One entry per group, in the order the caller listed them. Always present,
   * with a single implicit group when the caller named none: flattening that
   * case would make every caller branch on whether they passed groups.
   */
  groups: GroupRunResult[];
  /**
   * How many discovered files failed to parse and were skipped. Always equals
   * `parseFailures.length` — it is derived from it, not counted separately.
   */
  parseErrors?: number;
  /**
   * One entry per skipped file, naming it and why. A bare count is a dead end
   * for a caller that cannot bisect: it says a subset ran without saying which
   * subset. Absent only on the single-request path, where a parse failure
   * throws instead of being tallied.
   */
  parseFailures?: ParseFailure[];
  /**
   * Notes about the run as a whole rather than about one request — a request's
   * own warnings live on its `RequestExecutionResult`. Absent when there is
   * nothing to say.
   */
  warnings?: string[];
}
