/**
 * The auth types the type surface accepts but the executor cannot perform.
 *
 * `AuthType` advertises `oauth2` and `digest`, and neither executes: both need a
 * challenge/token flow this tool does not run. The executor is allowed not to
 * implement them — what it must not do is send an unauthenticated request while
 * the collection says auth is configured. So each unapplied mode has to produce
 * a warning naming the mode, and no credential header.
 */

import { buildFetchOptions } from '../../../src/bruno/request-executor';
import type { UnappliedAuthType, YamlRequest } from '../../../src/bruno/types';

function requestWithAuth(auth: unknown): YamlRequest {
  return {
    info: { name: 'Authed', type: 'http', seq: 1 },
    http: { method: 'GET', url: 'https://api.test/r', auth },
  } as unknown as YamlRequest;
}

describe('auth types the executor does not apply', () => {
  // Listed explicitly rather than derived, so adding a member to AuthType
  // without deciding whether it executes fails to type-check here.
  const unapplied: UnappliedAuthType[] = ['oauth2', 'digest'];

  it.each(unapplied)('warns by name and sends no credential for %s', async (type) => {
    const { options, warnings } = await buildFetchOptions(
      requestWithAuth({ type, token: 'SUPERSECRET' }),
      new Map(),
    );

    expect(options.headers).toEqual({});
    expect(warnings).toEqual(
      expect.arrayContaining([expect.stringContaining(type)]),
    );
    // A warning crosses back to the caller, so it must never carry the value.
    expect(JSON.stringify(warnings)).not.toContain('SUPERSECRET');
  });

  it.each(unapplied)('states that no credential was sent for %s', async (type) => {
    const { warnings } = await buildFetchOptions(
      requestWithAuth({ type }),
      new Map(),
    );

    expect(warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('no credential was sent')]),
    );
  });

  it('distinguishes a known-but-unimplemented mode from an unrecognised one', async () => {
    // Different situations for whoever reads the warning: the first needs a
    // workaround, the second is a typo or a Bruno feature not modelled yet.
    const known = await buildFetchOptions(requestWithAuth({ type: 'oauth2' }), new Map());
    const unknown = await buildFetchOptions(requestWithAuth({ type: 'ntlm' }), new Map());

    expect(known.warnings![0]).toContain('does not perform');
    expect(unknown.warnings![0]).toContain('not recognised');
    expect(unknown.warnings![0]).toContain('ntlm');
    expect(unknown.options.headers).toEqual({});
  });

  it('still applies the auth types it does implement', async () => {
    const { options, warnings } = await buildFetchOptions(
      requestWithAuth({ type: 'bearer', token: 'T' }),
      new Map(),
    );

    expect(options.headers).toEqual({ Authorization: 'Bearer T' });
    expect(warnings).toBeUndefined();
  });
});
