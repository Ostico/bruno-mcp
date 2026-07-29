/**
 * The parse boundary must not assert its way past unvalidated file data (Q17a).
 *
 * HttpMethod, BodyType and AuthType are closed unions, but both parsers reached
 * them with a bare `as`: bru-parser did
 * `(json.http?.method?.toUpperCase() ?? 'GET') as HttpMethod` and yaml-parser
 * did `String(raw.method ?? '').toUpperCase()`. Nothing between those lines and
 * the fetch call ever checked membership, so any string in a collection file
 * became a value the rest of the code trusts as a union member.
 *
 * Two concrete consequences this pins down:
 *   - a .yml with `method: BOGUS` reached the request path, including the
 *     redirect logic that branches on the method;
 *   - a .yml with no method at all produced the empty string, while the .bru
 *     parser defaulted to GET for the same missing field.
 *
 * Unknown values are rejected rather than coerced. A collection using a body or
 * auth type this build does not model is better stopped with a named error than
 * silently turned into a request that means something else.
 */

import { parseYamlRequest } from '../../../src/bruno/yaml-parser';
import { parseBruRequest } from '../../../src/bruno/bru-parser';
import { BrunoError } from '../../../src/bruno/types';

const yaml = (http: string): string => `info:
  name: R
  type: http
http:
${http}
`;

const bru = (block: string): string => `meta {
  name: R
  type: http
}

${block}
`;

describe('yaml parse boundary rejects out-of-union values (Q17a)', () => {
  it('rejects a method that is not an HTTP method', () => {
    expect(() => parseYamlRequest(yaml('  method: BOGUS\n  url: https://api.test/'))).toThrow(
      BrunoError,
    );
  });

  it('names the offending field and the accepted values', () => {
    let caught: BrunoError | undefined;
    try {
      parseYamlRequest(yaml('  method: BOGUS\n  url: https://api.test/'));
    } catch (e) {
      caught = e as BrunoError;
    }
    expect(caught?.code).toBe('VALIDATION_ERROR');
    expect(caught?.message).toContain('method');
    expect(caught?.message).toContain('BOGUS');
    expect(caught?.message).toContain('GET');
  });

  it('defaults a missing method to GET rather than the empty string', () => {
    // Previously produced `method: ''`, which is not an HttpMethod and does not
    // match what the .bru parser does for the same missing field.
    expect(parseYamlRequest(yaml('  url: https://api.test/')).http.method).toBe('GET');
  });

  it('still accepts a lowercase method and normalises it', () => {
    expect(parseYamlRequest(yaml('  method: get\n  url: https://api.test/')).http.method).toBe(
      'GET',
    );
  });

  it.each(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])(
    'accepts %s',
    (method) => {
      expect(
        parseYamlRequest(yaml(`  method: ${method}\n  url: https://api.test/`)).http.method,
      ).toBe(method);
    },
  );

  it('rejects an unknown body type', () => {
    expect(() =>
      parseYamlRequest(yaml('  method: POST\n  url: https://api.test/\n  body:\n    type: nonsense')),
    ).toThrow(BrunoError);
  });

  it('accepts a known body type', () => {
    const req = parseYamlRequest(
      yaml('  method: POST\n  url: https://api.test/\n  body:\n    type: json\n    data: "{}"'),
    );
    expect(req.http.body?.type).toBe('json');
  });
});

describe('bru parse boundary rejects out-of-union values (Q17a)', () => {
  // Deliberately NOT validated against BodyType/AuthType. A .bru file uses
  // Bruno's own vocabulary — multipartForm, formUrlEncoded, sparql, inherit —
  // which is a different set from those unions, so rejecting anything outside
  // them would refuse valid Bruno collections. Validating here was tried and
  // broke six suites on real fixtures. The underlying mismodelling (the field
  // is declared BodyType and holds Bruno tokens) is tracked as D16.
  it.each(['multipartForm', 'formUrlEncoded', 'sparql', 'json', 'none'])(
    'accepts Bruno body vocabulary %s unchanged',
    (body) => {
      const parsed = parseBruRequest(bru(`post {\n  url: https://api.test/\n  body: ${body}\n}`));
      expect(parsed.http.body).toBe(body);
    },
  );

  it('accepts the inherit auth token, which is not in AuthType', () => {
    const parsed = parseBruRequest(
      bru('get {\n  url: https://api.test/\n  body: none\n  auth: inherit\n}'),
    );
    expect(parsed.http.auth).toBe('inherit');
  });

  it('keeps defaulting a missing method to GET', () => {
    const parsed = parseBruRequest(bru('get {\n  url: https://api.test/\n}'));
    expect(parsed.http.method).toBe('GET');
  });

  it('still uppercases the method block name', () => {
    const parsed = parseBruRequest(bru('post {\n  url: https://api.test/\n  body: none\n}'));
    expect(parsed.http.method).toBe('POST');
  });

  it.each(['none', 'bearer', 'basic', 'oauth2', 'api-key', 'digest'])(
    'accepts auth type %s',
    (auth) => {
      const parsed = parseBruRequest(
        bru(`get {\n  url: https://api.test/\n  body: none\n  auth: ${auth}\n}`),
      );
      expect(parsed.http.auth).toBe(auth);
    },
  );
});
