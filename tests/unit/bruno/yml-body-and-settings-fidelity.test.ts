/**
 * Two parse-fidelity holes where a value the file plainly contains never
 * reaches the request.
 *
 * 1. A `.yml` body whose `data` is a YAML mapping — which is what a JSON body
 *    and a graphql envelope both look like on disk — was coerced with
 *    `String()`. That yields the literal text `[object Object]`, a perfectly
 *    valid string, so the user's body was replaced by garbage and nothing
 *    errored.
 * 2. The `.bru` `settings` block modelled only `encodeUrl` and `timeout`, so
 *    `followRedirects` and `maxRedirects` were dropped on read and could not
 *    be written at all — even though the executor honours both.
 *
 * The inputs here are literal bytes, not output from our own generator: our
 * parser is tolerant of our own malformed writes, so a round-trip through the
 * parse/generate pair would hide both defects.
 */

import { parseYamlRequest } from '../../../src/bruno/yaml-parser';
import { parseBruRequest, generateBruRequest } from '../../../src/bruno/bru-parser';
import { BrunoError, type BruGraphql } from '../../../src/bruno/types';

function ymlRequest(bodyBlock: string): string {
  return `info:
  name: Create Order
  type: http
  seq: 1
http:
  method: POST
  url: https://api.test/orders
${bodyBlock}`;
}

describe('.yml body data is not stringified into "[object Object]"', () => {
  it('serialises a JSON body written as a YAML mapping into JSON text', () => {
    const request = parseYamlRequest(
      ymlRequest(`  body:
    type: json
    data:
      hello: world
      count: 2
      nested:
        ok: true
`),
    );

    const data = request.http.body?.data;
    expect(typeof data).toBe('string');
    expect(data).not.toContain('[object Object]');
    expect(JSON.parse(data as string)).toEqual({
      hello: 'world',
      count: 2,
      nested: { ok: true },
    });
  });

  it('keeps a graphql body as the structured envelope the executor reads', () => {
    const request = parseYamlRequest(
      ymlRequest(`  body:
    type: graphql
    data:
      query: "query Me { me { id } }"
      variables: "{\\"id\\": 1}"
`),
    );

    const data = request.http.body?.data as BruGraphql;
    expect(typeof data).toBe('object');
    expect(data.query).toBe('query Me { me { id } }');
    expect(data.variables).toBe('{"id": 1}');
  });

  it('leaves a textual body untouched', () => {
    const request = parseYamlRequest(
      ymlRequest(`  body:
    type: text
    data: plain old text
`),
    );

    expect(request.http.body?.data).toBe('plain old text');
  });

  it('rejects a mapping under a body type that can only hold text', () => {
    expect(() =>
      parseYamlRequest(
        ymlRequest(`  body:
    type: xml
    data:
      root: value
`),
      ),
    ).toThrow(BrunoError);
  });
});

describe('.bru settings block round-trips followRedirects and maxRedirects', () => {
  const ALL_OPTIONS = `meta {
  name: All Options
  type: http
  seq: 1
}

put {
  url: https://api.test/all-options
}

settings {
  encodeUrl: true
  followRedirects: false
  maxRedirects: 0
  timeout: 60000
}
`;

  it('reads every settings key upstream writes', () => {
    const bruFile = parseBruRequest(ALL_OPTIONS);

    expect(bruFile.settings).toEqual({
      encodeUrl: true,
      followRedirects: false,
      maxRedirects: 0,
      timeout: 60000,
    });
  });

  it('writes followRedirects and maxRedirects back into the settings block', () => {
    const bruFile = parseBruRequest(ALL_OPTIONS);
    const written = generateBruRequest(bruFile);

    expect(written).toContain('followRedirects: false');
    expect(written).toContain('maxRedirects: 0');
    expect(written).toContain('encodeUrl: true');
    expect(written).toContain('timeout: 60000');
  });

  it('authors followRedirects on a request that had no settings block', () => {
    const bruFile = parseBruRequest(`meta {
  name: No Settings
  type: http
  seq: 1
}

get {
  url: https://api.test/plain
}
`);
    expect(bruFile.settings).toBeUndefined();

    bruFile.settings = { followRedirects: false, maxRedirects: 3 };
    const written = generateBruRequest(bruFile);

    expect(written).toContain('followRedirects: false');
    expect(written).toContain('maxRedirects: 3');
    expect(parseBruRequest(written).settings).toMatchObject({
      followRedirects: false,
      maxRedirects: 3,
    });
  });
});
