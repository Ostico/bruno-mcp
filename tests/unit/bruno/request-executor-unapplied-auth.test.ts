/**
 * What the executor refuses to pretend it can authenticate.
 *
 * This file used to assert that `oauth2` and `digest` were both accepted by the
 * type surface and performed by nothing — each producing a warning and no
 * credential. L3 implemented both, so `UnappliedAuthType` is now `never` and the
 * question changed. What has to stay true is the original rule: the executor may
 * decline to perform a scheme, but it must never send an unauthenticated request
 * while the collection says auth is configured and say nothing about it.
 *
 * Two cases still decline, for different reasons, and both are pinned here.
 */

import { buildFetchOptions } from '../../../src/bruno/request-executor';
import type { YamlRequest } from '../../../src/bruno/types';

function requestWithAuth(auth: unknown): YamlRequest {
  return {
    info: { name: 'Authed', type: 'http', seq: 1 },
    http: { method: 'GET', url: 'https://api.test/r', auth },
  } as unknown as YamlRequest;
}

describe('auth the executor declines to perform', () => {
  it.each(['authorization_code', 'implicit'])(
    'warns and sends nothing for the oauth2 %s grant',
    async (grantType) => {
      // Not an effort gap: both are defined around redirecting a human's
      // browser and catching the redirect back, which a headless server has no
      // way to do.
      const { options, warnings } = await buildFetchOptions(
        requestWithAuth({ type: 'oauth2', grantType, clientSecret: 'SUPERSECRET' }),
        new Map(),
      );

      expect(options.headers).toEqual({});
      expect(warnings).toEqual(expect.arrayContaining([expect.stringContaining(grantType)]));
      expect(warnings![0]).toContain('browser');
      // A warning crosses back to the caller, so it must never carry the value.
      expect(JSON.stringify(warnings)).not.toContain('SUPERSECRET');
    },
  );

  it('warns by name and sends no credential for an unrecognised mode', async () => {
    const { options, warnings } = await buildFetchOptions(
      requestWithAuth({ type: 'ntlm', token: 'SUPERSECRET' }),
      new Map(),
    );

    expect(options.headers).toEqual({});
    expect(warnings![0]).toContain('not recognised');
    expect(warnings![0]).toContain('ntlm');
    expect(warnings![0]).toContain('no credential was sent');
    expect(JSON.stringify(warnings)).not.toContain('SUPERSECRET');
  });

  it('sends nothing on the first request for digest, and does not warn', async () => {
    // Digest legitimately contributes no header up front: the credential is a
    // hash over a nonce the server has not issued yet. Silence is right here
    // precisely because the executor DOES go on to answer the challenge — a
    // warning would report a failure that is not happening.
    const { options, warnings } = await buildFetchOptions(
      requestWithAuth({ type: 'digest', username: 'u', password: 'SUPERSECRET' }),
      new Map(),
    );

    expect(options.headers).toEqual({});
    expect(warnings).toBeUndefined();
  });

  it('applies an oauth2 grant that does not need a browser once a token exists', async () => {
    const { options, warnings } = await buildFetchOptions(
      requestWithAuth({ type: 'oauth2', grantType: 'client_credentials' }),
      new Map(),
      undefined,
      undefined,
      'TOKEN-FROM-PROVIDER',
    );

    expect(options.headers).toEqual({ Authorization: 'Bearer TOKEN-FROM-PROVIDER' });
    expect(warnings).toBeUndefined();
  });

  it('still applies the auth types it always did', async () => {
    const { options, warnings } = await buildFetchOptions(
      requestWithAuth({ type: 'bearer', token: 'T' }),
      new Map(),
    );

    expect(options.headers).toEqual({ Authorization: 'Bearer T' });
    expect(warnings).toBeUndefined();
  });
});
