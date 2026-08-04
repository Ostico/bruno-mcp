import {
  expandDynamicVariables,
  isDynamicVariable,
} from '../../../src/bruno/dynamic-variables.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('expandDynamicVariables', () => {
  it('generates a value for a known keyword', () => {
    expect(expandDynamicVariables('{{$guid}}')).toMatch(UUID);
  });

  it('leaves the surrounding text alone', () => {
    const result = expandDynamicVariables('id-{{$guid}}-end');
    expect(result.startsWith('id-')).toBe(true);
    expect(result.endsWith('-end')).toBe(true);
  });

  it('generates a fresh value per occurrence, the way upstream does', () => {
    const [first, second] = expandDynamicVariables('{{$guid}} {{$guid}}').split(' ');
    expect(first).toMatch(UUID);
    expect(second).toMatch(UUID);
    expect(first).not.toBe(second);
  });

  it('leaves an unknown keyword exactly as written', () => {
    // The near miss a typo produces. Turning it into `undefined` would put that
    // word on the wire; left alone, the unresolved-variable report can name it.
    expect(expandDynamicVariables('{{$gid}}')).toBe('{{$gid}}');
  });

  it('leaves an ordinary variable placeholder alone', () => {
    expect(expandDynamicVariables('{{host}}')).toBe('{{host}}');
  });

  it('returns empty text untouched', () => {
    expect(expandDynamicVariables('')).toBe('');
  });

  it('resolves a prototype member the way upstream does', () => {
    // Inherited, not endorsed: the table is a plain object, so `$constructor`
    // finds `Object` and calls it. Upstream renders the same inert text, and
    // matching it beats explaining a divergence. Nothing host-side is reachable.
    expect(expandDynamicVariables('{{$constructor}}')).toBe('[object Object]');
  });

  describe('escaping for JSON', () => {
    it('escapes the characters that would break a JSON string', () => {
      // `randomLoremParagraphs` is the generator that reliably produces newlines.
      const escaped = expandDynamicVariables('{"text":"{{$randomLoremParagraphs}}"}', true);
      expect(escaped).toContain('\\n');
      expect(escaped).not.toMatch(/[\n\r\t]/);
      expect(() => JSON.parse(escaped) as unknown).not.toThrow();
    });

    it('leaves a generated value without special characters unchanged', () => {
      // The fast path: a guid has nothing to escape, so escaping must not alter it.
      const plain = expandDynamicVariables('{{$guid}}', false);
      const escaped = expandDynamicVariables('{{$guid}}', true);
      expect(plain).toMatch(UUID);
      expect(escaped).toMatch(UUID);
    });

    it('does not escape when asked not to', () => {
      const raw = expandDynamicVariables('{{$randomLoremParagraphs}}', false);
      expect(raw).toMatch(/\n/);
    });
  });
});

describe('isDynamicVariable', () => {
  it('recognises a generator', () => {
    expect(isDynamicVariable('$guid')).toBe(true);
    expect(isDynamicVariable('$timestamp')).toBe(true);
  });

  it('rejects a name that is not prefixed', () => {
    expect(isDynamicVariable('guid')).toBe(false);
  });

  it('rejects a keyword no generator answers to', () => {
    expect(isDynamicVariable('$gid')).toBe(false);
  });
});
