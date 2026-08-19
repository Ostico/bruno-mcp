/**
 * `.yml` body fidelity, write path and read path together.
 *
 * The two halves are one defect. A body this tool wrote and could not send was
 * the write half; a body Bruno wrote and this tool re-wrote with an extra key
 * was the read half. Fixing either alone leaves a file that round-trips through
 * this codebase and diverges from Bruno, so both are pinned here.
 *
 * `form-urlencoded-fidelity.test.ts` is the same guard for `.bru`.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequestBuilder, RequestBuilder } from '../../../src/bruno/request';
import { createCollectionManager } from '../../../src/bruno/collection';
import { parseYamlRequest } from '../../../src/bruno/yaml-parser';
import { generateYamlRequest } from '../../../src/bruno/yaml-generator';
import { buildFetchOptions } from '../../../src/bruno/request-executor';
import type { YamlRequest } from '../../../src/bruno/types';

let builder: RequestBuilder;
let collectionPath: string;

beforeEach(async () => {
  builder = createRequestBuilder();
  const tmpDir = await fs.mkdtemp(join(tmpdir(), 'yml-body-'));
  const created = await createCollectionManager().createCollection({
    name: 'C',
    outputPath: tmpDir,
    format: 'yaml',
  });
  if (!created.success) throw new Error(`setup failed: ${created.error}`);
  collectionPath = join(tmpDir, 'C');
});

/** Author a request and hand back the bytes on disk. Never rebuild the path —
 * the writer lowercases the filename, so only what it reports is real. */
async function write(
  body: NonNullable<Parameters<RequestBuilder['createRequest']>[0]['body']>,
  name = 'R',
): Promise<string> {
  const created = await builder.createRequest({
    collectionPath,
    name,
    method: 'POST',
    url: 'https://api.example.com/x',
    body,
  });
  if (!created.success) throw new Error(`create failed: ${created.error}`);
  return fs.readFile(created.path!, 'utf-8');
}

/** What this request actually puts on the wire. */
async function send(yaml: YamlRequest) {
  const { options, warnings } = await buildFetchOptions(yaml, new Map(), collectionPath);
  const headers = (options.headers ?? {}) as Record<string, string>;
  const contentType = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === 'content-type',
  )?.[1];
  return { body: options.body, contentType, warnings: warnings ?? [] };
}

describe('form-urlencoded is stored as pairs, not as a string', () => {
  it('authored with formData, the pairs reach the file and the wire', async () => {
    const raw = await write({
      type: 'form-urlencoded',
      formData: [
        { name: 'username', value: 'ada' },
        { name: 'password', value: 'hunter2' },
      ],
    });

    // Upstream writes a form-urlencoded pair as name/value and nothing else.
    expect(raw).toContain('type: form-urlencoded');
    expect(raw).toContain('- name: username');
    expect(raw).toContain('value: ada');
    expect(raw).not.toMatch(/type: text/);

    const sent = await send(parseYamlRequest(raw));
    expect(sent.body).toBe('username=ada&password=hunter2');
    expect(sent.contentType).toBe('application/x-www-form-urlencoded');
  });

  it('authored with an encoded content string, the pairs are parsed out', async () => {
    // The string is decoded here rather than stored literally, so `%40` and `+`
    // mean on disk what they would have meant on the wire.
    const raw = await write({
      type: 'form-urlencoded',
      content: 'email=ada%40example.com&note=two+words',
    });

    expect(raw).toContain('- name: email');
    expect(raw).toContain('value: ada@example.com');
    expect(raw).toContain('value: two words');

    const sent = await send(parseYamlRequest(raw));
    expect(sent.body).toBe('email=ada%40example.com&note=two+words');
    expect(sent.contentType).toBe('application/x-www-form-urlencoded');
  });

  it('a switched-off pair is written as disabled and is not sent', async () => {
    const raw = await write({
      type: 'form-urlencoded',
      formData: [
        { name: 'keep', value: '1' },
        { name: 'drop', value: '2', enabled: false },
      ],
    });

    expect(raw).toContain('disabled: true');
    expect(raw).not.toContain('enabled:');

    const sent = await send(parseYamlRequest(raw));
    expect(sent.body).toBe('keep=1');
  });

  it('write_request writes the same shape as write_request', async () => {
    const created = await builder.createRequest({
      collectionPath,
      name: 'Mod',
      method: 'POST',
      url: 'https://api.example.com/x',
      body: { type: 'json', content: '{"a":1}' },
    });
    if (!created.success) throw new Error(`create failed: ${created.error}`);

    const modified = await builder.updateRequest(created.path!, {
      body: { type: 'form-urlencoded', formData: [{ name: 'a', value: '1' }] },
    });
    if (!modified.success) throw new Error(`modify failed: ${modified.error}`);

    const after = await fs.readFile(created.path!, 'utf-8');
    expect(after).toContain('type: form-urlencoded');
    expect(after).toContain('- name: a');
    expect(after).not.toMatch(/type: text/);

    const sent = await send(parseYamlRequest(after));
    expect(sent.body).toBe('a=1');
  });

  it('leaves multipart alone', async () => {
    const raw = await write({
      type: 'multipart-form',
      formData: [{ name: 'field', value: 'v' }],
    });
    // A multipart part does carry `type` — that is the key that marks a part as
    // a file, and it is what a form-urlencoded pair must not have.
    expect(raw).toContain('type: multipart-form');
    expect(raw).toContain('type: text');
  });
});

