/**
 * Tests for RequestExecutor — the engine that executes Bruno YAML requests
 * via native fetch, runs test scripts, and collects structured results.
 */

import { RequestExecutor } from '../../../src/bruno/request-executor';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Mock fetch globally
// ---------------------------------------------------------------------------

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

// Mock fs/promises for reading YAML files
jest.mock('node:fs/promises');
const mockedFs = jest.mocked(fs);

// Mock url-validator
jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
}));
import { validateUrl } from '../../../src/bruno/url-validator';
const mockedValidateUrl = jest.mocked(validateUrl);

// Mock fetch-dispatcher — returns undefined by default (plain fetch)
jest.mock('../../../src/bruno/fetch-dispatcher', () => ({
  buildDispatcher: jest.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const GET_REQUEST_YAML = `
info:
  name: Get Users
  type: http
  seq: 1
http:
  method: GET
  url: "{{base_url}}/api/users"
  headers:
    - name: Accept
      value: application/json
    - name: Authorization
      value: "Bearer {{api_key}}"
`;

const POST_REQUEST_YAML = `
info:
  name: Create User
  type: http
  seq: 2
http:
  method: POST
  url: "{{base_url}}/api/users"
  headers:
    - name: Content-Type
      value: application/json
  body:
    type: json
    data: '{"name": "John", "email": "john@example.com"}'
`;

const REQUEST_WITH_TESTS_YAML = `
info:
  name: Get Status
  type: http
  seq: 1
http:
  method: GET
  url: "{{base_url}}/api/status"
runtime:
  scripts:
    - type: after-response
      code: |
        test("should return 200", function() {
          expect(res.getStatus()).to.equal(200);
        });
        test("should have status field", function() {
          expect(res.getBody()).to.have.property("status");
        });
`;

const REQUEST_WITH_FAILING_TEST_YAML = `
info:
  name: Health Check
  type: http
  seq: 2
http:
  method: GET
  url: "{{base_url}}/health"
runtime:
  scripts:
    - type: after-response
      code: |
        test("should return 200", function() {
          expect(res.getStatus()).to.equal(200);
        });
`;

const ENV_YAML = `
variables:
  - name: base_url
    value: "https://api.example.com"
  - name: api_key
    value: "test-key-123"
  - name: disabled_var
    value: "should-not-appear"
    disabled: true
`;

const REQUEST_WITH_TIMEOUT_YAML = `
info:
  name: Slow Request
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/slow"
settings:
  timeout: 100
`;

const SSRF_REQUEST_YAML = `
info:
  name: SSRF Request
  type: http
  seq: 1
http:
  method: GET
  url: "http://169.254.169.254/metadata"
`;

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
    text: jest.fn().mockResolvedValue(
      typeof body === 'string' ? body : JSON.stringify(body),
    ),
    ok: status >= 200 && status < 300,
  } as unknown as Response;
}

/**
 * Setup readdir mock for recursive directory scanning.
 * dirMap is a mapping from directory path to an array of entries.
 * Each entry is { name, isFile, isDirectory }.
 */
function setupFsReaddirRecursive(
  dirMap: Record<string, Array<{ name: string; isFile: boolean; isDirectory: boolean }>>,
): void {
  mockedFs.readdir.mockImplementation(async (dirPath: any) => {
    const p = typeof dirPath === 'string' ? dirPath : dirPath.toString();
    const entries = dirMap[p];
    if (!entries) {
      const err = new Error(`ENOENT: no such directory - ${p}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return entries.map(e => ({
      name: e.name,
      isFile: () => e.isFile,
      isDirectory: () => e.isDirectory,
    })) as any;
  });
}

function setupFsReaddir(files: string[]): void {
  // For backward compat: flat readdir returns only files, no subdirectories
  setupFsReaddirRecursive({
    '/test-collection': files.map(f => ({
      name: f,
      isFile: true,
      isDirectory: false,
    })),
  });
}

function setupFsReadFile(fileMap: Record<string, string>): void {
  mockedFs.readFile.mockImplementation(async (filePath: any) => {
    const p = typeof filePath === 'string' ? filePath : filePath.toString();
    // Normalize path separators for matching
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
    const err = new Error(`ENOENT`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RequestExecutor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedValidateUrl.mockReturnValue({ valid: true });
  });

  describe('response body capture', () => {
    beforeEach(() => {
      setupFsReaddir(['Get Users.yml']);
      setupFsReadFile({ 'Get Users.yml': GET_REQUEST_YAML, 'dev.yml': ENV_YAML });
      setupFsStat(['/test-collection', '/test-collection/environments']);
    });

    it('returns the response body and content-type by default', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ hello: 'world' }, 200, 'OK', 'application/json'),
      );

      const result = await RequestExecutor.executeCollection('/test-collection', {
        environment: 'dev',
      });

      expect(result.results[0].response_body).toBe(JSON.stringify({ hello: 'world' }));
      expect(result.results[0].response_content_type).toBe('application/json');
      expect(result.results[0].response_body_truncated).toBe(false);
    });

    it('truncates the body when it exceeds maxResponseBodyBytes', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse('abcdefghijklmnop', 200, 'OK', 'text/plain'),
      );

      const result = await RequestExecutor.executeCollection('/test-collection', {
        environment: 'dev',
        maxResponseBodyBytes: 5,
      });

      expect(result.results[0].response_body).toBe('abcde');
      expect(Buffer.byteLength(result.results[0].response_body!, 'utf8')).toBeLessThanOrEqual(5);
      expect(result.results[0].response_body_truncated).toBe(true);
    });

    it('omits body fields when includeResponseBody is false', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ hello: 'world' }, 200, 'OK', 'application/json'),
      );

      const result = await RequestExecutor.executeCollection('/test-collection', {
        environment: 'dev',
        includeResponseBody: false,
      });

      expect(result.results[0].response_body).toBeUndefined();
      expect(result.results[0].response_body_truncated).toBeUndefined();
      expect(result.results[0].response_content_type).toBeUndefined();
    });
  });

  describe('executeCollection', () => {
    it('should execute all requests in a folder sorted by seq', async () => {
      // Setup: 2 request files + env
      setupFsReaddir(['Get Users.yml', 'Create User.yml', 'folder.yml', 'opencollection.yml']);
      setupFsReadFile({
        'Get Users.yml': GET_REQUEST_YAML,
        'Create User.yml': POST_REQUEST_YAML,
        'dev.yml': ENV_YAML,
      });
      setupFsStat(['/test-collection', '/test-collection/environments']);

      mockFetch
        .mockResolvedValueOnce(
          createMockResponse([{ id: 1, name: 'Alice' }]),
        )
        .mockResolvedValueOnce(
          createMockResponse({ id: 2, name: 'John' }, 201, 'Created'),
        );

      const result = await RequestExecutor.executeCollection(
        '/test-collection',
        { environment: 'dev' },
      );

      expect(result.summary.total).toBe(2);
      expect(result.summary.failed).toBe(0);
      expect(result.summary.passed).toBe(2);
      expect(result.summary.duration_ms).toBeGreaterThanOrEqual(0);

      // Verify order: seq 1 (Get Users) before seq 2 (Create User)
      expect(result.results).toHaveLength(2);
      expect(result.results[0].name).toBe('Get Users');
      expect(result.results[0].method).toBe('GET');
      expect(result.results[0].status).toBe(200);
      expect(result.results[1].name).toBe('Create User');
      expect(result.results[1].method).toBe('POST');
      expect(result.results[1].status).toBe(201);

      // Verify variable substitution was applied
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const firstCallUrl = mockFetch.mock.calls[0][0];
      expect(firstCallUrl).toBe('https://api.example.com/api/users');
    });

    it('should run after-response test scripts and collect results', async () => {
      setupFsReaddir(['Get Status.yml']);
      setupFsReadFile({
        'Get Status.yml': REQUEST_WITH_TESTS_YAML,
        'dev.yml': ENV_YAML,
      });
      setupFsStat(['/test-collection', '/test-collection/environments']);

      mockFetch.mockResolvedValueOnce(
        createMockResponse({ status: 'healthy' }),
      );

      const result = await RequestExecutor.executeCollection(
        '/test-collection',
        { environment: 'dev' },
      );

      expect(result.summary.total).toBe(1);
      expect(result.summary.passed).toBe(1);
      expect(result.results[0].tests).toHaveLength(2);
      expect(result.results[0].tests[0]).toEqual({
        description: 'should return 200',
        status: 'pass',
      });
      expect(result.results[0].tests[1]).toEqual({
        description: 'should have status field',
        status: 'pass',
      });
    });

    it('should handle network errors gracefully and continue', async () => {
      setupFsReaddir(['Get Users.yml', 'Create User.yml']);
      setupFsReadFile({
        'Get Users.yml': GET_REQUEST_YAML,
        'Create User.yml': POST_REQUEST_YAML,
        'dev.yml': ENV_YAML,
      });
      setupFsStat(['/test-collection', '/test-collection/environments']);

      // First request fails with network error
      mockFetch
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(
          createMockResponse({ id: 2, name: 'John' }, 201, 'Created'),
        );

      const result = await RequestExecutor.executeCollection(
        '/test-collection',
        { environment: 'dev' },
      );

      expect(result.summary.total).toBe(2);
      expect(result.summary.failed).toBe(1);
      expect(result.summary.passed).toBe(1);

      // First request should be marked as failed
      expect(result.results[0].name).toBe('Get Users');
      expect(result.results[0].status).toBe(0);
      expect(result.results[0].error).toContain('ECONNREFUSED');

      // Second request should still execute
      expect(result.results[1].name).toBe('Create User');
      expect(result.results[1].status).toBe(201);
    });

    it('should handle test script failures', async () => {
      setupFsReaddir(['Health Check.yml']);
      setupFsReadFile({
        'Health Check.yml': REQUEST_WITH_FAILING_TEST_YAML,
        'dev.yml': ENV_YAML,
      });
      setupFsStat(['/test-collection', '/test-collection/environments']);

      // Return 500 so the test "should return 200" fails
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ error: 'internal' }, 500, 'Internal Server Error'),
      );

      const result = await RequestExecutor.executeCollection(
        '/test-collection',
        { environment: 'dev' },
      );

      expect(result.summary.total).toBe(1);
      expect(result.summary.failed).toBe(1);
      expect(result.results[0].status).toBe(500);
      expect(result.results[0].tests).toHaveLength(1);
      expect(result.results[0].tests[0].status).toBe('fail');
      expect(result.results[0].tests[0].error).toBeDefined();
    });

    it('should proceed with empty vars when environment is missing', async () => {
      setupFsReaddir(['Get Users.yml']);
      setupFsReadFile({
        'Get Users.yml': GET_REQUEST_YAML,
        // No env file — loadEnvironment returns empty map
      });
      setupFsStat(['/test-collection']);

      mockFetch.mockResolvedValueOnce(
        createMockResponse({ users: [] }),
      );

      const result = await RequestExecutor.executeCollection(
        '/test-collection',
        { environment: 'nonexistent' },
      );

      expect(result.summary.total).toBe(1);
      expect(result.summary.passed).toBe(1);

      // URL should still have unsubstituted variables
      const calledUrl = mockFetch.mock.calls[0][0];
      expect(calledUrl).toBe('{{base_url}}/api/users');
    });

    it('should work with no environment specified', async () => {
      const NO_VARS_REQUEST = `
info:
  name: Ping
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/ping"
`;
      setupFsReaddir(['Ping.yml']);
      setupFsReadFile({
        'Ping.yml': NO_VARS_REQUEST,
      });
      setupFsStat(['/test-collection']);

      mockFetch.mockResolvedValueOnce(
        createMockResponse({ pong: true }),
      );

      const result = await RequestExecutor.executeCollection(
        '/test-collection',
      );

      expect(result.summary.total).toBe(1);
      expect(result.summary.passed).toBe(1);
      expect(result.results[0].url).toBe('https://api.example.com/ping');
    });
  });

  describe('executeSingleRequest', () => {
    it('should execute a single request file', async () => {
      setupFsReadFile({
        '/test-collection/requests/Get Users.yml': GET_REQUEST_YAML,
        'dev.yml': ENV_YAML,
      });
      setupFsStat(['/test-collection', '/test-collection/environments']);

      // Need to mock readFile to return the content for the specific path
      mockedFs.readFile.mockImplementation(async (filePath: any) => {
        const p = typeof filePath === 'string' ? filePath : filePath.toString();
        if (p.includes('Get Users.yml')) return GET_REQUEST_YAML;
        if (p.includes('dev.yml')) return ENV_YAML;
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      });

      mockFetch.mockResolvedValueOnce(
        createMockResponse([{ id: 1 }]),
      );

      const result = await RequestExecutor.executeCollection(
        '/test-collection',
        {
          environment: 'dev',
          requestPath: '/test-collection/requests/Get Users.yml',
        },
      );

      expect(result.summary.total).toBe(1);
      expect(result.results[0].name).toBe('Get Users');
      expect(result.results[0].method).toBe('GET');
      expect(result.results[0].url).toBe('https://api.example.com/api/users');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('variable substitution in requests', () => {
    it('should substitute variables in URL, headers, and body', async () => {
      const REQUEST_WITH_VARS = `
info:
  name: Create Thing
  type: http
  seq: 1
http:
  method: POST
  url: "{{base_url}}/api/things"
  headers:
    - name: Authorization
      value: "Bearer {{api_key}}"
    - name: Content-Type
      value: application/json
  body:
    type: json
    data: '{"owner": "{{api_key}}"}'
`;
      setupFsReaddir(['Create Thing.yml']);
      setupFsReadFile({
        'Create Thing.yml': REQUEST_WITH_VARS,
        'dev.yml': ENV_YAML,
      });
      setupFsStat(['/test-collection', '/test-collection/environments']);

      mockFetch.mockResolvedValueOnce(
        createMockResponse({ id: 99 }, 201, 'Created'),
      );

      await RequestExecutor.executeCollection(
        '/test-collection',
        { environment: 'dev' },
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [calledUrl, calledOptions] = mockFetch.mock.calls[0];
      expect(calledUrl).toBe('https://api.example.com/api/things');
      expect(calledOptions.headers['Authorization']).toBe('Bearer test-key-123');
      expect(calledOptions.body).toContain('test-key-123');
    });
  });

  describe('request sorting', () => {
    it('should sort requests by seq number', async () => {
      const REQ_SEQ_3 = `
info:
  name: Third
  type: http
  seq: 3
http:
  method: GET
  url: "https://api.example.com/third"
`;
      const REQ_SEQ_1 = `
info:
  name: First
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/first"
`;
      const REQ_SEQ_2 = `
info:
  name: Second
  type: http
  seq: 2
http:
  method: GET
  url: "https://api.example.com/second"
`;

      // readdir returns them out of order
      setupFsReaddir(['Third.yml', 'First.yml', 'Second.yml']);
      mockedFs.readFile.mockImplementation(async (filePath: any) => {
        const p = typeof filePath === 'string' ? filePath : filePath.toString();
        if (p.includes('Third.yml')) return REQ_SEQ_3;
        if (p.includes('First.yml')) return REQ_SEQ_1;
        if (p.includes('Second.yml')) return REQ_SEQ_2;
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      });
      setupFsStat(['/test-collection']);

      mockFetch
        .mockResolvedValueOnce(createMockResponse({ n: 1 }))
        .mockResolvedValueOnce(createMockResponse({ n: 2 }))
        .mockResolvedValueOnce(createMockResponse({ n: 3 }));

      const result = await RequestExecutor.executeCollection('/test-collection');

      expect(result.results[0].name).toBe('First');
      expect(result.results[1].name).toBe('Second');
      expect(result.results[2].name).toBe('Third');
    });
  });

  describe('error handling', () => {
    it('should return empty results when collection path does not exist', async () => {
      mockedFs.readdir.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );

      const result = await RequestExecutor.executeCollection('/nonexistent');

      // Recursive discovery gracefully handles missing directories
      expect(result.summary.total).toBe(0);
      expect(result.results).toHaveLength(0);
      expect(result.parseErrors).toBe(0);
    });

    it('should skip non-request YAML files (folder.yml, opencollection.yml)', async () => {
      const SIMPLE_REQUEST = `
info:
  name: Simple
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/simple"
`;
      setupFsReaddir(['folder.yml', 'opencollection.yml', 'Simple.yml']);
      setupFsReadFile({ 'Simple.yml': SIMPLE_REQUEST });
      setupFsStat(['/test-collection']);

      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

      const result = await RequestExecutor.executeCollection('/test-collection');

      expect(result.summary.total).toBe(1);
      expect(result.results[0].name).toBe('Simple');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should handle requests without seq field', async () => {
      const NO_SEQ_REQUEST = `
info:
  name: No Seq
  type: http
http:
  method: GET
  url: "https://api.example.com/no-seq"
`;
      setupFsReaddir(['No Seq.yml']);
      setupFsReadFile({ 'No Seq.yml': NO_SEQ_REQUEST });
      setupFsStat(['/test-collection']);

      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

      const result = await RequestExecutor.executeCollection('/test-collection');

      expect(result.summary.total).toBe(1);
      expect(result.results[0].name).toBe('No Seq');
    });
  });

  describe('headers and body handling', () => {
    it('should send headers from the request YAML', async () => {
      setupFsReaddir(['Get Users.yml']);
      setupFsReadFile({ 'Get Users.yml': GET_REQUEST_YAML });
      setupFsStat(['/test-collection']);

      mockFetch.mockResolvedValueOnce(createMockResponse([]));

      await RequestExecutor.executeCollection('/test-collection');

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers['Accept']).toBe('application/json');
      // Without env substitution, the raw template is sent
      expect(options.headers['Authorization']).toBe('Bearer {{api_key}}');
    });

    it('should send POST body when present', async () => {
      setupFsReaddir(['Create User.yml']);
      setupFsReadFile({ 'Create User.yml': POST_REQUEST_YAML });
      setupFsStat(['/test-collection']);

      mockFetch.mockResolvedValueOnce(
        createMockResponse({ id: 1 }, 201, 'Created'),
      );

      await RequestExecutor.executeCollection('/test-collection');

      const [, options] = mockFetch.mock.calls[0];
      expect(options.method).toBe('POST');
      expect(options.body).toBeDefined();
      const parsedBody = JSON.parse(options.body);
      expect(parsedBody.name).toBe('John');
    });
  });

  describe('duration tracking', () => {
    it('should record duration_ms for each request', async () => {
      setupFsReaddir(['Get Users.yml']);
      setupFsReadFile({ 'Get Users.yml': GET_REQUEST_YAML });
      setupFsStat(['/test-collection']);

      mockFetch.mockResolvedValueOnce(createMockResponse([]));

      const result = await RequestExecutor.executeCollection('/test-collection');

      expect(result.results[0].duration_ms).toBeGreaterThanOrEqual(0);
      expect(typeof result.results[0].duration_ms).toBe('number');
      expect(result.summary.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================================================
  // New tests for Task 6: recursive discovery, SSRF, timeout, parse errors
  // =========================================================================

  describe('recursive discovery', () => {
    it('should find request files in nested subdirectories', async () => {
      const NESTED_REQUEST = `
info:
  name: Nested Request
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/nested"
`;
      const TOP_REQUEST = `
info:
  name: Top Request
  type: http
  seq: 2
http:
  method: GET
  url: "https://api.example.com/top"
`;

      // Simulate a nested directory structure:
      // /test-collection/
      //   Top Request.yml
      //   subfolder/
      //     Nested Request.yml
      setupFsReaddirRecursive({
        '/test-collection': [
          { name: 'Top Request.yml', isFile: true, isDirectory: false },
          { name: 'subfolder', isFile: false, isDirectory: true },
        ],
        '/test-collection/subfolder': [
          { name: 'Nested Request.yml', isFile: true, isDirectory: false },
        ],
      });

      setupFsReadFile({
        'Top Request.yml': TOP_REQUEST,
        'Nested Request.yml': NESTED_REQUEST,
      });
      setupFsStat(['/test-collection']);

      mockFetch
        .mockResolvedValueOnce(createMockResponse({ ok: true }))
        .mockResolvedValueOnce(createMockResponse({ ok: true }));

      const result = await RequestExecutor.executeCollection('/test-collection');

      expect(result.summary.total).toBe(2);
      // Sorted by seq: Nested (seq 1) before Top (seq 2)
      expect(result.results[0].name).toBe('Nested Request');
      expect(result.results[1].name).toBe('Top Request');
    });

    it('should exclude node_modules, .git, and environments directories', async () => {
      const VALID_REQUEST = `
info:
  name: Valid
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/valid"
`;

      setupFsReaddirRecursive({
        '/test-collection': [
          { name: 'Valid.yml', isFile: true, isDirectory: false },
          { name: 'node_modules', isFile: false, isDirectory: true },
          { name: '.git', isFile: false, isDirectory: true },
          { name: 'environments', isFile: false, isDirectory: true },
        ],
        // These should NOT be traversed — if they are, the test will break
        // because we haven't set them up. The code should skip them.
      });

      setupFsReadFile({ 'Valid.yml': VALID_REQUEST });
      setupFsStat(['/test-collection']);

      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

      const result = await RequestExecutor.executeCollection('/test-collection');

      expect(result.summary.total).toBe(1);
      expect(result.results[0].name).toBe('Valid');

      // readdir should only have been called for /test-collection, not excluded dirs
      const readdirCalls = mockedFs.readdir.mock.calls.map(c =>
        typeof c[0] === 'string' ? c[0] : c[0].toString(),
      );
      expect(readdirCalls).not.toContain('/test-collection/node_modules');
      expect(readdirCalls).not.toContain('/test-collection/.git');
      expect(readdirCalls).not.toContain('/test-collection/environments');
    });
  });

  describe('SSRF protection', () => {
    it('should block SSRF URLs and return error result without throwing', async () => {
      mockedValidateUrl.mockReturnValue({
        valid: false,
        reason: 'Blocked IP: link-local address (169.254.0.0/16)',
      });

      setupFsReaddir(['SSRF Request.yml']);
      setupFsReadFile({ 'SSRF Request.yml': SSRF_REQUEST_YAML });
      setupFsStat(['/test-collection']);

      const result = await RequestExecutor.executeCollection('/test-collection');

      expect(result.summary.total).toBe(1);
      expect(result.summary.failed).toBe(1);
      expect(result.results[0].status).toBe(0);
      expect(result.results[0].error).toContain('SSRF blocked');
      expect(result.results[0].error).toContain('link-local');
      // fetch should NOT have been called
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should continue executing remaining requests after SSRF block', async () => {
      const SAFE_REQUEST_YAML = `
info:
  name: Safe Request
  type: http
  seq: 2
http:
  method: GET
  url: "https://api.example.com/safe"
`;

      // First call (SSRF) blocked, second call (safe) allowed
      mockedValidateUrl
        .mockReturnValueOnce({ valid: false, reason: 'Blocked IP: link-local address' })
        .mockReturnValueOnce({ valid: true });

      setupFsReaddir(['SSRF Request.yml', 'Safe Request.yml']);
      setupFsReadFile({
        'SSRF Request.yml': SSRF_REQUEST_YAML,
        'Safe Request.yml': SAFE_REQUEST_YAML,
      });
      setupFsStat(['/test-collection']);

      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

      const result = await RequestExecutor.executeCollection('/test-collection');

      expect(result.summary.total).toBe(2);
      expect(result.summary.failed).toBe(1);
      expect(result.summary.passed).toBe(1);
      // SSRF request should be first (seq 1)
      expect(result.results[0].error).toContain('SSRF blocked');
      // Safe request should still execute
      expect(result.results[1].name).toBe('Safe Request');
      expect(result.results[1].status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('fetch timeout', () => {
    it('should apply timeout from YAML settings', async () => {
      setupFsReaddir(['Slow Request.yml']);
      setupFsReadFile({ 'Slow Request.yml': REQUEST_WITH_TIMEOUT_YAML });
      setupFsStat(['/test-collection']);

      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

      await RequestExecutor.executeCollection('/test-collection');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, fetchOptions] = mockFetch.mock.calls[0];
      // The signal should be set (AbortSignal.timeout)
      expect(fetchOptions.signal).toBeDefined();
    });

    it('should use default 30000ms timeout when settings.timeout is not specified', async () => {
      const NO_TIMEOUT_REQUEST = `
info:
  name: Default Timeout
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/default"
`;
      setupFsReaddir(['Default Timeout.yml']);
      setupFsReadFile({ 'Default Timeout.yml': NO_TIMEOUT_REQUEST });
      setupFsStat(['/test-collection']);

      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

      await RequestExecutor.executeCollection('/test-collection');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, fetchOptions] = mockFetch.mock.calls[0];
      expect(fetchOptions.signal).toBeDefined();
    });
  });

  describe('parse error tracking', () => {
    it('should count parse errors and include in result', async () => {
      const VALID_REQUEST = `
info:
  name: Valid
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/valid"
`;
      const INVALID_YAML = `not: [valid: yaml: request`;

      setupFsReaddirRecursive({
        '/test-collection': [
          { name: 'Valid.yml', isFile: true, isDirectory: false },
          { name: 'Invalid.yml', isFile: true, isDirectory: false },
        ],
      });

      mockedFs.readFile.mockImplementation(async (filePath: any) => {
        const p = typeof filePath === 'string' ? filePath : filePath.toString();
        if (p.includes('Valid.yml')) return VALID_REQUEST;
        if (p.includes('Invalid.yml')) return INVALID_YAML;
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      });
      setupFsStat(['/test-collection']);

      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

      const result = await RequestExecutor.executeCollection('/test-collection');

      expect(result.summary.total).toBe(1);
      expect(result.parseErrors).toBe(1);
    });

    it('should return parseErrors 0 when all files parse successfully', async () => {
      const VALID_REQUEST = `
info:
  name: Valid
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/valid"
`;

      setupFsReaddir(['Valid.yml']);
      setupFsReadFile({ 'Valid.yml': VALID_REQUEST });
      setupFsStat(['/test-collection']);

      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

      const result = await RequestExecutor.executeCollection('/test-collection');

      expect(result.summary.total).toBe(1);
      expect(result.parseErrors).toBe(0);
    });
  });

  // =========================================================================
  // Security fix tests: timeout ?? and redirect SSRF
  // =========================================================================

  describe('timeout nullish coalescing fix', () => {
    it('should use timeout: 0 as no-timeout (omit AbortSignal)', async () => {
      const ZERO_TIMEOUT_REQUEST = `
info:
  name: Zero Timeout
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/zero"
settings:
  timeout: 0
`;
      setupFsReaddir(['Zero Timeout.yml']);
      setupFsReadFile({ 'Zero Timeout.yml': ZERO_TIMEOUT_REQUEST });
      setupFsStat(['/test-collection']);

      const abortTimeoutSpy = jest.spyOn(AbortSignal, 'timeout');

      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

      await RequestExecutor.executeCollection('/test-collection');

      // timeout: 0 means no timeout — AbortSignal.timeout should NOT be called
      expect(abortTimeoutSpy).not.toHaveBeenCalled();

      abortTimeoutSpy.mockRestore();
    });
  });

  describe('cross-request variable propagation', () => {
    it('should propagate variables from request A script to request B substitution', async () => {
      const REQUEST_A = `
info:
  name: Request A
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/login"
runtime:
  scripts:
    - type: after-response
      code: |
        bru.setVar("auth_token", "tok_abc123");
        test("login ok", function() {
          expect(res.getStatus()).to.equal(200);
        });
`;

      const REQUEST_B = `
info:
  name: Request B
  type: http
  seq: 2
http:
  method: GET
  url: "https://api.example.com/data"
  headers:
    - name: Authorization
      value: "Bearer {{auth_token}}"
`;

      setupFsReaddir(['Request A.yml', 'Request B.yml']);
      setupFsReadFile({
        'Request A.yml': REQUEST_A,
        'Request B.yml': REQUEST_B,
      });
      setupFsStat(['/test-collection']);

      mockFetch
        .mockResolvedValueOnce(createMockResponse({ token: 'tok_abc123' }))
        .mockResolvedValueOnce(createMockResponse({ data: 'secret' }));

      const result = await RequestExecutor.executeCollection('/test-collection');

      expect(result.summary.total).toBe(2);
      expect(result.summary.passed).toBe(2);

      // Request B should have the token substituted from Request A's bru.setVar
      const secondCallOptions = mockFetch.mock.calls[1][1];
      expect(secondCallOptions.headers['Authorization']).toBe('Bearer tok_abc123');
    });

    it('should allow runtime vars to override env vars', async () => {
      const REQUEST_A = `
info:
  name: Set Override
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/init"
runtime:
  scripts:
    - type: after-response
      code: |
        bru.setVar("api_key", "runtime-key");
        test("ok", function() { expect(res.getStatus()).to.equal(200); });
`;

      const REQUEST_B = `
info:
  name: Use Override
  type: http
  seq: 2
http:
  method: GET
  url: "https://api.example.com/data"
  headers:
    - name: Authorization
      value: "Bearer {{api_key}}"
`;

      setupFsReaddir(['Set Override.yml', 'Use Override.yml']);
      setupFsReadFile({
        'Set Override.yml': REQUEST_A,
        'Use Override.yml': REQUEST_B,
        'dev.yml': ENV_YAML, // ENV_YAML has api_key = "test-key-123"
      });
      setupFsStat(['/test-collection', '/test-collection/environments']);

      mockFetch
        .mockResolvedValueOnce(createMockResponse({ ok: true }))
        .mockResolvedValueOnce(createMockResponse({ ok: true }));

      const result = await RequestExecutor.executeCollection(
        '/test-collection',
        { environment: 'dev' },
      );

      expect(result.summary.total).toBe(2);
      expect(result.summary.passed).toBe(2);

      // Request B should use runtime-key (from bru.setVar), not env test-key-123
      const secondCallOptions = mockFetch.mock.calls[1][1];
      expect(secondCallOptions.headers['Authorization']).toBe('Bearer runtime-key');
    });

    it('should use a fresh variable store for each executeCollection call', async () => {
      const REQUEST_WITH_SETVAR = `
info:
  name: Setter
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/set"
runtime:
  scripts:
    - type: after-response
      code: |
        bru.setVar("run_var", "from_run");
        test("ok", function() { expect(res.getStatus()).to.equal(200); });
`;

      const REQUEST_WITH_GETVAR = `
info:
  name: Getter
  type: http
  seq: 2
http:
  method: GET
  url: "https://api.example.com/get?val={{run_var}}"
`;

      setupFsReaddir(['Setter.yml', 'Getter.yml']);
      setupFsReadFile({
        'Setter.yml': REQUEST_WITH_SETVAR,
        'Getter.yml': REQUEST_WITH_GETVAR,
      });
      setupFsStat(['/test-collection']);

      // Run 1: sets run_var
      mockFetch
        .mockResolvedValueOnce(createMockResponse({ ok: true }))
        .mockResolvedValueOnce(createMockResponse({ ok: true }));

      const result1 = await RequestExecutor.executeCollection('/test-collection');
      expect(result1.summary.total).toBe(2);
      expect(mockFetch.mock.calls[1][0]).toBe('https://api.example.com/get?val=from_run');

      // Reset mocks for run 2
      mockFetch.mockClear();

      // Run 2: variable store should be fresh — run_var should still resolve
      // because the setter runs again
      mockFetch
        .mockResolvedValueOnce(createMockResponse({ ok: true }))
        .mockResolvedValueOnce(createMockResponse({ ok: true }));

      const result2 = await RequestExecutor.executeCollection('/test-collection');
      expect(result2.summary.total).toBe(2);
      // The setter runs again, so run_var is set again
      expect(mockFetch.mock.calls[1][0]).toBe('https://api.example.com/get?val=from_run');
    });

    it('should not have variables from a previous run leak into a new run', async () => {
      // Run 1: has a setter request
      const SETTER_REQUEST = `
info:
  name: Setter
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/set"
runtime:
  scripts:
    - type: after-response
      code: |
        bru.setVar("leak_test", "should_not_leak");
        test("ok", function() { expect(res.getStatus()).to.equal(200); });
`;

      setupFsReaddir(['Setter.yml']);
      setupFsReadFile({ 'Setter.yml': SETTER_REQUEST });
      setupFsStat(['/test-collection']);

      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
      await RequestExecutor.executeCollection('/test-collection');

      // Run 2: only getter, no setter — leak_test should not be available
      const GETTER_REQUEST = `
info:
  name: Getter
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/get?val={{leak_test}}"
`;

      // Clear call history for second run assertions
      mockFetch.mockClear();

      setupFsReaddirRecursive({
        '/test-collection2': [
          { name: 'Getter.yml', isFile: true, isDirectory: false },
        ],
      });
      setupFsReadFile({ 'Getter.yml': GETTER_REQUEST });

      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
      await RequestExecutor.executeCollection('/test-collection2');

      // leak_test should NOT be substituted — fresh store means it stays as template
      expect(mockFetch.mock.calls[0][0]).toBe('https://api.example.com/get?val={{leak_test}}');
    });

    it('should accumulate variables across multiple requests', async () => {
      const REQ_1 = `
info:
  name: Step 1
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/step1"
runtime:
  scripts:
    - type: after-response
      code: |
        bru.setVar("var1", "value1");
        test("ok", function() { expect(res.getStatus()).to.equal(200); });
`;

      const REQ_2 = `
info:
  name: Step 2
  type: http
  seq: 2
http:
  method: GET
  url: "https://api.example.com/step2?v={{var1}}"
runtime:
  scripts:
    - type: after-response
      code: |
        bru.setVar("var2", "value2");
        test("ok", function() { expect(res.getStatus()).to.equal(200); });
`;

      const REQ_3 = `
info:
  name: Step 3
  type: http
  seq: 3
http:
  method: GET
  url: "https://api.example.com/step3?a={{var1}}&b={{var2}}"
`;

      setupFsReaddir(['Step 1.yml', 'Step 2.yml', 'Step 3.yml']);
      setupFsReadFile({
        'Step 1.yml': REQ_1,
        'Step 2.yml': REQ_2,
        'Step 3.yml': REQ_3,
      });
      setupFsStat(['/test-collection']);

      mockFetch
        .mockResolvedValueOnce(createMockResponse({ ok: true }))
        .mockResolvedValueOnce(createMockResponse({ ok: true }))
        .mockResolvedValueOnce(createMockResponse({ ok: true }));

      const result = await RequestExecutor.executeCollection('/test-collection');

      expect(result.summary.total).toBe(3);
      expect(result.summary.passed).toBe(3);

      // Step 2 should have var1 substituted
      expect(mockFetch.mock.calls[1][0]).toBe('https://api.example.com/step2?v=value1');
      // Step 3 should have both var1 and var2 substituted
      expect(mockFetch.mock.calls[2][0]).toBe('https://api.example.com/step3?a=value1&b=value2');
    });

    it('should work with existing tests that do not use bru', async () => {
      // This verifies backward compatibility — existing test scripts
      // that don't call bru.setVar/getVar should still work
      setupFsReaddir(['Get Status.yml']);
      setupFsReadFile({
        'Get Status.yml': REQUEST_WITH_TESTS_YAML,
        'dev.yml': ENV_YAML,
      });
      setupFsStat(['/test-collection', '/test-collection/environments']);

      mockFetch.mockResolvedValueOnce(
        createMockResponse({ status: 'healthy' }),
      );

      const result = await RequestExecutor.executeCollection(
        '/test-collection',
        { environment: 'dev' },
      );

      expect(result.summary.total).toBe(1);
      expect(result.summary.passed).toBe(1);
      expect(result.results[0].tests).toHaveLength(2);
      expect(result.results[0].tests[0]).toEqual({
        description: 'should return 200',
        status: 'pass',
      });
    });
  });

  describe('redirect SSRF protection', () => {
    it('should block redirect to internal IP (SSRF via 302)', async () => {
      const PUBLIC_REQUEST = `
info:
  name: Public Request
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/api"
`;
      setupFsReaddir(['Public Request.yml']);
      setupFsReadFile({ 'Public Request.yml': PUBLIC_REQUEST });
      setupFsStat(['/test-collection']);

      // Initial fetch passes validation (public URL)
      // But the response is a 302 redirect to an internal IP
      const redirectHeaders = new Headers({ location: 'http://169.254.169.254/metadata' });
      const redirectResponse = {
        status: 302,
        statusText: 'Found',
        headers: redirectHeaders,
        ok: false,
        text: jest.fn().mockResolvedValue(''),
      } as unknown as Response;

      mockFetch.mockResolvedValueOnce(redirectResponse);

      // validateUrl: first call (original URL) passes, second call (redirect target) blocks
      mockedValidateUrl
        .mockReturnValueOnce({ valid: true })
        .mockReturnValueOnce({ valid: false, reason: 'Blocked IP: link-local address (169.254.0.0/16)' });

      const result = await RequestExecutor.executeCollection('/test-collection');

      expect(result.summary.total).toBe(1);
      expect(result.summary.failed).toBe(1);
      expect(result.results[0].status).toBe(0);
      expect(result.results[0].error).toContain('blocked');
      expect(result.results[0].error).toContain('169.254.169.254');

      // fetch must only have been called once (for the original URL, not the redirect target)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should follow a redirect to a valid public URL successfully', async () => {
      const PUBLIC_REQUEST = `
info:
  name: Redirect Request
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/old"
`;
      setupFsReaddir(['Redirect Request.yml']);
      setupFsReadFile({ 'Redirect Request.yml': PUBLIC_REQUEST });
      setupFsStat(['/test-collection']);

      const redirectHeaders = new Headers({ location: 'https://api.example.com/new' });
      const redirectResponse = {
        status: 302,
        statusText: 'Found',
        headers: redirectHeaders,
        ok: false,
        text: jest.fn().mockResolvedValue(''),
      } as unknown as Response;

      const finalResponse = createMockResponse({ ok: true }, 200);

      mockFetch
        .mockResolvedValueOnce(redirectResponse)
        .mockResolvedValueOnce(finalResponse);

      // Both URLs pass validation
      mockedValidateUrl.mockReturnValue({ valid: true });

      const result = await RequestExecutor.executeCollection('/test-collection');

      expect(result.summary.total).toBe(1);
      expect(result.summary.passed).toBe(1);
      expect(result.results[0].status).toBe(200);
      expect(result.results[0].error).toBeUndefined();
      // fetch called twice: original + redirect
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[1][0]).toBe('https://api.example.com/new');
    });

    it('should return error after exceeding max redirects (10 hops)', async () => {
      const PUBLIC_REQUEST = `
info:
  name: Loop Request
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/loop"
`;
      setupFsReaddir(['Loop Request.yml']);
      setupFsReadFile({ 'Loop Request.yml': PUBLIC_REQUEST });
      setupFsStat(['/test-collection']);

      // Every fetch returns a 302 pointing back to the same URL
      const loopHeaders = new Headers({ location: 'https://api.example.com/loop' });
      const loopResponse = {
        status: 302,
        statusText: 'Found',
        headers: loopHeaders,
        ok: false,
        text: jest.fn().mockResolvedValue(''),
      } as unknown as Response;

      // 11 calls: 1 original + 10 redirects (loop terminates at MAX_REDIRECTS)
      mockFetch.mockResolvedValue(loopResponse);

      mockedValidateUrl.mockReturnValue({ valid: true });

      const result = await RequestExecutor.executeCollection('/test-collection');

      expect(result.summary.total).toBe(1);
      expect(result.summary.failed).toBe(1);
      expect(result.results[0].status).toBe(0);
      expect(result.results[0].error).toContain('Too many redirects');
      expect(result.results[0].error).toContain('10');
      // fetch called 11 times: 1 + 10 redirect follows (loop exits before 11th redirect fetch)
      expect(mockFetch).toHaveBeenCalledTimes(11);
    });
  });

  // =========================================================================
  // Pre-request script tests
  // =========================================================================

  describe('pre-request scripts', () => {
    it('should execute before-request script and apply header mutations', async () => {
      const REQUEST_WITH_PRE_SCRIPT = `
info:
  name: Pre Script Request
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/data"
runtime:
  scripts:
    - type: before-request
      code: |
        req.setHeader("Authorization", "Bearer pre-token");
`;
      setupFsReaddir(['Pre Script Request.yml']);
      setupFsReadFile({ 'Pre Script Request.yml': REQUEST_WITH_PRE_SCRIPT });
      setupFsStat(['/test-collection']);

      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

      const result = await RequestExecutor.executeCollection('/test-collection');

      expect(result.summary.total).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, fetchOptions] = mockFetch.mock.calls[0];
      expect(fetchOptions.headers['Authorization']).toBe('Bearer pre-token');
    });

    it('should apply URL mutation from pre-request script', async () => {
      const REQUEST_WITH_URL_MUTATION = `
info:
  name: URL Mutation
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/original"
runtime:
  scripts:
    - type: before-request
      code: |
        req.setUrl("https://api.example.com/overridden");
`;
      setupFsReaddir(['URL Mutation.yml']);
      setupFsReadFile({ 'URL Mutation.yml': REQUEST_WITH_URL_MUTATION });
      setupFsStat(['/test-collection']);

      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

      await RequestExecutor.executeCollection('/test-collection');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [calledUrl] = mockFetch.mock.calls[0];
      expect(calledUrl).toBe('https://api.example.com/overridden');
    });

    it('should feed pre-request script variables into VariableStore', async () => {
      const REQUEST_A = `
info:
  name: Pre Set Var
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/init"
runtime:
  scripts:
    - type: before-request
      code: |
        bru.setVar("pre_token", "from-pre-script");
`;

      const REQUEST_B = `
info:
  name: Use Pre Var
  type: http
  seq: 2
http:
  method: GET
  url: "https://api.example.com/data"
  headers:
    - name: Authorization
      value: "Bearer {{pre_token}}"
`;

      setupFsReaddir(['Pre Set Var.yml', 'Use Pre Var.yml']);
      setupFsReadFile({
        'Pre Set Var.yml': REQUEST_A,
        'Use Pre Var.yml': REQUEST_B,
      });
      setupFsStat(['/test-collection']);

      mockFetch
        .mockResolvedValueOnce(createMockResponse({ ok: true }))
        .mockResolvedValueOnce(createMockResponse({ ok: true }));

      const result = await RequestExecutor.executeCollection('/test-collection');

      expect(result.summary.total).toBe(2);
      const secondCallOptions = mockFetch.mock.calls[1][1];
      expect(secondCallOptions.headers['Authorization']).toBe('Bearer from-pre-script');
    });

    it('should handle requests without pre-request scripts unchanged', async () => {
      const SIMPLE_REQUEST = `
info:
  name: No Pre Script
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/simple"
`;
      setupFsReaddir(['No Pre Script.yml']);
      setupFsReadFile({ 'No Pre Script.yml': SIMPLE_REQUEST });
      setupFsStat(['/test-collection']);

      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

      const result = await RequestExecutor.executeCollection('/test-collection');

      expect(result.summary.total).toBe(1);
      expect(result.summary.passed).toBe(1);
      expect(mockFetch.mock.calls[0][0]).toBe('https://api.example.com/simple');
    });

    it('should run pre-request and after-response scripts together', async () => {
      const REQUEST_BOTH_SCRIPTS = `
info:
  name: Both Scripts
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/both"
runtime:
  scripts:
    - type: before-request
      code: |
        req.setHeader("X-Pre", "true");
    - type: after-response
      code: |
        test("status ok", function() {
          expect(res.getStatus()).to.equal(200);
        });
`;
      setupFsReaddir(['Both Scripts.yml']);
      setupFsReadFile({ 'Both Scripts.yml': REQUEST_BOTH_SCRIPTS });
      setupFsStat(['/test-collection']);

      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

      const result = await RequestExecutor.executeCollection('/test-collection');

      expect(result.summary.total).toBe(1);
      expect(result.summary.passed).toBe(1);
      // Pre-request header applied
      const [, fetchOptions] = mockFetch.mock.calls[0];
      expect(fetchOptions.headers['X-Pre']).toBe('true');
      // After-response test ran
      expect(result.results[0].tests).toHaveLength(1);
      expect(result.results[0].tests[0].status).toBe('pass');
    });
  });

  // =========================================================================
  // Parallel folder execution tests
  // =========================================================================

  describe('parallel folder execution', () => {
    it('should produce same results as serial when parallel: false (default)', async () => {
      const REQ_A = `
info:
  name: A
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/a"
`;
      const REQ_B = `
info:
  name: B
  type: http
  seq: 2
http:
  method: GET
  url: "https://api.example.com/b"
`;
      setupFsReaddir(['A.yml', 'B.yml']);
      setupFsReadFile({ 'A.yml': REQ_A, 'B.yml': REQ_B });
      setupFsStat(['/test-collection']);

      mockFetch
        .mockResolvedValueOnce(createMockResponse({ ok: true }))
        .mockResolvedValueOnce(createMockResponse({ ok: true }));

      const result = await RequestExecutor.executeCollection('/test-collection');

      expect(result.summary.total).toBe(2);
      expect(result.summary.passed).toBe(2);
      expect(result.results[0].name).toBe('A');
      expect(result.results[1].name).toBe('B');
    });

    it('should execute folders in parallel and merge results in folder order', async () => {
      const FOLDER_A_REQ = `
info:
  name: A Request
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/a"
`;
      const FOLDER_B_REQ = `
info:
  name: B Request
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/b"
`;

      setupFsReaddirRecursive({
        '/test-collection': [
          { name: 'folderA', isFile: false, isDirectory: true },
          { name: 'folderB', isFile: false, isDirectory: true },
        ],
        '/test-collection/folderA': [
          { name: 'A Request.yml', isFile: true, isDirectory: false },
        ],
        '/test-collection/folderB': [
          { name: 'B Request.yml', isFile: true, isDirectory: false },
        ],
      });

      setupFsReadFile({
        'A Request.yml': FOLDER_A_REQ,
        'B Request.yml': FOLDER_B_REQ,
      });
      setupFsStat(['/test-collection']);

      mockFetch
        .mockResolvedValueOnce(createMockResponse({ ok: true }))
        .mockResolvedValueOnce(createMockResponse({ ok: true }));

      const result = await RequestExecutor.executeCollection(
        '/test-collection',
        { parallel: true },
      );

      expect(result.summary.total).toBe(2);
      expect(result.summary.passed).toBe(2);
      // Results merged in alphabetical folder order: folderA before folderB
      expect(result.results[0].name).toBe('A Request');
      expect(result.results[1].name).toBe('B Request');
    });

    it('should isolate variables between parallel folders', async () => {
      const FOLDER_A_SETTER = `
info:
  name: A Setter
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/a"
runtime:
  scripts:
    - type: after-response
      code: |
        bru.setVar("shared_var", "from_a");
        test("ok", function() { expect(res.getStatus()).to.equal(200); });
`;
      const FOLDER_B_GETTER = `
info:
  name: B Getter
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/b?val={{shared_var}}"
`;

      setupFsReaddirRecursive({
        '/test-collection': [
          { name: 'folderA', isFile: false, isDirectory: true },
          { name: 'folderB', isFile: false, isDirectory: true },
        ],
        '/test-collection/folderA': [
          { name: 'A Setter.yml', isFile: true, isDirectory: false },
        ],
        '/test-collection/folderB': [
          { name: 'B Getter.yml', isFile: true, isDirectory: false },
        ],
      });

      setupFsReadFile({
        'A Setter.yml': FOLDER_A_SETTER,
        'B Getter.yml': FOLDER_B_GETTER,
      });
      setupFsStat(['/test-collection']);

      mockFetch
        .mockResolvedValueOnce(createMockResponse({ ok: true }))
        .mockResolvedValueOnce(createMockResponse({ ok: true }));

      const result = await RequestExecutor.executeCollection(
        '/test-collection',
        { parallel: true },
      );

      expect(result.summary.total).toBe(2);

      // B Getter should NOT have shared_var resolved (variable isolation)
      const bGetterCall = mockFetch.mock.calls.find(
        (c: any[]) => c[0].includes('/b?'),
      );
      expect(bGetterCall).toBeDefined();
      expect(bGetterCall![0]).toBe('https://api.example.com/b?val={{shared_var}}');
    });

    it('should work with single folder when parallel: true', async () => {
      const REQ = `
info:
  name: Single
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/single"
`;
      setupFsReaddirRecursive({
        '/test-collection': [
          { name: 'folder', isFile: false, isDirectory: true },
        ],
        '/test-collection/folder': [
          { name: 'Single.yml', isFile: true, isDirectory: false },
        ],
      });

      setupFsReadFile({ 'Single.yml': REQ });
      setupFsStat(['/test-collection']);

      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

      const result = await RequestExecutor.executeCollection(
        '/test-collection',
        { parallel: true },
      );

      expect(result.summary.total).toBe(1);
      expect(result.summary.passed).toBe(1);
      expect(result.results[0].name).toBe('Single');
    });

    it('should run requests within a folder serially by seq order in parallel mode', async () => {
      const REQ_1 = `
info:
  name: First
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/first"
`;
      const REQ_2 = `
info:
  name: Second
  type: http
  seq: 2
http:
  method: GET
  url: "https://api.example.com/second"
`;

      setupFsReaddirRecursive({
        '/test-collection': [
          { name: 'folder', isFile: false, isDirectory: true },
        ],
        '/test-collection/folder': [
          { name: 'Second.yml', isFile: true, isDirectory: false },
          { name: 'First.yml', isFile: true, isDirectory: false },
        ],
      });

      setupFsReadFile({ 'First.yml': REQ_1, 'Second.yml': REQ_2 });
      setupFsStat(['/test-collection']);

      mockFetch
        .mockResolvedValueOnce(createMockResponse({ ok: true }))
        .mockResolvedValueOnce(createMockResponse({ ok: true }));

      const result = await RequestExecutor.executeCollection(
        '/test-collection',
        { parallel: true },
      );

      expect(result.summary.total).toBe(2);
      // Sorted by seq within folder: First (seq 1) before Second (seq 2)
      expect(result.results[0].name).toBe('First');
      expect(result.results[1].name).toBe('Second');
    });
  });
});
