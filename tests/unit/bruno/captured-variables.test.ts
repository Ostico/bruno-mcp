/**
 * What a group reports back about the variables its scripts captured, and what
 * the run makes of it.
 *
 * The reduction itself, away from the executor that feeds it. Two rules worth
 * pinning, because a reader would otherwise have to infer them: names come back
 * unasked while values do not, and a name one group's store lacks is not a
 * finding — only a name every group lacked is.
 */
import {
  collectCapturedVariables,
  reconcileCapturedVariables,
} from '../../../src/bruno/captured-variables';

const store = (entries: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(entries));

describe('reporting captured variables', () => {
  it('lists every name a script set even when nothing was asked for', () => {
    const report = collectCapturedVariables(store({ token: 'abc', userId: '7' }));

    expect(report.names).toEqual(['token', 'userId']);
    expect(report.values).toEqual({});
    expect(report.unresolved).toEqual([]);
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

  it('reports a name no script set rather than returning an empty string', () => {
    // An empty string would be indistinguishable from a script that set one,
    // which is the difference between "the login failed" and "the login
    // returned an empty token".
    const report = collectCapturedVariables(store({ token: 'abc' }), ['token', 'refresh']);

    expect(report.values).toEqual({ token: 'abc' });
    expect(report.values).not.toHaveProperty('refresh');
    expect(report.unresolved).toEqual(['refresh']);
  });

  it('sorts the names it could not resolve, whatever order they were asked in', () => {
    const report = collectCapturedVariables(store({}), ['zulu', 'alpha']);

    expect(report.unresolved).toEqual(['alpha', 'zulu']);
  });

  it('reports a name asked for twice only once', () => {
    const report = collectCapturedVariables(store({}), ['refresh', 'refresh']);

    expect(report.unresolved).toEqual(['refresh']);
  });

  it('says nothing at all about a group whose scripts set nothing', () => {
    const report = collectCapturedVariables(store({}));

    expect(report).toEqual({ names: [], values: {}, unresolved: [] });
  });

  it('reads one store, so a name set twice in it is reported once', () => {
    // There is no second store to reconcile against any more: a group has
    // exactly one, and a later bru.setVar to the same name has already
    // overwritten the earlier value inside it before this ever runs.
    const single = store({ token: 'second-write' });

    const report = collectCapturedVariables(single, ['token']);

    expect(report.names).toEqual(['token']);
    expect(report.values).toEqual({ token: 'second-write' });
    expect(report.unresolved).toEqual([]);
  });
});

describe('reconciling captured variables across groups', () => {
  const report = (unresolved: string[]) => ({ names: [], values: {}, unresolved });

  it('says nothing when each group set what the other group lacked', () => {
    // Two groups, each capturing one of the two requested names. Every group's
    // own store is missing a name, and nothing is wrong: this is what group
    // isolation is for. Warned per group, this run said twice that a name was
    // never set, each time naming the one the other group had just set.
    const warnings = reconcileCapturedVariables(
      [report(['refresh']), report(['token'])],
      new Set(),
    );

    expect(warnings).toEqual([]);
  });

  it('warns once for a name no group set anywhere', () => {
    const warnings = reconcileCapturedVariables(
      [report(['tokne', 'refresh']), report(['tokne'])],
      new Set(),
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('tokne');
    expect(warnings[0]).toContain('bru.setVar');
    // `refresh` was set by the second group, so only the typo survives.
    expect(warnings[0]).not.toContain('refresh');
  });

  it('names a vars:preRequest variable as scoped rather than as never set', () => {
    // The name IS being set; it is the asking for its value here that cannot
    // work, because a pre-request vars block is applied for interpolation and
    // never reaches the store this reads. Telling the caller no script set it
    // sent them looking for a bug that is not there.
    const warnings = reconcileCapturedVariables([report(['host'])], new Set(['host']));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('host');
    expect(warnings[0]).toContain('vars:preRequest');
    expect(warnings[0]).not.toContain('no script set');
  });

  it('separates the two explanations when a run has one of each', () => {
    const warnings = reconcileCapturedVariables(
      [report(['host', 'tokne'])],
      new Set(['host']),
    );

    expect(warnings).toHaveLength(2);
    const nowhere = warnings.find((w) => w.includes('no script set'))!;
    const scoped = warnings.find((w) => w.includes('vars:preRequest'))!;
    expect(nowhere).toContain('tokne');
    expect(nowhere).not.toContain('host');
    expect(scoped).toContain('host');
    expect(scoped).not.toContain('tokne');
  });

  it('says nothing about a run whose every group crashed before reporting', () => {
    // No report is not the same as a report of nothing: a run that produced no
    // store at all has a crash to explain itself, and a note about capture on
    // top of it would be noise.
    expect(reconcileCapturedVariables([], new Set(['host']))).toEqual([]);
  });

  it('sorts the names it lists so two runs of the same collection agree', () => {
    const warnings = reconcileCapturedVariables([report(['zulu', 'alpha'])], new Set());

    expect(warnings[0]).toContain('alpha, zulu');
  });
});
