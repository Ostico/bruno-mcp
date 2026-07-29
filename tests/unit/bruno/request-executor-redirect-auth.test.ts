/**
 * Credential stripping on cross-origin redirects.
 *
 * The manual redirect loop reused the same headers on every hop, so a target
 * that 302s to another origin received the caller's Authorization, api-key, or
 * cookies. These cover the two building blocks: buildFetchOptions reports which
 * header names carry auth (so a caller-named api-key header is known, not just
 * Authorization), and stripCredentialHeaders drops exactly those plus the
 * always-sensitive set. The loop wiring is covered in request-executor.test.ts.
 */

import {
  buildFetchOptions,
  stripCredentialHeaders,
} from '../../../src/bruno/request-executor';
import type { YamlAuth, YamlRequest } from '../../../src/bruno/types';

function req(auth: YamlAuth | undefined): YamlRequest {
  return {
    info: { name: 'R', type: 'http' },
    http: { method: 'GET', url: 'https://api.test/resource', headers: [], auth },
  } as YamlRequest;
}
const noVars = new Map<string, string>();

describe('buildFetchOptions reports the header names that carry auth', () => {
  it('reports Authorization for bearer auth', async () => {
    const { authHeaderNames } = await buildFetchOptions(req({ type: 'bearer', token: 't' }), noVars);
    expect(authHeaderNames).toEqual(['Authorization']);
  });

  it('reports Authorization for basic auth', async () => {
    const { authHeaderNames } = await buildFetchOptions(
      req({ type: 'basic', username: 'u', password: 'p' }),
      noVars,
    );
    expect(authHeaderNames).toEqual(['Authorization']);
  });

  it('reports the caller-named header for a header api-key', async () => {
    const { authHeaderNames } = await buildFetchOptions(
      req({ type: 'api-key', key: 'X-Api-Key', value: 's', in: 'header' }),
      noVars,
    );
    expect(authHeaderNames).toEqual(['X-Api-Key']);
  });

  it('reports no header names for a query api-key (nothing to strip from headers)', async () => {
    const { authHeaderNames } = await buildFetchOptions(
      req({ type: 'api-key', key: 'api_key', value: 's', in: 'query' }),
      noVars,
    );
    expect(authHeaderNames).toBeUndefined();
  });

  it('reports no header names when there is no auth', async () => {
    const { authHeaderNames } = await buildFetchOptions(req(undefined), noVars);
    expect(authHeaderNames).toBeUndefined();
  });
});

describe('stripCredentialHeaders', () => {
  it('drops the always-sensitive headers case-insensitively', () => {
    const out = stripCredentialHeaders(
      { Authorization: 'Bearer x', Cookie: 'a=b', 'Proxy-Authorization': 'y', Accept: 'application/json' },
      [],
    );
    expect(out).toEqual({ Accept: 'application/json' });
  });

  it('also drops the request-specific auth header names', () => {
    const out = stripCredentialHeaders(
      { 'X-Api-Key': 'secret', 'X-Trace': 'keep' },
      ['X-Api-Key'],
    );
    expect(out).toEqual({ 'X-Trace': 'keep' });
  });

  it('matches auth header names case-insensitively', () => {
    const out = stripCredentialHeaders({ 'x-api-key': 'secret' }, ['X-Api-Key']);
    expect(out).toEqual({});
  });

  it('keeps everything when nothing is sensitive', () => {
    const headers = { Accept: 'application/json', 'X-Trace': '1' };
    expect(stripCredentialHeaders(headers, [])).toEqual(headers);
  });
});
