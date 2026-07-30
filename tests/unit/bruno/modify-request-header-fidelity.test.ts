/**
 * What `updateRequest` actually persists when it is handed a header map.
 *
 * The two formats had opposite failures here, and both were silent:
 *
 *   .bru  the merge landed in the enabled-only `headers` map, but the generator
 *         writes from `headersList` whenever that list is populated. Every
 *         request that already had a header therefore ignored the update
 *         completely. A request with no headers at all took the fallback path
 *         and worked, which is why the defect survived — the easy case passes.
 *
 *   .yml  the list was rebuilt from the update map alone, so every header the
 *         caller did not mention was deleted, and each surviving entry was
 *         rewritten as a bare name/value pair, clearing any `disabled` flag and
 *         re-arming a header the author had deliberately switched off.
 *
 * The assertions read the bytes on disk, not a round-trip through our own
 * parser, which tolerates our own malformed output.
 */

import { createRequestBuilder, RequestBuilder } from '../../../src/bruno/request.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let builder: RequestBuilder;

beforeEach(() => {
  builder = createRequestBuilder();
});

async function collectionDir(label: string): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), `bruno-modhdr-${label}-`));
  await fs.writeFile(
    join(dir, 'bruno.json'),
    JSON.stringify({ version: '1', name: 'c', type: 'collection' }),
  );
  return dir;
}

/** Hand-write a request file, as Bruno itself would, and return its path. */
async function seed(label: string, fileName: string, source: string): Promise<string> {
  const dir = await collectionDir(label);
  const filePath = join(dir, fileName);
  await fs.writeFile(filePath, source);
  return filePath;
}

const BRU_WITH_HEADERS = `meta {
  name: R
  type: http
  seq: 1
}

get {
  url: https://api.example.com/x
  body: none
  auth: none
}

headers {
  X-Keep: kept
  ~X-Off: switched-off
}
`;

const YML_WITH_HEADERS = `info:
  name: R
  type: http
http:
  method: GET
  url: https://api.example.com/x
  headers:
    - name: X-Keep
      value: kept
    - name: X-Off
      value: switched-off
      disabled: true
`;

describe('.bru updateRequest persists a header update', () => {
  it('writes a new header into a request that already has headers', async () => {
    const filePath = await seed('bru-add', 'R.bru', BRU_WITH_HEADERS);

    const result = await builder.updateRequest(filePath, {
      headers: { 'X-Added': 'added-value' },
    });
    expect(result.success).toBe(true);

    const source = await fs.readFile(filePath, 'utf-8');
    expect(source).toContain('X-Added: added-value');
  });

  it('leaves a header the caller did not mention untouched, disabled flag included', async () => {
    const filePath = await seed('bru-keep', 'R.bru', BRU_WITH_HEADERS);

    await builder.updateRequest(filePath, { headers: { 'X-Added': 'added-value' } });

    const source = await fs.readFile(filePath, 'utf-8');
    expect(source).toContain('X-Keep: kept');
    // The tilde is how .bru marks a switched-off header. Losing it would send a
    // header the author had turned off.
    expect(source).toContain('~X-Off: switched-off');
  });

  it('overwrites the value of an existing header', async () => {
    const filePath = await seed('bru-over', 'R.bru', BRU_WITH_HEADERS);

    await builder.updateRequest(filePath, { headers: { 'X-Keep': 'replaced' } });

    const source = await fs.readFile(filePath, 'utf-8');
    expect(source).toContain('X-Keep: replaced');
    expect(source).not.toContain('X-Keep: kept');
  });
});

describe('.yml updateRequest persists a header update', () => {
  it('keeps headers the caller did not mention', async () => {
    const filePath = await seed('yml-keep', 'R.yml', YML_WITH_HEADERS);

    const result = await builder.updateRequest(filePath, {
      headers: { 'X-Added': 'added-value' },
    });
    expect(result.success).toBe(true);

    const source = await fs.readFile(filePath, 'utf-8');
    expect(source).toContain('X-Added');
    expect(source).toContain('X-Keep');
  });

  it('keeps the disabled flag on an untouched header', async () => {
    const filePath = await seed('yml-flag', 'R.yml', YML_WITH_HEADERS);

    await builder.updateRequest(filePath, { headers: { 'X-Added': 'added-value' } });

    const source = await fs.readFile(filePath, 'utf-8');
    expect(source).toContain('X-Off');
    // Dropping this re-arms a header the author switched off.
    expect(source).toContain('disabled: true');
  });

  it('overwrites the value of an existing header', async () => {
    const filePath = await seed('yml-over', 'R.yml', YML_WITH_HEADERS);

    await builder.updateRequest(filePath, { headers: { 'X-Keep': 'replaced' } });

    const source = await fs.readFile(filePath, 'utf-8');
    expect(source).toContain('replaced');
    expect(source).not.toContain('kept');
  });
});
