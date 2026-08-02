/**
 * Digest and oauth2 reaching the wire, through a real run.
 *
 * `auth-digest.test.ts` and `auth-oauth2.test.ts` cover the computations. This
 * covers the part that was actually broken: both schemes were understood by the
 * parser and performed by nobody, so a request configured with either went out
 * unauthenticated. What matters here is the request the server would have seen.
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'node:crypto';
import { RequestExecutor } from '../../../src/bruno/request-executor';
import { TestRunner } from '../../../src/bruno/test-runner';

const mockFetch = jest.fn();
(global as unknown as { fetch: unknown }).fetch = mockFetch;

jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockResolvedValue({ valid: true }),
  ssrfRemediation: jest.fn().mockReturnValue(''),
}));

const ok = (body: unknown = { ok: true }): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

const unauthorized = (challenge: string): Response =>
  ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    headers: new Headers({ 'www-authenticate': challenge }),
    text: async () => '',
  }) as unknown as Response;

beforeEach(() => jest.clearAllMocks());

async function collection(layout: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'auth-e2e-'));
  for (const [name, content] of Object.entries(layout)) {
    const full = join(root, name);
    await fs.mkdir(join(full, '..'), { recursive: true });
    await fs.writeFile(full, content);
  }
  return root;
}

const run = (root: string, variables?: Record<string, string>) =>
  RequestExecutor.executeCollection(root, { scriptRunner: TestRunner, variables });

/** Headers of the nth outbound call. */
const sent = (n: number): Record<string, string> =>
  (mockFetch.mock.calls[n][1].headers ?? {}) as Record<string, string>;

describe('digest auth through a run', () => {
  const digestRequest = `info:
  name: secret
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.test/vault"
  auth:
    type: digest
    username: Mufasa
    password: "{{secret_word}}"
`;

  it('answers the 401 challenge and re-sends with a computed credential', async () => {
    mockFetch
      .mockResolvedValueOnce(
        unauthorized('Digest realm="vault", qop="auth", nonce="NONCE1", opaque="OP"'),
      )
      .mockResolvedValueOnce(ok());
    const root = await collection({ 'r.yml': digestRequest });

    const result = await run(root, { secret_word: 'Circle Of Life' });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // First attempt carries nothing: the nonce did not exist yet.
    expect(sent(0).Authorization).toBeUndefined();

    const header = sent(1).Authorization;
    const md5 = (s: string): string => createHash('md5').update(s).digest('hex');
    const ha1 = md5('Mufasa:vault:Circle Of Life');
    const cnonce = /cnonce="([^"]+)"/.exec(header)![1];
    expect(header).toContain(
      `response="${md5(`${ha1}:NONCE1:00000001:${cnonce}:auth:${md5('GET:/vault')}`)}"`,
    );
    expect(header).toContain('opaque="OP"');
    expect(result.summary.passed).toBe(1);
  });

  it('resolves a placeholder in the password, which nothing had substituted before', async () => {
    // Digest contributes no header to the first request, so its credentials
    // never went through substitution on the way out; the retry is the first
    // and only place they can be resolved.
    mockFetch
      .mockResolvedValueOnce(unauthorized('Digest realm="vault", qop="auth", nonce="N"'))
      .mockResolvedValueOnce(ok());
    const root = await collection({ 'r.yml': digestRequest });

    await run(root, { secret_word: 'Circle Of Life' });

    expect(sent(1).Authorization).not.toContain('{{secret_word}}');
  });

  it('does not retry a 401 that carries no digest challenge', async () => {
    mockFetch.mockResolvedValueOnce(unauthorized('Basic realm="vault"'));
    const root = await collection({ 'r.yml': digestRequest });

    await run(root);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries only once, so a wrong password cannot loop', async () => {
    const challenge = unauthorized('Digest realm="v", qop="auth", nonce="N"');
    mockFetch.mockResolvedValue(challenge);
    const root = await collection({ 'r.yml': digestRequest });

    await run(root, { secret_word: 'wrong' });

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a successful response that happens to carry a challenge', async () => {
    // Some servers send WWW-Authenticate on a 200 — advertising a scheme rather
    // than refusing. Retrying there would double every such request and replace
    // a good response with the answer to a challenge nobody made.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({
        'content-type': 'application/json',
        'www-authenticate': 'Digest realm="v", qop="auth", nonce="N"',
      }),
      text: async () => '{}',
    } as unknown as Response);
    const root = await collection({ 'r.yml': digestRequest });

    await run(root, { secret_word: 'x' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('leaves a non-digest request alone when a server answers 401', async () => {
    mockFetch.mockResolvedValueOnce(unauthorized('Digest realm="v", nonce="N"'));
    const root = await collection({
      'r.yml': `info:
  name: plain
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.test/x"
  auth:
    type: bearer
    token: T
`,
    });

    await run(root);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('oauth2 through a run', () => {
  const oauthRequest = (grantType: string): string => `info:
  name: api
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.test/data"
  auth:
    type: oauth2
    grantType: ${grantType}
    accessTokenUrl: "https://idp.test/token"
    clientId: id
    clientSecret: "{{client_secret}}"
`;

  it('fetches a token and sends it as a bearer credential', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ access_token: 'AT-123' }))
      .mockResolvedValueOnce(ok());
    const root = await collection({ 'r.yml': oauthRequest('client_credentials') });

    const result = await run(root, { client_secret: 's3cret' });

    expect(mockFetch.mock.calls[0][0]).toBe('https://idp.test/token');
    expect(new URLSearchParams(mockFetch.mock.calls[0][1].body).get('client_secret')).toBe('s3cret');
    expect(mockFetch.mock.calls[1][0]).toBe('https://api.test/data');
    expect(sent(1).Authorization).toBe('Bearer AT-123');
    expect(result.summary.passed).toBe(1);
  });

  it('warns and sends no credential for a grant that needs a browser', async () => {
    mockFetch.mockResolvedValue(ok());
    const root = await collection({ 'r.yml': oauthRequest('authorization_code') });

    const result = await run(root);

    // One call: no token was fetched, and the request still went out.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sent(0).Authorization).toBeUndefined();
    const warnings = (result.results?.[0] as { warnings?: string[] }).warnings ?? [];
    expect(warnings.join(' ')).toContain('authorization_code');
  });

  it('reports why the request went out unauthenticated when the token fetch fails', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ error: 'invalid_client' }))
      .mockResolvedValueOnce(ok());
    const root = await collection({ 'r.yml': oauthRequest('client_credentials') });

    const result = await run(root, { client_secret: 'wrong' });

    expect(sent(1).Authorization).toBeUndefined();
    const warnings = (result.results?.[0] as { warnings?: string[] }).warnings ?? [];
    expect(warnings.join(' ')).toContain('invalid_client');
  });

  it('fetches one token for a run of several requests sharing a config', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ access_token: 'AT' }))
      .mockResolvedValue(ok());
    const root = await collection({
      'a.yml': oauthRequest('client_credentials').replace('name: api', 'name: a'),
      'b.yml': oauthRequest('client_credentials')
        .replace('name: api', 'name: b')
        .replace('seq: 1', 'seq: 2'),
    });

    await run(root, { client_secret: 's' });

    const tokenCalls = mockFetch.mock.calls.filter((c) => c[0] === 'https://idp.test/token');
    expect(tokenCalls).toHaveLength(1);
    expect(sent(1).Authorization).toBe('Bearer AT');
    expect(sent(2).Authorization).toBe('Bearer AT');
  });
});
