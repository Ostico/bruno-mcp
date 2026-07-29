/**
 * Duplicate request headers must reach the wire.
 *
 * A collection may legitimately author the same header name twice — two Accept
 * values, two Cookie pairs, an X-Forwarded-For chain. Both halves of the path
 * used to collapse them to a single value, last one wins:
 *
 *   - bruFileToYamlRequest built the header list from BruFile.headers, the flat
 *     Record the .bru parser keeps for lookups, so duplicates were already gone
 *     before the model was built. The parser's own order-preserving
 *     BruFile.headersList was ignored.
 *   - buildFetchOptions then rebuilt a Record<string, string> with
 *     `headers[h.name] = value`, collapsing whatever survived a second time.
 *
 * What "reaching the wire" means here is worth stating, because it constrains
 * the fix. undici's fetch does NOT emit two field-lines for a repeated request
 * header under any input shape: an array of pairs and Headers.append both
 * arrive at the server combined into one line. That is RFC 9110 §5.3 behaviour,
 * and it is correct — a recipient may combine repeated field-lines with commas.
 * Cookie is the documented exception and joins with "; " per RFC 6265 §5.4.
 *
 * So the fix is not to carry duplicates further down; it is to combine them
 * exactly the way the transport would, instead of discarding all but the last.
 * The equivalence tests below pin our combiner to undici's own Headers rather
 * than to a hand-written expectation, so the two cannot drift.
 *
 * Header names are matched case-insensitively (they are case-insensitive per
 * RFC 9110 §5.1) but the first occurrence's casing is preserved on the wire.
 * Routing through Headers would have been simpler and was rejected: it
 * lowercases every name, which would have changed what picky servers receive.
 */

import {
  buildFetchOptions,
  bruFileToYamlRequest,
  stripCredentialHeaders,
} from '../../../src/bruno/request-executor';
import type { BruFile, YamlHeader, YamlRequest } from '../../../src/bruno/types';

const noVars = new Map<string, string>();

function reqWithHeaders(headers: YamlHeader[]): YamlRequest {
  return {
    info: { name: 'R', type: 'http' },
    http: { method: 'GET', url: 'https://api.test/resource', headers },
  } as YamlRequest;
}

/** The headers buildFetchOptions produced, as a plain Record. */
async function sentHeaders(headers: YamlHeader[]): Promise<Record<string, string>> {
  const { options } = await buildFetchOptions(reqWithHeaders(headers), noVars);
  return options.headers as Record<string, string>;
}

describe('duplicate request headers survive to the wire', () => {
  it('combines two values for the same header instead of keeping only the last', async () => {
    const headers = await sentHeaders([
      { name: 'Accept', value: 'text/plain' },
      { name: 'Accept', value: 'application/json' },
    ]);
    // Previously: 'application/json' — the first value was silently dropped.
    expect(headers.Accept).toBe('text/plain, application/json');
  });

  it('preserves order when the same header appears three times', async () => {
    const headers = await sentHeaders([
      { name: 'X-Forwarded-For', value: '10.0.0.1' },
      { name: 'X-Forwarded-For', value: '10.0.0.2' },
      { name: 'X-Forwarded-For', value: '10.0.0.3' },
    ]);
    expect(headers['X-Forwarded-For']).toBe('10.0.0.1, 10.0.0.2, 10.0.0.3');
  });

  it('joins duplicate Cookie headers with "; " rather than a comma (RFC 6265)', async () => {
    const headers = await sentHeaders([
      { name: 'Cookie', value: 'a=1' },
      { name: 'Cookie', value: 'b=2' },
    ]);
    expect(headers.Cookie).toBe('a=1; b=2');
  });

  it('treats differently-cased names as the same header, keeping the first casing', async () => {
    const headers = await sentHeaders([
      { name: 'X-MiXeD', value: 'one' },
      { name: 'x-mixed', value: 'two' },
    ]);
    expect(headers['X-MiXeD']).toBe('one, two');
    expect(headers['x-mixed']).toBeUndefined();
    expect(Object.keys(headers)).toHaveLength(1);
  });

  it('leaves a single header untouched', async () => {
    const headers = await sentHeaders([{ name: 'Accept', value: 'application/json' }]);
    expect(headers.Accept).toBe('application/json');
  });

  it('skips a disabled duplicate rather than combining it', async () => {
    const headers = await sentHeaders([
      { name: 'Accept', value: 'text/plain' },
      { name: 'Accept', value: 'application/json', disabled: true },
    ]);
    expect(headers.Accept).toBe('text/plain');
  });

  it('does not resurrect a header whose only occurrences are disabled', async () => {
    const headers = await sentHeaders([
      { name: 'X-Gone', value: 'a', disabled: true },
      { name: 'X-Gone', value: 'b', disabled: true },
    ]);
    expect(headers['X-Gone']).toBeUndefined();
  });
});

