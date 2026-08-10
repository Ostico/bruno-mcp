/**
 * Report files: what the XML says, what the HTML carries, and what happens to a
 * report that cannot be written.
 *
 * The JUnit assertions are deliberately about the things a CI system reads and a
 * summary hides — the roll-up counts, the skipped testcase standing in for a
 * request that verified nothing, and the suites for work the run could not do.
 * A report that lists only what executed is the failure mode being tested for.
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderHtmlReport, renderJUnitXml, writeRunReports } from '../../../src/bruno/run-reports';
import { RequestExecutor } from '../../../src/bruno/request-executor';
import { TestRunner } from '../../../src/bruno/test-runner';
import type {
  CollectionRunResult,
  CollectionRunSummary,
  GroupRunResult,
  RequestExecutionResult,
} from '../../../src/bruno/run-results';

// `example.test` does not resolve, and what is under test is reporting.
jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
  ssrfRemediation: jest.fn().mockReturnValue(''),
}));

const COLLECTION = '/collection';
const COMPLETED_AT = new Date('2026-08-10T12:00:00.000Z');

const summary = (over: Partial<CollectionRunSummary> = {}): CollectionRunSummary => ({
  total: 1,
  passed: 0,
  failed: 1,
  duration_ms: 120,
  tests: { total: 2, passed: 1, failed: 1 },
  requestsWithoutTests: 0,
  ...over,
});

const request = (over: Partial<RequestExecutionResult> = {}): RequestExecutionResult => ({
  name: 'alpha',
  path: `${COLLECTION}/api/alpha.bru`,
  method: 'GET',
  url: 'https://example.test/a',
  status: 200,
  duration_ms: 120,
  tests: [
    { description: 'status is 200', status: 'pass' },
    { description: 'body has an id', status: 'fail', error: 'expected undefined to equal 1' },
  ],
  ...over,
});

const group = (over: Partial<GroupRunResult> = {}): GroupRunResult => ({
  index: 0,
  summary: summary(),
  results: [request()],
  ...over,
});

const runResult = (over: Partial<CollectionRunResult> = {}): CollectionRunResult => ({
  summary: summary(),
  groups: [group()],
  parseErrors: 0,
  parseFailures: [],
  ...over,
});

const junit = (over: Partial<CollectionRunResult> = {}): string =>
  renderJUnitXml(runResult(over), COLLECTION, COMPLETED_AT);

describe('JUnit XML', () => {
  it('reports one suite per request, named and located by its file', () => {
    const xml = junit();

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<testsuite name="alpha" file="api/alpha.bru" ');
    // Duration in seconds, and each testcase an equal share of the request.
    expect(xml).toContain('time="0.120">');
    expect(xml).toContain(
      '<testcase name="status is 200" classname="api/alpha" status="pass" time="0.060" />',
    );
  });

  it('carries a failing test as a failure element and counts it on both levels', () => {
    const xml = junit();

    expect(xml).toContain(
      '<failure type="failure" message="expected undefined to equal 1" />',
    );
    expect(xml).toContain('<testsuites tests="2" failures="1" errors="0" skipped="0" time="0.120">');
    expect(xml).toContain('tests="2" failures="1" errors="0" skipped="0"');
  });

  it('reports an errored request as one suite error, whatever its tests say', () => {
    const xml = junit({
      groups: [group({ results: [request({ error: 'connect ECONNREFUSED', status: 0 })] })],
    });

    expect(xml).toContain('<testcase name="Request completes" classname="api/alpha" status="fail"');
    expect(xml).toContain('<error type="error" message="connect ECONNREFUSED" />');
    expect(xml).toContain('errors="1"');
    // The tests it did register are not also reported: upstream reports the
    // error instead of them, and a request that failed to complete has not
    // verified anything.
    expect(xml).not.toContain('status is 200');
  });

  it('gives a request that verified nothing one skipped testcase, not an empty suite', () => {
    const xml = junit({ groups: [group({ results: [request({ tests: [] })] })] });

    expect(xml).toContain('<testcase name="No checks registered" classname="api/alpha" status="skipped"');
    expect(xml).toContain('<skipped type="skipped" message="The request ran and nothing was verified');
    expect(xml).toContain('<testsuites tests="1" failures="0" errors="0" skipped="1"');
    // The reading this exists to prevent: a suite with no testcases at all,
    // which every CI summary renders as a pass.
    expect(xml).not.toContain('tests="0"');
  });

  it('gives a request file that would not parse a suite of its own', () => {
    const xml = junit({
      parseErrors: 1,
      parseFailures: [{ file: `${COLLECTION}/api/broken.bru`, message: 'Line 4: expected a block' }],
    });

    expect(xml).toContain('<testsuite name="api/broken.bru" file="api/broken.bru" ');
    expect(xml).toContain(
      '<testcase name="Request file parses" classname="api/broken" status="fail"',
    );
    expect(xml).toContain('<error type="error" message="Line 4: expected a block" />');
  });

  it('gives a named request that resolved to nothing a skipped suite', () => {
    const xml = junit({ groups: [group({ missingRequests: ['api/gone.bru'] })] });

    expect(xml).toContain('<testcase name="Request exists" classname="api/gone" status="skipped"');
    expect(xml).toContain('message="No request matched &quot;api/gone.bru&quot;" />');
  });

  it('gives a group that crashed a suite, so it cannot vanish from the report', () => {
    const xml = junit({
      groups: [group({ name: 'alice', results: [], error: 'Environment "staging" not found' })],
    });

    expect(xml).toContain('<testsuite name="alice: group" ');
    expect(xml).toContain('<error type="error" message="Environment &quot;staging&quot; not found" />');
    expect(xml).toContain('errors="1"');
  });

  it('folds a named group into the suite name and leaves an unnamed one alone', () => {
    expect(junit({ groups: [group({ name: 'alice' })] })).toContain('<testsuite name="alice: alpha" ');
    expect(junit()).toContain('<testsuite name="alpha" ');
  });

  it('escapes XML metacharacters and drops characters XML cannot carry', () => {
    const xml = junit({
      groups: [group({
        results: [request({
          tests: [{
            description: 'a & b < c "quoted"',
            status: 'fail',
            // A NUL and an ANSI escape are both illegal in XML 1.0, and either
            // one makes the whole file unparseable by the consumer it was
            // written for. A tab is legal and is escaped rather than dropped.
            error: 'saw \u001B[31mred\u001B[0m\u0000\there',
          }],
        })],
      })],
    });

    expect(xml).toContain('name="a &amp; b &lt; c &quot;quoted&quot;"');
    expect(xml).toContain('message="saw [31mred[0m&#9;here"');
    expect(xml).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
  });

  it('writes no hostname, unlike upstream', () => {
    expect(junit()).not.toContain('hostname');
  });

  it('reports a failing test with no message under a generic one', () => {
    // A declared assertion can fail without producing a message. A `<failure>`
    // with no `message` attribute is what several CI readers render as a blank
    // row, so the element always carries one.
    const xml = junit({
      groups: [group({
        results: [request({ tests: [{ description: 'body has an id', status: 'fail' }] })],
      })],
    });

    expect(xml).toContain('<failure type="failure" message="Assertion failed" />');
  });

  it('locates a request with no known file by its name alone', () => {
    const xml = junit({ groups: [group({ results: [request({ path: undefined })] })] });

    expect(xml).toContain('<testsuite name="alpha" tests=');
    expect(xml).not.toContain('file=');
    expect(xml).toContain('classname="alpha"');
  });

  it('names an unnamed group that crashed by its index', () => {
    const xml = junit({
      groups: [group({ index: 2, results: [], error: 'Environment "staging" not found' })],
    });

    expect(xml).toContain('<testcase name="Group runs" classname="group 2"');
  });

  it('reports a run that carries no parse-failure list at all', () => {
    const xml = renderJUnitXml(
      { summary: summary(), groups: [group()] },
      COLLECTION,
      COMPLETED_AT,
    );

    expect(xml).toContain('<testsuites tests="2" failures="1" errors="0" skipped="0"');
  });

  it('names a request outside the collection by its own path', () => {
    const xml = junit({
      groups: [group({ results: [request({ path: '/elsewhere/outside.bru' })] })],
    });

    expect(xml).toContain('file="/elsewhere/outside.bru"');
    expect(xml).toContain('classname="/elsewhere/outside"');
  });
});

/** The report's payload, as the page itself decodes it. */
const htmlPayload = (html: string): {
  results: Array<{ iterationIndex: number; results: unknown[]; summary: Record<string, number> }>;
  runCompletionTime: string;
} => {
  const encoded = /decodeBase64\('([A-Za-z0-9+/=]+)'\)/.exec(html);
  expect(encoded).not.toBeNull();
  return JSON.parse(Buffer.from(encoded![1]!, 'base64').toString('utf-8'));
};

