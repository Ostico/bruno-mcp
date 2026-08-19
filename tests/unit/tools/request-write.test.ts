/**
 * The merged write tool infers what it is doing from which locator the caller
 * passed, rather than from a `mode` field that would only restate it.
 *
 * A batch hands the resolver its own `collectionPath` as `ambient`, once for the
 * whole call, so a caller writing ten requests into one collection names it once.
 * That is why the both-locators refusal is scoped to the keys the caller wrote in
 * *this item*: an ambient collection alongside an item's `filePath` is the normal
 * shape of a mixed batch, and refusing it would make batching useless for any run
 * that edits one request and creates another.
 */

import { resolveWriteTarget } from '../../../src/tools/request-write';

describe('resolveWriteTarget', () => {
  it('reads a filePath as an edit', () => {
    expect(resolveWriteTarget({ filePath: '/c/req.bru' }))
      .toEqual({ mode: 'edit', filePath: '/c/req.bru' });
  });

  it('reads collectionPath plus name as a create', () => {
    expect(resolveWriteTarget({ collectionPath: '/c', name: 'Login' }))
      .toEqual({ mode: 'create', collectionPath: '/c', name: 'Login' });
  });

  it('refuses both locators in one item rather than guessing which one wins', () => {
    const result = resolveWriteTarget({ filePath: '/c/req.bru', collectionPath: '/c', name: 'Login' });
    expect(result).toEqual({ error: expect.stringContaining('filePath') });
    expect((result as { error: string }).error).toContain('collectionPath');
  });

  it('refuses neither locator', () => {
    expect(resolveWriteTarget({})).toEqual({ error: expect.stringContaining('filePath') });
  });

  it('refuses a create-only field on an edit', () => {
    expect(resolveWriteTarget({ filePath: '/c/req.bru', folder: 'Auth' }))
      .toEqual({ error: expect.stringContaining('folder') });
  });

  it('refuses an edit-only field on a create', () => {
    expect(resolveWriteTarget({ collectionPath: '/c', name: 'Login', scriptMode: 'replace' }))
      .toEqual({ error: expect.stringContaining('scriptMode') });
  });

  // `name` is the one locator field both modes read, so it must not be treated
  // as create-only: an edit renames the request inside the file with it.
  it('accepts a name on an edit', () => {
    expect(resolveWriteTarget({ filePath: '/c/req.bru', name: 'Renamed' }))
      .toEqual({ mode: 'edit', filePath: '/c/req.bru' });
  });

  it('refuses a collectionPath with no name, naming the field it wants', () => {
    expect(resolveWriteTarget({ collectionPath: '/c' }))
      .toEqual({ error: expect.stringContaining('name') });
  });

  // Every mode-specific field is checked, not just the first one: a caller who
  // passes `kind` on an edit would otherwise have it silently dropped and
  // believe the transport changed.
  it.each(['kind', 'folder', 'sequence'])('refuses create-only field %s on an edit', (field) => {
    const result = resolveWriteTarget({ filePath: '/c/req.bru', [field]: 'x' });
    expect(result).toEqual({ error: expect.stringContaining(field) });
    expect((result as { error: string }).error).toContain('edit');
  });

  it.each(['filename', 'scriptMode'])('refuses edit-only field %s on a create', (field) => {
    const result = resolveWriteTarget({ collectionPath: '/c', name: 'Login', [field]: 'x' });
    expect(result).toEqual({ error: expect.stringContaining(field) });
    expect((result as { error: string }).error).toContain('create');
  });

  // A value the caller passed and a key that merely exists must not be treated
  // alike: the SDK hands the handler an object carrying the optional keys as
  // undefined, so rejecting on key presence would refuse every real call.
  it('ignores mode-specific keys explicitly set to undefined', () => {
    expect(resolveWriteTarget({ filePath: '/c/req.bru', folder: undefined, kind: undefined }))
      .toEqual({ mode: 'edit', filePath: '/c/req.bru' });
    expect(resolveWriteTarget({ collectionPath: '/c', name: 'Login', filename: undefined }))
      .toEqual({ mode: 'create', collectionPath: '/c', name: 'Login' });
  });

  // `sequence: 0` and an empty filename are falsy but present. Presence is what
  // the mode rule is about, so a truthiness test here would let both through.
  it('refuses a falsy but present mode-specific value', () => {
    expect(resolveWriteTarget({ filePath: '/c/req.bru', sequence: 0 }))
      .toEqual({ error: expect.stringContaining('sequence') });
    expect(resolveWriteTarget({ collectionPath: '/c', name: 'Login', filename: '' }))
      .toEqual({ error: expect.stringContaining('filename') });
  });

  // The batch form names its collection once, for the whole call. An ambient
  // value is not a locator the caller wrote in this item, so it neither triggers
  // the both-locators refusal nor outranks an item that names its own collection.
  it('reads an ambient collectionPath as a create when the item has no locator', () => {
    expect(resolveWriteTarget({ name: 'Login' }, { collectionPath: '/c' }))
      .toEqual({ mode: 'create', collectionPath: '/c', name: 'Login' });
  });

  it('lets an item filePath win over an ambient collectionPath, with no refusal', () => {
    expect(resolveWriteTarget({ filePath: '/c/req.bru' }, { collectionPath: '/c' }))
      .toEqual({ mode: 'edit', filePath: '/c/req.bru' });
  });

  it("prefers the item's own collectionPath over the ambient one", () => {
    expect(resolveWriteTarget({ collectionPath: '/other', name: 'Login' }, { collectionPath: '/c' }))
      .toEqual({ mode: 'create', collectionPath: '/other', name: 'Login' });
  });

  it('still wants a name when only the ambient collectionPath is available', () => {
    expect(resolveWriteTarget({}, { collectionPath: '/c' }))
      .toEqual({ error: expect.stringContaining('name') });
  });
});