describe('our combining matches what undici would put on the wire', () => {
  // Pin the separator rules to undici's own implementation instead of to a
  // hand-written string, so a change in its combining semantics fails here
  // rather than silently diverging from what the server actually receives.
  it.each([
    ['Accept', ['text/plain', 'application/json']],
    ['Cookie', ['a=1', 'b=2']],
    ['X-Forwarded-For', ['10.0.0.1', '10.0.0.2', '10.0.0.3']],
    ['Accept-Encoding', ['gzip', 'br']],
  ])('%s combines the same way undici Headers does', async (name, values) => {
    const ours = await sentHeaders(values.map((value) => ({ name, value })));

    const reference = new Headers();
    for (const value of values) reference.append(name, value);

    expect(ours[name]).toBe(reference.get(name));
  });
});

describe('credential stripping still holds over combined headers', () => {
  it('strips a Cookie header built from several authored values', async () => {
    const headers = await sentHeaders([
      { name: 'Cookie', value: 'session=secret' },
      { name: 'Cookie', value: 'csrf=alsosecret' },
    ]);
    // Guard the premise: the combine happened, so this is a real test.
    expect(headers.Cookie).toBe('session=secret; csrf=alsosecret');

    const stripped = stripCredentialHeaders(headers, []);
    expect(stripped.Cookie).toBeUndefined();
    expect(Object.values(stripped).join(' ')).not.toContain('secret');
  });

  it('strips Authorization when it was authored twice under different casing', async () => {
    const headers = await sentHeaders([
      { name: 'Authorization', value: 'Bearer one' },
      { name: 'authorization', value: 'Bearer two' },
    ]);
    const stripped = stripCredentialHeaders(headers, []);
    expect(Object.keys(stripped)).toHaveLength(0);
  });

  it('combining cannot smuggle a credential past the deny list', async () => {
    // The combined key keeps the first occurrence's casing; stripping matches
    // lowercased, so no casing choice can produce a key that escapes it.
    const headers = await sentHeaders([
      { name: 'X-API-KEY', value: 'k1' },
      { name: 'x-api-key', value: 'k2' },
    ]);
    const stripped = stripCredentialHeaders(headers, ['X-API-KEY']);
    expect(Object.values(stripped).join(' ')).not.toContain('k1');
    expect(Object.values(stripped).join(' ')).not.toContain('k2');
  });
});

