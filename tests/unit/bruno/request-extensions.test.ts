/**
 * Which extensions name a request, and what we say about `.yaml`.
 *
 * `.yaml` was recognised nowhere, so a collection written with it enumerated as
 * empty — no requests, no error, nothing to act on. It is recognised now, and
 * because Bruno's own app and `bru run` do NOT recognise it, reading one has to
 * come with a warning rather than a quiet success.
 */

import {
  REQUEST_EXTENSIONS,
  isRequestExtension,
  isYamlExtension,
  isRequestFile,
  isYamlRequestFile,
  isBruRequestFile,
  usesUnconventionalExtension,
  unconventionalExtensionWarning,
  dialectExtension,
  mismatchesCollectionDialect,
  collectionDialectWarnings,
} from '../../../src/bruno/request-extensions';

describe('request extensions', () => {
  it('accepts the three dialect spellings and nothing else', () => {
    expect(isRequestFile('/c/Get.bru')).toBe(true);
    expect(isRequestFile('/c/Get.yml')).toBe(true);
    expect(isRequestFile('/c/Get.yaml')).toBe(true);

    expect(isRequestFile('/c/Get.json')).toBe(false);
    expect(isRequestFile('/c/Get.txt')).toBe(false);
    expect(isRequestFile('/c/Get')).toBe(false);
  });

  it('groups .yaml with .yml as the YAML dialect, not with .bru', () => {
    expect(isYamlRequestFile('/c/Get.yaml')).toBe(true);
    expect(isYamlRequestFile('/c/Get.yml')).toBe(true);
    expect(isYamlRequestFile('/c/Get.bru')).toBe(false);

    expect(isBruRequestFile('/c/Get.bru')).toBe(true);
    expect(isBruRequestFile('/c/Get.yaml')).toBe(false);
  });

  it('matches case-sensitively, as the collection walks always have', () => {
    // Not an endorsement of `.YML`, just the documented boundary: making this
    // case-insensitive would newly treat `Collection.YML` as a request, because
    // the metadata-basename check beside it is case-sensitive too.
    expect(isRequestFile('/c/Get.YML')).toBe(false);
    expect(isRequestFile('/c/Get.YAML')).toBe(false);
  });

  it('distinguishes a bare extension from a path', () => {
    // The trap this pair of functions exists for: `extname('.yml')` is '',
    // because `.yml` reads as a dotfile. A gate that already holds an extension
    // and hands it to the path-taking form gets a confident, silent false.
    expect(isRequestFile('.yml')).toBe(false);
    expect(isRequestExtension('.yml')).toBe(true);
    expect(isYamlExtension('.yaml')).toBe(true);
    expect(isYamlExtension('.bru')).toBe(false);
    expect(isRequestExtension('.json')).toBe(false);
  });

  it('lists its accepted extensions for error messages', () => {
    expect(REQUEST_EXTENSIONS.join(', ')).toBe('.bru, .yml, .yaml');
  });

  it('flags only .yaml as the extension Bruno will not read', () => {
    expect(usesUnconventionalExtension('/c/Get.yaml')).toBe(true);
    expect(usesUnconventionalExtension('/c/Get.yml')).toBe(false);
    expect(usesUnconventionalExtension('/c/Get.bru')).toBe(false);
  });
});

describe('unconventionalExtensionWarning', () => {
  it('says nothing when no file uses .yaml', () => {
    expect(unconventionalExtensionWarning(['/c/a.yml', '/c/b.bru'])).toEqual([]);
    expect(unconventionalExtensionWarning([])).toEqual([]);
  });

  it('names the offenders and what to do about them', () => {
    const [warning] = unconventionalExtensionWarning(['/c/a.yml', '/c/b.yaml']);

    // Naming the file is the point: a count tells a caller something is wrong
    // without telling them which file to rename.
    expect(warning).toContain('/c/b.yaml');
    expect(warning).not.toContain('/c/a.yml');
    expect(warning).toContain('.yml');
    expect(warning).toContain('bru run');
  });

  it('agrees with itself about the count, singular and plural', () => {
    const [one] = unconventionalExtensionWarning(['/c/a.yaml']);
    expect(one).toContain('1 request uses');

    const [two] = unconventionalExtensionWarning(['/c/a.yaml', '/c/b.yaml']);
    expect(two).toContain('2 requests use');
  });

  it('summarises the tail rather than listing a hundred files', () => {
    const files = Array.from({ length: 8 }, (_, i) => `/c/r${i}.yaml`);

    const [warning] = unconventionalExtensionWarning(files);

    expect(warning).toContain('/c/r0.yaml');
    expect(warning).toContain('/c/r4.yaml');
    expect(warning).not.toContain('/c/r5.yaml');
    expect(warning).toContain('and 3 more');
    expect(warning).toContain('8 requests use');
  });
});

