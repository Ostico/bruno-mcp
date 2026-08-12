/**
 * Run reports on disk: JUnit XML for a CI system, HTML for a person.
 *
 * Both exist because a run result is JSON in a tool result, and neither of those
 * two consumers reads that. A CI system collects a file at the path its pipeline
 * configuration names; a person wants the HTML page upstream already renders,
 * which is around 30 KB and has no business inline in a tool result. So the
 * contract is: the caller names a file, this writes it, and the run result
 * reports the path and the size.
 *
 * One thing to know about that HTML: the run's data is embedded in the file, but
 * the renderer is not. Upstream's template loads Vue and naive-ui from
 * unpkg.com, so the page needs network access when it is OPENED and shows
 * nothing offline. That is upstream's own reporter, unmodified — inlining those
 * two libraries would mean fetching them at write time, which is a worse thing
 * for this server to do — but it is a property worth stating rather than
 * discovering from a blank page in an air-gapped pipeline.
 *
 * Confinement is deliberate. A report path is resolved against the collection
 * and must stay inside it. The alternative — an arbitrary caller-named path —
 * would turn this server into a general file-write primitive, which is a far
 * larger authorization than "run these requests". A pipeline that needs the file
 * somewhere else copies it. A report that cannot be written is a warning on the
 * run and never a thrown error: the results are the product and the file is a
 * by-product of them.
 *
 * A report holds exactly what the run result holds. Response headers arrive
 * already masked (see `response-headers.ts`); the HTML path masks sensitive
 * header NAMES again on its way through upstream's generator, and nothing else
 * is masked anywhere. `walkAndMask` also takes a list of secret VALUES, and the
 * only values we hold are the caller's run variables — which are ordinary
 * variables as often as they are secrets, with no length floor in that matcher,
 * so a run with `user: 1` would have every "1" in the report replaced. Feeding
 * it those would corrupt the artifact to hide data the caller already gets back
 * inline.
 *
 * Two fidelity limits, both from the result shape rather than from the writers:
 * the HTML report's request pane is empty because a result does not retain the
 * request as sent, and every check lands in its `testResults` list because our
 * `TestResult` merges declared assertions with script tests. Neither costs
 * anything in JUnit, whose schema has no slot for either distinction.
 */

import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';

import { generateHtmlReport, getRunnerSummary } from '@usebruno/common/runner';

import { writeFileAtomic } from './atomic-write.js';
import { validatePath } from './path-validator.js';
import type { RunReportRequest } from './execution-options.js';
import type {
  CollectionRunResult,
  GroupRunResult,
  RequestExecutionResult,
  RunReportFile,
} from './run-results.js';

/** What a run report writer produces, alongside the files it managed to write. */
export interface WrittenReports {
  files: RunReportFile[];
  /** One per format that was asked for and could not be written, naming why. */
  warnings: string[];
}

/**
 * Write the reports the caller asked for, and report what happened.
 *
 * Never throws. A refused path, an unwritable directory or a full disk becomes a
 * warning naming the format and the reason, so a run whose requests all passed
 * is not reported as a failure because a by-product could not be saved.
 */
