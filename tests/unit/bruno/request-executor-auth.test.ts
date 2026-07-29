/**
 * Auth application at execution.
 *
 * Auth is authored and parsed but was never applied on the wire: a request with
 * bearer/basic/api-key auth sent no credential, so a run against a protected
 * endpoint failed for a reason that looked like the endpoint's, not ours. These
 * assert the credential now reaches the request, that variables in it are
 * substituted, and — the always-green point — that an auth type we cannot apply
 * automatically is surfaced as a warning rather than dropped in silence.
 */

import { buildFetchOptions, bruAuthToYamlAuth } from '../../../src/bruno/request-executor';
import type { BruAuth, YamlAuth, YamlHeader, YamlRequest } from '../../../src/bruno/types';

function req(auth: YamlAuth | undefined, headers: YamlHeader[] = []): YamlRequest {
  return {
    info: { name: 'R', type: 'http' },
    http: { method: 'GET', url: 'https://api.test/resource', headers, auth },
  } as YamlRequest;
}

const noVars = new Map<string, string>();

describe('buildFetchOptions auth application', () => {
  it('sends a bearer token as an Authorization header', async () => {
    const { options } = await buildFetchOptions(req({ type: 'bearer', token: 'abc123' }), noVars);
    expect((options.headers as Record<string, string>).Authorization).toBe('Bearer abc123');
  });

  it('substitutes variables inside the bearer token', async () => {
    const { options } = await buildFetchOptions(
      req({ type: 'bearer', token: '{{token}}' }),
      new Map([['token', 'live-value']]),
    );
    expect((options.headers as Record<string, string>).Authorization).toBe('Bearer live-value');
  });

  it('sends basic auth as a base64 Authorization header', async () => {
    const { options } = await buildFetchOptions(
      req({ type: 'basic', username: 'user', password: 'pass' }),
      noVars,
    );
    const expected = 'Basic ' + Buffer.from('user:pass').toString('base64');
    expect((options.headers as Record<string, string>).Authorization).toBe(expected);
  });

  it('sends an api-key in a header by default', async () => {
    const { options } = await buildFetchOptions(
      req({ type: 'api-key', key: 'X-Api-Key', value: 's3cret' }),
      noVars,
    );
    expect((options.headers as Record<string, string>)['X-Api-Key']).toBe('s3cret');
  });

  it('sends an api-key in the query string when configured', async () => {
    const { url } = await buildFetchOptions(
      req({ type: 'api-key', key: 'api_key', value: 's3cret', in: 'query' }),
      noVars,
    );
    expect(url).toMatch(/[?&]api_key=s3cret/);
  });

  it('warns rather than silently dropping an unsupported oauth2 auth', async () => {
    const { options, warnings } = await buildFetchOptions(req({ type: 'oauth2' }), noVars);
    expect((options.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(warnings?.some(w => /oauth2/i.test(w) && /not applied/i.test(w))).toBe(true);
  });

  it('warns on digest auth', async () => {
    const { warnings } = await buildFetchOptions(
      req({ type: 'digest', username: 'u', password: 'p' }),
      noVars,
    );
    expect(warnings?.some(w => /digest/i.test(w))).toBe(true);
  });

  it('warns that inherited auth is not resolved', async () => {
    const { warnings } = await buildFetchOptions(req('inherit'), noVars);
    expect(warnings?.some(w => /inherit/i.test(w))).toBe(true);
  });

  it('does nothing for no auth', async () => {
    const { options, warnings } = await buildFetchOptions(req(undefined), noVars);
    expect((options.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(warnings ?? []).toEqual([]);
  });

  it('does nothing for an explicit type "none" auth block', async () => {
    const { options, warnings } = await buildFetchOptions(req({ type: 'none' }), noVars);
    expect((options.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(warnings ?? []).toEqual([]);
  });

  it('warns when a bearer token is empty rather than sending "Bearer "', async () => {
    const { options, warnings } = await buildFetchOptions(req({ type: 'bearer', token: '' }), noVars);
    expect((options.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(warnings?.some(w => /bearer/i.test(w))).toBe(true);
  });

  it('warns when an api-key has no key name', async () => {
    const { warnings } = await buildFetchOptions(
      req({ type: 'api-key', key: '', value: 'v', in: 'header' }),
      noVars,
    );
    expect(warnings?.some(w => /api-key/i.test(w) && /key name/i.test(w))).toBe(true);
  });

  it('appends a query api-key with & when the url already has a query string', async () => {
    const yaml = req({ type: 'api-key', key: 'api_key', value: 's3cret', in: 'query' });
    yaml.http.url = 'https://api.test/resource?page=1';
    const { url } = await buildFetchOptions(yaml, noVars);
    expect(url).toBe('https://api.test/resource?page=1&api_key=s3cret');
  });
});

describe('bruAuthToYamlAuth (.bru auth reaches the executor)', () => {
  it('flattens bearer', () => {
    const auth: BruAuth = { type: 'bearer', bearer: { token: 'T' } };
    expect(bruAuthToYamlAuth(auth)).toEqual({ type: 'bearer', token: 'T' });
  });

  it('flattens basic', () => {
    const auth: BruAuth = { type: 'basic', basic: { username: 'u', password: 'p' } };
    expect(bruAuthToYamlAuth(auth)).toEqual({ type: 'basic', username: 'u', password: 'p' });
  });

  it('flattens api-key with its placement', () => {
    // `placement` is the field a real file carries; the flattened `in` is our
    // own internal spelling and stays as it was.
    const auth: BruAuth = {
      type: 'api-key',
      apikey: { key: 'k', value: 'v', placement: 'queryparams' },
    };
    expect(bruAuthToYamlAuth(auth)).toEqual({ type: 'api-key', key: 'k', value: 'v', in: 'query' });
  });

  it('flattens api-key when the file spells the mode Bruno’s way', () => {
    // A request authored in Bruno arrives as `apikey`. Matching only the
    // hyphenated name dropped the key and value and sent the request bare.
    const auth: BruAuth = {
      type: 'apikey',
      apikey: { key: 'k', value: 'v', placement: 'header' },
    };
    expect(bruAuthToYamlAuth(auth)).toEqual({ type: 'api-key', key: 'k', value: 'v', in: 'header' });
  });

  it('carries oauth2 by type only so the executor can warn', () => {
    expect(bruAuthToYamlAuth({ type: 'oauth2' } as BruAuth)).toEqual({ type: 'oauth2' });
  });

  it('drops none and missing auth', () => {
    expect(bruAuthToYamlAuth({ type: 'none' } as BruAuth)).toBeUndefined();
    expect(bruAuthToYamlAuth(undefined)).toBeUndefined();
  });

  it('defaults an api-key with missing fields to empty header placement', () => {
    expect(bruAuthToYamlAuth({ type: 'api-key' } as BruAuth)).toEqual({
      type: 'api-key',
      key: '',
      value: '',
      in: 'header',
    });
  });
});

/**
 * Unresolved-variable warnings.
 *
 * When substitution leaves a `{{var}}` placeholder unresolved the literal used
 * to go on the wire silently. buildFetchOptions now names each unresolved
 * placeholder in `warnings`, across every substituted surface (url, headers,
 * auth, body). The warning names the placeholder only — never a resolved value,
 * which may be a secret.
 */
describe('buildFetchOptions unresolved-variable warnings', () => {
  const noVars = new Map<string, string>();

  function reqWith(overrides: Partial<YamlRequest['http']>): YamlRequest {
    return {
      info: { name: 'R', type: 'http' },
      http: { method: 'GET', url: 'https://api.test/resource', headers: [], ...overrides },
    } as YamlRequest;
  }

  it('warns when the URL references an unresolved variable', async () => {
    const { url, warnings } = await buildFetchOptions(
      reqWith({ url: 'https://api.test/{{path}}' }),
      noVars,
    );
    expect(url).toBe('https://api.test/{{path}}');
    expect(warnings).toContain('unresolved variable: {{path}}');
  });

  it('warns when a header references an unresolved variable', async () => {
    const { warnings } = await buildFetchOptions(
      reqWith({ headers: [{ name: 'Authorization', value: 'Bearer {{token}}' }] }),
      noVars,
    );
    expect(warnings).toContain('unresolved variable: {{token}}');
  });

  it('warns when a bearer token references an unresolved variable (auth surface)', async () => {
    const { options, warnings } = await buildFetchOptions(
      reqWith({ auth: { type: 'bearer', token: '{{token}}' } }),
      noVars,
    );
    // Isolation preserved: the literal placeholder still reaches the wire.
    expect((options.headers as Record<string, string>).Authorization).toBe('Bearer {{token}}');
    expect(warnings).toContain('unresolved variable: {{token}}');
  });

  it('warns for an unresolved variable inside a string body', async () => {
    const { warnings } = await buildFetchOptions(
      reqWith({ method: 'POST', body: { type: 'json', data: '{"id": "{{userId}}"}' } }),
      noVars,
    );
    expect(warnings).toContain('unresolved variable: {{userId}}');
  });

  it('warns for an unresolved variable inside a multipart text part', async () => {
    const { warnings } = await buildFetchOptions(
      reqWith({
        method: 'POST',
        body: {
          type: 'multipart-form',
          data: [{ name: 'field', value: '{{secretRef}}', type: 'text' }],
        },
      }),
      noVars,
    );
    expect(warnings).toContain('unresolved variable: {{secretRef}}');
  });

  it('de-duplicates repeated placeholders and preserves first-seen order', async () => {
    const { warnings } = await buildFetchOptions(
      reqWith({
        url: 'https://api.test/{{a}}/{{a}}',
        headers: [{ name: 'X-B', value: '{{b}}' }],
      }),
      noVars,
    );
    expect(warnings).toEqual([
      'unresolved variable: {{a}}',
      'unresolved variable: {{b}}',
    ]);
  });

  it('names only the placeholder, never the resolved secret value', async () => {
    const { warnings } = await buildFetchOptions(
      reqWith({
        headers: [
          { name: 'Authorization', value: 'Bearer {{known}}' },
          { name: 'X-Extra', value: '{{missing}}' },
        ],
      }),
      new Map([['known', 'super-secret-token']]),
    );
    expect(warnings).toEqual(['unresolved variable: {{missing}}']);
    for (const w of warnings ?? []) {
      expect(w).not.toContain('super-secret-token');
    }
  });

  it('omits the warnings key entirely when every placeholder resolves', async () => {
    const result = await buildFetchOptions(
      reqWith({ url: 'https://api.test/{{path}}' }),
      new Map([['path', 'users']]),
    );
    expect(result.url).toBe('https://api.test/users');
    expect(result.warnings).toBeUndefined();
  });
});