describe('graphql is sent as an envelope, whichever shape it was stored in', () => {
  it('a query authored as content goes out wrapped in JSON', async () => {
    const raw = await write({ type: 'graphql', content: '{ me { id } }' });

    const sent = await send(parseYamlRequest(raw));
    expect(JSON.parse(String(sent.body))).toEqual({ query: '{ me { id } }', variables: {} });
    expect(sent.contentType).toBe('application/json');
  });

  it('a query Bruno stored as a mapping keeps its variables', async () => {
    const raw = [
      'info:',
      '  name: G',
      'http:',
      '  method: POST',
      '  url: https://api.example.com/graphql',
      '  body:',
      '    type: graphql',
      '    data:',
      '      query: "query($id: ID!) { node(id: $id) { id } }"',
      '      variables: \'{"id":"7"}\'',
    ].join('\n');

    const sent = await send(parseYamlRequest(raw));
    expect(JSON.parse(String(sent.body))).toEqual({
      query: 'query($id: ID!) { node(id: $id) { id } }',
      variables: { id: '7' },
    });
    expect(sent.contentType).toBe('application/json');
  });
});

describe('reading a file Bruno wrote', () => {
  const brunoFile = [
    'info:',
    '  name: R',
    '  type: http',
    '  seq: 1',
    '',
    'http:',
    '  method: POST',
    '  url: https://api.example.com/x',
    '  body:',
    '    type: form-urlencoded',
    '    data:',
    '      - name: a',
    '        value: "1"',
    '      - name: b',
    '        value: "2"',
    '        disabled: true',
    '',
  ].join('\n');

  it('does not invent a type key on the pairs', () => {
    const parsed = parseYamlRequest(brunoFile);
    expect(parsed.http.body?.data).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2', enabled: false },
    ]);
  });

  it('writes the file back with nothing lost and only the settings block added', () => {
    // This fixture is hand-written, not real Bruno output — a request Bruno
    // saved would already carry a settings block, because its .yml writer states
    // all four every time. So the rewrite adds that block and changes nothing
    // else, which is what Bruno itself would do on opening this file.
    const out = generateYamlRequest(parseYamlRequest(brunoFile));

    expect(out).toContain(brunoFile.trimEnd());
    expect(out).toContain('settings:');
    expect(out).toContain('encodeUrl: true');
  });

  it('is stable from the second write onwards', () => {
    const once = generateYamlRequest(parseYamlRequest(brunoFile));

    expect(generateYamlRequest(parseYamlRequest(once))).toBe(once);
  });

  it('a hand-written string body still gets the form content-type', async () => {
    // Not a shape this tool writes any more, but a hand-edited file may hold
    // it, and a form post with no Content-Type is rejected by every server.
    const sent = await send(
      parseYamlRequest(
        [
          'info:',
          '  name: R',
          'http:',
          '  method: POST',
          '  url: https://api.example.com/x',
          '  body:',
          '    type: form-urlencoded',
          '    data: a=1&b=2',
        ].join('\n'),
      ),
    );
    expect(sent.body).toBe('a=1&b=2');
    expect(sent.contentType).toBe('application/x-www-form-urlencoded');
  });
});

describe('a body no encoder accepts is reported, not dropped in silence', () => {
  it('warns and sends nothing', async () => {
    const sent = await send({
      info: { name: 'R' },
      http: {
        method: 'POST',
        url: 'https://api.example.com/x',
        // Not reachable through the parser, which rejects this file. It is
        // reachable from a caller that builds the request itself, and the point
        // of the branch is that no shape leaves without a word either way.
        body: { type: 'json', data: { a: 1 } as never },
      },
    });

    expect(sent.body).toBeUndefined();
    expect(sent.warnings).toEqual([
      'body of type "json" was not sent: its data is object, which no encoder here accepts',
    ]);
  });

  it('names a list as a list', async () => {
    const sent = await send({
      info: { name: 'R' },
      http: {
        method: 'POST',
        url: 'https://api.example.com/x',
        body: { type: 'text', data: [{ name: 'a', value: '1' }] },
      },
    });

    expect(sent.body).toBeUndefined();
    expect(sent.warnings).toEqual([
      'body of type "text" was not sent: its data is a list, which no encoder here accepts',
    ]);
  });
});
