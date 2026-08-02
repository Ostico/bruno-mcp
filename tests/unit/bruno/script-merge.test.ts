/**
 * The merge rules, away from the executor that runs the result.
 *
 * `root-script-execution.test.ts` proves the merged program does the right
 * thing when run; this pins the text it produces, which is where the two
 * non-obvious rules live — the flow reversal, and the fact that a request with
 * no root scripts must come out exactly as it went in.
 */
import {
  mergePreRequest,
  mergePostResponse,
  ownPreRequestScript,
  ownPostScripts,
  scriptFlowFrom,
  type ScriptLayer,
} from '../../../src/bruno/script-merge';
import type { YamlRequest } from '../../../src/bruno/types';

const layer = (source: string, parts: Partial<ScriptLayer> = {}): ScriptLayer => ({
  source,
  ...parts,
});

/** Order of appearance, by the marker each segment carries. */
const order = (program: string | null): string[] =>
  [...(program ?? '').matchAll(/MARK_(\w+)/g)].map((match) => match[1]!);

describe('merging pre-request scripts', () => {
  it('returns the request untouched when no root has one', () => {
    expect(mergePreRequest([], 'MARK_R')).toBe('MARK_R');
  });

  it('returns null when nothing anywhere has one', () => {
    expect(mergePreRequest([layer('collection.bru')], null)).toBeNull();
  });

  it('runs outermost first: collection, folders top-down, then the request', () => {
    const merged = mergePreRequest(
      [
        layer('collection.bru', { preRequest: 'MARK_C' }),
        layer('a/folder.bru', { preRequest: 'MARK_1' }),
        layer('a/b/folder.bru', { preRequest: 'MARK_2' }),
      ],
      'MARK_R',
    );

    expect(order(merged)).toEqual(['C', '1', '2', 'R']);
  });

  it('wraps each segment once a root contributes', () => {
    const merged = mergePreRequest([layer('collection.bru', { preRequest: 'MARK_C' })], 'MARK_R');

    // The isolation upstream always applies: two sources may both declare the
    // same const without the second being a redeclaration.
    expect(merged).toBe('await (async () => {\nMARK_C\n})();\n\nawait (async () => {\nMARK_R\n})();');
  });

  it('leaves a lone root script unwrapped, exactly as it leaves a lone request one', () => {
    // One source has nothing to collide with, so its text is emitted as
    // authored whichever source it is.
    expect(mergePreRequest([layer('collection.bru', { preRequest: 'MARK_C' })], null)).toBe('MARK_C');
  });

  it('ignores a slot that is present but blank', () => {
    expect(mergePreRequest([layer('collection.bru', { preRequest: '   \n  ' })], 'MARK_R')).toBe(
      'MARK_R',
    );
  });
});

