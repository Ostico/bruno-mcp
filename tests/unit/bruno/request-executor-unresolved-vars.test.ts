/**
 * Unresolved-variable warnings.
 *
 * Requests are executed with per-folder VariableStore isolation. In parallel
 * mode each folder gets its own fresh store, so a variable set by a script in
 * folder A is invisible to folder B — a `{{token}}` folder B relies on is left
 * unsubstituted and the literal placeholder used to go on the wire silently
 * (green when the run has no assertions). We keep the isolation (a shared
 * mutable store would reintroduce a concurrent setVar/getVar race) but make the
 * divergence visible: any placeholder left unresolved after substitution is
 * surfaced as a per-request warning. These assert (a) the literal still goes on
 * the wire — isolation is intact — and (b) the run now warns instead of staying
 * silently green.
 */

import { RequestExecutor } from '../../../src/bruno/request-executor';
import * as fs from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Mocks (same harness as request-executor.test.ts)
// ---------------------------------------------------------------------------

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

jest.mock('node:fs/promises');
const mockedFs = jest.mocked(fs);

jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
  ssrfRemediation: jest.fn().mockReturnValue('REMEDIATION_SENTINEL'),
}));

jest.mock('../../../src/bruno/fetch-dispatcher', () => ({
  buildDispatcher: jest.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Fixtures — folder A sets `token`, folder B consumes `{{token}}`
// ---------------------------------------------------------------------------

const LOGIN_YAML = `
info:
  name: Login
  type: http
  seq: 1
http:
  method: POST
  url: "https://api.test/login"
runtime:
  scripts:
    - type: after-response
      code: |
        bru.setVar("token", "jwt-secret-value");
`;

const PROFILE_YAML = `
info:
  name: Get Profile
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.test/profile"
  headers:
    - name: Authorization
      value: "Bearer {{token}}"
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockResponse(body: unknown, status = 200): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  return {
    status,
    statusText: 'OK',
    headers,
    text: jest.fn().mockResolvedValue(
      typeof body === 'string' ? body : JSON.stringify(body),
    ),
    ok: status >= 200 && status < 300,
  } as unknown as Response;
}

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

function setupTwoFolders(): void {
  setupFsReaddirRecursive({
    '/test-collection': [
      { name: 'folderA', isFile: false, isDirectory: true },
      { name: 'folderB', isFile: false, isDirectory: true },
    ],
    '/test-collection/folderA': [
      { name: 'Login.yml', isFile: true, isDirectory: false },
    ],
    '/test-collection/folderB': [
      { name: 'Get Profile.yml', isFile: true, isDirectory: false },
    ],
  });
  setupFsReadFile({ 'Login.yml': LOGIN_YAML, 'Get Profile.yml': PROFILE_YAML });
  setupFsStat(['/test-collection']);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RequestExecutor — unresolved variable warnings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValue(createMockResponse({ ok: true }));
  });

  it('parallel: folder B cannot see folder A\'s variable, so {{token}} stays on the wire and is warned', async () => {
    setupTwoFolders();

    const result = await RequestExecutor.executeCollection('/test-collection', {
      parallel: true,
    });

    expect(result.summary.total).toBe(2);

    // (a) Isolation preserved: the literal placeholder still went on the wire.
    const profileCall = mockFetch.mock.calls.find(
      ([url]) => url === 'https://api.test/profile',
    );
    expect(profileCall).toBeDefined();
    expect(profileCall![1].headers.Authorization).toBe('Bearer {{token}}');

    // (b) The run is no longer silently green: the unresolved variable is named.
    const profileResult = result.results.find(r => r.name === 'Get Profile');
    expect(profileResult).toBeDefined();
    expect(profileResult!.warnings).toContain('unresolved variable: {{token}}');

    // And the warning names the placeholder only — never the resolved value.
    for (const w of profileResult!.warnings ?? []) {
      expect(w).not.toContain('jwt-secret-value');
    }
  });

  it('serial: an unresolved placeholder is also warned (correct in serial too)', async () => {
    // Only folder B exists, so {{token}} is never set even serially.
    setupFsReaddirRecursive({
      '/test-collection': [
        { name: 'Get Profile.yml', isFile: true, isDirectory: false },
      ],
    });
    setupFsReadFile({ 'Get Profile.yml': PROFILE_YAML });
    setupFsStat(['/test-collection']);

    const result = await RequestExecutor.executeCollection('/test-collection');

    expect(result.summary.total).toBe(1);
    expect(result.results[0].warnings).toContain('unresolved variable: {{token}}');
    // Literal placeholder still reaches the wire (single-pass, no bridging).
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer {{token}}');
  });

  it('no warning when every placeholder resolves (serial store propagation)', async () => {
    // Login sets token; a same-folder consumer resolves it serially.
    const CONSUMER_YAML = `
info:
  name: Get Profile
  type: http
  seq: 2
http:
  method: GET
  url: "https://api.test/profile"
  headers:
    - name: Authorization
      value: "Bearer {{token}}"
`;
    setupFsReaddirRecursive({
      '/test-collection': [
        { name: 'Login.yml', isFile: true, isDirectory: false },
        { name: 'Get Profile.yml', isFile: true, isDirectory: false },
      ],
    });
    setupFsReadFile({ 'Login.yml': LOGIN_YAML, 'Get Profile.yml': CONSUMER_YAML });
    setupFsStat(['/test-collection']);

    const result = await RequestExecutor.executeCollection('/test-collection');

    const profileResult = result.results.find(r => r.name === 'Get Profile');
    expect(profileResult).toBeDefined();
    expect(profileResult!.warnings).toBeUndefined();
    // Resolved value did reach the wire.
    const profileCall = mockFetch.mock.calls.find(
      ([url]) => url === 'https://api.test/profile',
    );
    expect(profileCall![1].headers.Authorization).toBe('Bearer jwt-secret-value');
  });
});
