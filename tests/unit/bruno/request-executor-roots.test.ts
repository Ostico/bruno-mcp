/**
 * Collection- and folder-level settings reaching the wire (M3).
 *
 * Reading the root files is tested in collection-roots.test.ts; this is about
 * what the request actually sends once they have been read — which header wins,
 * what `auth: inherit` resolves to, and whether a setting that is read but not
 * applied is reported.
 */

import { buildFetchOptions } from '../../../src/bruno/request-executor';
import type { RootChain } from '../../../src/bruno/collection-roots';
import type { YamlAuth, YamlHeader, YamlRequest } from '../../../src/bruno/types';

function req(auth: YamlAuth | undefined, headers: YamlHeader[] = []): YamlRequest {
  return {
    info: { name: 'R', type: 'http' },
    http: { method: 'GET', url: 'https://api.test/resource', headers, auth },
  } as YamlRequest;
}

function chain(partial: Partial<RootChain>): RootChain {
  return { headers: [], auth: undefined, unapplied: [], ...partial };
}

const noVars = new Map<string, string>();

function sent(options: RequestInit): Record<string, string> {
  return options.headers as Record<string, string>;
}

describe('collection and folder headers', () => {
  it('sends a header the collection root defines', async () => {
    const { options } = await buildFetchOptions(
      req(undefined),
      noVars,
      undefined,
      chain({ headers: [{ name: 'X-Collection', value: 'yes' }] }),
    );

    expect(sent(options)['X-Collection']).toBe('yes');
  });

  it('lets the request override a root header of the same name', async () => {
    const { options } = await buildFetchOptions(
      req(undefined, [{ name: 'X-Env', value: 'from-request' }]),
      noVars,
      undefined,
      chain({ headers: [{ name: 'X-Env', value: 'from-collection' }] }),
    );

    expect(sent(options)['X-Env']).toBe('from-request');
  });

  it('overrides across a case difference rather than sending both', async () => {
    const { options } = await buildFetchOptions(
      req(undefined, [{ name: 'Authorization', value: 'Bearer request-token' }]),
      noVars,
      undefined,
      chain({ headers: [{ name: 'authorization', value: 'Bearer collection-token' }] }),
    );

    // The failure this guards is a doubled credential: combining the two would
    // send "Bearer collection-token, Bearer request-token".
    const values = Object.entries(sent(options))
      .filter(([name]) => name.toLowerCase() === 'authorization')
      .map(([, value]) => value);
    expect(values).toEqual(['Bearer request-token']);
  });

  it('keeps the nearest root header when several roots set one', async () => {
    const { options } = await buildFetchOptions(
      req(undefined),
      noVars,
      undefined,
      // Chain order is collection first, so the folder entry is nearer.
      chain({
        headers: [
          { name: 'X-Scope', value: 'collection' },
          { name: 'X-Scope', value: 'folder' },
        ],
      }),
    );

    expect(sent(options)['X-Scope']).toBe('folder');
  });

  it('still sends a root header the request only defines as disabled', async () => {
    const { options } = await buildFetchOptions(
      req(undefined, [{ name: 'X-Collection', value: 'ignored', disabled: true }]),
      noVars,
      undefined,
      chain({ headers: [{ name: 'X-Collection', value: 'from-collection' }] }),
    );

    // A disabled request header is not a request header, so it does not
    // suppress the collection's.
    expect(sent(options)['X-Collection']).toBe('from-collection');
  });

  it('substitutes variables in a root header and reports one it cannot', async () => {
    const vars = new Map([['known', 'v']]);

    const { options, warnings } = await buildFetchOptions(
      req(undefined),
      vars,
      undefined,
      chain({
        headers: [
          { name: 'X-Known', value: '{{known}}' },
          { name: 'X-Unknown', value: '{{missing}}' },
        ],
      }),
    );

    expect(sent(options)['X-Known']).toBe('v');
    // Root vars are not applied yet, so a placeholder a root's own vars block
    // would have defined has to surface rather than go out literally.
    expect(warnings?.join(' ')).toContain('missing');
  });
});

describe('auth: inherit', () => {
  it('resolves to the auth a root defines', async () => {
    const { options, warnings } = await buildFetchOptions(
      req('inherit'),
      noVars,
      undefined,
      chain({ auth: { type: 'bearer', token: 'collection-token' } }),
    );

    expect(sent(options).Authorization).toBe('Bearer collection-token');
    expect(warnings ?? []).toEqual([]);
  });

  it('substitutes variables in the inherited credential', async () => {
    const { options } = await buildFetchOptions(
      req('inherit'),
      new Map([['collection_token', 'sub-token']]),
      undefined,
      chain({ auth: { type: 'bearer', token: '{{collection_token}}' } }),
    );

    expect(sent(options).Authorization).toBe('Bearer sub-token');
  });

  it('resolves inherited basic auth too, not only bearer', async () => {
    const { options } = await buildFetchOptions(
      req('inherit'),
      noVars,
      undefined,
      chain({ auth: { type: 'basic', username: 'u', password: 'p' } }),
    );

    expect(sent(options).Authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('warns and sends nothing when no root defines auth', async () => {
    const { options, warnings } = await buildFetchOptions(req('inherit'), noVars, undefined, chain({}));

    expect(sent(options).Authorization).toBeUndefined();
    expect(warnings?.some(w => /inherit/i.test(w) && /no collection or folder root/i.test(w))).toBe(true);
  });

  it('warns rather than looping when a root inherits in turn', async () => {
    const { options, warnings } = await buildFetchOptions(
      req('inherit'),
      noVars,
      undefined,
      chain({ auth: 'inherit' }),
    );

    expect(sent(options).Authorization).toBeUndefined();
    expect(warnings?.some(w => /inherit/i.test(w))).toBe(true);
  });

  it('leaves a request\'s own auth alone when a root also defines one', async () => {
    const { options } = await buildFetchOptions(
      req({ type: 'bearer', token: 'request-token' }),
      noVars,
      undefined,
      chain({ auth: { type: 'bearer', token: 'collection-token' } }),
    );

    expect(sent(options).Authorization).toBe('Bearer request-token');
  });
});

describe('settings a root declares but that are not applied', () => {
  it('reports them as warnings, ahead of the warnings they explain', async () => {
    const { warnings } = await buildFetchOptions(
      req(undefined),
      noVars,
      undefined,
      chain({
        unapplied: ['collection.bru declares a pre-request script, which is not applied to requests yet'],
        headers: [{ name: 'X-A', value: '{{from_root_vars}}' }],
      }),
    );

    expect(warnings?.[0]).toContain('declares a pre-request script');
    // The unresolved placeholder comes after, because the note above explains it.
    expect(warnings?.join(' ')).toContain('from_root_vars');
  });

  it('says nothing when a root declares nothing unapplied', async () => {
    const { warnings } = await buildFetchOptions(req(undefined), noVars, undefined, chain({}));

    expect(warnings ?? []).toEqual([]);
  });
});