export async function writeRunReports(
  result: CollectionRunResult,
  collectionPath: string,
  request: RunReportRequest,
  completedAt: Date,
): Promise<WrittenReports> {
  const written: WrittenReports = { files: [], warnings: [] };

  const requested: Array<{ format: RunReportFile['format']; target: string; render: () => string }> = [
    ...(request.junit !== undefined
      ? [{
        format: 'junit' as const,
        target: request.junit,
        render: () => renderJUnitXml(result, collectionPath, completedAt),
      }]
      : []),
    ...(request.html !== undefined
      ? [{
        format: 'html' as const,
        target: request.html,
        render: () => renderHtmlReport(result, collectionPath, completedAt),
      }]
      : []),
  ];

  for (const { format, target, render } of requested) {
    const resolved = path.isAbsolute(target) ? target : path.resolve(collectionPath, target);
    const check = validatePath(resolved, collectionPath);
    if (!check.valid) {
      written.warnings.push(
        `The ${format} report was not written: "${target}" ${check.reason?.toLowerCase() ?? 'is not an allowed path'}. `
        + 'A report path is resolved against the collection and must stay inside it.',
      );
      continue;
    }

    try {
      const content = render();
      // The caller names a file, not a directory that has to exist first. Only
      // ever inside the collection, which containment above has established.
      await mkdir(path.dirname(check.resolved), { recursive: true });
      await writeFileAtomic(check.resolved, content);
      written.files.push({
        format,
        path: check.resolved,
        bytes: Buffer.byteLength(content, 'utf-8'),
      });
    } catch (error) {
      written.warnings.push(
        `The ${format} report was not written to ${check.resolved}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return written;
}

// ---------------------------------------------------------------------------
// JUnit XML
// ---------------------------------------------------------------------------

/** One `<testcase>`, in the shape the serializer needs and nothing more. */
interface JUnitCase {
  name: string;
  classname: string;
  status: 'pass' | 'fail' | 'skipped';
  seconds: number;
  /** Rendered as `<failure>`, `<error>` or `<skipped>` according to `outcome`. */
  outcome?: { element: 'failure' | 'error' | 'skipped'; message: string };
}

/** One `<testsuite>`. */
interface JUnitSuite {
  name: string;
  /** Collection-relative request path, absent for a suite with no file behind it. */
  file?: string;
  seconds: number;
  cases: JUnitCase[];
}

/**
 * Render the run as JUnit XML.
 *
 * Follows upstream's reporter (`bruno-cli/src/reporters/junit.js`): one
 * `<testsuite>` per request rather than per folder, `file` the request path,
 * `classname` that path without its extension, suite `time` the request
 * duration in seconds and each `testcase` an equal share of it.
 *
 * Four deliberate divergences, each because the shape upstream has no concept
 * of would otherwise vanish from the artifact a pipeline keeps:
 *
 *  - **A request that registered no checks** gets one skipped `testcase` saying
 *    so, rather than an empty suite. An empty suite is invisible in every CI
 *    summary, which is precisely the "ran green, verified nothing" reading that
 *    `requestsWithoutTests` exists to prevent.
 *  - **A group that crashed, a request file that would not parse, and a named
 *    request that resolved to nothing** each get a suite of their own. They are
 *    real outcomes of the run, and a report that lists only what executed says
 *    a subset ran without saying that it was a subset.
 *  - **A named group's label is folded into the suite name.** There is no group
 *    concept in the schema, so two groups running the same request would
 *    otherwise produce two indistinguishable suites.
 *  - **No `hostname` attribute.** Upstream writes `os.hostname()` into the file;
 *    here the writer is a server acting for an agent, and the report is meant to
 *    be committed, so the machine name is a leak with no consumer.
 */
export function renderJUnitXml(
  result: CollectionRunResult,
  collectionPath: string,
  completedAt: Date,
): string {
  const suites: JUnitSuite[] = [
    ...result.groups.flatMap((group) => groupSuites(group, collectionPath)),
    // Discovered and skipped, so they never reached a group.
    ...(result.parseFailures ?? []).map((failure) => ({
      name: reportPath(failure.file, collectionPath),
      file: reportPath(failure.file, collectionPath),
      seconds: 0,
      cases: [{
        name: 'Request file parses',
        classname: stripExtension(reportPath(failure.file, collectionPath)),
        status: 'fail' as const,
        seconds: 0,
        outcome: { element: 'error' as const, message: failure.message },
      }],
    })),
  ];

  const total = suites.reduce((sum, suite) => sum + suite.cases.length, 0);
  const failures = countCases(suites, 'failure');
  const errors = countCases(suites, 'error');
  const skipped = countCases(suites, 'skipped');
  const seconds = (result.summary.duration_ms / 1000).toFixed(3);
  const timestamp = completedAt.toISOString().split('Z')[0]!;

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites tests="${total}" failures="${failures}" errors="${errors}" `
    + `skipped="${skipped}" time="${seconds}">`,
  ];
  for (const suite of suites) {
    lines.push(
      `  <testsuite name="${attr(suite.name)}"${suite.file === undefined ? '' : ` file="${attr(suite.file)}"`} `
      + `tests="${suite.cases.length}" failures="${suiteCount(suite, 'failure')}" `
      + `errors="${suiteCount(suite, 'error')}" skipped="${suiteCount(suite, 'skipped')}" `
      + `timestamp="${attr(timestamp)}" time="${suite.seconds.toFixed(3)}">`,
    );
    for (const testcase of suite.cases) {
      const open = `    <testcase name="${attr(testcase.name)}" classname="${attr(testcase.classname)}" `
        + `status="${testcase.status}" time="${testcase.seconds.toFixed(3)}"`;
      if (testcase.outcome === undefined) {
        lines.push(`${open} />`);
        continue;
      }
      lines.push(`${open}>`);
      lines.push(
        `      <${testcase.outcome.element} type="${testcase.outcome.element}" `
        + `message="${attr(testcase.outcome.message)}" />`,
      );
      lines.push('    </testcase>');
    }
    lines.push('  </testsuite>');
  }
  lines.push('</testsuites>');
  return `${lines.join('\n')}\n`;
}

/** Every suite one group contributes: its results, then what it could not do. */
function groupSuites(group: GroupRunResult, collectionPath: string): JUnitSuite[] {
  // The iteration is part of the label rather than left to `index`, because a
  // JUnit consumer addresses a suite by name: 200 rows of one group would
  // otherwise contribute 200 suites with one name, which every dashboard that
  // tracks a test over time reads as the same suite reported repeatedly.
  const parts = [
    ...(group.name === undefined ? [] : [group.name]),
    ...(group.iterationIndex === undefined ? [] : [`row ${group.iterationIndex}`]),
  ];
  const label = parts.length === 0 ? '' : `${parts.join(' ')}: `;

  const suites: JUnitSuite[] = group.results.map((request) => {
    const file = request.path === undefined ? undefined : reportPath(request.path, collectionPath);
    const classname = file === undefined ? request.name : stripExtension(file);
    const seconds = request.duration_ms / 1000;
    return {
      name: `${label}${request.name}`,
      ...(file === undefined ? {} : { file }),
      seconds,
      cases: requestCases(request, classname, seconds),
    };
  });

  // A group that failed before its first request ran contributes no results at
  // all, and the run summary counts it as one failure. Reported the same way
  // here so the two cannot disagree.
  if (group.error !== undefined) {
    suites.push({
      name: `${label}group`,
      seconds: 0,
      cases: [{
        name: 'Group runs',
        classname: group.name ?? `group ${group.index}`,
        status: 'fail',
        seconds: 0,
        outcome: { element: 'error', message: group.error },
      }],
    });
  }

  for (const missing of group.missingRequests ?? []) {
    suites.push({
      name: `${label}${missing}`,
      seconds: 0,
      cases: [{
        name: 'Request exists',
        classname: stripExtension(missing),
        status: 'skipped',
        seconds: 0,
        outcome: { element: 'skipped', message: `No request matched "${missing}"` },
      }],
    });
  }

  return suites;
}

/** One request's testcases: its checks, or a skip standing in for having none. */
function requestCases(
  request: RequestExecutionResult,
  classname: string,
  seconds: number,
): JUnitCase[] {
  if (request.error !== undefined) {
    // Matches upstream: an errored request reports one testcase carrying the
    // error, whatever its scripts managed to register before the failure.
    return [{
      name: 'Request completes',
      classname,
      status: 'fail',
      seconds,
      outcome: { element: 'error', message: request.error },
    }];
  }

  if (request.tests.length === 0) {
    return [{
      name: 'No checks registered',
      classname,
      status: 'skipped',
      seconds,
      outcome: {
        element: 'skipped',
        message: 'The request ran and nothing was verified: it declares no assertions and no test script',
      },
    }];
  }

  const share = seconds / request.tests.length;
  return request.tests.map((test) => ({
    name: test.description,
    classname,
    status: test.status,
    seconds: share,
    ...(test.status === 'fail'
      ? {
        outcome: {
          element: 'failure' as const,
          message: test.error ?? 'Assertion failed',
        },
      }
      : {}),
  }));
}

function countCases(suites: JUnitSuite[], element: 'failure' | 'error' | 'skipped'): number {
  return suites.reduce((sum, suite) => sum + suiteCount(suite, element), 0);
}

function suiteCount(suite: JUnitSuite, element: 'failure' | 'error' | 'skipped'): number {
  return suite.cases.filter((testcase) => testcase.outcome?.element === element).length;
}

/**
 * Escape a string for use as an XML attribute value.
 *
 * The control-character strip is not cosmetic: a response error message can
 * carry a NUL or an ANSI escape, both illegal in XML 1.0, and one of them makes
 * the whole report unparseable by every consumer it was written for. Tab,
 * newline and carriage return are the three control characters XML allows and
 * are escaped rather than dropped, since a multi-line assertion message is
 * ordinary.
 */
function attr(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;');
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/**
 * The subset of upstream's `T_RunnerRequestExecutionResult` we can fill.
 *
 * Declared here rather than imported because `@usebruno/common/runner` exports
 * its three functions and none of its types; structural typing is what makes
 * this acceptable to `generateHtmlReport`, and a shape it stops accepting fails
 * the build rather than the report.
 */
interface UpstreamResult {
  iterationIndex: number;
  name: string;
  path: string;
  request: { method: string; url: string; headers: Record<string, string>; data: null };
  response: {
    status: number | string;
    statusText: string;
    headers: Record<string, string>;
    data: string | null;
    responseTime: number;
  };
  status: string | null;
  skipped?: boolean;
  skipReason?: string;
  error: string | null;
  testResults: Array<{ status: string; description: string; error?: string }>;
  runDuration: number;
}

/**
 * Render the run as upstream's HTML report.
 *
 * Execution groups map onto upstream's iterations: one `T_RunnerResults` per
 * group, in the order the caller listed them, each with its own summary
 * computed by upstream's own counter. That is the closest true correspondence —
 * both are "the same requests, run again under different inputs" — and it means
 * a two-identity run reads as two sections rather than one merged list.
 *
 * Request files that never ran are appended as one extra iteration of skipped
 * entries, for the same reason they get suites of their own in the XML.
 */
export function renderHtmlReport(
  result: CollectionRunResult,
  collectionPath: string,
  completedAt: Date,
): string {
  const iterations = result.groups.map((group, index) => {
    const results: UpstreamResult[] = [
      ...group.results.map((request) => upstreamResult(request, index, collectionPath)),
      ...(group.missingRequests ?? []).map((missing) =>
        skippedResult(missing, index, `No request matched "${missing}"`)),
    ];
    return { iterationIndex: index, results, summary: getRunnerSummary(results) };
  });

  const failures = result.parseFailures ?? [];
  if (failures.length > 0) {
    const index = iterations.length;
    const results = failures.map((failure) =>
      skippedResult(reportPath(failure.file, collectionPath), index, failure.message));
    iterations.push({ iterationIndex: index, results, summary: getRunnerSummary(results) });
  }

  return generateHtmlReport({
    runnerResults: iterations,
    environment: null,
    runCompletionTime: completedAt.toISOString(),
  });
}

function upstreamResult(
  request: RequestExecutionResult,
  iterationIndex: number,
  collectionPath: string,
): UpstreamResult {
  return {
    iterationIndex,
    name: request.name,
    path: request.path === undefined ? request.name : reportPath(request.path, collectionPath),
    // The request as sent is not retained, so the pane is empty rather than
    // reconstructed: a rebuilt request would show headers that may not be the
    // ones that went out.
    request: { method: request.method, url: request.url, headers: {}, data: null },
    response: {
      status: request.status,
      statusText: '',
      headers: flattenHeaders(request.response_headers),
      data: request.response_body ?? null,
      responseTime: request.duration_ms,
    },
    status: request.error === undefined ? null : 'error',
    error: request.error ?? null,
    // One list, because a declared assertion and a script test are already one
    // list by the time a result exists.
    testResults: request.tests.map((test) => ({
      status: test.status,
      description: test.description,
      ...(test.error === undefined ? {} : { error: test.error }),
    })),
    runDuration: request.duration_ms / 1000,
  };
}

function skippedResult(name: string, iterationIndex: number, reason: string): UpstreamResult {
  return {
    iterationIndex,
    name,
    path: name,
    request: { method: '', url: '', headers: {}, data: null },
    response: { status: '', statusText: '', headers: {}, data: null, responseTime: 0 },
    status: 'skipped',
    skipped: true,
    skipReason: reason,
    error: null,
    testResults: [],
    runDuration: 0,
  };
}

/**
 * Response headers as the flat record upstream's template reads.
 *
 * `set-cookie` is a list here — one entry per cookie, attributes kept, value
 * withheld — and joining it with a comma is what an HTTP consumer does with
 * repeated headers anyway.
 */
function flattenHeaders(headers?: Record<string, string | string[]>): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    flat[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return flat;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * A request path as a report should name it: relative to the collection, with
 * forward slashes so the same run reads the same way on either platform.
 *
 * A path outside the collection is reported as it is. `path.relative` would
 * express it as a climb out of the collection, which is neither shorter nor
 * clearer than the path itself.
 */
function reportPath(filePath: string, collectionPath: string): string {
  const relative = path.relative(collectionPath, filePath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return filePath;
  }
  return relative.split(path.sep).join('/');
}

/** Drop a final extension, as upstream's `classname` does. */
function stripExtension(filePath: string): string {
  return filePath.replace(/\.[^/.]+$/, '');
}
