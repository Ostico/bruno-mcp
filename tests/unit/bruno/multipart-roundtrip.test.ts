import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequestBuilder } from '../../../src/bruno/request';
import { parseYamlRequest } from '../../../src/bruno/yaml-parser';
import { parseBruRequest } from '../../../src/bruno/bru-parser';
import { clearFormatCache } from '../../../src/bruno/format-detector';
import type { CreateRequestInput } from '../../../src/bruno/types';

function multipartInput(collectionPath: string): CreateRequestInput {
  return {
    collectionPath,
    name: 'Upload File',
    method: 'POST',
    url: 'https://example.com/upload',
    body: {
      type: 'form-data',
      formData: [
        { name: 'title', value: 'hello', type: 'text', contentType: 'text/plain' },
        { name: 'note', value: 'plain-note', type: 'text' },
        { name: 'avatar', value: '/tmp/avatar.png', type: 'file', contentType: 'image/png' },
        { name: 'docs', value: ['/tmp/a.pdf', '/tmp/b.pdf'], type: 'file' },
      ],
    },
  };
}

describe('multipart serializer round-trip', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(join(tmpdir(), 'bruno-rt-'));
    clearFormatCache();
  });

  afterEach(async () => {
    clearFormatCache();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('round-trips a YAML multipart body through create_request', async () => {
    await fs.writeFile(
      join(tmpDir, 'opencollection.yml'),
      'opencollection: "1.0"\ninfo:\n  name: RT\n',
    );

    const builder = createRequestBuilder();
    const result = await builder.createRequest(multipartInput(tmpDir));
    expect(result.success).toBe(true);
    expect(result.path).toBeDefined();
    expect(result.path!.endsWith('.yml')).toBe(true);

    const content = await fs.readFile(result.path!, 'utf-8');
    const parsed = parseYamlRequest(content);

    expect(parsed.http.body?.type).toBe('multipart-form');
    const data = parsed.http.body?.data;
    expect(Array.isArray(data)).toBe(true);
    const parts = data as Array<Record<string, unknown>>;

    const title = parts.find((p) => p.name === 'title')!;
    expect(title.value).toBe('hello');
    expect(title.type).toBe('text');
    expect(title.contentType).toBe('text/plain');

    const note = parts.find((p) => p.name === 'note')!;
    expect(note.value).toBe('plain-note');
    expect(note.type).toBe('text');

    const avatar = parts.find((p) => p.name === 'avatar')!;
    expect(avatar.value).toBe('/tmp/avatar.png');
    expect(avatar.type).toBe('file');
    expect(avatar.contentType).toBe('image/png');

    const docs = parts.find((p) => p.name === 'docs')!;
    expect(docs.value).toEqual(['/tmp/a.pdf', '/tmp/b.pdf']);
    expect(docs.type).toBe('file');
  });

  it('round-trips a .bru multipart body through create_request', async () => {
    await fs.writeFile(
      join(tmpDir, 'bruno.json'),
      JSON.stringify({ version: '1', name: 'RT', type: 'collection' }),
    );

    const builder = createRequestBuilder();
    const result = await builder.createRequest(multipartInput(tmpDir));
    expect(result.success).toBe(true);
    expect(result.path!.endsWith('.bru')).toBe(true);

    const content = await fs.readFile(result.path!, 'utf-8');
    expect(content).toContain('body:multipart-form {');

    const parsed = parseBruRequest(content);
    expect(parsed.body?.formData).toBeDefined();
    const parts = parsed.body!.formData!;

    const title = parts.find((p) => p.name === 'title')!;
    expect(title.value).toBe('hello');
    expect(title.type).toBe('text');
    expect(title.contentType).toBe('text/plain');

    const avatar = parts.find((p) => p.name === 'avatar')!;
    expect(avatar.type).toBe('file');
    expect(avatar.contentType).toBe('image/png');
    expect(avatar.value).toEqual(['/tmp/avatar.png']);

    const docs = parts.find((p) => p.name === 'docs')!;
    expect(docs.type).toBe('file');
    expect(docs.value).toEqual(['/tmp/a.pdf', '/tmp/b.pdf']);
  });
});
