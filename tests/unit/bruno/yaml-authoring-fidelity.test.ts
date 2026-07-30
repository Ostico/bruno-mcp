/**
 * Byte-level fidelity of the .yml writer against Bruno's own reader.
 *
 * The .bru writer was already brought in line with Bruno's vocabulary; the .yml
 * writer is its twin and kept the same defects. Bruno's yml reader matches auth
 * modes and placements as exact literals, so a near-miss spelling is not a
 * cosmetic difference — the reader falls through and discards the whole auth
 * block, and the request goes out unauthenticated with no error anywhere.
 *
 * The assertions here read the bytes on disk on purpose. A round-trip through
 * our own parser proves nothing, because our parser tolerates our own
 * malformed output.
 *
 * Verified against Bruno at
 * bruno-filestore/src/formats/yml/common/auth.ts: the writer emits
 * `type: 'apikey'` and maps its internal `queryparams` down to `query`, and the
 * reader maps `query` back up. Note the two file formats do NOT share this
 * vocabulary — `.bru` stores `queryparams` where `.yml` stores `query`.
 */

import { createRequestBuilder, RequestBuilder } from '../../../src/bruno/request.js';
import { createCollectionManager } from '../../../src/bruno/collection.js';
import { RequestExecutor } from '../../../src/bruno/request-executor.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const mockFetch = jest.fn();
(global as unknown as { fetch: unknown }).fetch = mockFetch;

jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
}));

let builder: RequestBuilder;

beforeEach(() => {
  builder = createRequestBuilder();
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    text: async () => '{}',
    ok: true,
  } as unknown as Response);
});

async function makeYamlCollection(label: string): Promise<string> {
  const tmpDir = await fs.mkdtemp(join(tmpdir(), `bruno-yml-fidelity-${label}-`));
  const result = await createCollectionManager().createCollection({
    name: 'FidelityAPI',
    outputPath: tmpDir,
    format: 'yml',
  });
  if (!result.success) throw new Error(`collection setup failed: ${result.error}`);
  return join(tmpDir, 'FidelityAPI');
}

/** Author an api-key request and hand back the raw bytes plus its path. */
async function writeApiKeyRequest(
  label: string,
  config: Record<string, string>,
): Promise<{ source: string; collectionPath: string }> {
  const collectionPath = await makeYamlCollection(label);
  const created = await builder.createRequest({
    collectionPath,
    name: 'Keyed',
    method: 'GET',
    url: 'https://api.example.com/x',
    auth: { type: 'api-key', config },
  });
  if (!created.success) throw new Error(`create failed: ${created.error}`);
  const source = await fs.readFile(join(collectionPath, 'Keyed.yml'), 'utf-8');
  return { source, collectionPath };
}

describe('.yml api-key auth is written in Bruno\'s vocabulary', () => {
  it('writes the mode as apikey, never the hyphenated api-key', async () => {
    const { source } = await writeApiKeyRequest('mode', {
      key: 'api_key',
      value: 'secret123',
      placement: 'query',
    });

    expect(source).toContain('type: apikey');
    // The hyphenated spelling is ours alone. Bruno's reader matches `apikey`
    // exactly, so emitting `api-key` discards the entire auth block.
    expect(source).not.toContain('api-key');
  });

  it('names the placement key `placement`, not `in`, and spells query as query', async () => {
    const { source } = await writeApiKeyRequest('placement-query', {
      key: 'api_key',
      value: 'secret123',
      placement: 'query',
    });

    expect(source).toContain('placement: query');
    expect(source).not.toMatch(/^\s*in:/m);
    // `queryparams` is the .bru spelling. In a .yml file it matches neither of
    // Bruno's two branches and the placement is silently dropped.
    expect(source).not.toContain('queryparams');
  });

  it('translates the legacy `in` spelling instead of writing it through', async () => {
    const { source } = await writeApiKeyRequest('legacy-in', {
      key: 'api_key',
      value: 'secret123',
      in: 'queryparams',
    });

    expect(source).toContain('placement: query');
    expect(source).not.toMatch(/^\s*in:/m);
  });

  it('writes header placement as header', async () => {
    const { source } = await writeApiKeyRequest('placement-header', {
      key: 'api_key',
      value: 'secret123',
      placement: 'header',
    });

    expect(source).toContain('placement: header');
  });

  it('omits the placement key entirely when none was expressed', async () => {
    const { source } = await writeApiKeyRequest('no-placement', {
      key: 'api_key',
      value: 'secret123',
    });

    // Bruno only writes the key when a placement exists, so neither should we.
    expect(source).not.toMatch(/placement:/);
  });

  it('still applies the credential when the file it just wrote is executed', async () => {
    // The read side must keep honouring what the write side now emits. Changing
    // the written vocabulary without this check is how a fixed write path turns
    // into a silently unauthenticated request.
    const { collectionPath } = await writeApiKeyRequest('roundtrip', {
      key: 'api_key',
      value: 'secret123',
      placement: 'query',
    });

    const run = await RequestExecutor.executeCollection(collectionPath, {});
    expect(run.summary.failed).toBe(0);

    const requestedUrl = String(mockFetch.mock.calls[0]?.[0] ?? '');
    expect(requestedUrl).toContain('api_key=secret123');
  });
});
