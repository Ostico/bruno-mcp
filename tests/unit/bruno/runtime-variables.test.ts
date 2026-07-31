/**
 * Tests for the run-scoped variable override helpers.
 *
 * Wire-level behaviour (does an injected value actually reach the request, and
 * does anything reach disk) lives in request-executor-runtime-variables.test.ts.
 * This file covers coercion, name rejection, and map precedence.
 */

import {
  normalizeVariableOverrides,
  applyVariableOverrides,
} from '../../../src/bruno/runtime-variables';

describe('normalizeVariableOverrides', () => {
  it('returns an empty result for no input', () => {
    expect(normalizeVariableOverrides(undefined)).toEqual({ variables: {}, errors: [] });
  });

  it('coerces numbers and booleans, since everything downstream substitutes strings', () => {
    const { variables, errors } = normalizeVariableOverrides({
      token: 'secret-abc',
      port: 8080,
      verbose: false,
    });

    expect(errors).toEqual([]);
    expect(variables).toEqual({ token: 'secret-abc', port: '8080', verbose: 'false' });
  });

  it('keeps an empty string, which is a real value a caller may mean', () => {
    const { variables, errors } = normalizeVariableOverrides({ suffix: '' });

    expect(errors).toEqual([]);
    expect(variables).toEqual({ suffix: '' });
  });

  it('rejects a name no {{placeholder}} could reference instead of dropping it', () => {
    const { variables, errors } = normalizeVariableOverrides({
      '': 'empty',
      'has space ': 'trailing',
      'br{ace': 'open',
      'br}ace': 'close',
      good: 'kept',
    });

    // The one usable name still applies; the rest are reported, not silently lost.
    expect(variables).toEqual({ good: 'kept' });
    expect(errors).toHaveLength(4);
    expect(errors.join(' ')).toContain('name is empty');
    expect(errors.join(' ')).toContain('leading or trailing whitespace');
    expect(errors.filter((e) => e.includes('brace')).length).toBeGreaterThanOrEqual(2);
    // The offending name is quoted into the message, so a caller can find it.
    expect(errors.some((e) => e.includes('"br}ace"'))).toBe(true);
  });
});

describe('applyVariableOverrides', () => {
  it('overrides an environment value and adds a new one', () => {
    const env = new Map([['base_url', 'https://from-file'], ['keep', 'kept']]);

    const merged = applyVariableOverrides(env, {
      base_url: 'https://from-caller',
      token: 'injected',
    });

    expect(merged.get('base_url')).toBe('https://from-caller');
    expect(merged.get('token')).toBe('injected');
    expect(merged.get('keep')).toBe('kept');
  });

  it('does not mutate the map it was given', () => {
    const env = new Map([['base_url', 'https://from-file']]);

    applyVariableOverrides(env, { base_url: 'https://from-caller' });

    expect(env.get('base_url')).toBe('https://from-file');
  });

  it('returns the base map unchanged when there is nothing to apply', () => {
    const env = new Map([['a', 'b']]);

    expect(applyVariableOverrides(env, undefined)).toBe(env);
    expect(applyVariableOverrides(env, {})).toBe(env);
  });

  it('works from an empty base, which is the no-environment case', () => {
    const merged = applyVariableOverrides(new Map(), { token: 'injected' });

    expect(Object.fromEntries(merged)).toEqual({ token: 'injected' });
  });
});
