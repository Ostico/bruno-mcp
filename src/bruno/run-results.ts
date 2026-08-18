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
  /**
   * Absolute path of the request file this result came from, in the same shape
   * `list_requests` and `ParseFailure.file` report, so it can be handed straight
   * back to `read_request` or named in a later run.
   *
   * Optional because a result can be produced without one — `executeRequest`
   * runs a request it was handed rather than one it discovered — but every
   * result from a collection run carries it: a run of twelve requests otherwise
   * reports twelve names and nothing locating any of them on disk.
   */
  path?: string;
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
   * out of a result, and a body and a header map are not the same thing to
   * bound. `includeResponseHeaders` is the flag for this field.
   */
  response_headers?: ResponseHeaders;
  /**
   * Set only when at least one header value in `response_headers` was cut to
   * `maxResponseHeaderBytes`. Absent means every value is the one the server
   * sent, so a caller that never asks about truncation is never misled by a
   * value that is short because of this cap rather than because of the server.
   */
  response_headers_truncated?: boolean;
  /** Present only for a gRPC request that actually reached a server. */
  grpc?: GrpcResultDetail;
  /** Present only for a WebSocket session that actually opened. */
  websocket?: WebsocketResultDetail;
  /**
   * Set for a request that never ran because `bail` stopped the run at an
   * earlier failure.
   *
   * A skipped result is neither a pass nor a failure. It is counted in
   * `CollectionRunSummary.skipped` and in neither of the other two, because
   * calling it either would be a claim about a request nothing evaluated — and
   * "passed" is the claim that made stopping early dangerous to report.
   *
   * `method` and `url` carry what the request declares rather than nothing: it
   * is what would have been sent, and it is the only thing here that helps a
   * caller decide whether to rerun this one.
   */
  skipped?: true;
  /**
   * Why it was skipped. One value today; named rather than implied so that a
   * second reason cannot arrive and silently inherit this one's meaning.
   */
  skipReason?: 'bail';
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
  /**
   * Requests that never ran because `bail` stopped the run. Absent when nothing
   * was skipped, so a run without `bail` reads exactly as it did before.
   *
   * Outside `total`, `passed` and `failed`, all three of which are about
   * requests that were evaluated. `passed + failed === total` therefore still
   * holds, and a caller checking `failed === 0` for a green run is not told a
   * truncated run passed.
   */
  skipped?: number;
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
  /** Set when the group itself failed, as opposed to a request within it. */
  error?: string;
  /**
   * Which iteration of its group this is, counting from 0, when the group was
   * run once per data row. Absent when the group ran once.
   *
   * Two iterations report as two groups, with the same `name` and different
   * `index`, because that is what they are: an iteration is a group run with one
   * row bound, so it gets its own store, cookie jar and token cache.
   */
  iterationIndex?: number;
  /**
   * The row itself is deliberately not echoed here. A row read from a
   * `dataFile` is file content, and this result already refuses to carry file
   * content for the reason `ParseFailure` gives above: a column named
   * `password` would end up in a transcript nobody meant to put it in. The
   * index addresses the row for a caller who has the data, which every caller
   * does.
   */
}

/**
 * A report file a run wrote, named so the caller can collect it.
 *
 * `bytes` is here because the whole reason a report is a file rather than part
 * of this result is its size, and a caller deciding whether to read it back
 * should not have to stat it to find out.
 */
export interface RunReportFile {
  format: 'junit' | 'html';
  /** Absolute, inside the collection. */
  path: string;
  bytes: number;
}

/**
 * Where a `bail` run stopped, and what it cost.
 *
 * Reported at run level rather than on a group because "the run stopped here"
 * is a fact about the run: every group after this one is skipped too, and a
 * caller reading only the summary would otherwise have to scan the groups to
 * discover that the run is incomplete.
 */
export interface BailInfo {
  /**
   * What kind of failure stopped it: `'request failure'` or `'test failure'`,
   * upstream's own wording.
   *
   * Upstream distinguishes five kinds — it also names assertion, pre-request
   * test and post-response test failures separately. Those three cannot be
   * produced here, and not because they are unsupported: a declared assertion
   * and a script test are already one `tests` list by the time a result exists,
   * so the phase that registered a check is not recoverable from it. Reporting
   * a guessed phase would be worse than reporting the two that are certain.
   */
  reason: 'request failure' | 'test failure';
  /** The name of the request that failed. */
  at: string;
  /** Absolute path of that request's file, when the run discovered one. */
  path?: string;
  /** `index` of the group it was in, which addresses the group in `groups`. */
  group: number;
  /** How many requests never ran because of it, across every group. */
  skipped: number;
}

export interface CollectionRunResult {
  summary: CollectionRunSummary;
  /**
   * Set only when `bail` stopped the run early. Its absence means the run
   * covered everything it was given.
   */
  bail?: BailInfo;
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
   *
   * A group has no warnings of its own. Groups are isolated by design, each
   * with its own variable store, so a note about a name no store held is only
   * true of the run: warned per group, a run of three groups said three times
   * that a name was never set, each time listing what the other two had set.
   */
  warnings?: string[];
  /**
   * Report files this run wrote, one per format asked for and written. Absent
   * when none were asked for, and absent rather than empty when every one of
   * them failed — the reason for each failure is a run-level warning.
   */
  reports?: RunReportFile[];
}
