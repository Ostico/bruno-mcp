/**
 * A file body in the `.yml` dialect.
 *
 * Bruno stores one as a list of `{ filePath, contentType, selected }` — see
 * `bruno-filestore/src/formats/yml/common/body.ts` upstream. `parseBody` here
 * branched on `Array.isArray(data)` and, once past form-urlencoded, treated
 * every array as multipart parts. None of a file entry's keys exist on a part,
 * so a Bruno-authored file body was read as `{ name: '', value: '' }` and the
 * file path was **gone**. Rewriting the request for any unrelated reason then
 * wrote those empty parts back over a body this server never authored.
 *
 * That is data loss in someone else's file, and it needed no new feature to
 * reach: opening a collection with a file upload in it was enough. The array
 * shape alone never said what the entries were — only `type` does, which is the
 * same reason the form-urlencoded branch exists directly above.
 */
import { parseYamlRequest } from '../../../src/bruno/yaml-parser';
import { generateYamlRequest } from '../../../src/bruno/yaml-generator';
import type { BruFilePart } from '../../../src/bruno/types';

/** A request whose body is exactly what Bruno writes for a file upload. */
const BRUNO_AUTHORED = `info:
  name: upload
  type: http
  seq: 1
http:
  method: post
  url: https://example.com/upload
  body:
    type: file
    data:
      - filePath: report.pdf
        contentType: application/pdf
        selected: true
      - filePath: notes.txt
        contentType: text/plain
        selected: false
`;

describe('a .yml file body', () => {
  describe('reading one Bruno wrote', () => {
    it('keeps every file path', () => {
      const parsed = parseYamlRequest(BRUNO_AUTHORED);

      expect(parsed.http.body?.type).toBe('file');
      expect((parsed.http.body?.data as BruFilePart[]).map((p) => p.filePath)).toEqual([
        'report.pdf',
        'notes.txt',
      ]);
    });

    it('keeps each content type', () => {
      const parsed = parseYamlRequest(BRUNO_AUTHORED);

      expect((parsed.http.body?.data as BruFilePart[]).map((p) => p.contentType)).toEqual([
        'application/pdf',
        'text/plain',
      ]);
    });

    it('records a deselected entry and leaves a selected one unmarked', () => {
      // Enabled-only, the way the .bru side models it: absence means it will be
      // sent, so only `false` is worth carrying.
      const parsed = parseYamlRequest(BRUNO_AUTHORED);
      const [first, second] = parsed.http.body?.data as BruFilePart[];

      expect(first.selected).toBeUndefined();
      expect(second.selected).toBe(false);
    });

    it('does not read the entries as multipart parts', () => {
      // The exact old failure: `{ name: '', value: '', type: 'text' }` per file.
      const parts = parseYamlRequest(BRUNO_AUTHORED).http.body?.data as Array<
        Record<string, unknown>
      >;

      for (const part of parts) {
        expect(part).not.toHaveProperty('name');
        expect(part).not.toHaveProperty('value');
      }
    });
  });

  describe('writing one back', () => {
    it('survives a read-modify-write untouched', () => {
      // The scenario that lost data: parse a Bruno file, change something
      // unrelated, write it out.
      const parsed = parseYamlRequest(BRUNO_AUTHORED);
      parsed.info.name = 'upload renamed';

      const written = generateYamlRequest(parsed);

      expect(written).toContain('filePath: report.pdf');
      expect(written).toContain('contentType: application/pdf');
      expect(written).toContain('filePath: notes.txt');
      expect(written).not.toContain("name: ''");
    });

    it('round-trips to the same file paths a second time', () => {
      const once = generateYamlRequest(parseYamlRequest(BRUNO_AUTHORED));
      const twice = generateYamlRequest(parseYamlRequest(once));

      expect(twice).toBe(once);
    });

    it('keeps a deselected entry deselected', () => {
      const written = generateYamlRequest(parseYamlRequest(BRUNO_AUTHORED));

      expect(written).toContain('selected: false');
    });
  });

  describe('the neighbouring array bodies still read as themselves', () => {
    const bodyOf = (type: string, data: string): string => `info:
  name: r
  type: http
  seq: 1
http:
  method: post
  url: https://example.com/x
  body:
    type: ${type}
    data:
${data}
`;

    it('reads multipart parts as parts', () => {
      const parsed = parseYamlRequest(
        bodyOf('multipart-form', '      - name: field\n        value: v\n'),
      );

      expect(parsed.http.body?.data).toEqual([
        expect.objectContaining({ name: 'field', value: 'v' }),
      ]);
    });

    it('reads form-urlencoded pairs as pairs', () => {
      const parsed = parseYamlRequest(
        bodyOf('form-urlencoded', '      - name: a\n        value: b\n'),
      );

      expect(parsed.http.body?.data).toEqual([{ name: 'a', value: 'b' }]);
    });
  });
});
