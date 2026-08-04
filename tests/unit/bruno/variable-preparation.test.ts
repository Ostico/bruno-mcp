import { prepareVariables } from '../../../src/bruno/variable-preparation';
import { substitute } from '../../../src/bruno/env-loader';
import { VariableStore } from '../../../src/bruno/variable-store';

function map(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

const NO_RUNTIME = new Map<string, string>();

describe('authored variables expand against each other, as they do under bru run', () => {
  it('resolves a value that is built out of another variable', () => {
    // The parity this exists for. Bruno scans an inserted value again, so a
    // variable holding key={{apiKey}} arrives at the wire with the key in it.
    const prepared = prepareVariables(
      map({ header: 'key={{apiKey}}', apiKey: 's3cret' }),
      NO_RUNTIME,
    );

    expect(prepared.get('header')).toBe('key=s3cret');
  });

  it('follows a chain more than one link long', () => {
    const prepared = prepareVariables(map({ a: '{{b}}', b: '{{c}}', c: 'end' }), NO_RUNTIME);

    expect(prepared.get('a')).toBe('end');
  });

  it('stops on a self-referencing value instead of looping', () => {
    // Upstream expands a bounded number of times and then leaves the placeholder
    // standing; it does not detect the cycle up front. What matters is that it
    // terminates and cannot grow without limit — a variable a collection author
    // wrote by mistake must not hang a run or exhaust memory.
    const prepared = prepareVariables(map({ loop: 'x{{loop}}' }), NO_RUNTIME);
    const value = prepared.get('loop') ?? '';

    expect(value.endsWith('{{loop}}')).toBe(true);
    expect(value.length).toBeLessThan(64);
  });

  it('resolves a chain far longer than a cycle would survive', () => {
    // The bound above is on repetition, not on depth: a genuine chain of twelve
    // distinct names still resolves all the way.
    const chain: Record<string, string> = {};
    for (let n = 0; n < 12; n++) {
      chain[`v${n}`] = n === 11 ? 'END' : `{{v${n + 1}}}`;
    }

    expect(prepareVariables(map(chain), NO_RUNTIME).get('v0')).toBe('END');
  });

  it('terminates on a mutual cycle', () => {
    const prepared = prepareVariables(map({ p: '{{q}}', q: '{{p}}' }), NO_RUNTIME);

    // Upstream stops rather than resolving; what matters here is that it stops.
    expect(prepared.get('p')).toContain('{{');
  });

  it('leaves a name nothing defines as written', () => {
    const prepared = prepareVariables(map({ url: 'https://{{host}}/v1' }), NO_RUNTIME);

    expect(prepared.get('url')).toBe('https://{{host}}/v1');
  });

  it('inherits the accessors upstream reaches through, which we do not filter', () => {
    // Bruno's interpolate resolves a placeholder against a plain object, so a
    // name that Object.prototype happens to carry resolves to that member. This
    // pins the behaviour as inherited rather than intended. It reaches nothing
    // outside the vars object: {{process.env.HOME}} and {{global}} both stay
    // literal, which the next expectations check.
    const prepared = prepareVariables(
      map({ odd: '{{constructor}}', env: '{{process.env.HOME}}', g: '{{global}}' }),
      NO_RUNTIME,
    );

    expect(prepared.get('odd')).toContain('native code');
    expect(prepared.get('env')).toBe('{{process.env.HOME}}');
    expect(prepared.get('g')).toBe('{{global}}');
  });
});

describe('runtime variables are inserted once and never scanned', () => {
  it('keeps a captured value that looks like a placeholder as text', () => {
    // The mitigation. The value came from a response body, which the collection
    // does not control; expanding it would let a response reach a secret it was
    // never given.
    const prepared = prepareVariables(
      map({ apiKey: 's3cret' }),
      map({ captured: 'key={{apiKey}}' }),
    );

    expect(prepared.get('captured')).toBe('key={{apiKey}}');
    // And the template that uses it gets the text, not the secret.
    expect(substitute('{{captured}}', prepared)).toBe('key={{apiKey}}');
  });

  it('fills an authored value from a captured one', () => {
    // The other half: an environment variable written as a template around a
    // token the run captures has to pick that token up.
    const prepared = prepareVariables(
      map({ auth: 'Bearer {{token}}' }),
      map({ token: 'abc123' }),
    );

    expect(prepared.get('auth')).toBe('Bearer abc123');
  });

  it('does not rescan what a captured value contributed to an authored one', () => {
    // The case that decides the order of the two passes. The authored value is
    // expanded against authored names first, so the captured text lands last and
    // its placeholder is never looked at.
    const prepared = prepareVariables(
      map({ apiKey: 's3cret', header: '{{captured}}' }),
      map({ captured: 'key={{apiKey}}' }),
    );

    expect(prepared.get('header')).toBe('key={{apiKey}}');
  });

  it('wins over an authored variable of the same name', () => {
    const prepared = prepareVariables(map({ token: 'from-env' }), map({ token: 'from-script' }));

    expect(prepared.get('token')).toBe('from-script');
  });

  it('is not expanded even when it names another runtime variable', () => {
    const prepared = prepareVariables(NO_RUNTIME, map({ a: '{{b}}', b: 'value' }));

    expect(prepared.get('a')).toBe('{{b}}');
  });
});

describe('the store applies the same rules', () => {
  it('resolves authored values and lets runtime ones win', () => {
    const store = new VariableStore();
    store.set('token', 'runtime-token');

    const merged = store.merge(map({ auth: 'Bearer {{token}}', greeting: 'hi {{name}}', name: 'ada' }));

    expect(merged.get('auth')).toBe('Bearer runtime-token');
    expect(merged.get('greeting')).toBe('hi ada');
    expect(merged.get('token')).toBe('runtime-token');
  });
});