describe('HTML report', () => {
  it('renders a page carrying the whole run in its own payload', () => {
    const html = renderHtmlReport(runResult(), COLLECTION, COMPLETED_AT);

    expect(html).toContain('<html');
    // The DATA is embedded; the renderer is not. Upstream's template loads Vue
    // and naive-ui from unpkg.com, so the page needs network when it is OPENED.
    // Asserted rather than merely documented, because a caller archiving the
    // file needs to know it renders blank offline.
    expect(html).toContain('src="https://unpkg.com/vue@3/dist/vue.global.js"');

    const payload = htmlPayload(html);
    expect(payload.runCompletionTime).toBe('2026-08-10T12:00:00.000Z');
    expect(payload.results).toHaveLength(1);
    const [iteration] = payload.results;
    expect(iteration!.results).toHaveLength(1);
    expect(iteration!.results[0]).toMatchObject({
      name: 'alpha',
      path: 'api/alpha.bru',
      response: { status: 200, responseTime: 120 },
      runDuration: 0.12,
    });
    expect(iteration!.summary).toMatchObject({ totalTests: 2, passedTests: 1, failedTests: 1 });
  });

  it('maps each execution group to its own iteration, with its own summary', () => {
    const html = renderHtmlReport(
      runResult({
        groups: [
          group({ name: 'alice', index: 0 }),
          group({ name: 'bob', index: 1, results: [request({ tests: [] })] }),
        ],
      }),
      COLLECTION,
      COMPLETED_AT,
    );

    const payload = htmlPayload(html);
    expect(payload.results.map((iteration) => iteration.iterationIndex)).toEqual([0, 1]);
    expect(payload.results[0]!.summary.totalTests).toBe(2);
    expect(payload.results[1]!.summary.totalTests).toBe(0);
  });

  it('appends the files that never ran, so the page is not a green subset', () => {
    const html = renderHtmlReport(
      runResult({
        groups: [group({ missingRequests: ['api/gone.bru'] })],
        parseErrors: 1,
        parseFailures: [{ file: `${COLLECTION}/api/broken.bru`, message: 'Line 4: expected a block' }],
      }),
      COLLECTION,
      COMPLETED_AT,
    );

    const payload = htmlPayload(html);
    expect(payload.results).toHaveLength(2);
    expect(payload.results[0]!.results[1]).toMatchObject({
      name: 'api/gone.bru',
      skipped: true,
      skipReason: 'No request matched "api/gone.bru"',
    });
    expect(payload.results[1]!.results[0]).toMatchObject({
      name: 'api/broken.bru',
      skipped: true,
      skipReason: 'Line 4: expected a block',
    });
    expect(payload.results[1]!.summary.skippedRequests).toBe(1);
  });

  it('marks an errored request as errored and names it by what it has', () => {
    // No response body, no file path, and an error instead of a status: the
    // shape a connection failure produces. Upstream reads `status: 'error'` to
    // count it as an error rather than a silent pass.
    const html = renderHtmlReport(
      {
        summary: summary(),
        groups: [group({
          results: [request({
            path: undefined,
            status: 0,
            error: 'connect ECONNREFUSED',
            tests: [],
          })],
        })],
      },
      COLLECTION,
      COMPLETED_AT,
    );

    const payload = htmlPayload(html);
    expect(payload.results[0]!.results[0]).toMatchObject({
      name: 'alpha',
      path: 'alpha',
      status: 'error',
      error: 'connect ECONNREFUSED',
      response: { data: null },
    });
    expect(payload.results[0]!.summary.errorRequests).toBe(1);
  });

  it('leans on upstream masking for sensitive header names', () => {
    // The report holds what the result holds, and upstream's own generator
    // masks a header whose NAME is sensitive outright — so `set-cookie`, which
    // reaches here as a list with the cookie values already withheld, ends up
    // masked whole. Nothing else is masked: see `run-reports.ts` for why the
    // caller's run variables are not fed to that matcher.
    const html = renderHtmlReport(
      runResult({
        groups: [group({
          results: [request({
            response_body: '{"id":1}',
            response_headers: {
              'content-type': 'application/json',
              'set-cookie': ['sid=*****; Path=/; HttpOnly', 'csrf=*****; Path=/'],
            },
          })],
        })],
      }),
      COLLECTION,
      COMPLETED_AT,
    );

    const payload = htmlPayload(html);
    expect(payload.results[0]!.results[0]).toMatchObject({
      response: {
        data: '{"id":1}',
        headers: {
          'content-type': 'application/json',
          'set-cookie': '********',
        },
      },
    });
  });
});

