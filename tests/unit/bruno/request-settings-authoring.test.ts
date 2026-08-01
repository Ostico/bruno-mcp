/**
 * The request-level `settings` block has to be authorable, in both dialects.
 *
 * It was readable and round-trip-preserved but not writable: no schema field, no
 * input type, nothing in the writer. The consequence was not cosmetic. The
 * executor reads `settings.followRedirects !== false`, so an unauthorable block
 * means redirects are always followed, and a `Set-Cookie` issued alongside a 302
 * is consumed by the redirect hop and never seen — a session that the endpoint
 * did issue looks like one it never issued. The script budget has the same
 * shape: `settings.timeout ?? 5000` can only be lifted by authoring the block.
 *
 * Assertions here are on the bytes on disk and, for `.bru`, on what upstream's
 * own parser makes of them. Reading our output back with our own parser proves
 * only that we are self-consistent; this codebase has shipped files that only
 * its own tolerant parser could read.
 *
 * On-disk spelling, verified against upstream at packages/bruno-lang (the .bru
 * grammar's `settings` semantics in v2/src/bruToJson.js and the writer in
 * v2/src/jsonToBru.js) and packages/bruno-filestore (the YAML writer in
 * src/formats/yml/items/stringifyHttpRequest.ts):
 *
 *   .bru   a `settings { }` dictionary block of bare `key: value` lines
 *   .yml   a top-level `settings:` mapping
 *
 * Both dialects spell all four keys identically and camelCase, which is why no
 * per-dialect key translation exists for this block.
 */

import { bruToJsonV2 } from '@usebruno/lang';
import { createRequestBuilder, RequestBuilder } from '../../../src/bruno/request';
import { createCollectionManager } from '../../../src/bruno/collection';
import { parseYamlRequest } from '../../../src/bruno/yaml-parser';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parse as parseYaml } from 'yaml';

let builder: RequestBuilder;

beforeEach(() => {
  builder = createRequestBuilder();
});

async function makeCollection(format: 'bru' | 'yaml'): Promise<string> {
  const tmpDir = await fs.mkdtemp(join(tmpdir(), `bruno-settings-${format}-`));
  const result = await createCollectionManager().createCollection({
    name: 'SettingsAPI',
    outputPath: tmpDir,
    format,
  });
  if (!result.success) throw new Error(`collection setup failed: ${result.error}`);
  return join(tmpDir, 'SettingsAPI');
}

/**
 * Create a request and return both its path and its bytes.
 *
 * The path comes from the result rather than being rebuilt from the name: the
 * writer lowercases request filenames, so a reconstructed path passes on a
 * case-insensitive filesystem and fails on Linux.
 */
async function create(
  collectionPath: string,
  input: Partial<Parameters<RequestBuilder['createRequest']>[0]> = {},
): Promise<{ path: string; content: string }> {
  const result = await builder.createRequest({
    collectionPath,
    name: 'Reset Password',
    method: 'POST',
    url: 'https://api.example.com/reset',
    ...input,
  });
  if (!result.success || !result.path) {
    throw new Error(`create failed: ${result.error}`);
  }
  return { path: result.path, content: await fs.readFile(result.path, 'utf-8') };
}

describe('authoring the settings block in .bru', () => {
  it('writes a settings block that upstream parses back to the declared values', async () => {
    const collectionPath = await makeCollection('bru');
    const { content } = await create(collectionPath, {
      settings: { followRedirects: false, timeout: 20000, maxRedirects: 3, encodeUrl: true },
    });

    // The bytes: a dictionary block of bare key: value lines.
    expect(content).toContain('settings {');
    expect(content).toContain('followRedirects: false');
    expect(content).toContain('timeout: 20000');
    expect(content).toContain('maxRedirects: 3');
    expect(content).toContain('encodeUrl: true');

    // And what upstream's own parser makes of those bytes.
    const upstream = bruToJsonV2(content) as {
      settings?: { followRedirects?: boolean; timeout?: number; maxRedirects?: number; encodeUrl?: boolean };
    };
    expect(upstream.settings?.followRedirects).toBe(false);
    expect(upstream.settings?.timeout).toBe(20000);
    expect(upstream.settings?.maxRedirects).toBe(3);
    expect(upstream.settings?.encodeUrl).toBe(true);
  });

  it('writes only the fields declared, leaving the rest absent rather than defaulted', async () => {
    const collectionPath = await makeCollection('bru');
    const { content } = await create(collectionPath, { settings: { followRedirects: false } });

    expect(content).toContain('followRedirects: false');
    expect(content).not.toContain('timeout:');
    expect(content).not.toContain('maxRedirects:');
    expect(content).not.toContain('encodeUrl:');
  });

  it('writes no settings block at all when none was declared', async () => {
    // Deliberate: Bruno also omits the block, and emitting the executor's
    // fallbacks as explicit keys would make every request we create differ from
    // a hand-authored one. Upstream's writer is a passthrough — 248 of the 275
    // .bru files in its own test collection carry no settings block at all.
    const collectionPath = await makeCollection('bru');
    const { content } = await create(collectionPath);

    expect(content).not.toContain('settings {');
  });
});

