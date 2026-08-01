/**
 * A `.bru` body the model carries only as `content`.
 *
 * `BruBody` declares `content` alongside the structured fields, so
 * `{ type: 'file', content: 'upload.bin' }` is a legal value of the type. The
 * generator's body chain, though, is presence-based: it matches `body.file`,
 * `body.graphql`, `body.formUrlEncoded` and so on, and everything that matches
 * none of them fell through to a catch-all that wrote the model's own
 * kebab-case type as the key `@usebruno/lang` should read.
 *
 * That key is only right for json, text, xml and sparql. For the rest the
 * catch-all either threw (`file`, where upstream tests `.length` on what it
 * assumes is an array and then calls `.filter` on it) or produced a key upstream
 * has never heard of, so the body was written to a file that Bruno reads as
 * having none.
 *
 * These tests assert the emitted `.bru` text rather than a round-trip: a
 * round-trip through this codebase's own parser would agree with whatever the
 * generator wrote, which is exactly how the defect stayed invisible. They also
 * pin the failure that reaches the tool surface today — a `form-data` body given
 * as `content` and no parts, which `create_test_suite` produces from its own
 * schema.
 */
import { generateBruRequest, parseBruRequest } from '../../../src/bruno/bru-parser';
import type { BruBody, BruFile, BodyType } from '../../../src/bruno/types';

/** A minimal request whose only interesting part is the body. */
const withBody = (type: BodyType, body: BruBody | undefined): BruFile => ({
  meta: { name: 'r', type: 'http', seq: 1 },
  http: { method: 'POST', url: 'https://example.com/x', body: type, auth: 'none' },
  body,
});

/** The `body: <mode>` token inside the `post`/`get` block. */
const modeToken = (bru: string): string | undefined =>
  bru.match(/^\s+body:\s*(\S+)\s*$/m)?.[1];

