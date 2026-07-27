/**
 * Tests for VariableStore — pure in-memory runtime variable store.
 *
 * The store converts all values to strings (matching substitute()'s
 * Map<string, string> contract) and uses Map internally.
 */

import { VariableStore } from '../../../src/bruno/variable-store';

describe('VariableStore', () => {
  let store: VariableStore;

  beforeEach(() => {
    store = new VariableStore();
  });

  describe('set and get', () => {
    it('should store and retrieve a string value', () => {
      store.set('token', 'abc123');
      expect(store.get('token')).toBe('abc123');
    });

    it('should store a number value converted to string', () => {
      store.set('count', 42);
      expect(store.get('count')).toBe('42');
    });

    it('should store a boolean value converted to string', () => {
      store.set('flag', true);
      expect(store.get('flag')).toBe('true');
    });

    it('should store an empty string', () => {
      store.set('empty', '');
      expect(store.get('empty')).toBe('');
    });

    it('should store zero converted to string', () => {
      store.set('zero', 0);
      expect(store.get('zero')).toBe('0');
    });

    it('should store false converted to string', () => {
      store.set('off', false);
      expect(store.get('off')).toBe('false');
    });

    it('should return undefined for nonexistent key', () => {
      expect(store.get('missing')).toBeUndefined();
    });

    it('should overwrite an existing value', () => {
      store.set('x', 'first');
      store.set('x', 'second');
      expect(store.get('x')).toBe('second');
    });
  });

  describe('getAll', () => {
    it('should return all stored variables as a new Map', () => {
      store.set('a', 'alpha');
      store.set('b', 'beta');
      const all = store.getAll();
      expect(all.get('a')).toBe('alpha');
      expect(all.get('b')).toBe('beta');
      expect(all.size).toBe(2);
    });

    it('should return a copy (mutations do not affect the store)', () => {
      store.set('x', 'original');
      const all = store.getAll();
      all.set('x', 'mutated');
      expect(store.get('x')).toBe('original');
    });

    it('should return empty map when store is empty', () => {
      const all = store.getAll();
      expect(all.size).toBe(0);
    });
  });

  describe('merge', () => {
    it('should combine env vars with runtime vars (runtime wins)', () => {
      const envVars = new Map([
        ['base_url', 'https://api.example.com'],
        ['token', 'env-token'],
      ]);
      store.set('token', 'runtime-token');
      store.set('extra', 'runtime-only');

      const merged = store.merge(envVars);

      expect(merged.get('base_url')).toBe('https://api.example.com');
      expect(merged.get('token')).toBe('runtime-token');
      expect(merged.get('extra')).toBe('runtime-only');
      expect(merged.size).toBe(3);
    });

    it('should not modify the original env vars map', () => {
      const envVars = new Map([['key', 'env']]);
      store.set('key', 'runtime');
      store.merge(envVars);
      expect(envVars.get('key')).toBe('env');
    });

    it('should return env vars unchanged when store is empty', () => {
      const envVars = new Map([['a', '1'], ['b', '2']]);
      const merged = store.merge(envVars);
      expect(merged.get('a')).toBe('1');
      expect(merged.get('b')).toBe('2');
      expect(merged.size).toBe(2);
    });

    it('should return only runtime vars when env is empty', () => {
      store.set('x', 'val');
      const merged = store.merge(new Map());
      expect(merged.get('x')).toBe('val');
      expect(merged.size).toBe(1);
    });

    it('should return empty map when both store and env are empty', () => {
      const merged = store.merge(new Map());
      expect(merged.size).toBe(0);
    });
  });

  describe('unset values (undefined / null)', () => {
    // bru.setVar(name, value) can be called with an undefined or null value
    // (e.g. a script does `bru.setVar('token', res.body.token)` when the field
    // is missing). Runtime callers cast through `as string | number | boolean`,
    // so these reach set() at runtime. They must NOT be coerced to the literal
    // strings "undefined"/"null" — that would ship a bogus 5/4-letter token on
    // the wire via {{token}}. An unset value leaves the variable unresolved.
    const setUnknown = (name: string, value: unknown): void => {
      store.set(name, value as string | number | boolean);
    };

    it('should not store the literal string "undefined" for an undefined value', () => {
      setUnknown('token', undefined);
      expect(store.get('token')).toBeUndefined();
    });

    it('should not store the literal string "null" for a null value', () => {
      setUnknown('token', null);
      expect(store.get('token')).toBeUndefined();
    });

    it('should not expose an undefined value through getAll', () => {
      setUnknown('token', undefined);
      expect(store.getAll().has('token')).toBe(false);
      expect(store.getAll().size).toBe(0);
    });

    it('should not leak "undefined" into a merge result', () => {
      setUnknown('token', undefined);
      const merged = store.merge(new Map([['base_url', 'https://api.example.com']]));
      expect(merged.has('token')).toBe(false);
      expect(merged.get('token')).toBeUndefined();
      expect(merged.size).toBe(1);
    });

    it('should unset an existing variable when set to undefined', () => {
      store.set('token', 'real-token');
      setUnknown('token', undefined);
      expect(store.get('token')).toBeUndefined();
    });

    it('should unset an existing variable when set to null', () => {
      store.set('token', 'real-token');
      setUnknown('token', null);
      expect(store.get('token')).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('should remove all stored variables', () => {
      store.set('a', 'alpha');
      store.set('b', 'beta');
      store.clear();
      expect(store.get('a')).toBeUndefined();
      expect(store.get('b')).toBeUndefined();
      expect(store.getAll().size).toBe(0);
    });

    it('should be safe to call on an already-empty store', () => {
      store.clear();
      expect(store.getAll().size).toBe(0);
    });

    it('should allow setting new variables after clear', () => {
      store.set('x', 'before');
      store.clear();
      store.set('x', 'after');
      expect(store.get('x')).toBe('after');
    });
  });
});
