/**
 * The Content-Type a body type implies, asserted at the wire rather than on the
 * RequestInit.
 *
 * That distinction is the whole point of this suite. Inspecting `options.headers`
 * says "no Content-Type" and looks harmless. What actually leaves the process is
 * `text/plain;charset=UTF-8`, because the Fetch standard gives a string body that
 * default. A JSON payload therefore arrived *labelled as plain text*: worse than
 * a missing header, since a server presented with an explicit wrong type has no
 * reason to sniff. express.json() leaves req.body empty and Spring answers 415.
 *
 * So these tests read the header off a real request received by a real server.
 */
import { createServer, Server } from 'http';
import { parseBruRequest } from '../../../src/bruno/bru-parser';
import { bruFileToYamlRequest, buildFetchOptions } from '../../../src/bruno/request-executor';

let server: Server;
let port: number;
let received: { contentType?: string; body: string };

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received = { contentType: req.headers['content-type'], body };
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const bru = (bodyMeta: string, block: string, extra = ''): string => `meta {
  name: r
  type: http
  seq: 1
}

post {
  url: http://127.0.0.1:${port}/x
  body: ${bodyMeta}
  auth: none
}
${extra}
${block}
`;

/** Send a .bru request for real and report what the server saw. */
const send = async (source: string): Promise<{ contentType?: string; body: string }> => {
  const yaml = bruFileToYamlRequest(parseBruRequest(source));
  const { options } = await buildFetchOptions(yaml, new Map());
  await fetch(yaml.http.url, options);
  return received;
};

describe('Content-Type is derived from the body type', () => {
  it.each([
    ['json', 'json', 'body:json {\n  {"a":1}\n}', 'application/json'],
    ['xml', 'xml', 'body:xml {\n  <a/>\n}', 'application/xml'],
    ['sparql', 'sparql', 'body:sparql {\n  SELECT * WHERE {}\n}', 'application/sparql-query'],
  ])('sends %s as %s', async (_label, meta, block, expected) => {
    const seen = await send(bru(meta, block));
    expect(seen.contentType).toBe(expected);
  });

  it('never labels a JSON body as plain text', async () => {
    // The specific regression: the Fetch default for a string body.
    const seen = await send(bru('json', 'body:json {\n  {"a":1}\n}'));
    expect(seen.contentType).not.toContain('text/plain');
    expect(seen.body).toBe('{"a":1}');
  });

  it('leaves a text body to the Fetch default, which already declares a charset', async () => {
    // Not an oversight: text/plain is the right type for a text body and the
    // default additionally carries the charset, so overriding it loses
    // information.
    const seen = await send(bru('text', 'body:text {\n  hi\n}'));
    expect(seen.contentType).toBe('text/plain;charset=UTF-8');
  });
});

describe('an explicit Content-Type always wins', () => {
  it.each([
    ['json', 'json', 'body:json {\n  {"a":1}\n}', 'application/vnd.api+json'],
    ['xml', 'xml', 'body:xml {\n  <a/>\n}', 'text/xml'],
  ])('keeps the collection\'s own %s media type', async (_label, meta, block, declared) => {
    // A collection may need a vendor type or the other registered XML spelling.
    const seen = await send(bru(meta, block, `\nheaders {\n  Content-Type: ${declared}\n}\n`));
    expect(seen.contentType).toBe(declared);
  });

  it('matches the header name case-insensitively', async () => {
    // RFC 9110 5.1: field names are case-insensitive, and a .bru file may use
    // any spelling. A case-sensitive check would silently add a second,
    // conflicting Content-Type.
    const seen = await send(
      bru('json', 'body:json {\n  {"a":1}\n}', '\nheaders {\n  content-type: application/vnd.api+json\n}\n'),
    );
    expect(seen.contentType).toBe('application/vnd.api+json');
  });
});

describe('bodies that already carried a derived type are unchanged', () => {
  it('still sends form-urlencoded with its own type', async () => {
    const seen = await send(bru('formUrlEncoded', 'body:form-urlencoded {\n  u: a\n}'));
    expect(seen.contentType).toBe('application/x-www-form-urlencoded');
    expect(seen.body).toBe('u=a');
  });

  it('still sends graphql as JSON', async () => {
    const seen = await send(bru('graphql', 'body:graphql {\n  query { a }\n}'));
    expect(seen.contentType).toBe('application/json');
  });

  it('still lets undici set the multipart boundary', async () => {
    const seen = await send(bru('multipartForm', 'body:multipart-form {\n  u: a\n}'));
    // The boundary is generated per request, so assert the shape, not a literal.
    expect(seen.contentType).toMatch(/^multipart\/form-data; boundary=/);
  });
});
