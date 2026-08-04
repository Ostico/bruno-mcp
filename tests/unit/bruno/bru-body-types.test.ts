/**
 * Body types that a .bru file can declare, end to end.
 *
 * Bruno writes the body type in camelCase inside the `http` meta block
 * (`body: formUrlEncoded`) but names the body block in kebab-case
 * (`body:form-urlencoded {`). The parser normalized only `multipartForm`, so
 * `body.type` also carried raw values like `formUrlEncoded` — values the
 * declared BodyType union does not contain.
 *
 * That mismodelling hid a data-loss bug: the translation into the executor's
 * shape branched on `body.formData` or `body.content` only, and the parser puts
 * form-urlencoded, graphql and file bodies in their own fields. None of them
 * matched either branch, so the body was dropped and the request went to the
 * wire with no payload at all — no error, no warning, just a 400 from the
 * server that the user had no way to explain.
 */
import { parseBruRequest } from '../../../src/bruno/bru-parser';
import { bruFileToYamlRequest, buildFetchOptions } from '../../../src/bruno/request-executor';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const bru = (bodyMeta: string, block: string): string => `meta {
  name: r
  type: http
  seq: 1
}

post {
  url: https://example.com/x
  body: ${bodyMeta}
  auth: none
}

${block}
`;

const FORM_URLENCODED = bru(
  'formUrlEncoded',
  'body:form-urlencoded {\n  username: alice\n  password: s3cret\n}',
);

const GRAPHQL = bru('graphql', 'body:graphql {\n  query { user { id } }\n}');

/** Read the body off a RequestInit as a string, whatever concrete form it took. */
const bodyText = async (options: RequestInit): Promise<string> => {
  const body = options.body;
  if (body == null) return '';
  if (typeof body === 'string') return body;
  return await new Response(body as BodyInit).text();
};

const headerValue = (options: RequestInit, name: string): string | undefined => {
  const headers = options.headers as Record<string, string> | undefined;
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
};

describe('.bru body types survive translation into the executor shape', () => {
  it('carries a form-urlencoded body instead of dropping it', () => {
    const yaml = bruFileToYamlRequest(parseBruRequest(FORM_URLENCODED));
    expect(yaml.http.body).toBeDefined();
  });

  it('carries a graphql body instead of dropping it', () => {
    const yaml = bruFileToYamlRequest(parseBruRequest(GRAPHQL));
    expect(yaml.http.body).toBeDefined();
  });

  it('normalizes the camelCase .bru spelling to a declared BodyType member', () => {
    // `formUrlEncoded` is what Bruno writes; it is not a BodyType member, so
    // leaving it raw made the declared type a false claim.
    const parsed = parseBruRequest(FORM_URLENCODED);
    expect(parsed.body?.type).toBe('form-urlencoded');
  });
});

describe('form-urlencoded bodies reach the wire correctly', () => {
  it('encodes the pairs as application/x-www-form-urlencoded', async () => {
    const yaml = bruFileToYamlRequest(parseBruRequest(FORM_URLENCODED));
    const { options } = await buildFetchOptions(yaml, new Map());

    expect(await bodyText(options)).toBe('username=alice&password=s3cret');
    expect(headerValue(options, 'content-type')).toBe('application/x-www-form-urlencoded');
  });

  it('omits a pair the author disabled', async () => {
    const src = bru(
      'formUrlEncoded',
      'body:form-urlencoded {\n  username: alice\n  ~password: s3cret\n}',
    );
    const parsed = parseBruRequest(src);
    // Guard the premise: the parser must actually mark it disabled, otherwise
    // this test would pass for the wrong reason.
    expect(parsed.body?.formUrlEncoded?.some((p) => p.enabled === false)).toBe(true);

    const { options } = await buildFetchOptions(bruFileToYamlRequest(parsed), new Map());
    const sent = await bodyText(options);
    expect(sent).toBe('username=alice');
    expect(sent).not.toContain('s3cret');
  });

  it('percent-encodes a substituted value that contains separators', async () => {
    // The reason the pairs stay structured until send time. Serializing at
    // translation and substituting the resulting string afterwards would splice
    // `&` and `=` in raw and forge extra fields.
    const src = bru('formUrlEncoded', 'body:form-urlencoded {\n  q: {{needle}}\n}');
    const yaml = bruFileToYamlRequest(parseBruRequest(src));
    const { options } = await buildFetchOptions(
      yaml,
      new Map([['needle', 'a&b=c']]),
    );

    const sent = await bodyText(options);
    expect(sent).toBe('q=a%26b%3Dc');
    // The forged-field failure mode, stated directly.
    expect(new URLSearchParams(sent).get('q')).toBe('a&b=c');
    expect([...new URLSearchParams(sent).keys()]).toEqual(['q']);
  });

  it('does not overwrite a Content-Type the author set explicitly', async () => {
    const src = `meta {
  name: r
  type: http
  seq: 1
}

post {
  url: https://example.com/x
  body: formUrlEncoded
  auth: none
}

headers {
  Content-Type: application/x-www-form-urlencoded; charset=utf-8
}

body:form-urlencoded {
  u: alice
}
`;
    const yaml = bruFileToYamlRequest(parseBruRequest(src));
    const { options } = await buildFetchOptions(yaml, new Map());
    expect(headerValue(options, 'content-type')).toBe(
      'application/x-www-form-urlencoded; charset=utf-8',
    );
  });
});

