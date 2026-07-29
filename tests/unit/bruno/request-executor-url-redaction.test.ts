/**
 * URL redaction before a URL crosses back to the caller.
 *
 * The substituted URL is returned in result.url and embedded in error strings.
 * A query api-key or userinfo substituted from an env file would otherwise be
 * disclosed to the MCP caller. redactUrl strips userinfo and masks known
 * secret query-parameter values, while leaving ordinary URLs byte-for-byte
 * unchanged so reported URLs stay useful.
 */

import { redactUrl } from '../../../src/bruno/request-executor';

describe('redactUrl', () => {
  it('strips userinfo (user:pass@host)', () => {
    expect(redactUrl('https://alice:s3cr3t@api.test/path')).toBe('https://api.test/path');
  });

  it('masks a secret query parameter value but keeps the rest', () => {
    expect(redactUrl('https://api.test/p?token=abc123&page=2')).toBe(
      'https://api.test/p?token=REDACTED&page=2',
    );
  });

  it('masks common api-key parameter names', () => {
    expect(redactUrl('https://api.test/p?api_key=xyz')).toBe('https://api.test/p?api_key=REDACTED');
    expect(redactUrl('https://api.test/p?apikey=xyz')).toBe('https://api.test/p?apikey=REDACTED');
    expect(redactUrl('https://api.test/p?x-api-key=xyz')).toBe('https://api.test/p?x-api-key=REDACTED');
  });

  it('matches the parameter name case-insensitively', () => {
    expect(redactUrl('https://api.test/p?Token=abc')).toBe('https://api.test/p?Token=REDACTED');
  });

  it('redacts both userinfo and a secret query param together', () => {
    expect(redactUrl('https://u:p@api.test/p?access_token=T&q=1')).toBe(
      'https://api.test/p?access_token=REDACTED&q=1',
    );
  });

  it('returns an ordinary URL byte-for-byte unchanged (no normalization)', () => {
    const url = 'https://api.test/search?page=1&sort=asc';
    expect(redactUrl(url)).toBe(url);
  });

  it('leaves a bare-origin URL untouched (no added trailing slash)', () => {
    expect(redactUrl('https://api.test')).toBe('https://api.test');
  });

  it('returns an unparseable value as-is', () => {
    expect(redactUrl('not a url')).toBe('not a url');
  });
});
