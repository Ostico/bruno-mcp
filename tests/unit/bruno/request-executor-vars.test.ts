/**
 * Tests for RequestExecutor — VariableStore integration.
 *
 * When a test script calls bru.setVar("token", "abc") in request A's
 * after-response script, {{token}} is substituted in request B's
 * URL/headers/body.
 *
 * Mocking pattern follows tests/unit/bruno/request-executor.test.ts.
 */

import { RequestExecutor } from '../../../src/bruno/request-executor';
// Opts out of the forking default: this lane has no built dist/ worker to fork.
import { TestRunner } from '../../../src/bruno/test-runner';
import * as fs from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Mock fetch globally
// ---------------------------------------------------------------------------

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

// Mock fs/promises
jest.mock('node:fs/promises');
const mockedFs = jest.mocked(fs);

// Mock url-validator
jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
}));

// ---------------------------------------------------------------------------
// YAML fixtures
// ---------------------------------------------------------------------------

const ENV_YAML = `
variables:
  - name: base_url
    value: "https://api.example.com"
  - name: api_key
    value: "env-key-123"
`;

/** Request 1: login — after-response script sets a "token" variable */
const LOGIN_REQUEST_YAML = `
info:
  name: Login
  type: http
  seq: 1
http:
  method: POST
  url: "{{base_url}}/auth/login"
  headers:
    - name: Content-Type
      value: application/json
  body:
    type: json
    data: '{"user": "admin", "pass": "secret"}'
runtime:
  scripts:
    - type: after-response
      code: |
        bru.setVar("token", "jwt-abc-123");
        test("login ok", function() {
          expect(res.getStatus()).to.equal(200);
        });
`;

/** Request 2: uses {{token}} from the variable store */
const PROFILE_REQUEST_YAML = `
info:
  name: Get Profile
  type: http
  seq: 2
http:
  method: GET
  url: "{{base_url}}/users/profile"
  headers:
    - name: Authorization
      value: "Bearer {{token}}"
`;

/** Request that sets a variable overriding an env variable */
const OVERRIDE_REQUEST_YAML = `
info:
  name: Override Env
  type: http
  seq: 1
http:
  method: GET
  url: "{{base_url}}/bootstrap"
runtime:
  scripts:
    - type: after-response
      code: |
        bru.setVar("api_key", "runtime-key-override");
`;

/** Request that uses the overridden env variable */
const USE_OVERRIDE_REQUEST_YAML = `
info:
  name: Use Override
  type: http
  seq: 2
http:
  method: GET
  url: "{{base_url}}/data"
  headers:
    - name: X-Api-Key
      value: "{{api_key}}"
`;

/** Request with no scripts at all */
const PLAIN_REQUEST_YAML = `
info:
  name: Plain
  type: http
  seq: 1
http:
  method: GET
  url: "{{base_url}}/ping"
`;

const PLAIN_REQUEST_2_YAML = `
info:
  name: Plain Two
  type: http
  seq: 2
http:
  method: GET
  url: "{{base_url}}/pong"
  headers:
    - name: X-Token
      value: "{{token}}"
`;

/** Request that sets multiple variables */
const MULTI_VAR_REQUEST_YAML = `
info:
  name: Multi Var
  type: http
  seq: 1
http:
  method: GET
  url: "{{base_url}}/init"
runtime:
  scripts:
    - type: after-response
      code: |
        bru.setVar("tokenA", "aaa");
        bru.setVar("tokenB", "bbb");
`;

const CONSUME_MULTI_YAML = `
info:
  name: Consume Multi
  type: http
  seq: 2
http:
  method: GET
  url: "{{base_url}}/check?a={{tokenA}}&b={{tokenB}}"
`;

