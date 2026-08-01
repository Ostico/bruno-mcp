/**
 * The body types a caller can actually ask for, end to end in both dialects.
 *
 * `BodyType` has eleven members and both writers handle all eleven, but the tool
 * schemas offered six. `graphql` and `file` were the costly omissions: every
 * layer beneath the surface supported a graphql request — `toBruBody` builds the
 * query, the executor sends it, and the `.yml` writer emits Bruno's own
 * `graphql:` block — while no caller could ask for one. `sparql` and
 * `multipart-form` were missing spellings of paths that already worked.
 *
 * These tests go through the real writer into a temp directory and read the
 * bytes back, because a schema that accepts a type proves nothing about the file
 * it produces. Where Bruno's own shape is known it is asserted literally:
 * `meta { type: graphql }`, `body:graphql:vars`, and a `.yml` file body as a
 * list of `filePath` entries.
 */
import { createRequestBuilder, RequestBuilder } from '../../../src/bruno/request.js';
import { createCollectionManager } from '../../../src/bruno/collection.js';
import type { BodyType, CreateRequestInput } from '../../../src/bruno/types.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
}));

let builder: RequestBuilder;

beforeEach(() => {
  builder = createRequestBuilder();
});

async function makeCollection(format: 'bru' | 'yml'): Promise<string> {
  const tmpDir = await fs.mkdtemp(join(tmpdir(), `bruno-bodytype-${format}-`));
  const result = await createCollectionManager().createCollection({
    name: 'BodyAPI',
    outputPath: tmpDir,
    format,
  });
  if (!result.success) throw new Error(`collection setup failed: ${result.error}`);
  return join(tmpDir, 'BodyAPI');
}

/** Author a request and return the bytes actually written. */
async function write(
  format: 'bru' | 'yml',
  name: string,
  body: CreateRequestInput['body'],
): Promise<string> {
  const collectionPath = await makeCollection(format);
  const created = await builder.createRequest({
    collectionPath,
    name,
    method: 'POST',
    url: 'https://example.com/x',
    body,
  });
  if (!created.success || !created.path) {
    throw new Error(`create failed: ${created.error}`);
  }
  // Read back the path the writer reported: it lowercases request filenames, so
  // a rebuilt path passes on a case-insensitive filesystem and fails on CI.
  return await fs.readFile(created.path, 'utf-8');
}

describe('body types the tool surface accepts', () => {
  describe('graphql, which was unreachable entirely', () => {
    it('writes the query into a .bru graphql body', async () => {
      const bru = await write('bru', 'gqlq', { type: 'graphql', content: '{ user { id } }' });

      expect(bru).toContain('body:graphql {');
      expect(bru).toContain('{ user { id } }');
      expect(bru).toContain('body: graphql');
    });

    it('marks the .bru request as a graphql one in its meta block', async () => {
      // Bruno writes `type: graphql` here and its UI reads that key, not the
      // body mode, to know what the request is.
      const bru = await write('bru', 'gqlmeta', { type: 'graphql', content: '{ a }' });

      expect(bru).toMatch(/meta \{[^}]*type: graphql/s);
    });

    it('writes variables to body:graphql:vars, as authored', async () => {
      const variables = '{\n  "id": "{{userId}}"\n}';
      const bru = await write('bru', 'gqlvars', {
        type: 'graphql',
        content: '{ user { id } }',
        variables,
      });

      expect(bru).toContain('body:graphql:vars {');
      // Unreformatted: a placeholder that is not valid JSON alone must survive.
      expect(bru).toContain('"id": "{{userId}}"');
    });

    it('writes a .yml graphql request into the graphql block, with its variables', async () => {
      const yml = await write('yml', 'gqly', {
        type: 'graphql',
        content: '{ user { id } }',
        variables: '{"id": "{{userId}}"}',
      });

      expect(yml).toContain('graphql:');
      expect(yml).toContain('query:');
      expect(yml).toContain('variables:');
      expect(yml).toContain('{{userId}}');
    });

    it('omits the vars block when no variables were given', async () => {
      const bru = await write('bru', 'gqlnovars', { type: 'graphql', content: '{ a }' });

      expect(bru).not.toContain('body:graphql:vars');
    });
  });

  describe('file, which was also unreachable', () => {
    it('writes content as the single file path in .bru', async () => {
      const bru = await write('bru', 'fileone', { type: 'file', content: 'upload.bin' });

      expect(bru).toContain('@file(upload.bin)');
    });

    it('writes the parts, with content types, when files is given', async () => {
      const bru = await write('bru', 'filemany', {
        type: 'file',
        files: [
          { filePath: 'a.pdf', contentType: 'application/pdf' },
          { filePath: 'b.txt', contentType: 'text/plain' },
        ],
      });

      expect(bru).toContain('@file(a.pdf)');
      expect(bru).toContain('@file(b.txt)');
      expect(bru).toContain('@contentType(application/pdf)');
    });

    it('prefers files over the content shorthand when both are given', async () => {
      const bru = await write('bru', 'fileboth', {
        type: 'file',
        content: 'ignored.bin',
        files: [{ filePath: 'real.bin' }],
      });

      expect(bru).toContain('@file(real.bin)');
      expect(bru).not.toContain('ignored.bin');
    });

    it('writes a .yml file body as a list of filePath entries, not a string', async () => {
      // Bruno's .yml reader takes filePath off each entry; a bare path string
      // reads as no files at all.
      const yml = await write('yml', 'filey', {
        type: 'file',
        files: [{ filePath: 'a.pdf', contentType: 'application/pdf' }],
      });

      expect(yml).toContain('filePath: a.pdf');
      expect(yml).toContain('contentType: application/pdf');
    });
  });

  describe('the two missing spellings', () => {
    it('writes a sparql body', async () => {
      const query = 'SELECT * WHERE { ?s ?p ?o }';
      const bru = await write('bru', 'sparqlq', { type: 'sparql', content: query });

      expect(bru).toContain('body:sparql {');
      expect(bru).toContain(query);
    });

    it('writes multipart-form the same way form-data already did', async () => {
      const formData = [{ name: 'a', value: '1', type: 'text' as const, enabled: true }];
      const asMultipart = await write('bru', 'mp1', { type: 'multipart-form', formData });
      const asFormData = await write('bru', 'mp1', { type: 'form-data', formData });

      expect(asMultipart).toBe(asFormData);
      expect(asMultipart).toContain('body:multipart-form {');
    });
  });

  describe('what the surface still refuses', () => {
    it.each(['none', 'json', 'text', 'xml', 'binary'] as BodyType[])(
      'still writes %s as it did before',
      async (type) => {
        const bru = await write('bru', `plain-${type}`, { type, content: 'payload' });

        expect(bru).toContain(`body: ${type}`);
      },
    );
  });
});
