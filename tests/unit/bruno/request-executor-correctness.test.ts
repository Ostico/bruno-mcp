/**
 * Correctness fixes for the request executor.
 *
 *  A multipart form part disabled in the collection must NOT be sent.
 *        The .bru -> internal converter now carries the `enabled` flag and the
 *        multipart build loop skips any part with `enabled === false`.
 *  A failing pre-request script must HALT the request: the HTTP call must
 *        not fire and the result carries the script error.
 *  A variable set by the pre-request script must fill THIS request's own
 *        {{placeholders}} (re-substitution from the original template with the
 *        merged vars), while the script's req.set* mutations keep precedence.
 *
 * Mocking pattern follows tests/unit/bruno/request-executor.test.ts.
 */

import { buildFetchOptions, RequestExecutor } from '../../../src/bruno/request-executor';
import { generateBruRequest } from '../../../src/bruno/bru-parser';
import type { YamlRequest } from '../../../src/bruno/types';
import type { ScriptRunner } from '../../../src/bruno/sandbox-host';
import * as fs from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

jest.mock('node:fs/promises');
const mockedFs = jest.mocked(fs);

jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
  ssrfRemediation: jest.fn().mockReturnValue('REMEDIATION_SENTINEL'),
}));

jest.mock('../../../src/bruno/fetch-dispatcher', () => ({
  buildDispatcher: jest.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockResponse(body: unknown, status = 200): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  return {
    status,
    statusText: 'OK',
    headers,
    text: jest.fn().mockResolvedValue(
      typeof body === 'string' ? body : JSON.stringify(body),
    ),
    ok: status >= 200 && status < 300,
  } as unknown as Response;
}

function setupSingleFile(name: string, content: string): void {
  mockedFs.readdir.mockImplementation(async (dirPath: any) => {
    const p = typeof dirPath === 'string' ? dirPath : dirPath.toString();
    if (p === '/test-collection') {
      return [{ name, isFile: () => true, isDirectory: () => false }] as any;
    }
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
  mockedFs.readFile.mockImplementation(async (filePath: any) => {
    const p = typeof filePath === 'string' ? filePath : filePath.toString();
    if (p.endsWith(name) || p === name) return content;
    const err = new Error(`ENOENT: no such file - ${p}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
  mockedFs.stat.mockImplementation(async () => {
    return { isDirectory: () => true, isFile: () => false } as any;
  });
}

/**
 * A pre-request script runner seam that returns a fixed result, so the
 * executor's handling of pre-request output is exercised deterministically
 * without forking a sandbox. `runScript` is unused here (no after-response
 * scripts) but is part of the ScriptRunner contract.
 */
function mockScriptRunner(preResult: {
  variables?: Record<string, unknown>;
  mutations?: { url?: string; headers?: Record<string, string>; body?: unknown };
  error?: string;
}): ScriptRunner {
  return {
    runPreRequestScript: jest.fn().mockResolvedValue({
      variables: preResult.variables ?? {},
      mutations: preResult.mutations ?? {},
      ...(preResult.error !== undefined ? { error: preResult.error } : {}),
    }),
    runScript: jest.fn().mockResolvedValue({ results: [], variables: {} }),
  };
}

// ---------------------------------------------------------------------------
// Disabled multipart parts must not be sent
// ---------------------------------------------------------------------------

describe('Disabled multipart form parts are dropped', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValue(createMockResponse({ ok: true }));
  });

  it('buildFetchOptions omits a part with enabled === false from the FormData', async () => {
    const yaml: YamlRequest = {
      info: { name: 'Upload', type: 'http' },
      http: {
        method: 'POST',
        url: 'https://example.com/upload',
        body: {
          type: 'multipart-form',
          data: [
            { name: 'kept', value: 'yes', type: 'text', enabled: true },
            { name: 'dropped', value: 'no', type: 'text', enabled: false },
          ],
        },
      },
    };

    const { options } = await buildFetchOptions(yaml, new Map(), '/test-collection');
    const form = options.body as FormData;
    expect(form.get('kept')).toBe('yes');
    expect(form.get('dropped')).toBeNull();
    expect(form.has('dropped')).toBe(false);
  });

  it('a disabled part authored in a .bru file is carried as disabled and not sent', async () => {
    // Round-trip a .bru so the .bru -> internal converter path runs (it must
    // carry `enabled: false` through rather than silently re-enabling it).
    const bruContent = generateBruRequest({
      meta: { name: 'Upload', type: 'http', seq: 1 },
      http: { method: 'POST', url: 'https://example.com/upload', body: 'multipart-form', auth: 'none' },
      body: {
        type: 'form-data',
        formData: [
          { name: 'kept', value: 'yes', type: 'text', enabled: true },
          { name: 'dropped', value: 'no', type: 'text', enabled: false },
        ],
      },
    } as any);

    setupSingleFile('Upload.bru', bruContent);

    const result = await RequestExecutor.executeCollection('/test-collection', {
      requestPath: '/test-collection/Upload.bru',
    });

    expect(result.summary.total).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const form = mockFetch.mock.calls[0][1].body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('kept')).toBe('yes');
    expect(form.has('dropped')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A failing pre-request script halts the request
// ---------------------------------------------------------------------------

describe('Failing pre-request script halts before fetch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValue(createMockResponse({ ok: true }));
  });

  const YAML = `
info:
  name: Pre Fails
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.test/thing"
runtime:
  scripts:
    - type: before-request
      code: |
        throw new Error("boom");
`;

  it('does not fire the HTTP request and returns the script error', async () => {
    setupSingleFile('Pre Fails.yml', YAML);

    const result = await RequestExecutor.executeCollection('/test-collection', {
      requestPath: '/test-collection/Pre Fails.yml',
      scriptRunner: mockScriptRunner({ error: 'pre-request boom' }),
    });

    // The HTTP call must NOT fire.
    expect(mockFetch).not.toHaveBeenCalled();

    // The result carries the script error as a failure.
    const r = result.groups[0]!.results[0];
    expect(r.status).toBe(0);
    expect(r.error).toBe('pre-request boom');
    expect(r.url).toBe('https://api.test/thing');
    expect(r.name).toBe('Pre Fails');
    expect(r.method).toBe('GET');
  });

  it('redacts a secret query param in the halted result URL', async () => {
    const SECRET_YAML = `
info:
  name: Pre Fails Secret
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.test/thing?api_key=super-secret"
runtime:
  scripts:
    - type: before-request
      code: |
        throw new Error("boom");
`;
    setupSingleFile('Pre Fails Secret.yml', SECRET_YAML);

    const result = await RequestExecutor.executeCollection('/test-collection', {
      requestPath: '/test-collection/Pre Fails Secret.yml',
      scriptRunner: mockScriptRunner({ error: 'boom' }),
    });

    expect(mockFetch).not.toHaveBeenCalled();
    const r = result.groups[0]!.results[0];
    expect(r.error).toBe('boom');
    expect(r.url).toContain('api_key=REDACTED');
    expect(r.url).not.toContain('super-secret');
  });
});

// ---------------------------------------------------------------------------
// A pre-request setVar fills this request's own {{placeholders}}
// ---------------------------------------------------------------------------

describe('Pre-request variables fill the same request', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValue(createMockResponse({ ok: true }));
  });

  it('a var set in the pre-request script substitutes this request URL/header', async () => {
    const YAML = `
info:
  name: Uses Prevar
  type: http
  seq: 1
http:
  method: GET
  url: "https://{{host}}/path"
  headers:
    - name: X-Token
      value: "{{tok}}"
runtime:
  scripts:
    - type: before-request
      code: |
        bru.setVar("host", "api.example.com");
        bru.setVar("tok", "t123");
`;
    setupSingleFile('Uses Prevar.yml', YAML);

    const result = await RequestExecutor.executeCollection('/test-collection', {
      requestPath: '/test-collection/Uses Prevar.yml',
      scriptRunner: mockScriptRunner({ variables: { host: 'api.example.com', tok: 't123' } }),
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.example.com/path');
    expect(opts.headers['X-Token']).toBe('t123');

    // No unresolved-variable warning, since the vars now resolve.
    const r = result.groups[0]!.results[0];
    expect(r.warnings ?? []).not.toContain('unresolved variable: {{host}}');
    expect(r.warnings ?? []).not.toContain('unresolved variable: {{tok}}');
  });

  it('script req.set* mutations keep precedence over the re-substituted values', async () => {
    const YAML = `
info:
  name: Var And Mutate
  type: http
  seq: 1
http:
  method: POST
  url: "https://{{host}}/path"
  headers:
    - name: X-Token
      value: "{{tok}}"
  body:
    type: json
    data: '{"from":"template"}'
runtime:
  scripts:
    - type: before-request
      code: |
        bru.setVar("host", "api.example.com");
`;
    setupSingleFile('Var And Mutate.yml', YAML);

    const result = await RequestExecutor.executeCollection('/test-collection', {
      requestPath: '/test-collection/Var And Mutate.yml',
      scriptRunner: mockScriptRunner({
        variables: { host: 'api.example.com', tok: 'ignored-by-mutation' },
        mutations: {
          url: 'https://mutated.example.com/final',
          headers: { 'X-Token': 'mutated-token' },
          body: { from: 'mutation' },
        },
      }),
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    // Mutation wins over the re-substituted template value.
    expect(url).toBe('https://mutated.example.com/final');
    expect(opts.headers['X-Token']).toBe('mutated-token');
    expect(opts.body).toBe(JSON.stringify({ from: 'mutation' }));
    expect(result.groups[0]!.results[0].status).toBe(200);
  });

  it('applies req.set* mutations even when the script sets no variables (no re-substitution)', async () => {
    const YAML = `
info:
  name: Mutate Only
  type: http
  seq: 1
http:
  method: GET
  url: "https://original.test/x"
runtime:
  scripts:
    - type: before-request
      code: |
        req.setUrl("https://mutated.test/y");
`;
    setupSingleFile('Mutate Only.yml', YAML);

    const result = await RequestExecutor.executeCollection('/test-collection', {
      requestPath: '/test-collection/Mutate Only.yml',
      scriptRunner: mockScriptRunner({
        mutations: {
          url: 'https://mutated.test/y',
          headers: { 'X-Added': '1' },
          body: 'raw-string-body',
        },
      }),
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://mutated.test/y');
    expect(opts.headers['X-Added']).toBe('1');
    expect(opts.body).toBe('raw-string-body');
    expect(result.groups[0]!.results[0].status).toBe(200);
  });
});
