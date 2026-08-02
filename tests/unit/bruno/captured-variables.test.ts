/**
 * What a group reports back about the variables its scripts captured.
 *
 * The reduction itself, away from the executor that feeds it. The rule worth
 * pinning is the one a reader would otherwise have to infer: names come back
 * unasked while values do not.
 */
import { collectCapturedVariables } from '../../../src/bruno/captured-variables';

const store = (entries: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(entries));

describe('reporting captured variables', () => {
  it('lists every name a script set even when nothing was asked for', () => {
    const report = collectCapturedVariables(store({ token: 'abc', userId: '7' }));

    expect(report.names).toEqual(['token', 'userId']);
    expect(report.values).toEqual({});
    expect(report.warnings).toEqual([]);
  });

  it('withholds values until they are asked for by name', () => {
    const report = collectCapturedVariables(store({ token: 'abc', userId: '7' }), ['userId']);

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
      store({ token: 'eyJhbGciOi.secret.value' }),
      ['token'],
    );

    expect(report.values.token).toBe('eyJhbGciOi.secret.value');
  });

  it('sorts names so two runs of the same collection agree', () => {
    const report = collectCapturedVariables(store({ zulu: '1', alpha: '2', mike: '3' }));

    expect(report.names).toEqual(['alpha', 'mike', 'zulu']);
  });

  it('warns instead of returning an empty string for a name no script set', () => {
    // An empty string would be indistinguishable from a script that set one,
    // which is the difference between "the login failed" and "the login
    // returned an empty token".
    const report = collectCapturedVariables(store({ token: 'abc' }), ['token', 'refresh']);

    expect(report.values).toEqual({ token: 'abc' });
    expect(report.values).not.toHaveProperty('refresh');
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('refresh');
    expect(report.warnings[0]).not.toContain('token');
  });

  it('reports a name asked for twice only once', () => {
    const report = collectCapturedVariables(store({}), ['refresh', 'refresh']);

    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]!.match(/refresh/g)).toHaveLength(1);
  });

  it('says nothing at all about a group whose scripts set nothing', () => {
    const report = collectCapturedVariables(store({}));

    expect(report).toEqual({ names: [], values: {}, warnings: [] });
  });

  it('reads one store, so a name set twice in it is reported once', () => {
    // There is no second store to reconcile against any more: a group has
    // exactly one, and a later bru.setVar to the same name has already
    // overwritten the earlier value inside it before this ever runs.
    const single = store({ token: 'second-write' });

    const report = collectCapturedVariables(single, ['token']);

    expect(report.names).toEqual(['token']);
    expect(report.values).toEqual({ token: 'second-write' });
    expect(report.warnings).toEqual([]);
  });
});
