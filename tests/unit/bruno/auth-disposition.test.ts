/**
 * Every auth mode has an explicit disposition for every transport.
 *
 * `applyAuth`'s contract is that a run never silently sends an unauthenticated
 * request while claiming the auth was configured. Two of its branches broke that
 * contract for the non-HTTP transports rather than for HTTP: a query-placed
 * api-key is handed back for the caller to append to a URL, and gRPC has no query
 * string; and digest returns nothing at all because the HTTP path answers the 401
 * challenge, which gRPC never receives.
 *
 * So the matrix is enumerated here by name — every mode, every transport — rather
 * than asserted as "the unsupported ones refuse". A mode that reaches the
 * catch-all `default:` for a new transport is a mode that goes out bare.
 */
import { applyAuth } from '../../../src/bruno/auth-apply.js';
import type { YamlAuth } from '../../../src/bruno/types.js';

const identity = (v: string) => v;

interface Applied {
  disposition: ReturnType<typeof applyAuth>;
  headers: Record<string, string>;
  warnings: string[];
  authHeaderNames: string[];
}

function apply(
  auth: YamlAuth | undefined,
  transport: 'http' | 'grpc' | 'ws',
  extra?: { inherited?: YamlAuth; token?: string },
): Applied {
  const headers: Record<string, string> = {};
  const warnings: string[] = [];
  const authHeaderNames: string[] = [];
  const disposition = applyAuth(
    auth,
    headers,
    identity,
    warnings,
    authHeaderNames,
    extra?.inherited,
    extra?.token,
    transport,
  );
  return { disposition, headers, warnings, authHeaderNames };
}

/** Every mode this server can encounter, named so "every mode" is checkable. */
const MODES: Array<[label: string, auth: YamlAuth | undefined]> = [
  ['absent', undefined],
  ['none', { type: 'none' }],
  ['bearer', { type: 'bearer', token: 'tok' }],
  ['basic', { type: 'basic', username: 'u', password: 'p' }],
  ['apikey (header)', { type: 'api-key', key: 'x-key', value: 'v', in: 'header' }],
  ['apikey (query)', { type: 'api-key', key: 'x-key', value: 'v', in: 'query' }],
  ['digest', { type: 'digest', username: 'u', password: 'p' }],
  ['oauth2 (client_credentials)', { type: 'oauth2', grantType: 'client_credentials' }],
  ['oauth2 (authorization_code)', { type: 'oauth2', grantType: 'authorization_code' }],
  ['awsv4', { type: 'awsv4', accessKeyId: 'a', secretAccessKey: 'b' }],
  ['wsse', { type: 'wsse', username: 'u', password: 'p' }],
  ['ntlm', { type: 'ntlm', username: 'u', password: 'p' }],
];

describe('every mode has a disposition for every transport', () => {
  it.each(MODES)('%s reaches a decision for grpc', (_label, auth) => {
    const { disposition, headers, warnings } = apply(auth, 'grpc', { token: 'tok' });
    // Exactly one of the three outcomes, and never "nothing happened": either a
    // credential was placed, or the mode was refused by name.
    const placed = Object.keys(headers).length > 0;
    const refused = disposition?.outcome === 'refused';
    const query = disposition?.outcome === 'query';
    expect(placed || refused || query || auth === undefined || auth.type === 'none').toBe(true);
    if (refused) expect(disposition.reason).not.toHaveLength(0);
    // A refusal is a refusal, not a warning-and-carry-on.
    if (refused) expect(warnings).toEqual([]);
  });

  it.each(MODES)('%s reaches a decision for ws', (_label, auth) => {
    const { disposition, headers } = apply(auth, 'ws', { token: 'tok' });
    const placed = Object.keys(headers).length > 0;
    expect(
      placed
      || disposition?.outcome === 'refused'
      || disposition?.outcome === 'query'
      || auth === undefined
      || auth.type === 'none',
    ).toBe(true);
  });
});

