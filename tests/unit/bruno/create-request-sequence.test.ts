/**
 * `write_request` end to end: the file on disk carries a usable `seq`.
 *
 * Without an explicit sequence the field was left out of the file entirely, and
 * the run order treats a missing `seq` as MAX_SAFE_INTEGER — so every request
 * created without one tied for last and ran in an order decided by nothing. The
 * unit-level choice is tested in request-sequence.test.ts; this is about what
 * `write_request` actually writes, in both dialects, because the two build the
 * meta block through different code.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RequestBuilder } from '../../../src/bruno/request';
import { createCollectionManager } from '../../../src/bruno/collection';
import { parseBruRequest } from '../../../src/bruno/bru-parser';
import { parseYamlRequest } from '../../../src/bruno/yaml-parser';

const builder = new RequestBuilder();

async function makeCollection(format: 'bru' | 'yaml'): Promise<string> {
  const tmpDir = await fs.mkdtemp(join(tmpdir(), `bruno-seq-${format}-`));
  const result = await createCollectionManager().createCollection({
    name: 'SeqAPI',
    outputPath: tmpDir,
    format,
  });
  if (!result.success) throw new Error(`collection setup failed: ${result.error}`);
  return join(tmpDir, 'SeqAPI');
}

/** Create a request and return the `seq` actually written to disk. */
async function createAndReadSeq(
  collectionPath: string,
  name: string,
  sequence?: number,
): Promise<number | undefined> {
  const created = await builder.createRequest({
    collectionPath,
    name,
    method: 'GET',
    url: 'https://api.test/x',
    ...(sequence === undefined ? {} : { sequence }),
  });
  if (!created.success) throw new Error(`create failed: ${created.error}`);

  // Read back `created.path` rather than rebuilding it: the writer lowercases
  // request filenames, so a reconstructed path passes on macOS and ENOENTs on
  // a case-sensitive filesystem.
  const raw = await fs.readFile(created.path!, 'utf-8');
  return created.path!.endsWith('.bru')
    ? parseBruRequest(raw).meta.seq
    : parseYamlRequest(raw).info.seq;
}

describe.each(['bru', 'yaml'] as const)('write_request seq (%s collection)', (format) => {
  it('gives the first request seq 1', async () => {
    const collectionPath = await makeCollection(format);

    expect(await createAndReadSeq(collectionPath, 'First')).toBe(1);
  });

  it('puts each new request after the ones already there', async () => {
    const collectionPath = await makeCollection(format);

    expect(await createAndReadSeq(collectionPath, 'First')).toBe(1);
    expect(await createAndReadSeq(collectionPath, 'Second')).toBe(2);
    expect(await createAndReadSeq(collectionPath, 'Third')).toBe(3);
  });

  it('still honours an explicit sequence', async () => {
    const collectionPath = await makeCollection(format);

    expect(await createAndReadSeq(collectionPath, 'Pinned', 42)).toBe(42);
  });

  it('continues past an explicit sequence rather than colliding with it', async () => {
    const collectionPath = await makeCollection(format);
    await createAndReadSeq(collectionPath, 'Pinned', 7);

    // Upstream's `count + 1` would return 2 here, which nothing holds — but it
    // also returns a number already in use as soon as the gap is below the
    // maximum. Taking the maximum is what keeps sequences unique.
    expect(await createAndReadSeq(collectionPath, 'Next')).toBe(8);
  });

  it('numbers a subfolder independently of the collection root', async () => {
    const collectionPath = await makeCollection(format);
    await createAndReadSeq(collectionPath, 'RootOne');
    await createAndReadSeq(collectionPath, 'RootTwo');

    const created = await builder.createRequest({
      collectionPath,
      name: 'Nested',
      method: 'GET',
      url: 'https://api.test/x',
      folder: 'sub',
    });
    expect(created.success).toBe(true);

    const raw = await fs.readFile(created.path!, 'utf-8');
    const seq = created.path!.endsWith('.bru')
      ? parseBruRequest(raw).meta.seq
      : parseYamlRequest(raw).info.seq;

    // `seq` orders siblings, so a new folder starts again at 1 rather than
    // carrying on from the root's numbering.
    expect(seq).toBe(1);
  });
});