describe('writing report files', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'reports-'));
  });

  it('writes each format asked for, creating directories inside the collection', async () => {
    const written = await writeRunReports(
      runResult(),
      root,
      { junit: 'reports/junit.xml', html: 'reports/run.html' },
      COMPLETED_AT,
    );

    expect(written.warnings).toEqual([]);
    expect(written.files).toEqual([
      { format: 'junit', path: join(root, 'reports', 'junit.xml'), bytes: expect.any(Number) },
      { format: 'html', path: join(root, 'reports', 'run.html'), bytes: expect.any(Number) },
    ]);

    const xml = await readFile(join(root, 'reports', 'junit.xml'), 'utf-8');
    expect(xml).toContain('<testsuite name="alpha"');
    // The size reported is the size on disk, since deciding whether to read the
    // file back is the only reason to report it.
    expect(Buffer.byteLength(xml, 'utf-8')).toBe(written.files[0]!.bytes);
    const html = await readFile(join(root, 'reports', 'run.html'), 'utf-8');
    expect(html).toContain('<html');
  });

  it('writes only the format asked for', async () => {
    const written = await writeRunReports(runResult(), root, { html: 'run.html' }, COMPLETED_AT);

    expect(written.files.map((file) => file.format)).toEqual(['html']);
  });

  it('refuses a path outside the collection and says so', async () => {
    // The collection is one level down, so the escape target is still inside
    // this test's own temporary directory and can be proven absent. Asserting
    // against the system temp directory itself would be asserting about state
    // every other run on the machine shares.
    const collection = join(root, 'collection');
    await mkdir(collection);

    const written = await writeRunReports(
      runResult(),
      collection,
      { junit: '../escaped.xml' },
      COMPLETED_AT,
    );

    expect(written.files).toEqual([]);
    expect(written.warnings).toHaveLength(1);
    expect(written.warnings[0]).toContain('../escaped.xml');
    expect(written.warnings[0]).toContain('must stay inside it');
    await expect(readFile(join(root, 'escaped.xml'), 'utf-8')).rejects.toThrow();
  });

  it('refuses an absolute path outside the collection too', async () => {
    const collection = join(root, 'collection');
    await mkdir(collection);
    const outside = join(root, 'absolute.xml');

    const written = await writeRunReports(runResult(), collection, { junit: outside }, COMPLETED_AT);

    expect(written.files).toEqual([]);
    expect(written.warnings[0]).toContain(outside);
    await expect(readFile(outside, 'utf-8')).rejects.toThrow();
  });

  it('accepts an absolute path inside the collection', async () => {
    const written = await writeRunReports(
      runResult(),
      root,
      { junit: join(root, 'nested', 'junit.xml') },
      COMPLETED_AT,
    );

    expect(written.warnings).toEqual([]);
    expect(written.files[0]!.path).toBe(join(root, 'nested', 'junit.xml'));
  });

  it('turns a write that cannot happen into a warning, not a throw', async () => {
    // A file where a directory would have to be: the write fails inside the
    // collection, with the path already accepted.
    await writeFile(join(root, 'reports'), 'not a directory');

    const written = await writeRunReports(
      runResult(),
      root,
      { junit: 'reports/junit.xml' },
      COMPLETED_AT,
    );

    expect(written.files).toEqual([]);
    expect(written.warnings[0]).toContain('junit report was not written');
    expect(written.warnings[0]).toContain(join(root, 'reports', 'junit.xml'));
  });

  it('overwrites a report from a previous run', async () => {
    await mkdir(join(root, 'reports'));
    await writeFile(join(root, 'reports', 'junit.xml'), 'stale');

    await writeRunReports(runResult(), root, { junit: 'reports/junit.xml' }, COMPLETED_AT);

    expect(await readFile(join(root, 'reports', 'junit.xml'), 'utf-8')).toContain('<testsuites');
  });
});