describe('the dialect a collection reads', () => {
  it('names the one extension each dialect reads', () => {
    expect(dialectExtension('yaml')).toBe('.yml');
    expect(dialectExtension('bru')).toBe('.bru');
  });

  it('calls a request mismatched when its dialect is the other one', () => {
    expect(mismatchesCollectionDialect('/c/a.bru', 'yaml')).toBe(true);
    expect(mismatchesCollectionDialect('/c/a.yml', 'bru')).toBe(true);
    expect(mismatchesCollectionDialect('/c/a.yml', 'yaml')).toBe(false);
    expect(mismatchesCollectionDialect('/c/a.bru', 'bru')).toBe(false);
  });

  it('treats .yaml as the YAML dialect, mismatching only a .bru collection', () => {
    expect(mismatchesCollectionDialect('/c/a.yaml', 'yaml')).toBe(false);
    expect(mismatchesCollectionDialect('/c/a.yaml', 'bru')).toBe(true);
  });

  it('says nothing about a file that names no dialect at all', () => {
    // A `.json` sitting in the collection is not a request being missed.
    expect(mismatchesCollectionDialect('/c/notes.json', 'bru')).toBe(false);
    expect(collectionDialectWarnings(['/c/notes.json'], 'bru')).toEqual([]);
  });
});

describe('collectionDialectWarnings', () => {
  it('is silent when every request matches the collection', () => {
    expect(collectionDialectWarnings(['/c/a.bru', '/c/b.bru'], 'bru')).toEqual([]);
  });

  it('names the mismatched files and the rename that fixes them', () => {
    const [warning] = collectionDialectWarnings(['/c/a.yml', '/c/b.bru'], 'bru');

    expect(warning).toContain('/c/a.yml');
    expect(warning).not.toContain('/c/b.bru');
    expect(warning).toContain('rename them to ".bru"');
    expect(warning).toContain('1 request uses');
  });

  it('agrees with itself about the count, and summarises a long tail', () => {
    const files = Array.from({ length: 8 }, (_, i) => `/c/r${i}.yml`);

    const [warning] = collectionDialectWarnings(files, 'bru');

    expect(warning).toContain('8 requests use');
    expect(warning).toContain('/c/r4.yml');
    expect(warning).not.toContain('/c/r5.yml');
    expect(warning).toContain('and 3 more');
  });

  it('gives a .yaml file in a .bru collection the dialect warning only', () => {
    // Both causes apply, and the `.yaml` warning's advice — rename to `.yml` —
    // would leave the file just as invisible here. One warning, and it is the
    // one whose rename works.
    const warnings = collectionDialectWarnings(['/c/a.yaml'], 'bru');

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('rename them to ".bru"');
  });

  it('still gives a .yaml file in a YAML collection the .yaml warning', () => {
    const warnings = collectionDialectWarnings(['/c/a.yaml'], 'yaml');

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('do not recognise');
  });

  it('makes no dialect claim when no collection declares one', () => {
    // No marker file above these paths: nothing says what Bruno would read, so
    // the only thing left to report is the extension it never reads anywhere.
    expect(collectionDialectWarnings(['/c/a.yml', '/c/b.bru'], null)).toEqual([]);

    const warnings = collectionDialectWarnings(['/c/a.yaml'], null);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('.yaml');
  });
});
