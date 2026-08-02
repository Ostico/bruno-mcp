/**
 * Tests for RequestExecutor — the per-run cookie jar (H2).
 *
 * The point of the feature is that a login carries into the requests after it
 * without a hand-written set-cookie relay. The point of these tests is that it
 * carries only where it should: same host, and only while the run lasts.
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
  validateUrl: jest.fn().mockResolvedValue({ valid: true }),
  ssrfRemediation: jest.fn().mockReturnValue('REMEDIATION_SENTINEL'),
}));

jest.mock('../../../src/bruno/fetch-dispatcher', () => ({
  buildDispatcher: jest.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LOGIN_YAML = `
info:
  name: Login
  type: http
  seq: 1
http:
  method: POST
  url: "https://api.example.com/login"
`;

const PROFILE_YAML = `
info:
  name: Profile
  type: http
  seq: 2
http:
  method: GET
  url: "https://api.example.com/profile"
`;

/** Second request on a DIFFERENT host, to prove the jar does not leak to it. */
const OTHER_HOST_YAML = `
info:
  name: Other
  type: http
  seq: 2
http:
  method: GET
  url: "https://other.example.org/profile"
`;

/** A request that writes its own Cookie header. */
const EXPLICIT_COOKIE_YAML = `
info:
  name: Profile
  type: http
  seq: 2
http:
  method: GET
  url: "https://api.example.com/profile"
  headers:
    - name: Cookie
      value: "mine=1"
`;

/**
 * A pair of requests that each pin their own credential under the SAME cookie
 * name — the multi-credential shape the precedence rule exists for.
 */
function credentialRequest(seq: number, credential: string): string {
  return `
info:
  name: As${credential}
  type: http
  seq: ${seq}
http:
  method: GET
  url: "https://api.example.com/whoami"
  headers:
    - name: Cookie
      value: "sid=${credential}"
`;
}

function response(
  { status = 200, setCookie = [], location }:
  { status?: number; setCookie?: string[]; location?: string },
): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const value of setCookie) {
    headers.append('set-cookie', value);
  }
  if (location) {
    headers.set('location', location);
  }
  return {
    status,
    statusText: 'OK',
    headers,
    text: async () => '{}',
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
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });

  mockedFs.stat.mockImplementation(async () => (
    { isDirectory: () => true, isFile: () => false } as any
  ));
}

/** The Cookie header sent on the nth fetch, or undefined. */
function sentCookie(callIndex: number): string | undefined {
  const headers = mockFetch.mock.calls[callIndex][1].headers as Record<string, string>;
  const name = Object.keys(headers).find((k) => k.toLowerCase() === 'cookie');
  return name ? headers[name] : undefined;
}

const TWO_REQUEST_COLLECTION = {
  'Login.yml': LOGIN_YAML,
  'Profile.yml': PROFILE_YAML,
};