describe('merging the post-response phase', () => {
  const own = { postResponse: 'MARK_R', tests: 'MARK_T' };

  it('leaves a request with no root scripts exactly as it was', () => {
    // Byte-for-byte the old concatenation, so the single shared scope a
    // request's post-response script and its tests have always had survives.
    expect(mergePostResponse([], own, 'sandwich')).toBe('MARK_R\nMARK_T');
  });

  it('returns null when the request has neither slot and no root does', () => {
    expect(mergePostResponse([], { postResponse: null, tests: null }, 'sandwich')).toBeNull();
  });

  it('reverses under sandwich, the default flow', () => {
    const merged = mergePostResponse(
      [
        layer('collection.bru', { postResponse: 'MARK_C' }),
        layer('sub/folder.bru', { postResponse: 'MARK_F' }),
      ],
      { postResponse: 'MARK_R', tests: null },
      'sandwich',
    );

    expect(order(merged)).toEqual(['R', 'F', 'C']);
  });

  it('keeps outermost-first under sequential', () => {
    const merged = mergePostResponse(
      [
        layer('collection.bru', { postResponse: 'MARK_C' }),
        layer('sub/folder.bru', { postResponse: 'MARK_F' }),
      ],
      { postResponse: 'MARK_R', tests: null },
      'sequential',
    );

    expect(order(merged)).toEqual(['C', 'F', 'R']);
  });

  it('runs every post-response script before any test, whatever the flow', () => {
    // Phases, not layers. Were this grouped per layer, the collection's test
    // would run before the request's post-response script.
    const layers = [
      layer('collection.bru', { postResponse: 'MARK_CS', tests: 'MARK_CT' }),
    ];

    expect(order(mergePostResponse(layers, own, 'sandwich'))).toEqual(['R', 'CS', 'T', 'CT']);
    expect(order(mergePostResponse(layers, own, 'sequential'))).toEqual(['CS', 'R', 'CT', 'T']);
  });

  it('applies the flow to tests as well as to post-response scripts', () => {
    const layers = [
      layer('collection.bru', { tests: 'MARK_C' }),
      layer('sub/folder.bru', { tests: 'MARK_F' }),
    ];

    expect(order(mergePostResponse(layers, { postResponse: null, tests: 'MARK_R' }, 'sandwich')))
      .toEqual(['R', 'F', 'C']);
    expect(order(mergePostResponse(layers, { postResponse: null, tests: 'MARK_R' }, 'sequential')))
      .toEqual(['C', 'F', 'R']);
  });

  it('wraps segments once a root contributes, so scopes cannot collide', () => {
    const merged = mergePostResponse(
      [layer('collection.bru', { postResponse: 'MARK_C' })],
      { postResponse: 'MARK_R', tests: null },
      'sandwich',
    );

    expect(merged).toBe('await (async () => {\nMARK_R\n})();\n\nawait (async () => {\nMARK_C\n})();');
  });

  it('does not treat a root that only declares a pre-request script as a contributor', () => {
    // Otherwise a collection with only a pre-request script would silently
    // change the shape of every request's post-response program.
    expect(mergePostResponse([layer('collection.bru', { preRequest: 'MARK_C' })], own, 'sandwich'))
      .toBe('MARK_R\nMARK_T');
  });
});

describe('reading a request own scripts', () => {
  const yaml = (scripts: { type: string; code: string }[]): YamlRequest =>
    ({ runtime: { scripts } }) as unknown as YamlRequest;

  it('returns null when a request declares no scripts at all', () => {
    expect(ownPreRequestScript({} as YamlRequest)).toBeNull();
    expect(ownPostScripts({} as YamlRequest)).toEqual({ postResponse: null, tests: null });
  });

  it('keeps the two post-response halves apart', () => {
    expect(ownPostScripts(yaml([
      { type: 'tests', code: 'T' },
      { type: 'after-response', code: 'A' },
    ]))).toEqual({ postResponse: 'A', tests: 'T' });
  });

  it('joins repeated blocks of the same kind in file order', () => {
    expect(ownPreRequestScript(yaml([
      { type: 'before-request', code: 'one' },
      { type: 'after-response', code: 'skipped' },
      { type: 'before-request', code: 'two' },
    ]))).toBe('one\ntwo');
  });
});

describe('reading scripts.flow from bruno.json', () => {
  it('defaults to sandwich, which is upstream default', () => {
    expect(scriptFlowFrom(null)).toBe('sandwich');
    expect(scriptFlowFrom({})).toBe('sandwich');
    expect(scriptFlowFrom({ scripts: {} })).toBe('sandwich');
  });

  it('reads sequential when it is set', () => {
    expect(scriptFlowFrom({ scripts: { flow: 'sequential' } })).toBe('sequential');
  });

  it('falls back to the default for a value it does not recognise', () => {
    // Bruno's field, not this server's: refusing to run a collection over a
    // setting merely read here would be worse than running it the usual way.
    expect(scriptFlowFrom({ scripts: { flow: 'backwards' } })).toBe('sandwich');
  });
});
