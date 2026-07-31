/**
 * Tests for the per-run cookie jar.
 *
 * Domain, path and expiry matching belong to tough-cookie and are not re-tested
 * here — except host isolation, which is the property a bug would turn into a
 * cross-host credential leak, so it is pinned at this level too.
 */

import {
  createRunCookieJar,
  applyCookiesToHeaders,
  storeResponseCookies,
  mergeCookieHeader,
} from '../../../src/bruno/cookie-jar';

function headersWithSetCookie(values: string[]): Response {
  const headers = new Headers();
  for (const value of values) {
    headers.append('set-cookie', value);
  }
  return { headers } as unknown as Response;
}

describe('mergeCookieHeader', () => {
  it('returns the jar value when the request carried no cookie header', () => {
    expect(mergeCookieHeader(undefined, 'a=1')).toBe('a=1');
    expect(mergeCookieHeader('   ', 'a=1')).toBe('a=1');
  });

  it('returns the existing header when the jar has nothing', () => {
    expect(mergeCookieHeader('a=1', '')).toBe('a=1');
  });

  it('keeps an explicit cookie the jar does not know about', () => {
    expect(mergeCookieHeader('mine=1', 'sid=2')).toBe('mine=1; sid=2');
  });

  it('lets the jar win on a same-named cookie, as upstream does', () => {
    // The server just set this value; the hand-written one is staler.
    expect(mergeCookieHeader('sid=old', 'sid=new')).toBe('sid=new');
  });

  it('tolerates odd spacing and values containing =', () => {
    expect(mergeCookieHeader('a = 1 ;b=x=y', 'c=3')).toBe('a=1; b=x=y; c=3');
  });

  it('ignores a malformed segment with no name', () => {
    expect(mergeCookieHeader('=novalue; ok=1', '')).toBe('=novalue; ok=1');
    expect(mergeCookieHeader('ok=1', '=nonsense')).toBe('ok=1');
  });
});

describe('createRunCookieJar', () => {
  it('sends a stored cookie back to the same host', () => {
    const jar = createRunCookieJar();

    jar.store('https://api.example.com/login', ['sid=abc; Path=/']);

    expect(jar.cookieHeaderFor('https://api.example.com/profile')).toBe('sid=abc');
  });

  it('does not send one host\'s cookie to another host', () => {
    const jar = createRunCookieJar();

    jar.store('https://api.example.com/login', ['sid=abc; Path=/']);

    expect(jar.cookieHeaderFor('https://other.example.org/profile')).toBe('');
    // A suffix that merely looks similar is still a different host.
    expect(jar.cookieHeaderFor('https://api.example.com.evil.test/x')).toBe('');
  });

  it('withholds a Secure cookie from http but allows it to localhost', () => {
    const jar = createRunCookieJar();
    jar.store('https://api.example.com/login', ['sid=abc; Path=/; Secure']);

    expect(jar.cookieHeaderFor('http://api.example.com/x')).toBe('');
    expect(jar.cookieHeaderFor('https://api.example.com/x')).toBe('sid=abc');

    const local = createRunCookieJar();
    local.store('http://localhost:3000/login', ['t=1; Path=/; Secure']);
    expect(local.cookieHeaderFor('http://localhost:3000/x')).toBe('t=1');
  });

  it('skips an unparseable cookie instead of failing the run', () => {
    const jar = createRunCookieJar();

    jar.store('https://api.example.com/login', ['', 'good=1; Path=/']);

    // The empty value parses to nothing and is dropped; the run continues.
    expect(jar.cookieHeaderFor('https://api.example.com/x')).toBe('good=1');
  });

  it('keeps a bare token, because loose parsing is upstream\'s choice', () => {
    const jar = createRunCookieJar();

    jar.store('https://api.example.com/login', ['sessionvalue', 'good=1; Path=/']);

    // `Cookie.parse(..., { loose: true })` reads a value with no `name=` as a
    // valueless cookie rather than rejecting it, which is what Bruno passes.
    // Asserted rather than assumed: it decides what goes back on the wire.
    expect(jar.cookieHeaderFor('https://api.example.com/x')).toBe('sessionvalue; good=1');
  });

  it('ignores a cookie scoped to a domain the response cannot set', () => {
    const jar = createRunCookieJar();

    // Cross-domain Set-Cookie: rejected, and rejection must not throw.
    jar.store('https://api.example.com/login', ['sid=abc; Domain=evil.test; Path=/']);

    expect(jar.cookieHeaderFor('https://evil.test/x')).toBe('');
  });

  it('returns no cookies for a URL it cannot parse', () => {
    const jar = createRunCookieJar();

    expect(jar.cookieHeaderFor('not a url')).toBe('');
  });

  it('keeps two Set-Cookie values separate even when a value contains a comma', () => {
    const jar = createRunCookieJar();

    jar.store('https://api.example.com/login', [
      'sid=abc; Path=/',
      'pref=a,b; Path=/',
    ]);

    const header = jar.cookieHeaderFor('https://api.example.com/x');
    expect(header).toContain('sid=abc');
    expect(header).toContain('pref=a,b');
  });
});

describe('applyCookiesToHeaders', () => {
  it('adds a Cookie header when the request had none', () => {
    const jar = createRunCookieJar();
    jar.store('https://api.example.com/login', ['sid=abc; Path=/']);
    const headers: Record<string, string> = { Accept: 'application/json' };

    applyCookiesToHeaders(headers, 'https://api.example.com/x', jar);

    expect(headers.Cookie).toBe('sid=abc');
  });

  it('writes back under the header name the request already used', () => {
    const jar = createRunCookieJar();
    jar.store('https://api.example.com/login', ['sid=abc; Path=/']);
    const headers: Record<string, string> = { cookie: 'mine=1' };

    applyCookiesToHeaders(headers, 'https://api.example.com/x', jar);

    expect(headers.cookie).toBe('mine=1; sid=abc');
    expect(headers.Cookie).toBeUndefined();
  });

  it('leaves headers untouched when the jar has nothing for this URL', () => {
    const jar = createRunCookieJar();
    const headers: Record<string, string> = { Accept: '*/*' };

    applyCookiesToHeaders(headers, 'https://api.example.com/x', jar);

    expect(headers).toEqual({ Accept: '*/*' });
  });
});

describe('storeResponseCookies', () => {
  it('stores every Set-Cookie the response carried', () => {
    const jar = createRunCookieJar();

    storeResponseCookies(
      jar,
      'https://api.example.com/login',
      headersWithSetCookie(['sid=abc; Path=/', 'csrf=xyz; Path=/']),
    );

    const header = jar.cookieHeaderFor('https://api.example.com/x');
    expect(header).toContain('sid=abc');
    expect(header).toContain('csrf=xyz');
  });

  it('does nothing when the response set none', () => {
    const jar = createRunCookieJar();

    storeResponseCookies(jar, 'https://api.example.com/x', headersWithSetCookie([]));

    expect(jar.cookieHeaderFor('https://api.example.com/x')).toBe('');
  });

  it('tolerates a Headers stand-in without getSetCookie', () => {
    const jar = createRunCookieJar();
    const response = { headers: { get: () => null } } as unknown as Response;

    expect(() => storeResponseCookies(jar, 'https://api.example.com/x', response)).not.toThrow();
  });
});
