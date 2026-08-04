/**
 * `tags` survives a rewrite, in both formats (defect-register L16).
 *
 * The model is upstream's: a list of strings, written only when non-empty, and
 * anything that is not a list read as no tags at all. Both ends of Bruno agree
 * on that — `bruno-cli/src/utils/bru.js:80` and `bruno-filestore`'s
 * `parseApp.ts:22` both normalize with `Array.isArray(tags) ? tags : []`.
 *
 * The single-line form `tags: smoke` is therefore NOT a tags list. It parses to
 * the string `'smoke'`, which upstream reads as no tags, and which `jsonToBruV2`
 * would write back one character per line if handed to it. It is dropped on
 * rewrite rather than repaired: a value Bruno itself ignores is not data, and
 * turning it into a real tag would change what the file means to the runner.
 */

import { parseBruRequest, generateBruRequest } from '../../../src/bruno/bru-parser';
import { bruFileToYamlRequest } from '../../../src/bruno/bru-to-yaml';
import { parseYamlRequest } from '../../../src/bruno/yaml-parser';
import { generateYamlRequest } from '../../../src/bruno/yaml-generator';
import { toRequestView } from '../../../src/bruno/request-view';

/** A `.bru` request whose meta block carries whatever `tags` line is given. */
const bruWith = (tagsLine: string): string =>
  `meta {\n  name: r\n  type: http\n  seq: 1\n${tagsLine}}\n\nget {\n  url: https://example.test/r\n}\n`;

const LIST_FORM = '  tags: [\n    smoke\n    fast\n  ]\n';

const rewriteBru = (content: string): string => generateBruRequest(parseBruRequest(content));

const yamlWith = (tags: string): string =>
  `info:\n  name: r\n  type: http\n  seq: 1\n${tags}http:\n  method: GET\n  url: https://example.test/r\n`;

const rewriteYaml = (content: string): string => generateYamlRequest(parseYamlRequest(content));

describe('.bru tags', () => {
  it('carries a list of tags through a rewrite', () => {
    const out = rewriteBru(bruWith(LIST_FORM));

    expect(parseBruRequest(out).meta.tags).toEqual(['smoke', 'fast']);
  });

  it('writes the list form, which is the only form upstream reads', () => {
    const out = rewriteBru(bruWith(LIST_FORM));

    // Asserted on the bytes, not the round-trip: our own parser would accept a
    // shape Bruno's does not.
    expect(out).toContain('tags: [');
    expect(out).toContain('\n    smoke\n');
    expect(out).toContain('\n    fast\n');
  });

  it('keeps tag order, because a tag list is a list and not a set', () => {
    const out = rewriteBru(bruWith('  tags: [\n    b\n    a\n    c\n  ]\n'));

    expect(parseBruRequest(out).meta.tags).toEqual(['b', 'a', 'c']);
  });

  it('reads a single-line tags value as no tags, as upstream does', () => {
    expect(parseBruRequest(bruWith('  tags: smoke\n')).meta.tags).toBeUndefined();
  });

  it('does not write a single-line tags value back one character per line', () => {
    // The corruption this defect was filed for. `jsonToBruV2` iterates whatever
    // it is handed, so a string reached the writer as five separate tags.
    const out = rewriteBru(bruWith('  tags: smoke\n'));

    expect(out).not.toContain('\n    s\n');
    expect(out).not.toContain('tags');
  });

  it('writes no tags key when the request has none', () => {
    expect(rewriteBru(bruWith(''))).not.toContain('tags');
  });

  it('writes no tags key for an empty list, matching upstream `tags?.length`', () => {
    // Through the model rather than a fixture: the grammar has no empty list
    // block — `tags: [\n]` fails to parse — so an empty list can only arrive
    // from a caller who removed the last tag.
    const parsed = parseBruRequest(bruWith(LIST_FORM));
    parsed.meta.tags = [];

    expect(generateBruRequest(parsed)).not.toContain('tags');
  });

  it('leaves the rest of meta alone', () => {
    // A positive control: if `name` or `seq` broke, every assertion above would
    // still pass while the file became useless.
    const meta = parseBruRequest(rewriteBru(bruWith(LIST_FORM))).meta;

    expect(meta.name).toBe('r');
    expect(meta.seq).toBe(1);
  });
});

describe('.yml tags', () => {
  it('carries a list of tags through a rewrite', () => {
    const out = rewriteYaml(yamlWith('  tags:\n    - smoke\n    - fast\n'));

    expect(parseYamlRequest(out).info.tags).toEqual(['smoke', 'fast']);
  });

  it('writes tags inside info, where upstream looks for them', () => {
    const out = rewriteYaml(yamlWith('  tags:\n    - smoke\n'));

    expect(out).toMatch(/info:[\s\S]*tags:/);
  });

  it('reads a single-line tags value as no tags', () => {
    expect(parseYamlRequest(yamlWith('  tags: smoke\n')).info.tags).toBeUndefined();
  });

  it('drops a single-line tags value on rewrite rather than carrying it', () => {
    // A real change in what `.yml` keeps: before `tags` was modelled the value
    // rode along in `info.extra` and came back verbatim. It is dropped now, for
    // the same reason `.bru` drops it — upstream's `Array.isArray(info.tags)`
    // reads it as no tags, so preserving it preserved something already inert.
    expect(rewriteYaml(yamlWith('  tags: smoke\n'))).not.toContain('tags');
  });

  it('keeps only the string entries of a list', () => {
    // YAML types its scalars, so `- 1` arrives as a number. A numeric tag matches
    // no `--tags` argument a caller can type.
    const out = parseYamlRequest(yamlWith('  tags:\n    - smoke\n    - 1\n    - true\n'));

    expect(out.info.tags).toEqual(['smoke']);
  });

  it('writes no tags key when the request has none', () => {
    expect(rewriteYaml(yamlWith(''))).not.toContain('tags');
  });

  it('writes no tags key for an empty list', () => {
    expect(rewriteYaml(yamlWith('  tags: []\n'))).not.toContain('tags');
  });
});

describe('what a reader sees', () => {
  it('reports tags for a .bru request', () => {
    const view = toRequestView(parseBruRequest(bruWith(LIST_FORM)), 'bru', '/c/r.bru');

    expect(view.tags).toEqual(['smoke', 'fast']);
  });

  it('reports tags for a .yml request', () => {
    const yml = yamlWith('  tags:\n    - smoke\n');
    const view = toRequestView(parseYamlRequest(yml), 'yaml', '/c/r.yml');

    expect(view.tags).toEqual(['smoke']);
  });

  it('omits the key entirely when there are none, rather than reporting []', () => {
    const view = toRequestView(parseBruRequest(bruWith('')), 'bru', '/c/r.bru');

    expect('tags' in view).toBe(false);
  });
});

describe('converting .bru to .yml', () => {
  it('carries tags across the format boundary', () => {
    // The conversion builds `info` field by field, so an unlisted field is lost
    // here even when both formats model it.
    const yaml = bruFileToYamlRequest(parseBruRequest(bruWith(LIST_FORM)));

    expect(yaml.info.tags).toEqual(['smoke', 'fast']);
  });

  it('carries no tags key when the .bru had none', () => {
    expect(bruFileToYamlRequest(parseBruRequest(bruWith(''))).info.tags).toBeUndefined();
  });
});
