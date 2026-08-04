/**
 * A `file`-mode body on the wire.
 *
 * Until this landed the branch did not exist: a file body fell through to the
 * "no encoder here accepts this" warning and the request went out empty. These
 * pin the rules upstream applies in `prepare-request.js:397-427` — first selected
 * entry only, the entry's own content type winning outright, and a failed read
 * costing the body rather than the request.
 */

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFetchOptions } from '../../../src/bruno/request-executor.js';
import type { YamlRequest, BruFilePart } from '../../../src/bruno/types.js';

let root: string;

beforeEach(async () => {
  // Under the OS temp dir, which is one of the locations an upload path may sit
  // in, so confinement is satisfied without an operator-configured directory.
  root = await mkdtemp(join(tmpdir(), 'bruno-file-body-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const requestWith = (
  files: BruFilePart[],
  headers?: { name: string; value: string }[],
): YamlRequest => ({
  info: { name: 'Upload', type: 'http', seq: 1 },
  http: {
    method: 'POST',
    url: 'https://api.example.com/upload',
    ...(headers ? { headers } : {}),
    body: { type: 'file', data: files },
  },
});

const contentTypeOf = (options: RequestInit): string | undefined => {
  const headers = options.headers as Record<string, string>;
  const key = Object.keys(headers).find(n => n.toLowerCase() === 'content-type');
  return key === undefined ? undefined : headers[key];
};

const bodyText = async (options: RequestInit): Promise<string> =>
  await (options.body as Blob).text();

describe('a file body on the wire', () => {
  it('sends the selected file with the content type the entry names', async () => {
    await writeFile(join(root, 'payload.bin'), 'the bytes');

    const { options, warnings } = await buildFetchOptions(
      requestWith([{ filePath: 'payload.bin', contentType: 'application/pdf', selected: true }]),
      new Map(),
      root,
    );

    expect(await bodyText(options)).toBe('the bytes');
    expect(contentTypeOf(options)).toBe('application/pdf');
    expect(warnings ?? []).toEqual([]);
  });

  it('sends no Content-Type at all when the selected entry names none', async () => {
    await writeFile(join(root, 'payload.bin'), 'raw');

    const { options } = await buildFetchOptions(
      requestWith([{ filePath: 'payload.bin', selected: true }]),
      new Map(),
      root,
    );

    // Upstream assigns the entry's `contentType` over the default, and for an
    // entry that has none that assignment is `undefined` — axios then sends no
    // Content-Type. The octet-stream default set a line earlier does not survive
    // it, which is easy to get wrong in the other direction.
    expect(await bodyText(options)).toBe('raw');
    expect(contentTypeOf(options)).toBeUndefined();
  });

  it("lets the entry's content type override an authored header", async () => {
    await writeFile(join(root, 'payload.bin'), 'x');

    const { options } = await buildFetchOptions(
      requestWith(
        [{ filePath: 'payload.bin', contentType: 'image/png', selected: true }],
        [{ name: 'Content-Type', value: 'text/plain' }],
      ),
      new Map(),
      root,
    );

    expect(contentTypeOf(options)).toBe('image/png');
    // And only once: an authored `Content-Type` beside an added `content-type`
    // would put the header on the wire twice.
    const headers = options.headers as Record<string, string>;
    expect(Object.keys(headers).filter(n => n.toLowerCase() === 'content-type')).toHaveLength(1);
  });

  it('keeps the octet-stream default when the entry names a blank content type', async () => {
    await writeFile(join(root, 'payload.bin'), 'raw');

    // What Bruno's own `.yml` writer produces for an entry with no type:
    // `contentType: ''`. Read as "none named", so the default stands rather than
    // an empty Content-Type going on the wire.
    const { options } = await buildFetchOptions(
      requestWith([{ filePath: 'payload.bin', contentType: '', selected: true }]),
      new Map(),
      root,
    );

    expect(await bodyText(options)).toBe('raw');
    expect(contentTypeOf(options)).toBe('application/octet-stream');
  });

  it('sends the first selected entry, not the first entry', async () => {
    await writeFile(join(root, 'skipped.bin'), 'skipped');
    await writeFile(join(root, 'wanted.bin'), 'wanted');

    const { options } = await buildFetchOptions(
      requestWith([
        { filePath: 'skipped.bin', selected: false },
        { filePath: 'wanted.bin', contentType: 'text/plain', selected: true },
      ]),
      new Map(),
      root,
    );

    expect(await bodyText(options)).toBe('wanted');
  });

  it('warns and sends nothing when no entry is selected', async () => {
    await writeFile(join(root, 'payload.bin'), 'never sent');

    const { options, warnings } = await buildFetchOptions(
      requestWith([{ filePath: 'payload.bin', selected: false }]),
      new Map(),
      root,
    );

    expect(options.body).toBeUndefined();
    // The default is still applied, as upstream applies it, but the caller is
    // told the body is empty — a silent empty POST comes back 2xx and every
    // assertion on it passes for the wrong reason.
    expect(contentTypeOf(options)).toBe('application/octet-stream');
    expect(warnings?.join(' ')).toContain('no selected file');
  });

  it('warns and sends nothing when the file is missing', async () => {
    const { options, warnings } = await buildFetchOptions(
      requestWith([{ filePath: 'absent.bin', contentType: 'text/plain', selected: true }]),
      new Map(),
      root,
    );

    expect(options.body).toBeUndefined();
    // Upstream logs the read error and sends the request anyway, so the request
    // still goes out; the content type the entry named still applies.
    expect(contentTypeOf(options)).toBe('text/plain');
    expect(warnings?.join(' ')).toContain('could not be read');
  });

  it('warns and sends nothing when the entry names no file', async () => {
    const { options, warnings } = await buildFetchOptions(
      requestWith([{ filePath: '   ', selected: true }]),
      new Map(),
      root,
    );

    expect(options.body).toBeUndefined();
    expect(warnings?.join(' ')).toContain('names no file');
  });

  it('refuses a path outside the allowed upload directories', async () => {
    await expect(
      buildFetchOptions(
        requestWith([{ filePath: '../../../../../../etc/passwd', selected: true }]),
        new Map(),
        root,
      ),
    ).rejects.toThrow(/Refusing to read file body/);
  });

  it('resolves variables in both the path and the content type', async () => {
    await writeFile(join(root, 'report-2026.csv'), 'a,b');

    const { options } = await buildFetchOptions(
      requestWith([{ filePath: 'report-{{year}}.csv', contentType: '{{ctype}}', selected: true }]),
      new Map([
        ['year', '2026'],
        ['ctype', 'text/csv'],
      ]),
      root,
    );

    expect(await bodyText(options)).toBe('a,b');
    expect(contentTypeOf(options)).toBe('text/csv');
  });

  it('treats an entry with no flag as selected, which is what a .bru file means', async () => {
    await writeFile(join(root, 'payload.bin'), 'from bru');

    // A `.bru` file body reaches the executor with the flag absent unless the
    // entry carries `~`; the `.yml` reader sets it explicitly instead, because
    // upstream reads an absent key there as not-selected.
    const { options } = await buildFetchOptions(
      requestWith([{ filePath: 'payload.bin', contentType: 'text/plain' }]),
      new Map(),
      root,
    );

    expect(await bodyText(options)).toBe('from bru');
  });
});
