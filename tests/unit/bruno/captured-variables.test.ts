/**
 * What a run reports back about the variables its scripts captured.
 *
 * The reduction itself, away from the executor that feeds it. The two rules
 * worth pinning are the ones a reader would otherwise have to infer: names come
 * back unasked while values do not, and a parallel run's isolated folders can
 * disagree about a name without either of them being wrong.
 */
import { collectCapturedVariables } from '../../../src/bruno/captured-variables';

const store = (entries: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(entries));

describe('reporting captured variables', () => {
  it('lists every name a script set even when nothing was asked for', () => {
    const report = collectCapturedVariables([store({ token: 'abc', userId: '7' })]);

    expect(report.names).toEqual(['token', 'userId']);
    expect(report.values).toEqual({});
    expect(report.warnings).toEqual([]);
  });

  it('withholds values until they are asked for by name', () => {
    const report = collectCapturedVariables(
      [store({ token: 'abc', userId: '7' })],
      ['userId'],
    );

    // The point of the whole module: `token` was set, is listed, and its value
    // is not in the result because nobody asked for it.
    expect(report.names).toEqual(['token', 'userId']);
    expect(report.values).toEqual({ userId: '7' });
  });

  it('returns a requested value verbatim rather than masking it', () => {
    // Deliberate. run_collection returns response_body by default and a
    // captured token came out of a response body, so masking here would protect
    // nothing while making the feature useless for its one purpose.
    const report = collectCapturedVariables(
      [store({ token: 'eyJhbGciOi.secret.value' })],
      ['token'],
    );

    expect(report.values.token).toBe('eyJhbGciOi.secret.value');
  });

  it('sorts names so two runs of the same collection agree', () => {
    const report = collectCapturedVariables([store({ zulu: '1', alpha: '2', mike: '3' })]);

    expect(report.names).toEqual(['alpha', 'mike', 'zulu']);
  });

  it('warns instead of returning an empty string for a name no script set', () => {
    // An empty string would be indistinguishable from a script that set one,
    // which is the difference between "the login failed" and "the login
    // returned an empty token".
    const report = collectCapturedVariables([store({ token: 'abc' })], ['token', 'refresh']);

    expect(report.values).toEqual({ token: 'abc' });
    expect(report.values).not.toHaveProperty('refresh');
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('refresh');
    expect(report.warnings[0]).not.toContain('token');
  });

  it('reports a name asked for twice only once', () => {
    const report = collectCapturedVariables([store({})], ['refresh', 'refresh']);

    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]!.match(/refresh/g)).toHaveLength(1);
  });

  it('merges folders that set different names', () => {
    const report = collectCapturedVariables(
      [store({ authToken: 'a' }), store({ orderId: '9' })],
      ['authToken', 'orderId'],
    );

    expect(report.values).toEqual({ authToken: 'a', orderId: '9' });
    expect(report.warnings).toEqual([]);
  });

  it('keeps the first folder value and warns when folders disagree', () => {
    // Folders are isolated in a parallel run, so both values are genuinely
    // "the" value — of different folders. Reporting one silently would present
    // a value no single folder produced.
    const report = collectCapturedVariables(
      [store({ token: 'from-first' }), store({ token: 'from-second' })],
      ['token'],
    );

    expect(report.values.token).toBe('from-first');
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('token');
  });

  it('stays quiet when two folders agree on a value', () => {
    const report = collectCapturedVariables([store({ token: 'same' }), store({ token: 'same' })]);

    expect(report.names).toEqual(['token']);
    expect(report.warnings).toEqual([]);
  });

  it('names every disagreeing variable in one warning', () => {
    const report = collectCapturedVariables([
      store({ token: 'a', userId: '1', stable: 'x' }),
      store({ token: 'b', userId: '2', stable: 'x' }),
    ]);

    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('token');
    expect(report.warnings[0]).toContain('userId');
    expect(report.warnings[0]).not.toContain('stable');
  });

  it('says nothing at all about a run whose scripts set nothing', () => {
    const report = collectCapturedVariables([store({})]);

    expect(report).toEqual({ names: [], values: {}, warnings: [] });
  });

  it('handles a run with no stores at all', () => {
    expect(collectCapturedVariables([], ['token']).names).toEqual([]);
  });
});
