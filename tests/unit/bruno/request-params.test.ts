/**
 * Query and path parameters, asserted against a request a server really received.
 *
 * Both formats declare them, both parsers populate them and both generators write
 * them back — and nothing applied them to the outgoing request. A `params:query`
 * entry never reached the query string and a `params:path` entry left `:id` in
 * the URL verbatim. It was reachable straight through the MCP surface:
 * write_request stores its `query` input, the file on disk looks right, and the
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

  it('substitutes a value containing separators raw, as Bruno does', async () => {
    // This request declares no `settings` block, so `encodeUrl` defaults to off
    // and the URL is sent byte for byte — which means a value carrying `&` or `=`
    // becomes additional parameters.
    //
    // That is upstream behaviour, not an oversight here. Bruno applies its URL
    // encoding as a pass over the finished string and splits query pairs on the
    // raw text, so a separator inside a variable's value is already its own pair
    // before any encoding happens: the transform normalizes, it does not
    // sanitize. Encoding per-value here instead would be *safer* but would send
    // different bytes than Bruno for the same collection, which is the one thing
    // a collection runner must not do.
    const seen = await sendBru(
      bru('/s', '\nparams:query {\n  q: {{needle}}\n}\n'),
      new Map([['needle', 'a&b=c']]),
    );
    expect(seen).toBe('/s?q=a&b=c');
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

  it('substitutes a path value containing a slash raw, as Bruno does', async () => {
    // A `/` in the value does add a path segment. Upstream splices path parameter
    // values in unencoded, and even with `encodeUrl` on the split into segments
    // happens after substitution, so the slash stays a separator either way.
    // Matching that is the point; the host cannot be affected, since substitution
    // only ever happens after the authority.
    const seen = await sendBru(
      bru('/u/:id', '\nparams:path {\n  id: {{v}}\n}\n'),
      new Map([['v', 'a/b']]),
    );
    expect(seen).toBe('/u/a/b');
  });

  it('substitutes an OData-style parameter inside parentheses', async () => {
    // Bruno recognises `EntitySet(:key)` in addition to a whole `:segment`, so a
    // lookbehind requiring `/` before the colon is not sufficient.
    const seen = await sendBru(bru('/Customers(:id)', '\nparams:path {\n  id: ALFKI\n}\n'));
    expect(seen).toBe('/Customers(ALFKI)');
  });

  it('leaves a :name inside a query value alone', async () => {
    // Upstream substitutes into url.pathname and reattaches the raw query string,
    // so a colon-prefixed token in a query value is not a path parameter.
    const seen = await sendBru(bru('/s?next=/u/:id', '\nparams:path {\n  id: 9\n}\n'));
    expect(seen).toBe('/s?next=/u/:id');
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

describe('a raw parameter value cannot redirect the request to another host', () => {
  // Substituting raw is Bruno parity, so it is worth pinning what raw canNOT do.
  // Path parameters only ever appear after the authority, so none of these change
  // the host — and the SSRF check downstream runs on the final URL either way.
  const hostile = ['@evil.com', '/evil.com', '//evil.com', '..%2F..%2Fetc', 'x?a=b', 'x#frag'];

  it.each(hostile)('keeps the host when a path value is %s', async (value) => {
    const yaml = bruFileToYamlRequest(
      parseBruRequest(bru('/u/:id', '\nparams:path {\n  id: {{v}}\n}\n')),
    );
    const { url } = await buildFetchOptions(yaml, new Map([['v', value]]));
    expect(new URL(url).host).toBe(`127.0.0.1:${port}`);
  });

  it.each(hostile)('keeps the host when a query value is %s', async (value) => {
    const yaml = bruFileToYamlRequest(
      parseBruRequest(bru('/s', '\nparams:query {\n  q: {{v}}\n}\n')),
    );
    const { url } = await buildFetchOptions(yaml, new Map([['v', value]]));
    expect(new URL(url).host).toBe(`127.0.0.1:${port}`);
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
