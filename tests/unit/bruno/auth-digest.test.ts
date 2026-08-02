/**
 * Digest challenge parsing and response computation (RFC 7616 / RFC 2617).
 *
 * The hashes are checked against values computed by hand from the RFC's own
 * formula rather than against whatever this implementation happens to emit —
 * a test that asserts `response === buildDigestHeader(...)` would pass on any
 * consistent-but-wrong algorithm, and a wrong digest is indistinguishable from
 * a wrong password to whoever has to debug it.
 */
import { createHash } from 'node:crypto';
import {
  parseDigestChallenge,
  buildDigestHeader,
  type DigestChallenge,
} from '../../../src/bruno/auth-digest';

const md5 = (input: string): string => createHash('md5').update(input).digest('hex');
const field = (header: string, name: string): string | undefined =>
  new RegExp(`${name}="?([^",]*)"?`).exec(header)?.[1];

describe('parsing a WWW-Authenticate challenge', () => {
  it('reads the quoted and unquoted parameters of a Digest challenge', () => {
    const challenge = parseDigestChallenge(
      'Digest realm="test@host", qop="auth", nonce="abc123", opaque="op", algorithm=MD5',
    );

    expect(challenge).toEqual({
      realm: 'test@host',
      qop: 'auth',
      nonce: 'abc123',
      opaque: 'op',
      algorithm: 'MD5',
    });
  });

  it('picks the Digest offer out of a header that also offers Basic', () => {
    // A server may advertise several schemes in one header; taking the first
    // one would answer Basic with a digest.
    const challenge = parseDigestChallenge('Basic realm="other", Digest realm="right", nonce="n"');

    expect(challenge?.realm).toBe('right');
  });

  it('returns null when there is no Digest offer at all', () => {
    expect(parseDigestChallenge('Basic realm="only"')).toBeNull();
    expect(parseDigestChallenge(null)).toBeNull();
  });

  it('returns null for a Digest offer with no nonce, rather than inventing one', () => {
    expect(parseDigestChallenge('Digest realm="r", qop="auth"')).toBeNull();
  });
});

describe('computing the Authorization response', () => {
  const base: DigestChallenge = { realm: 'testrealm@host.com', nonce: 'dcd98b7102dd2f0e', qop: 'auth' };
  const creds = { username: 'Mufasa', password: 'Circle Of Life' };

  it('matches the RFC formula for qop=auth', () => {
    const header = buildDigestHeader(base, creds, 'GET', 'https://host.com/dir/index.html', 1, 'cn');

    const ha1 = md5('Mufasa:testrealm@host.com:Circle Of Life');
    const ha2 = md5('GET:/dir/index.html');
    const expected = md5(`${ha1}:dcd98b7102dd2f0e:00000001:cn:auth:${ha2}`);

    expect(field(header!, 'response')).toBe(expected);
    expect(field(header!, 'nc')).toBe('00000001');
    expect(field(header!, 'cnonce')).toBe('cn');
    expect(field(header!, 'qop')).toBe('auth');
  });

  it('uses the RFC 2069 formula when the server offers no qop', () => {
    // Without qop the hash has no nc or cnonce in it, and the header must not
    // carry them either — a server implementing 2069 rejects the extra fields.
    const header = buildDigestHeader({ ...base, qop: undefined }, creds, 'GET', 'https://host.com/x');

    const ha1 = md5('Mufasa:testrealm@host.com:Circle Of Life');
    const expected = md5(`${ha1}:dcd98b7102dd2f0e:${md5('GET:/x')}`);

    expect(field(header!, 'response')).toBe(expected);
    expect(header).not.toContain('nc=');
    expect(header).not.toContain('cnonce=');
  });

  it('hashes the request-target, not the whole URL', () => {
    // The digest URI is path + query. Including the origin gives a hash the
    // server cannot reproduce, and the failure looks like a bad password.
    const header = buildDigestHeader(base, creds, 'GET', 'https://host.com/a/b?q=1#frag', 1, 'cn');

    expect(field(header!, 'uri')).toBe('/a/b?q=1');
  });

  it('folds the method into the hash, so two verbs differ', () => {
    const get = buildDigestHeader(base, creds, 'GET', 'https://h/x', 1, 'cn');
    const post = buildDigestHeader(base, creds, 'POST', 'https://h/x', 1, 'cn');

    expect(field(get!, 'response')).not.toBe(field(post!, 'response'));
  });

  it('supports SHA-256', () => {
    const sha = (input: string): string => createHash('sha256').update(input).digest('hex');
    const challenge = { ...base, algorithm: 'SHA-256' };

    const header = buildDigestHeader(challenge, creds, 'GET', 'https://h/x', 1, 'cn');

    const ha1 = sha('Mufasa:testrealm@host.com:Circle Of Life');
    const ha2 = sha('GET:/x');
    expect(field(header!, 'response')).toBe(sha(`${ha1}:${base.nonce}:00000001:cn:auth:${ha2}`));
    expect(field(header!, 'algorithm')).toBe('SHA-256');
  });

  it('hashes the nonce and cnonce into HA1 for a -sess algorithm', () => {
    const header = buildDigestHeader({ ...base, algorithm: 'MD5-sess' }, creds, 'GET', 'https://h/x', 1, 'cn');

    const ha1 = md5(`${md5('Mufasa:testrealm@host.com:Circle Of Life')}:${base.nonce}:cn`);
    expect(field(header!, 'response')).toBe(md5(`${ha1}:${base.nonce}:00000001:cn:auth:${md5('GET:/x')}`));
  });

  it('picks auth when the server offers auth and auth-int together', () => {
    const header = buildDigestHeader({ ...base, qop: 'auth-int,auth' }, creds, 'GET', 'https://h/x');

    expect(field(header!, 'qop')).toBe('auth');
  });

  it('refuses rather than guessing when only auth-int is offered', () => {
    // auth-int hashes the body. Sending an `auth` response to an auth-int-only
    // server is a credential the server will reject; the 401 it already has is
    // a better answer than a wrong retry.
    expect(buildDigestHeader({ ...base, qop: 'auth-int' }, creds, 'GET', 'https://h/x')).toBeNull();
  });

  it('refuses an algorithm it cannot compute', () => {
    expect(buildDigestHeader({ ...base, algorithm: 'SHA-512-256' }, creds, 'GET', 'https://h/x'))
      .toBeNull();
  });

  it('escapes a quote in the realm so the field cannot be terminated early', () => {
    const header = buildDigestHeader({ ...base, realm: 'we"ird' }, creds, 'GET', 'https://h/x');

    expect(header).toContain('realm="we\\"ird"');
  });

  it('echoes opaque back only when the server sent one', () => {
    expect(buildDigestHeader({ ...base, opaque: 'xyz' }, creds, 'GET', 'https://h/x'))
      .toContain('opaque="xyz"');
    expect(buildDigestHeader(base, creds, 'GET', 'https://h/x')).not.toContain('opaque');
  });

  it('generates a different cnonce per call when one is not supplied', () => {
    const a = buildDigestHeader(base, creds, 'GET', 'https://h/x');
    const b = buildDigestHeader(base, creds, 'GET', 'https://h/x');

    expect(field(a!, 'cnonce')).not.toBe(field(b!, 'cnonce'));
  });
});
