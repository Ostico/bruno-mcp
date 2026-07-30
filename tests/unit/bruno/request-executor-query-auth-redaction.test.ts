/**
 * A query-placed api-key credential has to reach the redaction set.
 *
 * `redactUrl` masks a fixed list of well-known secret-bearing parameter names.
 * An api-key auth block names its own parameter, and that name is very often not
 * on the list (`sig_token`, `X-Corp-Key`, …). The credential is appended to the
 * URL, and the URL is what `result.url` and every error message report — so
 * unless the name auth actually used is handed to the redactor, the secret is
 * disclosed verbatim to the MCP caller.
 *
 * Also pinned here: which placement values put the credential in the query
 * string. Bruno writes `queryparams`; reading only `query` sent Bruno's own
 * value as a HEADER instead.
 */

import { buildFetchOptions, redactUrl } from '../../../src/bruno/request-executor';
import type { YamlRequest } from '../../../src/bruno/types';

function requestWithApiKey(key: string, value: string, placement: unknown): YamlRequest {
  return {
    info: { name: 'Keyed', type: 'http', seq: 1 },
    http: {
      method: 'GET',
      url: 'https://api.test/resource',
      auth: { type: 'api-key', key, value, in: placement },
    },
  } as unknown as YamlRequest;
}

describe('query-placed api-key credentials', () => {
  describe('placement values that mean "query string"', () => {
    it.each(['query', 'queryparams', 'QueryParams'])(
      'appends the credential to the URL for in: %s',
      async (placement) => {
        const { url, options } = await buildFetchOptions(
          requestWithApiKey('sig_token', 'SUPERSECRET', placement),
          new Map(),
        );

        expect(url).toContain('sig_token=SUPERSECRET');
        // The credential must not ALSO be sent as a header.
        expect(options.headers).toEqual({});
      },
    );

    it('places the credential in a header when the placement says header', async () => {
      const { url, options } = await buildFetchOptions(
        requestWithApiKey('X-Corp-Key', 'SUPERSECRET', 'header'),
        new Map(),
      );

      expect(url).toBe('https://api.test/resource');
      expect(options.headers).toEqual({ 'X-Corp-Key': 'SUPERSECRET' });
    });

    it('reads the Bruno spelling of the placement field as well as `in`', async () => {
      const yaml = {
        info: { name: 'Keyed', type: 'http', seq: 1 },
        http: {
          method: 'GET',
          url: 'https://api.test/resource',
          auth: { type: 'api-key', key: 'sig_token', value: 'SUPERSECRET', placement: 'queryparams' },
        },
      } as unknown as YamlRequest;

      const { url } = await buildFetchOptions(yaml, new Map());
      expect(url).toContain('sig_token=SUPERSECRET');
    });
  });

  describe('reaching the redaction set', () => {
    it('reports the query parameter name auth used so the value can be masked', async () => {
      const built = await buildFetchOptions(
        requestWithApiKey('sig_token', 'SUPERSECRET', 'query'),
        new Map(),
      );

      // `sig_token` is deliberately NOT one of redactUrl's built-in names.
      expect(redactUrl(built.url)).toContain('SUPERSECRET');
      expect(built.authQueryNames).toEqual(['sig_token']);
      expect(redactUrl(built.url, built.authQueryNames)).toBe(
        'https://api.test/resource?sig_token=REDACTED',
      );
    });

    it('does not report a query name when the key went into a header', async () => {
      const built = await buildFetchOptions(
        requestWithApiKey('X-Corp-Key', 'SUPERSECRET', 'header'),
        new Map(),
      );

      expect(built.authQueryNames).toBeUndefined();
    });

    it('substitutes the parameter name before reporting it for redaction', async () => {
      const built = await buildFetchOptions(
        requestWithApiKey('{{keyParam}}', 'SUPERSECRET', 'query'),
        new Map([['keyParam', 'corp_sig']]),
      );

      expect(built.authQueryNames).toEqual(['corp_sig']);
      expect(redactUrl(built.url, built.authQueryNames)).toContain('corp_sig=REDACTED');
    });
  });

  describe('appending the credential to the URL', () => {
    it('keeps a fragment after the appended query parameter', async () => {
      const yaml = requestWithApiKey('sig_token', 'S', 'query');
      yaml.http.url = 'https://api.test/resource#section';

      const { url } = await buildFetchOptions(yaml, new Map());

      // String concatenation put the parameter inside the fragment, so the
      // credential was never sent and the fragment was corrupted.
      expect(url).toBe('https://api.test/resource?sig_token=S#section');
    });

    it('replaces rather than duplicates an existing parameter of the same name', async () => {
      const yaml = requestWithApiKey('sig_token', 'FROMAUTH', 'query');
      yaml.http.url = 'https://api.test/resource?sig_token=STALE&page=2';

      const { url } = await buildFetchOptions(yaml, new Map());

      expect(url).toContain('sig_token=FROMAUTH');
      expect(url).not.toContain('STALE');
      expect(url).toContain('page=2');
    });

    it('preserves an existing unrelated query parameter', async () => {
      const yaml = requestWithApiKey('sig_token', 'S', 'query');
      yaml.http.url = 'https://api.test/resource?page=2';

      const { url } = await buildFetchOptions(yaml, new Map());

      expect(url).toContain('page=2');
      expect(url).toContain('sig_token=S');
    });

    it('still appends the credential to a URL with no scheme', async () => {
      // A schemeless URL cannot be parsed by URL(), but the credential must not
      // be dropped on that account: it is validated and encoded further down.
      const yaml = requestWithApiKey('sig_token', 'S', 'query');
      yaml.http.url = 'api.test/resource';

      const { url } = await buildFetchOptions(yaml, new Map());

      expect(url).toBe('api.test/resource?sig_token=S');
    });

    it('joins with & on a schemeless URL that already has a query', async () => {
      const yaml = requestWithApiKey('sig_token', 'S', 'query');
      yaml.http.url = 'api.test/resource?page=2';

      const { url } = await buildFetchOptions(yaml, new Map());

      expect(url).toBe('api.test/resource?page=2&sig_token=S');
    });

    it('percent-encodes a key and value that need it on a schemeless URL', async () => {
      const yaml = requestWithApiKey('sig token', 'a&b=c', 'query');
      yaml.http.url = 'api.test/resource';

      const { url } = await buildFetchOptions(yaml, new Map());

      // A value containing & or = must not be able to forge extra parameters.
      expect(url).toBe('api.test/resource?sig%20token=a%26b%3Dc');
    });
  });

  describe('placement values that do not mean "query string"', () => {
    it.each([
      ['an unrecognised string', 'body'],
      ['a non-string value', 7],
      ['no placement at all', undefined],
    ])('falls back to a header for %s', async (_label, placement) => {
      const { url, options } = await buildFetchOptions(
        requestWithApiKey('X-Corp-Key', 'S', placement),
        new Map(),
      );

      expect(url).toBe('https://api.test/resource');
      expect(options.headers).toEqual({ 'X-Corp-Key': 'S' });
    });
  });
});

describe('redactUrl with caller-supplied names', () => {
  it('masks a name that is not in the built-in set', () => {
    expect(redactUrl('https://api.test/p?sig_token=abc', ['sig_token'])).toBe(
      'https://api.test/p?sig_token=REDACTED',
    );
  });

  it('matches a caller-supplied name case-insensitively', () => {
    expect(redactUrl('https://api.test/p?Sig_Token=abc', ['sig_token'])).toBe(
      'https://api.test/p?Sig_Token=REDACTED',
    );
  });

  it('leaves an ordinary URL unchanged when no supplied name is present', () => {
    const url = 'https://api.test/search?page=1';
    expect(redactUrl(url, ['sig_token'])).toBe(url);
  });

  it('still applies the built-in names when extra names are supplied', () => {
    expect(redactUrl('https://api.test/p?token=a&sig_token=b', ['sig_token'])).toBe(
      'https://api.test/p?token=REDACTED&sig_token=REDACTED',
    );
  });
});
