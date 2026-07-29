/**
 * Declared `assert` blocks, end to end through RequestExecutor.
 *
 * The regression that matters most here is a request that declares assertions
 * and NO post-response script: the sandbox used to be invoked only when a script
 * was present, so such a request reported zero assertions and looked green while
 * every declared check went unevaluated.
 *
 * Both authoring formats are covered. A .bru file spells the switched-off flag
 * with the opposite polarity (`enabled: false` rather than `disabled: true`), so
 * the translation is exercised rather than assumed.
 *
 * Mocking pattern follows tests/unit/bruno/request-executor-vars.test.ts.
 */

import { RequestExecutor } from '../../../src/bruno/request-executor';
import * as fs from 'node:fs/promises';

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

jest.mock('node:fs/promises');
const mockedFs = jest.mocked(fs);

jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** .yml request with assertions and no script whatsoever. */
const YAML_ASSERT_ONLY = `
info:
  name: Assert Only
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/widgets/7"
assert:
  - name: res.status
    value: eq 200
  - name: res.body.name
    value: eq widget
  - name: res.body.id
    value: eq 999
`;

/** .yml request whose assertions sit alongside a post-response script. */
const YAML_ASSERT_AND_SCRIPT = `
info:
  name: Assert And Script
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/widgets/7"
assert:
  - name: res.status
    value: eq 200
runtime:
  scripts:
    - type: after-response
      code: |
        test("script also ran", function() {
          expect(res.getStatus()).to.equal(200);
        });
`;

/** .yml request with a disabled assertion between two enabled ones. */
const YAML_DISABLED_ASSERT = `
info:
  name: Disabled Assert
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/widgets/7"
assert:
  - name: res.status
    value: eq 200
  - name: res.body.name
    value: eq never-evaluated
    disabled: true
  - name: res.body.id
    value: eq 7
`;

/** .yml request exercising the non-trivial operand kinds. */
const YAML_RICH_OPERATORS = `
info:
  name: Rich Operators
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/widgets/7"
assert:
  - name: res.status
    value: between 200, 299
  - name: res.status
    value: in 200, 201
  - name: res.body.name
    value: matches ^wid
  - name: res.body.id
    value: isDefined
  - name: res.body.items
    value: length 3
`;

/** .bru request with an assertions block and no script. */
const BRU_ASSERT_ONLY = `meta {
  name: Bru Assert
  type: http
  seq: 1
}

get {
  url: https://api.example.com/widgets/7
}

assert {
  res.status: eq 200
  res.body.name: eq widget
  ~res.body.id: eq 999
}
`;

const WIDGET_BODY = { id: 7, name: 'widget', items: [1, 2, 3] };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockResponse(
  body: unknown,
  status = 200,
  statusText = 'OK',
  contentType = 'application/json',
): Response {
  const headers = new Headers({ 'content-type': contentType });
  return {
    status,
    statusText,
    headers,
    text: jest
      .fn()
      .mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
    ok: status >= 200 && status < 300,
  } as unknown as Response;
}

