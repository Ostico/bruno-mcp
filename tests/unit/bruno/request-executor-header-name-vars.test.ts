/**
 * A `{{var}}` in a header NAME has to be treated like one in a header value.
 *
 * Only values were substituted and only values were tracked, so a header
 * authored as `{{tokenHeader}}: abc` went on the wire with the literal name
 * `{{tokenHeader}}` — and the unresolved-variable report, the one mechanism that
 * exists to stop an unsubstituted placeholder reaching the wire silently, did
 * not mention it.
 */

import { buildFetchOptions } from '../../../src/bruno/request-executor';
import type { YamlRequest } from '../../../src/bruno/types';

function requestWithHeaders(
  headers: Array<{ name: string; value: string; disabled?: boolean }>,
): YamlRequest {
  return {
    info: { name: 'Headed', type: 'http', seq: 1 },
    http: { method: 'GET', url: 'https://api.test/r', headers },
  } as unknown as YamlRequest;
}

describe('variables in header names', () => {
  it('substitutes a variable used as a header name', async () => {
    const { options } = await buildFetchOptions(
      requestWithHeaders([{ name: '{{tokenHeader}}', value: 'abc' }]),
      new Map([['tokenHeader', 'X-Auth-Token']]),
    );

    expect(options.headers).toEqual({ 'X-Auth-Token': 'abc' });
  });

  it('reports an unresolved header name as an unresolved variable', async () => {
    const { options, warnings } = await buildFetchOptions(
      requestWithHeaders([{ name: '{{tokenHeader}}', value: 'abc' }]),
      new Map(),
    );

    expect(warnings).toEqual(
      expect.arrayContaining(['unresolved variable: {{tokenHeader}}']),
    );
    // Unresolved leaves the template in place, matching how values behave.
    expect(options.headers).toEqual({ '{{tokenHeader}}': 'abc' });
  });

  it('reports an unresolved name and value together', async () => {
    const { warnings } = await buildFetchOptions(
      requestWithHeaders([{ name: '{{hName}}', value: '{{hValue}}' }]),
      new Map(),
    );

    expect(warnings).toEqual(
      expect.arrayContaining([
        'unresolved variable: {{hName}}',
        'unresolved variable: {{hValue}}',
      ]),
    );
  });

  it('does not track a disabled header name', async () => {
    const { options, warnings } = await buildFetchOptions(
      requestWithHeaders([{ name: '{{tokenHeader}}', value: 'abc', disabled: true }]),
      new Map(),
    );

    expect(options.headers).toEqual({});
    expect(warnings).toBeUndefined();
  });

  it('collapses two headers whose names substitute to the same field', async () => {
    // The duplicate bookkeeping keys off the header NAME, so it has to run on
    // the substituted name — otherwise two distinct templates resolving to one
    // field look like two different headers.
    const { options } = await buildFetchOptions(
      requestWithHeaders([
        { name: '{{h1}}', value: 'first' },
        { name: '{{h2}}', value: 'second' },
      ]),
      new Map([
        ['h1', 'X-Trace'],
        ['h2', 'X-Trace'],
      ]),
    );

    expect(options.headers).toEqual({ 'X-Trace': 'first, second' });
  });

  it('warns about a single-value header duplicated via substituted names', async () => {
    const { warnings } = await buildFetchOptions(
      requestWithHeaders([
        { name: '{{authHeader}}', value: 'Bearer a' },
        { name: 'Authorization', value: 'Bearer b' },
      ]),
      new Map([['authHeader', 'Authorization']]),
    );

    expect(warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('single-value field')]),
    );
    // The credential values must never appear in a warning.
    expect(JSON.stringify(warnings)).not.toContain('Bearer a');
    expect(JSON.stringify(warnings)).not.toContain('Bearer b');
  });

  it('leaves a plain header name untouched', async () => {
    const { options, warnings } = await buildFetchOptions(
      requestWithHeaders([{ name: 'Accept', value: 'application/json' }]),
      new Map(),
    );

    expect(options.headers).toEqual({ Accept: 'application/json' });
    expect(warnings).toBeUndefined();
  });
});