describe('duplicates on a single-value header are warned about', () => {
  // Combining is right for comma-list fields, but RFC 9110 §5.2/§5.3 only allow
  // it when the field is defined as a list — a sender must not repeat a
  // singleton field at all. Repeating Content-Type yields
  // "application/json, text/plain", which is invalid and the server will likely
  // reject. fetch offers no way to emit two field lines, so the combine stays;
  // the warning is what stops one silent behaviour (drop) being traded for
  // another (invalid value).
  async function warningsFor(headers: YamlHeader[]): Promise<string[]> {
    const { warnings } = await buildFetchOptions(reqWithHeaders(headers), noVars);
    return warnings ?? [];
  }

  it('warns when Content-Type is set twice', async () => {
    const warnings = await warningsFor([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Content-Type', value: 'text/plain' },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Content-Type');
  });

  it('warns when Authorization is set twice', async () => {
    const warnings = await warningsFor([
      { name: 'Authorization', value: 'Bearer a' },
      { name: 'Authorization', value: 'Bearer b' },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Authorization');
  });

  it('never puts the header values in the warning', async () => {
    // Same rule the unresolved-variable warnings follow: name the header, never
    // the value, because a repeated Authorization or Cookie carries a secret.
    const warnings = await warningsFor([
      { name: 'Authorization', value: 'Bearer supersecret' },
      { name: 'Authorization', value: 'Bearer alsosecret' },
    ]);
    expect(warnings.join(' ')).not.toContain('supersecret');
    expect(warnings.join(' ')).not.toContain('alsosecret');
  });

  it('does NOT warn for a comma-list field like Accept', async () => {
    const warnings = await warningsFor([
      { name: 'Accept', value: 'text/plain' },
      { name: 'Accept', value: 'application/json' },
    ]);
    expect(warnings).toEqual([]);
  });

  it('does NOT warn for Cookie, which is combined correctly per RFC 6265', async () => {
    const warnings = await warningsFor([
      { name: 'Cookie', value: 'a=1' },
      { name: 'Cookie', value: 'b=2' },
    ]);
    expect(warnings).toEqual([]);
  });

  it('warns exactly once when a singleton header appears three times', async () => {
    const warnings = await warningsFor([
      { name: 'Content-Type', value: 'a/b' },
      { name: 'Content-Type', value: 'c/d' },
      { name: 'Content-Type', value: 'e/f' },
    ]);
    expect(warnings).toHaveLength(1);
  });

  it('names the header using the first occurrence casing', async () => {
    const warnings = await warningsFor([
      { name: 'Content-Type', value: 'a/b' },
      { name: 'content-type', value: 'c/d' },
    ]);
    expect(warnings[0]).toContain('Content-Type');
    expect(warnings[0]).not.toContain('content-type');
  });

  it('does not warn when the repeat is disabled', async () => {
    const warnings = await warningsFor([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Content-Type', value: 'text/plain', disabled: true },
    ]);
    expect(warnings).toEqual([]);
  });

  it('does not warn for a single occurrence', async () => {
    expect(await warningsFor([{ name: 'Content-Type', value: 'application/json' }])).toEqual([]);
  });

  it('still combines the values — the warning does not change what is sent', async () => {
    const headers = await sentHeaders([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Content-Type', value: 'text/plain' },
    ]);
    expect(headers['Content-Type']).toBe('application/json, text/plain');
  });

  it('reports alongside an unresolved-variable warning rather than replacing it', async () => {
    const { warnings } = await buildFetchOptions(
      reqWithHeaders([
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Content-Type', value: '{{missing}}' },
      ]),
      noVars,
    );
    expect(warnings).toHaveLength(2);
    expect(warnings!.some((w) => w.includes('Content-Type'))).toBe(true);
    expect(warnings!.some((w) => w.includes('{{missing}}'))).toBe(true);
  });
});

describe('bruFileToYamlRequest keeps duplicate headers from the .bru file', () => {
  function bru(partial: Partial<BruFile>): BruFile {
    return {
      meta: { name: 'R', type: 'http' },
      http: { method: 'get', url: 'https://api.test/r' },
      ...partial,
    } as BruFile;
  }

  it('reads the order-preserving headersList rather than the flat Record', () => {
    const yaml = bruFileToYamlRequest(
      bru({
        headers: { Accept: 'application/json' }, // flat Record: duplicate already lost
        headersList: [
          { name: 'Accept', value: 'text/plain' },
          { name: 'Accept', value: 'application/json' },
        ],
      }),
    );
    expect(yaml.http.headers).toEqual([
      { name: 'Accept', value: 'text/plain' },
      { name: 'Accept', value: 'application/json' },
    ]);
  });

  it('carries a disabled header through as disabled rather than dropping it', () => {
    const yaml = bruFileToYamlRequest(
      bru({
        headers: { Accept: 'application/json' },
        headersList: [
          { name: 'Accept', value: 'application/json' },
          { name: 'X-Off', value: 'v', enabled: false },
        ],
      }),
    );
    expect(yaml.http.headers).toEqual([
      { name: 'Accept', value: 'application/json' },
      { name: 'X-Off', value: 'v', disabled: true },
    ]);
  });

  it('falls back to the flat Record when headersList is absent', () => {
    const yaml = bruFileToYamlRequest(bru({ headers: { Accept: 'application/json' } }));
    expect(yaml.http.headers).toEqual([{ name: 'Accept', value: 'application/json' }]);
  });

  it('leaves headers undefined when the .bru file has none', () => {
    const yaml = bruFileToYamlRequest(bru({}));
    expect(yaml.http.headers).toBeUndefined();
  });

  it('end-to-end: duplicates authored in .bru reach buildFetchOptions combined', async () => {
    const yaml = bruFileToYamlRequest(
      bru({
        headers: { Accept: 'application/json' },
        headersList: [
          { name: 'Accept', value: 'text/plain' },
          { name: 'Accept', value: 'application/json' },
        ],
      }),
    );
    const { options } = await buildFetchOptions(yaml, noVars);
    expect((options.headers as Record<string, string>).Accept).toBe(
      'text/plain, application/json',
    );
  });
});