// ---------------------------------------------------------------------------
// Helpers (same as request-executor.test.ts)
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
    const err = new Error(`ENOENT`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RequestExecutor — VariableStore integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('substitutes variable set in request 1 script into request 2 URL/headers', async () => {
    setupFsReaddir(['Login.yml', 'Get Profile.yml']);
    setupFsReadFile({
      'Login.yml': LOGIN_REQUEST_YAML,
      'Get Profile.yml': PROFILE_REQUEST_YAML,
      'dev.yml': ENV_YAML,
    });
    setupFsStat(['/test-collection', '/test-collection/environments']);

    mockFetch
      .mockResolvedValueOnce(createMockResponse({ token: 'jwt-abc-123' }))
      .mockResolvedValueOnce(createMockResponse({ name: 'Admin' }));

    const result = await RequestExecutor.executeCollection(
      '/test-collection',
      { environment: 'dev', scriptRunner: TestRunner },
    );

    expect(result.summary.total).toBe(2);

    // The second request's Authorization header should contain the runtime token
    const secondCallOptions = mockFetch.mock.calls[1];
    expect(secondCallOptions).toBeDefined();

    const [secondUrl, secondOpts] = secondCallOptions;
    // URL should have base_url substituted
    expect(secondUrl).toBe('https://api.example.com/users/profile');
    // Header should have the runtime token, not the raw template
    expect(secondOpts.headers['Authorization']).toBe('Bearer jwt-abc-123');
  });

  it('runtime variable overrides environment variable with same name', async () => {
    setupFsReaddir(['Override Env.yml', 'Use Override.yml']);
    setupFsReadFile({
      'Override Env.yml': OVERRIDE_REQUEST_YAML,
      'Use Override.yml': USE_OVERRIDE_REQUEST_YAML,
      'dev.yml': ENV_YAML,
    });
    setupFsStat(['/test-collection', '/test-collection/environments']);

    mockFetch
      .mockResolvedValueOnce(createMockResponse({ ok: true }))
      .mockResolvedValueOnce(createMockResponse({ data: [] }));

    const result = await RequestExecutor.executeCollection(
      '/test-collection',
      { environment: 'dev', scriptRunner: TestRunner },
    );

    expect(result.summary.total).toBe(2);

    // The second request should use the runtime override, not the env value
    const [, secondOpts] = mockFetch.mock.calls[1];
    expect(secondOpts.headers['X-Api-Key']).toBe('runtime-key-override');
  });

  it('request with no scripts does not affect next request variables', async () => {
    setupFsReaddir(['Plain.yml', 'Plain Two.yml']);
    setupFsReadFile({
      'Plain.yml': PLAIN_REQUEST_YAML,
      'Plain Two.yml': PLAIN_REQUEST_2_YAML,
      'dev.yml': ENV_YAML,
    });
    setupFsStat(['/test-collection', '/test-collection/environments']);

    mockFetch
      .mockResolvedValueOnce(createMockResponse({ ok: true }))
      .mockResolvedValueOnce(createMockResponse({ ok: true }));

    const result = await RequestExecutor.executeCollection(
      '/test-collection',
      { environment: 'dev', scriptRunner: TestRunner },
    );

    expect(result.summary.total).toBe(2);

    // {{token}} was never set by any script, so it should remain unsubstituted
    const [, secondOpts] = mockFetch.mock.calls[1];
    expect(secondOpts.headers['X-Token']).toBe('{{token}}');
  });

  it('multiple variables accumulate across requests', async () => {
    setupFsReaddir(['Multi Var.yml', 'Consume Multi.yml']);
    setupFsReadFile({
      'Multi Var.yml': MULTI_VAR_REQUEST_YAML,
      'Consume Multi.yml': CONSUME_MULTI_YAML,
      'dev.yml': ENV_YAML,
    });
    setupFsStat(['/test-collection', '/test-collection/environments']);

    mockFetch
      .mockResolvedValueOnce(createMockResponse({ ok: true }))
      .mockResolvedValueOnce(createMockResponse({ ok: true }));

    const result = await RequestExecutor.executeCollection(
      '/test-collection',
      { environment: 'dev', scriptRunner: TestRunner },
    );

    expect(result.summary.total).toBe(2);

    // The second request URL should have both tokenA and tokenB substituted
    const secondUrl = mockFetch.mock.calls[1][0];
    expect(secondUrl).toBe('https://api.example.com/check?a=aaa&b=bbb');
  });

  it('variable store is fresh per executeCollection call', async () => {
    setupFsReaddir(['Plain Two.yml']);
    setupFsReadFile({
      'Plain Two.yml': PLAIN_REQUEST_2_YAML,
      'dev.yml': ENV_YAML,
    });
    setupFsStat(['/test-collection', '/test-collection/environments']);

    mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

    // Even if a previous call set variables, a new executeCollection should
    // start with a clean store. {{token}} should remain unsubstituted.
    const result = await RequestExecutor.executeCollection(
      '/test-collection',
      { environment: 'dev', scriptRunner: TestRunner },
    );

    expect(result.summary.total).toBe(1);
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers['X-Token']).toBe('{{token}}');
  });
});