describe('a run that asks for reports', () => {
  let root: string;
  // The collection sits one level below the temporary root so that a refused
  // path resolves inside this test's own tree rather than the shared system
  // temporary directory.
  let collection: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'report-run-'));
    collection = join(root, 'collection');
    await mkdir(collection);
    await writeFile(
      join(collection, 'alpha.bru'),
      'meta {\n  name: alpha\n  type: http\n  seq: 1\n}\n\nget {\n  url: https://example.test/a\n}\n\n'
      + 'assert {\n  res.status: eq 200\n}\n',
    );
    global.fetch = jest.fn().mockResolvedValue(
      new Response('{"id":1}', { status: 200, headers: { 'content-type': 'application/json' } }),
    ) as never;
  });

  it('writes the files and names them on the result', async () => {
    const result = await RequestExecutor.executeCollection(collection, {
      scriptRunner: TestRunner,
      report: { junit: 'junit.xml', html: 'run.html' },
    });

    expect(result.warnings ?? []).toEqual([]);
    expect(result.reports).toEqual([
      { format: 'junit', path: join(collection, 'junit.xml'), bytes: expect.any(Number) },
      { format: 'html', path: join(collection, 'run.html'), bytes: expect.any(Number) },
    ]);

    const xml = await readFile(join(collection, 'junit.xml'), 'utf-8');
    expect(xml).toContain('<testsuite name="alpha" file="alpha.bru"');
    expect(xml).toContain('status="pass"');
    expect(xml).toContain('<testsuites tests="1" failures="0" errors="0" skipped="0"');
  });

  it('records the request file on every result, report or no report', async () => {
    const result = await RequestExecutor.executeCollection(collection, { scriptRunner: TestRunner });

    expect(result.reports).toBeUndefined();
    expect(result.groups[0]!.results[0]!.path).toBe(join(collection, 'alpha.bru'));
  });

  it('keeps the results when a report cannot be written', async () => {
    const result = await RequestExecutor.executeCollection(collection, {
      scriptRunner: TestRunner,
      report: { junit: '../escaped.xml' },
    });

    expect(result.summary.passed).toBe(1);
    expect(result.reports).toBeUndefined();
    expect(result.warnings?.[0]).toContain('junit report was not written');
    await expect(readFile(join(root, 'escaped.xml'), 'utf-8')).rejects.toThrow();
  });
});