describe('authoring the settings block in .yml', () => {
  it('writes a top-level settings mapping', async () => {
    const collectionPath = await makeCollection('yaml');
    const { content } = await create(collectionPath, {
      settings: { followRedirects: false, timeout: 20000, maxRedirects: 3, encodeUrl: true },
    });

    // Parsed as YAML rather than string-matched, so nesting is actually checked:
    // these are a top-level `settings` mapping, not keys loose in `http`.
    const doc = parseYaml(content) as { settings?: Record<string, unknown>; http?: Record<string, unknown> };
    expect(doc.settings).toEqual({
      followRedirects: false,
      timeout: 20000,
      maxRedirects: 3,
      encodeUrl: true,
    });
    expect(doc.http).not.toHaveProperty('followRedirects');
  });

  it('writes only the fields declared', async () => {
    const collectionPath = await makeCollection('yaml');
    const { content } = await create(collectionPath, { settings: { timeout: 20000 } });

    const doc = parseYaml(content) as { settings?: Record<string, unknown> };
    expect(doc.settings).toEqual({ timeout: 20000 });
  });

  it('writes no settings mapping at all when none was declared', async () => {
    const collectionPath = await makeCollection('yaml');
    const { content } = await create(collectionPath);

    const doc = parseYaml(content) as Record<string, unknown>;
    expect(doc).not.toHaveProperty('settings');
  });
});

describe('modify_request merges the settings block field by field', () => {
  it('keeps an existing followRedirects when only timeout is set (.bru)', async () => {
    const collectionPath = await makeCollection('bru');
    const { path } = await create(collectionPath, { settings: { followRedirects: false } });

    const result = await builder.updateRequest(path, { settings: { timeout: 20000 } });
    expect(result.success).toBe(true);

    const content = await fs.readFile(path, 'utf-8');
    const upstream = bruToJsonV2(content) as {
      settings?: { followRedirects?: boolean; timeout?: number };
    };
    // The whole point: setting one field must not delete the other. A block
    // replaced wholesale would silently turn redirect following back on.
    expect(upstream.settings?.followRedirects).toBe(false);
    expect(upstream.settings?.timeout).toBe(20000);
  });

  it('keeps an existing followRedirects when only timeout is set (.yml)', async () => {
    const collectionPath = await makeCollection('yaml');
    const { path } = await create(collectionPath, { settings: { followRedirects: false } });

    const result = await builder.updateRequest(path, { settings: { timeout: 20000 } });
    expect(result.success).toBe(true);

    const doc = parseYaml(await fs.readFile(path, 'utf-8')) as { settings?: Record<string, unknown> };
    expect(doc.settings).toEqual({ followRedirects: false, timeout: 20000 });
  });

  it('overwrites a field that is declared again', async () => {
    const collectionPath = await makeCollection('yaml');
    const { path } = await create(collectionPath, { settings: { maxRedirects: 3 } });

    await builder.updateRequest(path, { settings: { maxRedirects: 0 } });

    // 0 is falsy and is exactly the value worth writing down, so a
    // truthiness-guarded merge would drop it and leave the 3 in place.
    const doc = parseYaml(await fs.readFile(path, 'utf-8')) as { settings?: Record<string, unknown> };
    expect(doc.settings).toEqual({ maxRedirects: 0 });
  });

  it('leaves the settings block alone on an edit that does not mention it', async () => {
    const collectionPath = await makeCollection('yaml');
    const { path } = await create(collectionPath, { settings: { followRedirects: false } });

    await builder.updateRequest(path, { url: 'https://api.example.com/reset-v2' });

    const parsed = parseYamlRequest(await fs.readFile(path, 'utf-8'));
    expect(parsed.http.url).toBe('https://api.example.com/reset-v2');
    expect(parsed.settings?.followRedirects).toBe(false);
  });
});
