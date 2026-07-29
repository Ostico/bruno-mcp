/**
 * Query and path parameters, asserted against a request a server really received.
 *
 * Both formats declare them, both parsers populate them and both generators write
 * them back — and nothing applied them to the outgoing request. A `params:query`
 * entry never reached the query string and a `params:path` entry left `:id` in
 * the URL verbatim. It was reachable straight through the MCP surface:
 * create_request stores its `query` input, the file on disk looks right, and the
 * request went out without it.
 */
import { createServer, Server } from 'http';
import { parseBruRequest } from '../../../src/bruno/bru-parser';
import { bruFileToYamlRequest, buildFetchOptions } from '../../../src/bruno/request-executor';
import type { YamlRequest } from '../../../src/bruno/types';

let server: Server;
let port: number;
let receivedUrl: string | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    receivedUrl = req.url;
    res.writeHead(204).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const bru = (urlPath: string, blocks = ''): string => `meta {
  name: r
  type: http
  seq: 1
}

get {
  url: http://127.0.0.1:${port}${urlPath}
  body: none
  auth: none
}
${blocks}
`;

/** Send a .bru request for real; report the path+query the server saw. */
const sendBru = async (
  source: string,
  vars = new Map<string, string>(),
): Promise<string | undefined> => {
  const yaml = bruFileToYamlRequest(parseBruRequest(source));
  const { url, options } = await buildFetchOptions(yaml, vars);
  await fetch(url, options);
  return receivedUrl;
};

describe('query parameters reach the request', () => {
  it('appends an enabled query parameter', async () => {
    const seen = await sendBru(bru('/s', '\nparams:query {\n  on: yes\n}\n'));
    expect(seen).toBe('/s?on=yes');
  });

  it('omits a parameter the author disabled', async () => {
    const seen = await sendBru(bru('/s', '\nparams:query {\n  on: yes\n  ~off: no\n}\n'));
    expect(seen).toBe('/s?on=yes');
    expect(seen).not.toContain('off');
  });

  it('keeps a query string already present in the url and adds to it', async () => {
    const seen = await sendBru(bru('/s?keep=1', '\nparams:query {\n  on: yes\n}\n'));
    expect(seen).toContain('keep=1');
    expect(seen).toContain('on=yes');
  });

  it('percent-encodes a substituted value that contains separators', async () => {
    // Same ordering rule as form bodies: substitute first, encode second, or a
    // variable containing & or = forges extra parameters.
    const seen = await sendBru(
      bru('/s', '\nparams:query {\n  q: {{needle}}\n}\n'),
      new Map([['needle', 'a&b=c']]),
    );
    expect(seen).toBe('/s?q=a%26b%3Dc');
    const parsed = new URLSearchParams(seen!.split('?')[1]);
    expect(parsed.get('q')).toBe('a&b=c');
    expect([...parsed.keys()]).toEqual(['q']);
  });
});

describe('path parameters reach the request', () => {
  it('substitutes a :name segment', async () => {
    const seen = await sendBru(bru('/u/:id', '\nparams:path {\n  id: 42\n}\n'));
    expect(seen).toBe('/u/42');
  });

  it('leaves an unmatched :name alone rather than corrupting the path', async () => {
    // No value to substitute. Sending the literal segment is wrong but visible;
    // silently dropping it would change which resource is addressed.
    const seen = await sendBru(bru('/u/:missing'));
    expect(seen).toBe('/u/:missing');
  });

  it('encodes a path value containing a slash so it cannot escape its segment', async () => {
    // A raw `/` here would silently address a different resource.
    const seen = await sendBru(
      bru('/u/:id', '\nparams:path {\n  id: {{v}}\n}\n'),
      new Map([['v', 'a/b']]),
    );
    expect(seen).toBe('/u/a%2Fb');
  });

  it('substitutes only whole segments, not a colon inside a value', async () => {
    const seen = await sendBru(bru('/t/12:30/:id', '\nparams:path {\n  id: 9\n}\n'));
    expect(seen).toBe('/t/12:30/9');
  });
});

describe('edge cases that must not corrupt the url', () => {
  it('leaves a :name that no declared parameter matches', async () => {
    // A path block exists but names a different segment, so the replace runs and
    // has to decide. Leaving it visible beats addressing another resource.
    const seen = await sendBru(bru('/u/:other', '\nparams:path {\n  id: 42\n}\n'));
    expect(seen).toBe('/u/:other');
  });

  it('does not produce "?&" when the url already ends in a bare question mark', async () => {
    const seen = await sendBru(bru('/s?', '\nparams:query {\n  on: yes\n}\n'));
    expect(seen).toBe('/s?on=yes');
  });

  it('leaves the url untouched when every parameter is disabled', async () => {
    const seen = await sendBru(bru('/s', '\nparams:query {\n  ~off: no\n}\n'));
    expect(seen).toBe('/s');
  });
});

describe('both kinds together', () => {
  it('applies path and query parameters to the same request', async () => {
    const seen = await sendBru(
      bru('/u/:id', '\nparams:path {\n  id: 7\n}\n\nparams:query {\n  q: x\n}\n'),
    );
    expect(seen).toBe('/u/7?q=x');
  });
});

describe('the .yml format applies them too', () => {
  it('applies params declared on a .yml request', async () => {
    // The .yml surface declares YamlHttp.params, so it must behave the same way.
    const yaml: YamlRequest = {
      info: { name: 'r', type: 'http', seq: 1 },
      http: {
        method: 'GET',
        url: `http://127.0.0.1:${port}/u/:id`,
        params: [
          { name: 'id', value: '5', type: 'path' },
          { name: 'q', value: 'y', type: 'query' },
        ],
      },
    } as YamlRequest;

    const { url, options } = await buildFetchOptions(yaml, new Map());
    await fetch(url, options);
    expect(receivedUrl).toBe('/u/5?q=y');
  });
});