describe('what is applied for the new transports', () => {
  it.each([['grpc'], ['ws']] as const)('places a bearer token as a header for %s', (transport) => {
    const { headers, disposition } = apply({ type: 'bearer', token: 'tok' }, transport);
    expect(headers.Authorization).toBe('Bearer tok');
    expect(disposition?.outcome).toBe('done');
  });

  it.each([['grpc'], ['ws']] as const)('places basic credentials as a header for %s', (transport) => {
    expect(apply({ type: 'basic', username: 'u', password: 'p' }, transport).headers.Authorization)
      .toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it.each([['grpc'], ['ws']] as const)('places a header api-key for %s', (transport) => {
    expect(apply({ type: 'api-key', key: 'x-key', value: 'v', in: 'header' }, transport).headers)
      .toEqual({ 'x-key': 'v' });
  });

  it.each([['grpc'], ['ws']] as const)('applies an automatable oauth2 grant for %s', (transport) => {
    const { headers } = apply(
      { type: 'oauth2', grantType: 'client_credentials' },
      transport,
      { token: 'fetched' },
    );
    expect(headers.Authorization).toBe('Bearer fetched');
  });
});

describe('what is refused for the new transports, and why', () => {
  it.each([['grpc'], ['ws']] as const)('refuses digest for %s, naming the missing challenge', (transport) => {
    const { disposition, headers } = apply(
      { type: 'digest', username: 'u', password: 'p' },
      transport,
    );
    expect(disposition?.outcome).toBe('refused');
    expect(disposition?.outcome === 'refused' && disposition.reason).toMatch(/challenge|401/i);
    expect(headers).toEqual({});
  });

  it('refuses a query-placed api-key for grpc, naming the missing query string', () => {
    const { disposition } = apply(
      { type: 'api-key', key: 'x-key', value: 'v', in: 'query' },
      'grpc',
    );
    expect(disposition?.outcome).toBe('refused');
    expect(disposition?.outcome === 'refused' && disposition.reason).toMatch(/query string/i);
  });

  // Deliberately NOT refused for WebSocket: a `ws://` URL carries a query string
  // exactly like an `http://` one, and a token in the query is a common way to
  // authenticate a socket. Refusing it would have been a refusal with a false
  // reason.
  it('hands a query-placed api-key back for ws, to be appended to the target', () => {
    expect(apply({ type: 'api-key', key: 'x-key', value: 'v', in: 'query' }, 'ws').disposition)
      .toEqual({ outcome: 'query', key: 'x-key', value: 'v' });
  });

  it.each([
    ['awsv4', { type: 'awsv4' } as YamlAuth],
    ['wsse', { type: 'wsse' } as YamlAuth],
    ['ntlm', { type: 'ntlm' } as YamlAuth],
  ])('refuses %s for grpc rather than warning and sending nothing', (_label, auth) => {
    const { disposition, warnings } = apply(auth, 'grpc');
    expect(disposition?.outcome).toBe('refused');
    expect(warnings).toEqual([]);
  });

  it('refuses a non-automatable oauth2 grant for grpc', () => {
    const { disposition } = apply(
      { type: 'oauth2', grantType: 'authorization_code' },
      'grpc',
      { token: 'tok' },
    );
    expect(disposition?.outcome).toBe('refused');
    expect(disposition?.outcome === 'refused' && disposition.reason).toMatch(/redirect/i);
  });

  it('refuses an unrecognised mode for grpc instead of falling through', () => {
    const { disposition, warnings } = apply({ type: 'gopher-auth' } as YamlAuth, 'grpc');
    expect(disposition?.outcome).toBe('refused');
    expect(warnings).toEqual([]);
  });
});

describe('inherit resolves the same way for every transport', () => {
  // Both dialects normalise to the bare mode string `inherit`, which is what
  // applyAuth compares by identity — `.bru` carries it in the target block and
  // `.yml` as a bare value, and the funnel already made them one thing.
  it.each([['http'], ['grpc'], ['ws']] as const)('follows the root credential for %s', (transport) => {
    const { headers } = apply('inherit', transport, {
      inherited: { type: 'bearer', token: 'root-tok' },
    });
    expect(headers.Authorization).toBe('Bearer root-tok');
  });

  it.each([['grpc'], ['ws']] as const)('refuses when the root inherits a mode this transport cannot honour (%s)', (transport) => {
    const { disposition } = apply('inherit', transport, {
      inherited: { type: 'digest', username: 'u', password: 'p' },
    });
    // The refusal has to survive the recursion, or inheriting digest would send
    // the request bare while the file claims a credential.
    expect(disposition?.outcome).toBe('refused');
  });

  it.each([['http'], ['grpc'], ['ws']] as const)('warns, and does not refuse, when no root defines auth (%s)', (transport) => {
    const { disposition, warnings } = apply('inherit', transport);
    expect(disposition?.outcome).toBe('done');
    expect(warnings[0]).toMatch(/no collection or folder root defines auth/);
  });
});

describe('http dispositions are unchanged', () => {
  it('still hands a query api-key back to the caller', () => {
    expect(apply({ type: 'api-key', key: 'x-key', value: 'v', in: 'query' }, 'http').disposition)
      .toEqual({ outcome: 'query', key: 'x-key', value: 'v' });
  });

  it('still leaves digest to the 401 retry, with no warning and no header', () => {
    const { disposition, headers, warnings } = apply(
      { type: 'digest', username: 'u', password: 'p' },
      'http',
    );
    expect(disposition?.outcome).toBe('done');
    expect(headers).toEqual({});
    expect(warnings).toEqual([]);
  });

  it('still warns rather than refusing for an unrecognised mode', () => {
    const { disposition, warnings } = apply({ type: 'gopher-auth' } as YamlAuth, 'http');
    expect(disposition?.outcome).toBe('done');
    expect(warnings[0]).toMatch(/not recognised/);
  });

  it('still warns rather than refusing for a browser-redirect oauth2 grant', () => {
    const { disposition, warnings } = apply(
      { type: 'oauth2', grantType: 'authorization_code' },
      'http',
    );
    expect(disposition?.outcome).toBe('done');
    expect(warnings[0]).toMatch(/redirecting a browser/);
  });

  it('defaults to http when no transport is given, so the existing call site is unchanged', () => {
    const headers: Record<string, string> = {};
    const disposition = applyAuth(
      { type: 'api-key', key: 'x-key', value: 'v', in: 'query' },
      headers,
      identity,
      [],
      [],
    );
    expect(disposition).toEqual({ outcome: 'query', key: 'x-key', value: 'v' });
  });
});
