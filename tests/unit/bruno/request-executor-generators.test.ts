/**
 * Tests for RequestExecutor — Bruno's generators (`{{$guid}}` and friends) at the
 * layer the caller sees.
 *
 * The table and the escaping rules live in dynamic-variables and are unit-tested
 * there. What these check is that a run applies them: that a generator in a URL,
 * a header or a body reaches the wire generated rather than literal, that a
 * generator producing newlines still leaves a JSON body parseable, and that none
 * of them is reported as an unresolved variable.
 *
 * Mocking pattern follows tests/unit/bruno/request-executor-vars.test.ts.
 */

import { RequestExecutor } from '../../../src/bruno/request-executor';
// Opts out of the forking default: this lane has no built dist/ worker to fork.
import { TestRunner } from '../../../src/bruno/test-runner';
import * as fs from 'node:fs/promises';

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

jest.mock('node:fs/promises');
const mockedFs = jest.mocked(fs);

jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
}));

function createMockResponse(body: unknown, status = 200): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  return {
    status,
    statusText: 'OK',
    headers,
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
    ok: status >= 200 && status < 300,
  } as unknown as Response;
}

function setupFsReaddir(files: string[]): void {
  mockedFs.readdir.mockImplementation(async (dirPath: any) => {
    const p = typeof dirPath === 'string' ? dirPath : dirPath.toString();
    if (p === '/test-collection') {
      return files.map((f) => ({
        name: f,
        isFile: () => true,
        isDirectory: () => false,
      })) as any;
    }
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
}

function setupFsReadFile(fileMap: Record<string, string>): void {
  mockedFs.readFile.mockImplementation(async (filePath: any) => {
    const p = typeof filePath === 'string' ? filePath : filePath.toString();
    for (const [key, value] of Object.entries(fileMap)) {
      if (p.endsWith(key) || p === key) {
        return value;
      }
    }
    const err = new Error(`ENOENT: no such file - ${p}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
}

function setupFsStat(existingPaths: string[]): void {
  mockedFs.stat.mockImplementation(async (filePath: any) => {
    const p = typeof filePath === 'string' ? filePath : filePath.toString();
    for (const existing of existingPaths) {
      if (p.endsWith(existing) || p === existing) {
        return { isDirectory: () => true, isFile: () => false } as any;
      }
    }
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

const ENV_YAML = `
variables:
  - name: host
    value: "api.example.com"
`;

const GUID_REQUEST_YAML = `
info:
  name: Guid
  type: http
  seq: 1
http:
  method: GET
  url: "https://{{host}}/v1/things/{{$guid}}"
  headers:
    - name: X-Request-Id
      value: "{{$guid}}"
`;

/** `randomLoremParagraphs` is the generator that reliably produces newlines. */
const LOREM_BODY_REQUEST_YAML = `
info:
  name: Lorem
  type: http
  seq: 1
http:
  method: POST
  url: "https://{{host}}/v1/notes"
  body:
    type: json
    data: |
      {"note": "{{$randomLoremParagraphs}}"}
`;

const TYPO_REQUEST_YAML = `
info:
  name: Typo
  type: http
  seq: 1
http:
  method: GET
  url: "https://{{host}}/v1/things/{{$gid}}"
`;

describe('RequestExecutor — generators', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('generates a value for a generator in a URL and in a header', async () => {
    setupFsReaddir(['Guid.yml']);
    setupFsReadFile({ 'Guid.yml': GUID_REQUEST_YAML, 'dev.yml': ENV_YAML });
    setupFsStat(['/test-collection', '/test-collection/environments']);

    mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

    const result = await RequestExecutor.executeCollection('/test-collection', {
      environment: 'dev',
      scriptRunner: TestRunner,
    });

    expect(result.summary.total).toBe(1);
    const [url, options] = mockFetch.mock.calls[0];
    // Not `.../things/{{$guid}}`, which is what leaving generators alone sends.
    expect(url).toMatch(new RegExp(`^https://api\\.example\\.com/v1/things/${UUID.source}$`));
    expect(options.headers['X-Request-Id']).toMatch(UUID);
    // Each occurrence generates its own value, so the header is not the path's.
    expect(options.headers['X-Request-Id']).not.toBe(String(url).split('/').pop());
  });

  it('reports no unresolved variable for a generator', async () => {
    setupFsReaddir(['Guid.yml']);
    setupFsReadFile({ 'Guid.yml': GUID_REQUEST_YAML, 'dev.yml': ENV_YAML });
    setupFsStat(['/test-collection', '/test-collection/environments']);

    mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

    const result = await RequestExecutor.executeCollection('/test-collection', {
      environment: 'dev',
      scriptRunner: TestRunner,
    });

    const warnings = result.groups[0]!.results[0]!.warnings ?? [];
    expect(warnings.filter((w: string) => w.includes('unresolved variable'))).toEqual([]);
  });

  it('still reports a keyword no generator answers to', async () => {
    setupFsReaddir(['Typo.yml']);
    setupFsReadFile({ 'Typo.yml': TYPO_REQUEST_YAML, 'dev.yml': ENV_YAML });
    setupFsStat(['/test-collection', '/test-collection/environments']);

    mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

    const result = await RequestExecutor.executeCollection('/test-collection', {
      environment: 'dev',
      scriptRunner: TestRunner,
    });

    expect(result.groups[0]!.results[0]!.warnings ?? []).toContain('unresolved variable: {{$gid}}');
  });

  it('keeps a JSON body parseable when a generator produces newlines', async () => {
    setupFsReaddir(['Lorem.yml']);
    setupFsReadFile({ 'Lorem.yml': LOREM_BODY_REQUEST_YAML, 'dev.yml': ENV_YAML });
    setupFsStat(['/test-collection', '/test-collection/environments']);

    mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

    const result = await RequestExecutor.executeCollection('/test-collection', {
      environment: 'dev',
      scriptRunner: TestRunner,
    });

    const [, options] = mockFetch.mock.calls[0];
    // Unescaped, the raw newline lands inside a JSON string and the server gets
    // a body it cannot parse — with a warning here saying so.
    expect(options.body).not.toContain('{{$');
    expect(options.body).toContain('\\n');
    expect(() => JSON.parse(options.body) as unknown).not.toThrow();
    expect((JSON.parse(options.body) as { note: string }).note).toMatch(/\n/);
    const warnings = result.groups[0]!.results[0]!.warnings ?? [];
    expect(warnings.filter((w: string) => w.includes('not valid json'))).toEqual([]);
  });
});