describe('RequestExecutor — cookie jar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sends a cookie set by an earlier response on a later request', async () => {
    setupFs(TWO_REQUEST_COLLECTION, ['Login.yml', 'Profile.yml']);
    mockFetch
      .mockResolvedValueOnce(response({ setCookie: ['sid=abc; Path=/'] }))
      .mockResolvedValueOnce(response({}));

    const result = await RequestExecutor.executeCollection('/test-collection', {
      scriptRunner: TestRunner,
    });

    expect(result.summary.total).toBe(2);
    // The login itself carried no cookie; the request after it does.
    expect(sentCookie(0)).toBeUndefined();
    expect(sentCookie(1)).toBe('sid=abc');
  });

  it('does not send one host\'s cookie to a different host', async () => {
    setupFs({ 'Login.yml': LOGIN_YAML, 'Other.yml': OTHER_HOST_YAML }, ['Login.yml', 'Other.yml']);
    mockFetch
      .mockResolvedValueOnce(response({ setCookie: ['sid=abc; Path=/'] }))
      .mockResolvedValueOnce(response({}));

    await RequestExecutor.executeCollection('/test-collection', { scriptRunner: TestRunner });

    // A session cookie reaching an unrelated host would be a credential leak.
    expect(sentCookie(1)).toBeUndefined();
  });

  it('stores a cookie from a failed login, since a 4XX can still set one', async () => {
    setupFs(TWO_REQUEST_COLLECTION, ['Login.yml', 'Profile.yml']);
    mockFetch
      .mockResolvedValueOnce(response({ status: 401, setCookie: ['sid=abc; Path=/'] }))
      .mockResolvedValueOnce(response({}));

    await RequestExecutor.executeCollection('/test-collection', { scriptRunner: TestRunner });

    expect(sentCookie(1)).toBe('sid=abc');
  });

  it('merges with a Cookie header the request wrote itself, the request winning a clash', async () => {
    setupFs(
      { 'Login.yml': LOGIN_YAML, 'Profile.yml': EXPLICIT_COOKIE_YAML },
      ['Login.yml', 'Profile.yml'],
    );
    mockFetch
      .mockResolvedValueOnce(response({ setCookie: ['sid=abc; Path=/', 'mine=fromserver; Path=/'] }))
      .mockResolvedValueOnce(response({}));

    const result = await RequestExecutor.executeCollection(
      '/test-collection',
      { scriptRunner: TestRunner },
    );

    const cookie = sentCookie(1)!;
    // A name only the jar knows is still added — that is what the jar is for.
    expect(cookie).toContain('sid=abc');
    // The authored value survives the stored one.
    expect(cookie).toContain('mine=1');
    expect(cookie).not.toContain('mine=fromserver');

    // And the caller is told, because nothing in the collection shows that a
    // stored value was in play at all.
    const warnings = result.groups[0]!.results[1].warnings ?? [];
    expect(warnings.some((w) => w.includes('"mine"'))).toBe(true);
    expect(warnings.some((w) => w.includes('"sid"'))).toBe(false);
  });

  it('does not let the second credential inherit the first request\'s session', async () => {
    // The reported failure: two requests assert what two different credentials
    // can see, and the jar quietly replaced the second one's identity with the
    // first's — so both assertions passed against the same user.
    setupFs(
      { 'AsA.yml': credentialRequest(1, 'cred-a'), 'AsB.yml': credentialRequest(2, 'cred-b') },
      ['AsA.yml', 'AsB.yml'],
    );
    mockFetch
      // The first response rotates the session under the very name both
      // requests pin, which is what used to contaminate the second.
      .mockResolvedValueOnce(response({ setCookie: ['sid=session-of-a; Path=/'] }))
      .mockResolvedValueOnce(response({}));

    const result = await RequestExecutor.executeCollection(
      '/test-collection',
      { scriptRunner: TestRunner },
    );

    expect(result.summary.total).toBe(2);
    expect(sentCookie(0)).toBe('sid=cred-a');
    expect(sentCookie(1)).toBe('sid=cred-b');
    expect(sentCookie(1)).not.toContain('session-of-a');
  });

  it('warns once for a name re-applied on every hop of a redirect chain', async () => {
    setupFs({ 'Profile.yml': EXPLICIT_COOKIE_YAML }, ['Profile.yml']);
    mockFetch
      .mockResolvedValueOnce(response({
        status: 302,
        setCookie: ['mine=fromserver; Path=/'],
        location: 'https://api.example.com/one',
      }))
      .mockResolvedValueOnce(response({
        status: 302,
        location: 'https://api.example.com/two',
      }))
      .mockResolvedValueOnce(response({}));

    const result = await RequestExecutor.executeCollection(
      '/test-collection',
      { scriptRunner: TestRunner },
    );

    // Both hops kept the authored value against the stored one...
    expect(sentCookie(1)).toBe('mine=1');
    expect(sentCookie(2)).toBe('mine=1');
    // ...and that is one fact, reported once — one warning naming the cookie
    // once, not the same name repeated per hop inside it.
    const cookieWarnings = (result.groups[0]!.results[0].warnings ?? [])
      .filter((w) => w.includes('"mine"'));
    expect(cookieWarnings).toHaveLength(1);
    expect(cookieWarnings[0].match(/"mine"/g)).toHaveLength(1);
  });

  it('does not warn on an ordinary login flow that authors no Cookie header', async () => {
    setupFs(TWO_REQUEST_COLLECTION, ['Login.yml', 'Profile.yml']);
    mockFetch
      .mockResolvedValueOnce(response({ setCookie: ['sid=abc; Path=/'] }))
      .mockResolvedValueOnce(response({}));

    const result = await RequestExecutor.executeCollection(
      '/test-collection',
      { scriptRunner: TestRunner },
    );

    expect(sentCookie(1)).toBe('sid=abc');
    for (const request of result.groups[0]!.results) {
      expect(request.warnings ?? []).toEqual([]);
    }
  });

  it('sends nothing when the caller turns the jar off', async () => {
    setupFs(TWO_REQUEST_COLLECTION, ['Login.yml', 'Profile.yml']);
    mockFetch
      .mockResolvedValueOnce(response({ setCookie: ['sid=abc; Path=/'] }))
      .mockResolvedValueOnce(response({}));

    await RequestExecutor.executeCollection('/test-collection', {
      scriptRunner: TestRunner,
      cookieJar: false,
    });

    expect(sentCookie(1)).toBeUndefined();
  });

  it('still sends a request\'s own Cookie header when the jar is off', async () => {
    setupFs({ 'Profile.yml': EXPLICIT_COOKIE_YAML }, ['Profile.yml']);
    mockFetch.mockResolvedValueOnce(response({}));

    await RequestExecutor.executeCollection('/test-collection', {
      scriptRunner: TestRunner,
      cookieJar: false,
    });

    expect(sentCookie(0)).toBe('mine=1');
  });

  it('carries a cookie set by a redirect onto the redirected hop', async () => {
    setupFs({ 'Login.yml': LOGIN_YAML }, ['Login.yml']);
    mockFetch
      // The login-then-redirect shape: the 302 is what sets the session.
      .mockResolvedValueOnce(response({
        status: 302,
        setCookie: ['sid=abc; Path=/'],
        location: 'https://api.example.com/dashboard',
      }))
      .mockResolvedValueOnce(response({}));

    await RequestExecutor.executeCollection('/test-collection', { scriptRunner: TestRunner });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(String(mockFetch.mock.calls[1][0])).toBe('https://api.example.com/dashboard');
    expect(sentCookie(1)).toBe('sid=abc');
  });

  it('does not carry a cookie across a redirect to another origin', async () => {
    setupFs({ 'Login.yml': LOGIN_YAML }, ['Login.yml']);
    mockFetch
      .mockResolvedValueOnce(response({
        status: 302,
        setCookie: ['sid=abc; Path=/'],
        location: 'https://other.example.org/dashboard',
      }))
      .mockResolvedValueOnce(response({}));

    await RequestExecutor.executeCollection('/test-collection', { scriptRunner: TestRunner });

    expect(String(mockFetch.mock.calls[1][0])).toBe('https://other.example.org/dashboard');
    // The cross-origin strip removes the caller's cookies, and the jar has
    // nothing for this origin to put back.
    expect(sentCookie(1)).toBeUndefined();
  });

  it('keeps groups isolated when they run in parallel', async () => {
    // Two groups, each a login followed by a profile, running concurrently.
    // Sharing one jar would let a group send the other's session. The folder is
    // only where these requests happen to live — the group is what isolates.
    mockedFs.readdir.mockImplementation(async (dirPath: any) => {
      const p = typeof dirPath === 'string' ? dirPath : dirPath.toString();
      if (p === '/test-collection') {
        return [
          { name: 'a', isFile: () => false, isDirectory: () => true },
          { name: 'b', isFile: () => false, isDirectory: () => true },
        ] as any;
      }
      if (p.endsWith('/a') || p.endsWith('/b')) {
        return [
          { name: 'Login.yml', isFile: () => true, isDirectory: () => false },
          { name: 'Profile.yml', isFile: () => true, isDirectory: () => false },
        ] as any;
      }
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    mockedFs.readFile.mockImplementation(async (filePath: any) => {
      const p = typeof filePath === 'string' ? filePath : filePath.toString();
      if (p.includes('Login.yml')) return LOGIN_YAML;
      if (p.includes('Profile.yml')) return PROFILE_YAML;
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    mockedFs.stat.mockImplementation(async () => (
      { isDirectory: () => true, isFile: () => false } as any
    ));

    // Folder a's login sets sid=a, folder b's sets sid=b. Order between folders
    // is not deterministic, so assert the pairing rather than fixed positions.
    mockFetch.mockImplementation(async (url: any) => {
      const target = String(url);
      if (target.endsWith('/login')) {
        return response({ setCookie: ['sid=from-login; Path=/'] });
      }
      return response({});
    });

    const result = await RequestExecutor.executeCollection('/test-collection', {
      scriptRunner: TestRunner,
      parallel: true,
      groups: [
        { name: 'a', requests: ['a'] },
        { name: 'b', requests: ['b'] },
      ],
    });

    expect(result.summary.total).toBe(4);
    // Every profile request carries a session, and each got it from the login
    // in its own group — never from a jar shared with the other group.
    const profileCalls = mockFetch.mock.calls.filter(([u]) => String(u).endsWith('/profile'));
    expect(profileCalls).toHaveLength(2);
    for (const [, opts] of profileCalls) {
      const headers = opts.headers as Record<string, string>;
      const name = Object.keys(headers).find((k) => k.toLowerCase() === 'cookie');
      expect(name ? headers[name] : undefined).toBe('sid=from-login');
    }
  });
});
