import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join, basename } from 'path';
import { buildFetchOptions } from '../../../src/bruno/request-executor';
import type { YamlRequest } from '../../../src/bruno/types';

describe('buildFetchOptions — multipart/form-data', () => {
  let tmpDir: string;
  let filePathA: string;
  let filePathB: string;
  const fileContentA = 'file-a-contents';
  const fileContentB = 'file-b-contents';

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(join(tmpdir(), 'bruno-multipart-'));
    filePathA = join(tmpDir, 'a.txt');
    filePathB = join(tmpDir, 'b.bin');
    await fs.writeFile(filePathA, fileContentA);
    await fs.writeFile(filePathB, fileContentB);
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function buildYaml(): YamlRequest {
    return {
      info: { name: 'Upload', type: 'http' },
      http: {
        method: 'POST',
        url: 'https://example.com/upload',
        headers: [{ name: 'Content-Type', value: 'multipart/form-data' }],
        body: {
          type: 'multipart-form',
          data: [
            { name: 'plain', value: 'hello', type: 'text' },
            { name: 'typed', value: 'world', type: 'text', contentType: 'text/plain' },
            { name: 'single', value: filePathA, type: 'file', contentType: 'image/png' },
            { name: 'many', value: [filePathA, filePathB], type: 'file' },
          ],
        },
      },
    };
  }

  it('produces a FormData body instead of a raw string', async () => {
    const { options } = await buildFetchOptions(buildYaml(), new Map());
    expect(options.body).toBeInstanceOf(FormData);
  });

  it('appends a plain text part as a string when no contentType is set', async () => {
    const { options } = await buildFetchOptions(buildYaml(), new Map());
    const form = options.body as FormData;
    const entry = form.get('plain');
    expect(typeof entry).toBe('string');
    expect(entry).toBe('hello');
  });

  it('appends a text part with contentType as a Blob of that type', async () => {
    const { options } = await buildFetchOptions(buildYaml(), new Map());
    const form = options.body as FormData;
    const entry = form.get('typed');
    expect(entry).toBeInstanceOf(Blob);
    const blob = entry as Blob;
    expect(blob.type).toBe('text/plain');
    expect(await blob.text()).toBe('world');
  });

  it('appends a file part as a Blob with contentType and basename', async () => {
    const { options } = await buildFetchOptions(buildYaml(), new Map());
    const form = options.body as FormData;
    const entry = form.get('single');
    expect(entry).toBeInstanceOf(Blob);
    const file = entry as File;
    expect(file.type).toBe('image/png');
    expect(file.name).toBe(basename(filePathA));
    expect(await file.text()).toBe(fileContentA);
  });

  it('appends multiple files for an array value, defaulting to octet-stream', async () => {
    const { options } = await buildFetchOptions(buildYaml(), new Map());
    const form = options.body as FormData;
    const entries = form.getAll('many');
    expect(entries).toHaveLength(2);
    const [first, second] = entries as File[];
    expect(first).toBeInstanceOf(Blob);
    expect(second).toBeInstanceOf(Blob);
    expect(first.type).toBe('application/octet-stream');
    expect(first.name).toBe(basename(filePathA));
    expect(second.name).toBe(basename(filePathB));
    expect(await first.text()).toBe(fileContentA);
    expect(await second.text()).toBe(fileContentB);
  });

  it('strips any user-provided Content-Type header for multipart bodies', async () => {
    const { options } = await buildFetchOptions(buildYaml(), new Map());
    const headers = options.headers as Record<string, string>;
    const hasContentType = Object.keys(headers).some(
      (k) => k.toLowerCase() === 'content-type',
    );
    expect(hasContentType).toBe(false);
  });

  it('substitutes variables in file paths and part values', async () => {
    const yaml: YamlRequest = {
      info: { name: 'Upload', type: 'http' },
      http: {
        method: 'POST',
        url: 'https://example.com/upload',
        body: {
          type: 'multipart-form',
          data: [
            { name: 'greeting', value: '{{greeting}}', type: 'text', contentType: 'text/plain' },
            { name: 'doc', value: '{{docPath}}', type: 'file' },
          ],
        },
      },
    };
    const vars = new Map<string, string>([
      ['greeting', 'ciao'],
      ['docPath', filePathA],
    ]);
    const { options } = await buildFetchOptions(yaml, vars);
    const form = options.body as FormData;
    expect(await (form.get('greeting') as Blob).text()).toBe('ciao');
    const doc = form.get('doc') as File;
    expect(doc.name).toBe(basename(filePathA));
    expect(await doc.text()).toBe(fileContentA);
  });

  it('keeps raw string body behavior for non-multipart bodies', async () => {
    const yaml: YamlRequest = {
      info: { name: 'Json', type: 'http' },
      http: {
        method: 'POST',
        url: 'https://example.com/json',
        body: { type: 'json', data: '{"a":{{n}}}' },
      },
    };
    const { options } = await buildFetchOptions(yaml, new Map([['n', '1']]));
    expect(typeof options.body).toBe('string');
    expect(options.body).toBe('{"a":1}');
  });
});