/** Names of the `body:*` blocks the file carries. */
const bodyBlocks = (bru: string): string[] =>
  [...bru.matchAll(/^(body(?::[a-z-]+)*)\s*\{/gm)].map((m) => m[1]);

describe('a .bru body carried only as content', () => {
  describe('the four text types, which the catch-all always got right', () => {
    it.each([
      ['json', '{\n  "a": 1\n}'],
      ['text', 'plain words'],
      ['xml', '<a>1</a>'],
      ['sparql', 'SELECT * WHERE { ?s ?p ?o }'],
    ] as Array<[BodyType, string]>)('writes a %s body from content', (type, content) => {
      const bru = generateBruRequest(withBody(type, { type, content }));

      expect(bodyBlocks(bru)).toEqual([`body:${type}`]);
      expect(bru).toContain(content.split('\n')[0].trim());
      // The mode token is the model's own spelling for these four, so nothing
      // needs restoring.
      expect(modeToken(bru)).toBe(type);
    });

    it('round-trips a json body given as content', () => {
      const bru = generateBruRequest(withBody('json', { type: 'json', content: '{\n  "a": 1\n}' }));
      const reparsed = parseBruRequest(bru);

      expect(reparsed.body?.content).toContain('"a": 1');
      expect(reparsed.http.body).toBe('json');
    });
  });

  describe('a file body, which used to throw', () => {
    it('writes the content as the file path instead of crashing', () => {
      // Before the fix this threw `items.filter is not a function`: upstream
      // sees a truthy `.length` on the string and hands it to a filter.
      const bru = generateBruRequest(withBody('file', { type: 'file', content: 'upload.bin' }));

      expect(bodyBlocks(bru)).toEqual(['body:file']);
      expect(bru).toContain('@file(upload.bin)');
      expect(modeToken(bru)).toBe('file');
    });

    it('reads back as the same single-part file body', () => {
      const bru = generateBruRequest(withBody('file', { type: 'file', content: 'upload.bin' }));
      const reparsed = parseBruRequest(bru);

      // No `selected` on the way back: the parser records the flag only when it
      // is false, so a selected part comes back as the path alone.
      expect(reparsed.body?.file).toEqual([{ filePath: 'upload.bin' }]);
    });

    it('reads the same file path a structured body of one part would have written', () => {
      // Both spellings of the same request must produce the same file, because
      // `toBruBody` translates `content` into exactly this one-part array.
      const fromContent = generateBruRequest(withBody('file', { type: 'file', content: 'a.bin' }));
      const fromParts = generateBruRequest(
        withBody('file', { type: 'file', file: [{ filePath: 'a.bin' }] }),
      );

      expect(fromContent).toBe(fromParts);
    });

    it('still prefers the structured parts when both are present', () => {
      // This is the shape `toBruBody` produces: content AND file. The array is
      // the richer field and must win.
      const bru = generateBruRequest(
        withBody('file', {
          type: 'file',
          content: 'ignored.bin',
          file: [{ filePath: 'real.bin', contentType: 'application/octet-stream' }],
        }),
      );

      expect(bru).toContain('@file(real.bin)');
      expect(bru).not.toContain('ignored.bin');
    });
  });

  describe('a graphql body, whose query used to be dropped', () => {
    it('writes the content as the query', () => {
      const query = '{ user { id } }';
      const bru = generateBruRequest(withBody('graphql', { type: 'graphql', content: query }));

      // Upstream reads `body.graphql.query`, which a bare string does not have,
      // so the whole block used to be skipped.
      expect(bodyBlocks(bru)).toEqual(['body:graphql']);
      expect(bru).toContain(query);
      expect(modeToken(bru)).toBe('graphql');
    });

    it('matches what the same query written as a structured body produces', () => {
      const query = '{ user { id } }';

      expect(generateBruRequest(withBody('graphql', { type: 'graphql', content: query }))).toBe(
        generateBruRequest(withBody('graphql', { type: 'graphql', graphql: { query } })),
      );
    });
  });

  describe('a form-urlencoded body, whose key and mode were both wrong', () => {
    it('parses the content into entries and restores the camelCase mode', () => {
      const bru = generateBruRequest(
        withBody('form-urlencoded', { type: 'form-urlencoded', content: 'username=alice&x=1' }),
      );

      expect(bodyBlocks(bru)).toEqual(['body:form-urlencoded']);
      expect(bru).toContain('username: alice');
      expect(bru).toContain('x: 1');
      // Bruno spells the block kebab-case and the mode camelCase. Leaving the
      // model's kebab-case mode in the http block makes Bruno recognise no body
      // type at all, which is why the two structured branches restore it too.
      expect(modeToken(bru)).toBe('formUrlEncoded');
    });

    it('reads back as the entries it wrote', () => {
      const bru = generateBruRequest(
        withBody('form-urlencoded', { type: 'form-urlencoded', content: 'username=alice&x=1' }),
      );
      const reparsed = parseBruRequest(bru);

      expect(reparsed.body?.formUrlEncoded).toEqual([
        expect.objectContaining({ name: 'username', value: 'alice' }),
        expect.objectContaining({ name: 'x', value: '1' }),
      ]);
    });

    it('percent-decodes the same way the authoring path does', () => {
      const bru = generateBruRequest(
        withBody('form-urlencoded', { type: 'form-urlencoded', content: 'q=a%20b' }),
      );

      expect(bru).toContain('q: a b');
    });
  });

  describe('the multipart types, which no string can describe', () => {
    it.each(['form-data', 'multipart-form'] as BodyType[])(
      'restores the camelCase mode and writes no block for %s',
      (type) => {
        // Reachable today: create_test_suite forwards only `{type, content}`,
        // so a form-data body arrives here with no parts at all. The content is
        // lost either way — a bare string cannot name parts — but the mode token
        // is now one Bruno recognises rather than a kebab-case value it does not.
        const bru = generateBruRequest(withBody(type, { type, content: 'name=alice' }));

        expect(bodyBlocks(bru)).toEqual([]);
        expect(modeToken(bru)).toBe('multipartForm');
      },
    );

    it('still writes the parts when they are present', () => {
      const bru = generateBruRequest(
        withBody('multipart-form', {
          type: 'multipart-form',
          formData: [{ name: 'a', value: '1', type: 'text', enabled: true }],
        }),
      );

      expect(bodyBlocks(bru)).toEqual(['body:multipart-form']);
      expect(modeToken(bru)).toBe('multipartForm');
    });
  });

  describe('types Bruno has no body block for', () => {
    it.each(['binary', 'none'] as BodyType[])('writes no body block for %s', (type) => {
      const bru = generateBruRequest(withBody(type, { type, content: 'whatever' }));

      expect(bodyBlocks(bru)).toEqual([]);
    });

    it('writes no body block when there is no body at all', () => {
      expect(bodyBlocks(generateBruRequest(withBody('none', undefined)))).toEqual([]);
    });

    it('writes no body block for an empty content string', () => {
      expect(bodyBlocks(generateBruRequest(withBody('json', { type: 'json', content: '' })))).toEqual(
        [],
      );
    });
  });
});
