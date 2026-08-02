/**
 * Tests for RequestExecutor — variables injected for one run (H3).
 *
 * The two things worth proving are the two H3 asked for: the value resolves at
 * the wire, and it appears in no written file. Precedence is checked against
 * upstream's chain (env < request vars < bru.setVar), which is where Bruno's
 * `--env-var` sits.
 *
 * Mocking pattern follows tests/unit/bruno/request-executor-vars.test.ts.
 */

import { RequestExecutor } from '../../../src/bruno/request-executor';
// Opts out of the forking default: this lane has no built dist/ worker to fork.
import { TestRunner } from '../../../src/bruno/test-runner';
import * as fs from 'node:fs/promises';

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

jest.mock('node:fs/promises');
const mockedFs = jest.mocked(fs);

jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
  ssrfRemediation: jest.fn().mockReturnValue('REMEDIATION_SENTINEL'),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENV_YAML = `
variables:
  - name: base_url
    value: "https://from-env-file.example.com"
  - name: token
    value: "env-token"
`;

/** A secret declared in the environment carries no value, by design. */
const ENV_WITH_SECRET_YAML = `
variables:
  - name: base_url
    value: "https://api.example.com"
  - name: token
    secret: true
`;

const REQUEST_YAML = `
info:
  name: Fetch
  type: http
  seq: 1
http:
  method: GET
  url: "{{base_url}}/profile"
  headers:
    - name: Authorization
      value: "Bearer {{token}}"
`;

/** A request-level var sits ABOVE the environment in upstream's chain. */
const REQUEST_WITH_PRE_REQUEST_VAR_YAML = `
info:
  name: Fetch
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/profile"
  headers:
    - name: Authorization
      value: "Bearer {{token}}"
vars:
  preRequest:
    - name: token
      value: "request-var-token"
`;

/**
 * A script write sits above everything below process.env. The type is
 * `before-request`: that is what both dialects present to the executor — the
 * `.yml` writer emits it directly, and `bru-to-yaml` translates `.bru`'s
 * `pre-request` into it.
 */
const REQUEST_WITH_SETVAR_YAML = `
info:
  name: Fetch
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/profile"
  headers:
    - name: Authorization
      value: "Bearer {{token}}"
runtime:
  scripts:
    - type: before-request
      code: |
        bru.setVar("token", "script-token");
`;

function createMockResponse(body: any, status = 200): Response {
  return {
    status,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    ok: status >= 200 && status < 300,
  } as unknown as Response;
}

function setupFs(files: Record<string, string>, requestFiles: string[]): void {
  mockedFs.readdir.mockImplementation(async (dirPath: any) => {
    const p = typeof dirPath === 'string' ? dirPath : dirPath.toString();
    if (p === '/test-collection') {
      return requestFiles.map((f) => ({
        name: f,
        isFile: () => true,
        isDirectory: () => false,
      })) as any;
    }
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });

  mockedFs.readFile.mockImplementation(async (filePath: any) => {
    const p = typeof filePath === 'string' ? filePath : filePath.toString();
    for (const [key, value] of Object.entries(files)) {
      if (p.endsWith(key) || p === key) {
        return value;
      }
    }
    const err = new Error(`ENOENT: no such file - ${p}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });

  mockedFs.stat.mockImplementation(async () => (
    { isDirectory: () => true, isFile: () => false } as any
  ));
}

/** The Authorization header the run actually put on the wire. */
function sentAuthHeader(callIndex = 0): string {
  const headers = mockFetch.mock.calls[callIndex][1].headers as Record<string, string>;
  return headers.Authorization ?? headers.authorization;
}

function sentUrl(callIndex = 0): string {
  return String(mockFetch.mock.calls[callIndex][0]);
}

describe('RequestExecutor — variables injected for one run', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves an injected variable at the wire when no environment exists', async () => {
    setupFs({ 'Fetch.yml': REQUEST_YAML }, ['Fetch.yml']);
    mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

    const result = await RequestExecutor.executeCollection('/test-collection', {
      variables: { base_url: 'https://injected.example.com', token: 'injected-secret' },
      scriptRunner: TestRunner,
    });

    expect(result.summary.total).toBe(1);
    expect(sentUrl()).toBe('https://injected.example.com/profile');
    expect(sentAuthHeader()).toBe('Bearer injected-secret');
  });

  it('overrides a value the environment file does supply', async () => {
    setupFs({ 'Fetch.yml': REQUEST_YAML, 'dev.yml': ENV_YAML }, ['Fetch.yml']);
    mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

    await RequestExecutor.executeCollection('/test-collection', {
      environment: 'dev',
      variables: { token: 'injected-wins' },
      scriptRunner: TestRunner,
    });

    expect(sentAuthHeader()).toBe('Bearer injected-wins');
    // Untouched names still come from the file.
    expect(sentUrl()).toBe('https://from-env-file.example.com/profile');
  });

  it('supplies the secret an environment file cannot hold, and reports no unresolved name', async () => {
    setupFs({ 'Fetch.yml': REQUEST_YAML, 'dev.yml': ENV_WITH_SECRET_YAML }, ['Fetch.yml']);
    mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

    const result = await RequestExecutor.executeCollection('/test-collection', {
      environment: 'dev',
      variables: { token: 'the-real-secret' },
      scriptRunner: TestRunner,
    });

    expect(sentAuthHeader()).toBe('Bearer the-real-secret');
    // Without the injection this run warns about `token` and sends
    // "Bearer " — see env-loader's valueless-secret handling.
    const warnings = result.groups[0]!.results[0].warnings ?? [];
    expect(warnings.join(' ')).not.toContain('token');
  });

  it('writes nothing to disk — the injected value exists only for the run', async () => {
    setupFs({ 'Fetch.yml': REQUEST_YAML, 'dev.yml': ENV_WITH_SECRET_YAML }, ['Fetch.yml']);
    mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

    await RequestExecutor.executeCollection('/test-collection', {
      environment: 'dev',
      variables: { token: 'the-real-secret' },
      scriptRunner: TestRunner,
    });

    // The whole point of the in-memory path: no correct on-disk place exists
    // for a secret, so nothing may persist one.
    expect(mockedFs.writeFile).not.toHaveBeenCalled();
    expect(mockedFs.appendFile).not.toHaveBeenCalled();
    expect(mockedFs.rename).not.toHaveBeenCalled();
    expect(mockedFs.mkdir).not.toHaveBeenCalled();
  });

  it('yields to a request-level vars:pre-request entry, as upstream does', async () => {
    setupFs({ 'Fetch.yml': REQUEST_WITH_PRE_REQUEST_VAR_YAML }, ['Fetch.yml']);
    mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

    await RequestExecutor.executeCollection('/test-collection', {
      variables: { token: 'injected-token' },
      scriptRunner: TestRunner,
    });

    // env < request < runtime: an injected value sits at the environment layer,
    // so the request's own var wins.
    expect(sentAuthHeader()).toBe('Bearer request-var-token');
  });

  it('yields to a bru.setVar written by a script', async () => {
    setupFs({ 'Fetch.yml': REQUEST_WITH_SETVAR_YAML }, ['Fetch.yml']);
    mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

    await RequestExecutor.executeCollection('/test-collection', {
      variables: { token: 'injected-token' },
      scriptRunner: TestRunner,
    });

    expect(sentAuthHeader()).toBe('Bearer script-token');
  });
});
