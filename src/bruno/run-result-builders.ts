/**
 * The results a run reports for requests it never executed, and the reducer that
 * turns per-request results into a summary.
 *
 * None of it executes anything: each function takes results, or a request that
 * never became one, and answers what the caller is told. Moved out of
 * `request-executor.ts` to free `max-lines` headroom there, the same reason
 * `fetch-options.ts` was split out of it. `run-results.ts` next door holds the
 * types these return; this holds the code that builds them.
 */

import { type ParsedRequest } from './request-discovery.js';
import { type ResolvedGroup } from './run-plan.js';
import type {
  GroupRunResult,
  CollectionRunSummary,
  RequestExecutionResult,
} from './types.js';

/**
 * The result for a request that threw before it could produce one.
 *
 * `executeSingleRequest` turns a network failure into a result, so getting here
 * takes a throw from the setup around it — `rootLoader.forRequest` on a folder
 * root that will not read, or `buildDispatcher` on a malformed `settings.proxy`.
 * Rare, but one request's problem either way, so it is reported as one
 * request's result. `status: 0` matches how an SSRF refusal is already
 * reported: no response was received, rather than one that came back as zero.
 */
export function crashedRequestResult(req: ParsedRequest, reason: unknown): RequestExecutionResult {
  return {
    name: req.yaml.info.name,
    // A kind with no http block reports its kind where the method would go, and
    // no target: it never reached a URL, so claiming one would be a fiction.
    method: req.yaml.http?.method ?? (req.yaml.info.type ?? 'unknown').toUpperCase(),
    url: req.yaml.http?.url ?? '',
    status: 0,
    duration_ms: 0,
    tests: [],
    error: reason instanceof Error ? reason.message : String(reason),
  };
}

/**
 * A request `bail` stopped the run before reaching.
 *
 * Reported rather than omitted. A truncated run that simply returned fewer
 * results would be indistinguishable from a run over fewer requests, and the
 * caller's next question — which ones do I still have to run — has no answer in
 * that shape. `method` and `url` are what the request declares: what would have
 * been sent, not a claim that anything was.
 *
 * No `error`, and no test results, because neither happened.
 */
export function skippedRequestResult(req: ParsedRequest): RequestExecutionResult {
  return {
    name: req.yaml.info.name,
    method: req.yaml.http?.method ?? (req.yaml.info.type ?? 'unknown').toUpperCase(),
    url: req.yaml.http?.url ?? '',
    status: 0,
    duration_ms: 0,
    tests: [],
    skipped: true,
    skipReason: 'bail',
  };
}

/**
 * A whole group `bail` stopped the run before reaching.
 *
 * Its own resolution problems are not reported: a group with an unparseable
 * member carries `error`, and repeating that here would blame the group for a
 * defect the run stopped before it could hit. It did not run, which is the only
 * thing this says.
 */
export function skippedGroupResult(group: ResolvedGroup): GroupRunResult {
  const results = group.requests.map(skippedRequestResult);
  return {
    ...(group.name === undefined ? {} : { name: group.name }),
    index: group.index,
    // Kept, because an iteration is a group and a caller matching results back to
    // its data rows needs to know which row this skipped one stood for.
    ...(group.iterationIndex === undefined ? {} : { iterationIndex: group.iterationIndex }),
    summary: summarise(results, 0),
    results,
    ...(group.missingRequests.length > 0 ? { missingRequests: group.missingRequests } : {}),
  };
}

/**
 * Reduce per-request results to the run summary.
 *
 * Both the request-level and the test-level counts are tallied from the results
 * themselves. `passed` in particular is COUNTED, not derived as
 * `total - failed`: that subtraction made a run in which nothing was ever
 * evaluated arithmetically identical to a run in which everything passed, so a
 * dropped script or an inert feature left the summary green. `tests.total` and
 * `requestsWithoutTests` are what tell those two runs apart.
 */
export function summarise(
  results: RequestExecutionResult[],
  durationMs: number,
): CollectionRunSummary {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const tests = { total: 0, passed: 0, failed: 0 };
  let requestsWithoutTests = 0;

  for (const r of results) {
    // Counted apart from both, and before either. A skipped request registers no
    // test and carries no error, so falling through would make it `passed` and
    // would also inflate `requestsWithoutTests` — the field whose whole job is
    // to say "this ran and verified nothing".
    if (r.skipped === true) {
      skipped++;
      continue;
    }
    let requestFailed = r.error !== undefined;
    for (const t of r.tests) {
      tests.total++;
      if (t.status === 'fail') {
        tests.failed++;
        requestFailed = true;
      } else {
        tests.passed++;
      }
    }
    if (r.tests.length === 0) requestsWithoutTests++;
    if (requestFailed) failed++;
    else passed++;
  }

  return {
    // Requests evaluated, which is what every consumer of this number has always
    // meant by it: `results.length` would now include the skipped ones and make
    // `passed + failed === total` stop holding.
    total: passed + failed,
    passed,
    failed,
    duration_ms: durationMs,
    tests,
    requestsWithoutTests,
    // Absent rather than 0, so a run without `bail` reports exactly the summary
    // it reported before the option existed.
    ...(skipped > 0 ? { skipped } : {}),
  };
}
