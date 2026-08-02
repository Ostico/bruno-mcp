/**
 * Fetching an OAuth2 access token for the grants a headless server can run.
 *
 * The token endpoint is an outbound request to a URL that comes out of the
 * collection, so most of what matters here is what gets sent and what happens
 * when the answer is not a token — including the SSRF gate, which the request
 * path enforces and which this must not be a way around.
 */
import {
  fetchAccessToken,
  createTokenCache,
  isAutomatableGrant,
  resolveOAuth2,
} from '../../../src/bruno/auth-oauth2';
import type { YamlRequest } from '../../../src/bruno/types';
import type { RootChain } from '../../../src/bruno/collection-roots';
import { validateUrl } from '../../../src/bruno/url-validator';

jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockResolvedValue({ valid: true }),
  ssrfRemediation: jest.fn().mockReturnValue(''),
}));

const mockedValidate = jest.mocked(validateUrl);

function tokenResponse(body: unknown, status = 200): Response {
  return {
    status,
    ok: status < 400,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const config = {
  grantType: 'client_credentials',
  accessTokenUrl: 'https://idp.test/token',
  clientId: 'id',
  clientSecret: 'secret',
  scope: 'read',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedValidate.mockResolvedValue({ valid: true } as never);
});

describe('which grants can run without a browser', () => {
  it.each(['client_credentials', 'password'])('accepts %s', (grant) => {
    expect(isAutomatableGrant(grant)).toBe(true);
  });

  it.each(['authorization_code', 'implicit', undefined])('refuses %s', (grant) => {
    expect(isAutomatableGrant(grant)).toBe(false);
  });
});

describe('fetching a token', () => {
  it('posts a form-encoded client_credentials grant and returns the token', async () => {
    const fetchFn = jest.fn().mockResolvedValue(tokenResponse({ access_token: 'AT' }));

    const result = await fetchAccessToken(config, fetchFn as never, createTokenCache());

    expect(result).toEqual({ token: 'AT' });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://idp.test/token');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('client_id')).toBe('id');
    expect(body.get('client_secret')).toBe('secret');
    expect(body.get('scope')).toBe('read');
  });

  it('sends the resource owner credentials for a password grant', async () => {
    const fetchFn = jest.fn().mockResolvedValue(tokenResponse({ access_token: 'AT' }));

    await fetchAccessToken(
      { ...config, grantType: 'password', username: 'u', password: 'p' },
      fetchFn as never,
      createTokenCache(),
    );

    const body = new URLSearchParams(fetchFn.mock.calls[0][1].body as string);
    expect(body.get('username')).toBe('u');
    expect(body.get('password')).toBe('p');
  });

  it('moves the client credentials to a Basic header when asked, and out of the body', async () => {
    const fetchFn = jest.fn().mockResolvedValue(tokenResponse({ access_token: 'AT' }));

    await fetchAccessToken(
      { ...config, credentialsPlacement: 'basic_auth_header' },
      fetchFn as never,
      createTokenCache(),
    );

    const [, init] = fetchFn.mock.calls[0];
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('id:secret').toString('base64')}`);
    // Sending them twice is what a provider rejects as an invalid_client.
    expect(new URLSearchParams(init.body as string).get('client_secret')).toBeNull();
  });

  it('fetches once for repeated requests that want the same token', async () => {
    const fetchFn = jest.fn().mockResolvedValue(tokenResponse({ access_token: 'AT' }));
    const cache = createTokenCache();

    await Promise.all([
      fetchAccessToken(config, fetchFn as never, cache),
      fetchAccessToken(config, fetchFn as never, cache),
    ]);
    await fetchAccessToken(config, fetchFn as never, cache);

    // A run of forty requests should not look like forty logins to a provider
    // that rate-limits token issuance.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('keeps tokens for different scopes apart', async () => {
    const fetchFn = jest.fn().mockResolvedValue(tokenResponse({ access_token: 'AT' }));
    const cache = createTokenCache();

    await fetchAccessToken(config, fetchFn as never, cache);
    await fetchAccessToken({ ...config, scope: 'write' }, fetchFn as never, cache);

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('refuses a token endpoint the SSRF gate blocks', async () => {
    // Without this the token URL is a way to reach link-local metadata that the
    // request path already closes, with the response readable via the warning.
    mockedValidate.mockResolvedValue({ valid: false, reason: 'link-local address' } as never);
    const fetchFn = jest.fn();

    const result = await fetchAccessToken(
      { ...config, accessTokenUrl: 'http://169.254.169.254/token' },
      fetchFn as never,
      createTokenCache(),
    );

    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.token).toBeUndefined();
    expect(result.error).toContain('link-local address');
  });

  it('reports rather than throws when the endpoint is unreachable', async () => {
    const fetchFn = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await fetchAccessToken(config, fetchFn as never, createTokenCache());

    expect(result.error).toContain('ECONNREFUSED');
    expect(result.token).toBeUndefined();
  });

  it('reports a non-JSON body with its status', async () => {
    const fetchFn = jest.fn().mockResolvedValue(tokenResponse('<html>gateway timeout</html>', 504));

    const result = await fetchAccessToken(config, fetchFn as never, createTokenCache());

    expect(result.error).toContain('504');
    expect(result.error).toContain('not JSON');
  });

  it("quotes the provider's own error when it refuses", async () => {
    const fetchFn = jest.fn().mockResolvedValue(tokenResponse({ error: 'invalid_client' }, 401));

    const result = await fetchAccessToken(config, fetchFn as never, createTokenCache());

    expect(result.error).toContain('invalid_client');
  });

  it('resolves a token for a request whose auth is an automatable grant', async () => {
    const fetchFn = jest.fn().mockResolvedValue(tokenResponse({ access_token: 'AT' }));
    const yaml = { http: { auth: { type: 'oauth2', ...config } } } as unknown as YamlRequest;

    const result = await resolveOAuth2(yaml, undefined, new Map(), createTokenCache(), fetchFn as never);

    expect(result).toEqual({ token: 'AT' });
  });

  it('substitutes placeholders in the oauth2 config', async () => {
    // A client secret belongs in an environment or an injected variable, not in
    // the collection file.
    const fetchFn = jest.fn().mockResolvedValue(tokenResponse({ access_token: 'AT' }));
    const yaml = {
      http: { auth: { type: 'oauth2', ...config, clientSecret: '{{secret}}' } },
    } as unknown as YamlRequest;

    await resolveOAuth2(
      yaml, undefined, new Map([['secret', 'resolved']]), createTokenCache(), fetchFn as never,
    );

    expect(new URLSearchParams(fetchFn.mock.calls[0][1].body).get('client_secret')).toBe('resolved');
  });

  it('resolves inherit against the collection root, like every other mode', async () => {
    const fetchFn = jest.fn().mockResolvedValue(tokenResponse({ access_token: 'AT' }));
    const yaml = { http: { auth: 'inherit' } } as unknown as YamlRequest;
    const chain = { auth: { type: 'oauth2', ...config } } as unknown as RootChain;

    const result = await resolveOAuth2(yaml, chain, new Map(), createTokenCache(), fetchFn as never);

    expect(result).toEqual({ token: 'AT' });
  });

  it.each([
    ['no auth at all', undefined],
    ['a bearer token', { type: 'bearer', token: 'T' }],
    ['a browser grant', { type: 'oauth2', grantType: 'authorization_code' }],
    ['inherit with nothing to inherit', 'inherit'],
  ])('costs a request with %s nothing', async (_label, auth) => {
    const fetchFn = jest.fn();
    const yaml = { http: { auth } } as unknown as YamlRequest;

    const result = await resolveOAuth2(yaml, undefined, new Map(), createTokenCache(), fetchFn as never);

    expect(result).toEqual({});
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('reports a missing access token URL instead of fetching undefined', async () => {
    const fetchFn = jest.fn();

    const result = await fetchAccessToken(
      { ...config, accessTokenUrl: undefined },
      fetchFn as never,
      createTokenCache(),
    );

    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.error).toContain('no access token URL');
  });
});