function setupFsReaddir(files: string[]): void {
  mockedFs.readdir.mockImplementation(async (dirPath: any) => {
    const p = typeof dirPath === 'string' ? dirPath : dirPath.toString();
    if (p === '/test-collection') {
      return files.map(f => ({
        name: f,
        isFile: () => true,
        isDirectory: () => false,
      })) as any;
    }
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
}

function setupFsReadFile(fileMap: Record<string, string>): void {
  mockedFs.readFile.mockImplementation(async (filePath: any) => {
    const p = typeof filePath === 'string' ? filePath : filePath.toString();
    for (const [key, value] of Object.entries(fileMap)) {
      if (p.endsWith(key) || p === key) {
        return value;
      }
    }
    const err = new Error(`ENOENT: no such file - ${p}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
}

function setupFsStat(existingPaths: string[]): void {
  mockedFs.stat.mockImplementation(async (filePath: any) => {
    const p = typeof filePath === 'string' ? filePath : filePath.toString();
    for (const existing of existingPaths) {
      if (p.endsWith(existing) || p === existing) {
        return { isDirectory: () => true, isFile: () => false } as any;
      }
    }
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
}

/** Run a single-request collection and return that request's result. */
async function runOne(fileName: string, source: string, body: unknown = WIDGET_BODY) {
  setupFsReaddir([fileName]);
  setupFsReadFile({ [fileName]: source });
  setupFsStat(['/test-collection']);
  mockFetch.mockResolvedValue(createMockResponse(body));

  const result = await RequestExecutor.executeCollection('/test-collection', {});
  return result.results[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RequestExecutor — declared assertions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('evaluates a .yml request assertions when it has no script at all', async () => {
    const request = await runOne('Assert Only.yml', YAML_ASSERT_ONLY);

    expect(request.tests.map(t => [t.description, t.status])).toEqual([
      ['res.status eq 200', 'pass'],
      ['res.body.name eq widget', 'pass'],
      ['res.body.id eq 999', 'fail'],
    ]);
  });

  it('counts a request as failed on a failing assertion alone', async () => {
    setupFsReaddir(['Assert Only.yml']);
    setupFsReadFile({ 'Assert Only.yml': YAML_ASSERT_ONLY });
    setupFsStat(['/test-collection']);
    mockFetch.mockResolvedValue(createMockResponse(WIDGET_BODY));

    const result = await RequestExecutor.executeCollection('/test-collection', {});

    // The request itself returned 200 with no script error, so before assertions
    // were evaluated this collection reported green.
    expect(result.summary.total).toBe(1);
    expect(result.summary.failed).toBe(1);
  });

  it('reports assertions and the post-response script together', async () => {
    const request = await runOne('Assert And Script.yml', YAML_ASSERT_AND_SCRIPT);

    // Bruno's order: the post-response script finishes, then assertions run.
    expect(request.tests.map(t => t.description)).toEqual([
      'script also ran',
      'res.status eq 200',
    ]);
    expect(request.tests.every(t => t.status === 'pass')).toBe(true);
  });

  it('neither evaluates nor reports a disabled assertion', async () => {
    const request = await runOne('Disabled Assert.yml', YAML_DISABLED_ASSERT);

    expect(request.tests.map(t => t.description)).toEqual([
      'res.status eq 200',
      'res.body.id eq 7',
    ]);
    expect(request.tests.every(t => t.status === 'pass')).toBe(true);
  });

  it('walks the non-trivial operand kinds end to end', async () => {
    const request = await runOne('Rich Operators.yml', YAML_RICH_OPERATORS);

    expect(request.tests).toHaveLength(5);
    expect(request.tests.filter(t => t.status !== 'pass')).toEqual([]);
  });

  it('evaluates a .bru request assertions block', async () => {
    const request = await runOne('Bru Assert.bru', BRU_ASSERT_ONLY);

    // The third entry is prefixed `~` in the .bru file — disabled — so it must
    // be absent rather than reported as a failure.
    expect(request.tests.map(t => [t.description, t.status])).toEqual([
      ['res.status eq 200', 'pass'],
      ['res.body.name eq widget', 'pass'],
    ]);
  });

  it('reports a failing .bru assertion', async () => {
    const request = await runOne('Bru Assert.bru', BRU_ASSERT_ONLY, {
      id: 7,
      name: 'gadget',
    });

    expect(request.tests[1].status).toBe('fail');
    expect(request.tests[1].error).toMatch(/to equal/);
  });

  it('leaves a request with no assertions and no script reporting nothing', async () => {
    const request = await runOne(
      'Plain.yml',
      `
info:
  name: Plain
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/ping"
`,
    );

    expect(request.tests).toEqual([]);
  });

  it('fails only the malformed assertion, leaving the others and the script reported', async () => {
    const request = await runOne(
      'Mixed.yml',
      `
info:
  name: Mixed
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/widgets/7"
assert:
  - name: res.status
    value: eq 200
  - name: "res.status ==="
    value: eq 200
  - name: res.body.id
    value: eq 7
runtime:
  scripts:
    - type: after-response
      code: |
        test("script still ran", function() {
          expect(res.getStatus()).to.equal(200);
        });
`,
    );

    // Script first, then the assertions in declaration order — the malformed one
    // fails in place without displacing or discarding its neighbours.
    expect(request.tests.map(t => [t.description, t.status])).toEqual([
      ['script still ran', 'pass'],
      ['res.status eq 200', 'pass'],
      ['res.status === eq 200', 'fail'],
      ['res.body.id eq 7', 'pass'],
    ]);
  });
});