describe('graphql bodies reach the wire correctly', () => {
  it('sends a JSON envelope with the query', async () => {
    const yaml = bruFileToYamlRequest(parseBruRequest(GRAPHQL));
    const { options } = await buildFetchOptions(yaml, new Map());

    expect(headerValue(options, 'content-type')).toBe('application/json');
    const parsed = JSON.parse(await bodyText(options)) as { query: string };
    expect(parsed.query).toContain('user');
  });

  it('includes variables as parsed JSON, not as a nested string', async () => {
    const src = bru(
      'graphql',
      'body:graphql {\n  query { user { id } }\n}\n\nbody:graphql:vars {\n  {"id": 7}\n}',
    );
    const parsed = parseBruRequest(src);
    // The vars block is parsed as text, so the envelope must re-parse it rather
    // than nest a JSON string inside the JSON body.
    expect(parsed.body?.graphql?.variables).toBe('{"id": 7}');

    const { options } = await buildFetchOptions(bruFileToYamlRequest(parsed), new Map());
    const sent = JSON.parse(await bodyText(options)) as { variables?: unknown };
    expect(sent.variables).toEqual({ id: 7 });
  });

  it('fails the request by name when the vars block is not json', async () => {
    // This used to send the raw text, on the reasoning that a server-side error
    // beats a silently dropped variables block. Both are worse than what upstream
    // does: it throws `Failed to parse GraphQL variables`
    // (`run-single-request.js:362-367`), the request never leaves, and the message
    // names the block. Sending the text produced `"variables": "not-json"` — a
    // string where an object belongs — and a server complaint about a field the
    // author never wrote.
    const src = bru(
      'graphql',
      'body:graphql {\n  query { a }\n}\n\nbody:graphql:vars {\n  not-json\n}',
    );
    const yaml = bruFileToYamlRequest(parseBruRequest(src));

    await expect(buildFetchOptions(yaml, new Map())).rejects.toThrow(
      /Failed to parse GraphQL variables/,
    );
  });

  it('keeps the JSON envelope valid when a substituted value contains a quote', async () => {
    // Same trap as the form body: stringifying first and substituting after
    // would produce unparseable JSON.
    const src = bru('graphql', 'body:graphql {\n  query { user(name: "{{who}}") { id } }\n}');
    const yaml = bruFileToYamlRequest(parseBruRequest(src));
    const { options } = await buildFetchOptions(yaml, new Map([['who', 'a"b']]));

    const sent = await bodyText(options);
    expect(() => JSON.parse(sent)).not.toThrow();
    expect((JSON.parse(sent) as { query: string }).query).toContain('a"b');
  });
});

describe('file bodies are not sent, because the format does not exist upstream', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bru-body-file-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /**
   * @usebruno/lang 0.36.0 has no `body:file` block: no `filePath` token appears
   * anywhere in its dist. A `body:file {` block is therefore parsed as an
   * ordinary name/value pair list, so the `filePath` the parser looks for is
   * never populated.
   *
   * This test pins that reality rather than the behaviour I first assumed.
   * Sending such a body would mean resolving an empty path against the
   * collection root and reading a directory — turning a silently missing body
   * into an EISDIR failure. Not sending it is correct until the block exists
   * upstream.
   */
  it('does not attempt to read a file for a body:file block', async () => {
    await writeFile(join(root, 'payload.bin'), 'raw-bytes');
    const src = bru(
      'file',
      'body:file {\n  filePath: payload.bin\n  contentType: application/octet-stream\n}',
    );
    const yaml = bruFileToYamlRequest(parseBruRequest(src));

    // Must not throw, and must not post the collection root's contents.
    const { options } = await buildFetchOptions(yaml, new Map(), root);
    expect(await bodyText(options)).toBe('');
  });
});

describe('body types that already worked are unchanged', () => {
  it.each([
    ['json', 'json', 'body:json {\n  {"a":1}\n}', '{"a":1}'],
    ['text', 'text', 'body:text {\n  hello\n}', 'hello'],
    ['xml', 'xml', 'body:xml {\n  <a/>\n}', '<a/>'],
    ['sparql', 'sparql', 'body:sparql {\n  SELECT * WHERE {}\n}', 'SELECT * WHERE {}'],
  ])('still sends a %s body', async (_label, meta, block, expected) => {
    const yaml = bruFileToYamlRequest(parseBruRequest(bru(meta, block)));
    const { options } = await buildFetchOptions(yaml, new Map());
    expect(await bodyText(options)).toContain(expected);
  });

  it('still sends a multipart body', async () => {
    const yaml = bruFileToYamlRequest(
      parseBruRequest(bru('multipartForm', 'body:multipart-form {\n  u: alice\n}')),
    );
    const { options } = await buildFetchOptions(yaml, new Map());
    expect(await bodyText(options)).toContain('alice');
  });
});
