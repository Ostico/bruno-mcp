/**
 * The `settings.encodeUrl` transform, checked against Bruno's behaviour.
 *
 * These expectations are not chosen for tidiness — several of them look wrong in
 * isolation (a query value gets double-encoded, `#` stops being a fragment, a
 * path parameter's `/` still separates segments). They are what Bruno sends, and
 * matching Bruno is the requirement: a collection has to behave here the way it
 * behaves in the app it was authored in.
 */
import {
  encodeRequestUrl,
  shouldEncodeUrl,
  hasExplicitScheme,
  safeDecodeURIComponent,
} from '../../../src/bruno/url-encoder';

describe('the scheme and authority are never touched', () => {
  it('preserves userinfo, port and a bracketed IPv6 literal verbatim', () => {
    expect(encodeRequestUrl('http://user:pw@[::1]:8080/a')).toBe('http://user:pw@[::1]:8080/a');
  });

  it('does not encode the port colon', () => {
    // The reason the caller must ensure a scheme first: without `://` the
    // authority pattern cannot match and `localhost:6000` would become
    // `localhost%3A6000`, resolving to a nonsense host.
    expect(encodeRequestUrl('http://localhost:6000/x')).toBe('http://localhost:6000/x');
  });

  it('treats a misplaced # before the first slash as path data', () => {
    expect(encodeRequestUrl('https://example.com#bad/path')).toBe('https://example.com%23bad/path');
  });
});

describe('path segments encode idempotently', () => {
  it('encodes a space once', () => {
    expect(encodeRequestUrl('https://e.com/a b')).toBe('https://e.com/a%20b');
  });

  it('does not double-encode an already-encoded path segment', () => {
    // Path-side decodes before encoding precisely so a second pass is harmless —
    // upstream reaches this transform after new URL().pathname has already
    // encoded the path once.
    expect(encodeRequestUrl('https://e.com/a%20b')).toBe('https://e.com/a%20b');
  });

  it('keeps segment boundaries, so a slash in a value still separates', () => {
    expect(encodeRequestUrl('https://e.com/u/a/b')).toBe('https://e.com/u/a/b');
  });

  it('survives a malformed escape rather than throwing', () => {
    // decodeURIComponent would throw on a bare %; the forgiving variant must not.
    expect(() => encodeRequestUrl('https://e.com/100%')).not.toThrow();
  });
});

describe('the query side is content blind', () => {
  it('double-encodes an already-encoded value on purpose', () => {
    // Upstream's documented contract: a pre-encoded value is a signal that the
    // encoding should survive a server-side decode pass, as with a redirect URL.
    expect(encodeRequestUrl('https://e.com/a?q=%20')).toBe('https://e.com/a?q=%2520');
  });

  it('encodes separators that are already pairs, leaving the pairs intact', () => {
    // The split happens before encoding, so this stays two parameters. This is
    // why the transform normalizes rather than sanitizes.
    expect(encodeRequestUrl('https://e.com/a?q=x&b=c')).toBe('https://e.com/a?q=x&b=c');
  });

  it('encodes a # in a query value as data', () => {
    expect(encodeRequestUrl('https://e.com/a?q=a#b')).toBe('https://e.com/a?q=a%23b');
  });

  it('keeps a valueless parameter valueless', () => {
    expect(encodeRequestUrl('https://e.com/a?flag')).toBe('https://e.com/a?flag');
  });

  it('keeps an empty value as an empty value', () => {
    expect(encodeRequestUrl('https://e.com/a?flag=')).toBe('https://e.com/a?flag=');
  });

  it('drops a pair with no name', () => {
    expect(encodeRequestUrl('https://e.com/a?=orphan&keep=1')).toBe('https://e.com/a?keep=1');
  });

  it('encodes = inside a value without splitting on it again', () => {
    // A base64 tail is the common case for this.
    expect(encodeRequestUrl('https://e.com/a?t=abc==')).toBe('https://e.com/a?t=abc%3D%3D');
  });
});

describe('the default, which is one rule and not two', () => {
  it('is off when there is no settings block at all', () => {
    // The runtime reads settings?.encodeUrl and gets undefined, so the URL is
    // sent raw. A collection that has never been saved by Bruno's UI lands here.
    expect(shouldEncodeUrl(undefined)).toBe(false);
  });

  it('is on for a settings object that reached here without the key', () => {
    // Only a .yml request can be in this state, and for it the answer is `true`
    // — upstream's yml reader defaults the key to true when a block omits it.
    //
    // A .bru request never arrives shaped like this: @usebruno/lang resolves the
    // key while parsing and hands over `encodeUrl: false`, which bru-to-yaml
    // passes through verbatim. So this branch is the .yml default, not a guess
    // about blocks in general. See settings-parser-oracle.test.ts for the
    // measurement that makes the .bru half unreachable.
    expect(shouldEncodeUrl({})).toBe(true);
  });

  it('honours an explicit value either way', () => {
    expect(shouldEncodeUrl({ encodeUrl: true })).toBe(true);
    expect(shouldEncodeUrl({ encodeUrl: false })).toBe(false);
  });
});

describe('scheme detection', () => {
  it.each([
    ['http://e.com', true],
    ['https://e.com', true],
    ['HTTP://e.com', true],
    ['e.com/x', false],
    ['localhost:6000', false],
  ])('%s -> %s', (url, expected) => {
    expect(hasExplicitScheme(url)).toBe(expected);
  });
});

describe('forgiving decode', () => {
  it('decodes what it can and leaves the rest', () => {
    expect(safeDecodeURIComponent('a%20b')).toBe('a b');
    expect(safeDecodeURIComponent('100%')).toBe('100%');
    expect(safeDecodeURIComponent('a%20b%')).toBe('a b%');
  });

  it('leaves a well-formed escape that is still not valid UTF-8 alone', () => {
    // `%80` is a continuation byte with nothing to continue, so decoding it throws
    // even though it looks well formed. It has to survive rather than take the
    // request down with it.
    expect(safeDecodeURIComponent('a%80b')).toBe('a%80b');
  });
});

describe('a newline in the URL is neutralised, not passed through', () => {
  // The authority pattern ends in `$`, which cannot match in the middle of a
  // string, so a URL containing a newline matches nothing and falls back to
  // treating the whole string as a path. Worth pinning: the fallback encodes the
  // newline as %0A rather than letting a bare CR/LF through into a request line.
  it('encodes a newline as %0A', () => {
    expect(encodeRequestUrl('https://e.com/a\nb')).toContain('%0A');
  });

  it('does not leave a raw newline anywhere in the result', () => {
    expect(encodeRequestUrl('https://e.com/a\r\nHost: evil')).not.toMatch(/[\r\n]/);
  });
});

describe('degenerate input', () => {
  it('returns an empty string unchanged', () => {
    expect(encodeRequestUrl('')).toBe('');
  });

  it('handles a bare question mark', () => {
    expect(encodeRequestUrl('https://e.com/a?')).toBe('https://e.com/a?');
  });
});
