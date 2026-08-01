/**
 * `settings.encodeUrl` end to end, asserted on the exact URL string handed to
 * fetch.
 *
 * That is the right layer for this one. A real server cannot distinguish some of
 * these cases, because the HTTP client normalizes a raw space on its way out —
 * the difference this setting controls is in the bytes of the URL we hand over,
 * so that is what these tests read.
 *
 * The transform must sit where Bruno puts it: on the finished URL, after variable
 * interpolation, after path parameters, and after a pre-request script has had
 * its chance to rewrite the URL.
 */
import { RequestExecutor } from '../../../src/bruno/request-executor';
// Opts out of the forking default: this lane has no built dist/ worker to fork.
import { TestRunner } from '../../../src/bruno/test-runner';
import * as fs from 'node:fs/promises';

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

jest.mock('node:fs/promises');
const mockedFs = jest.mocked(fs);

// SSRF validation is exercised in its own suites; stub it so these tests can use
// example.com without network policy interfering.
jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockResolvedValue({ valid: true }),
  ssrfRemediation: jest.fn().mockReturnValue(''),
}));

function mockResponse(body: unknown = { ok: true }) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Map(),
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function setupCollection(files: Record<string, string>): void {
  mockedFs.readdir.mockImplementation(async (dirPath: any) => {
    if (String(dirPath) === '/c') {
      return Object.keys(files).map((name) => ({
        name,
        isFile: () => true,
        isDirectory: () => false,
      })) as any;
    }
    const err = new Error(`ENOENT ${String(dirPath)}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
  mockedFs.readFile.mockImplementation(async (filePath: any) => {
    const p = String(filePath);
    for (const [name, content] of Object.entries(files)) {
      if (p.endsWith(name)) return content;
    }
    const err = new Error(`ENOENT ${p}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
  mockedFs.stat.mockImplementation(async (filePath: any) => {
    const p = String(filePath);
    if (p.endsWith('/c')) return { isDirectory: () => true, isFile: () => false } as any;
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
}

/** Run a one-request collection and report the URL string fetch received. */
async function sentUrl(files: Record<string, string>): Promise<string> {
  setupCollection(files);
  mockFetch.mockResolvedValue(mockResponse());
  await RequestExecutor.executeCollection('/c', { scriptRunner: TestRunner });
  return mockFetch.mock.calls[0][0] as string;
}

const yml = (httpBody: string, settings = ''): string => `
info:
  name: R
  type: http
  seq: 1
http:
  method: GET
${httpBody}${settings}
`;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('the setting decides whether the URL is encoded', () => {
  it('encodes when settings.encodeUrl is true', async () => {
    const url = await sentUrl({
      'R.yml': yml('  url: "https://e.com/a b"', '\nsettings:\n  encodeUrl: true'),
    });
    expect(url).toBe('https://e.com/a%20b');
  });

  it('sends the URL byte for byte when settings.encodeUrl is false', async () => {
    const url = await sentUrl({
      'R.yml': yml('  url: "https://e.com/a b"', '\nsettings:\n  encodeUrl: false'),
    });
    expect(url).toBe('https://e.com/a b');
  });

  it('sends the URL raw when there is no settings block at all', async () => {
    // Upstream reads settings?.encodeUrl, gets undefined, and does not encode.
    const url = await sentUrl({ 'R.yml': yml('  url: "https://e.com/a b"') });
    expect(url).toBe('https://e.com/a b');
  });

  it('sends a Bruno-authored .bru request raw when its block sets only a timeout', async () => {
    // The shape that was actually diverging in the field. This file is one Bruno
    // wrote; the old rule encoded its URL while Bruno sends it raw, so the same
    // collection behaved differently depending on which tool ran it.
    const bru = `meta {
  name: R
  type: http
  seq: 1
}

get {
  url: https://e.com/a b
  auth: none
}

settings {
  timeout: 20000
}
`;
    const url = await sentUrl({ 'R.bru': bru });

    expect(url).toBe('https://e.com/a b');
  });

  it('still encodes a .bru request that asks for it', async () => {
    const bru = `meta {
  name: R
  type: http
  seq: 1
}

get {
  url: https://e.com/a b
  auth: none
}

settings {
  encodeUrl: true
}
`;
    const url = await sentUrl({ 'R.bru': bru });

    expect(url).toBe('https://e.com/a%20b');
  });

  it('encodes a .yml request whose settings block omits encodeUrl', async () => {
    // Present-but-silent means ON for this dialect, and only this one. Upstream's
    // .yml reader says so outright — parseHttpRequest.ts:
    //
    //   if (typeof settings.encodeUrl === 'boolean') { ... } else { encodeUrl = true }
    //
    // The .bru side is the opposite, and the two tests below the .yml ones cover
    // it. The asymmetry is upstream's, not ours.
    const url = await sentUrl({
      'R.yml': yml('  url: "https://e.com/a b"', '\nsettings:\n  timeout: 5000'),
    });
    expect(url).toBe('https://e.com/a%20b');
  });
});

describe('what gets encoded', () => {
  it('encodes a query value that arrived through a parameter', async () => {
    const url = await sentUrl({
      'R.yml': yml(
        '  url: "https://e.com/s"\n  params:\n    - name: q\n      value: "a&b"\n      type: query',
        '\nsettings:\n  encodeUrl: true',
      ),
    });
    // The pair split happens before encoding, so this stays two parameters — the
    // transform normalizes, it does not sanitize.
    expect(url).toBe('https://e.com/s?q=a&b');
  });

  it('encodes a space in a parameter value once', async () => {
    const url = await sentUrl({
      'R.yml': yml(
        '  url: "https://e.com/s"\n  params:\n    - name: q\n      value: "a b"\n      type: query',
        '\nsettings:\n  encodeUrl: true',
      ),
    });
    expect(url).toBe('https://e.com/s?q=a%20b');
  });

  it('leaves the port colon alone on a schemeless URL', async () => {
    // A scheme is prepended before encoding, or host:port would become
    // host%3Aport and resolve to a nonsense host.
    const url = await sentUrl({
      'R.yml': yml('  url: "localhost:6000/a b"', '\nsettings:\n  encodeUrl: true'),
    });
    expect(url).toBe('http://localhost:6000/a%20b');
  });
});

describe('ordering', () => {
  it('encodes the URL a pre-request script rewrote, not the one it replaced', async () => {
    // Bruno applies the transform after scripts run. If it ran earlier, a script
    // that sets a URL needing encoding would bypass the setting entirely.
    const url = await sentUrl({
      'R.yml': `
info:
  name: R
  type: http
  seq: 1
http:
  method: GET
  url: "https://e.com/original"
settings:
  encodeUrl: true
runtime:
  scripts:
    - type: before-request
      code: |
        req.setUrl("https://e.com/from script");
`,
    });
    expect(url).toBe('https://e.com/from%20script');
  });
});

describe('the .bru format reaches the same behaviour', () => {
  it('honours a settings block authored in a .bru file', async () => {
    // This only works because the .bru-to-executor translation forwards settings.
    const url = await sentUrl({
      'R.bru': `meta {
  name: R
  type: http
  seq: 1
}

get {
  url: https://e.com/a b
  body: none
  auth: none
}

settings {
  encodeUrl: true
}
`,
    });
    expect(url).toBe('https://e.com/a%20b');
  });
});
