/**
 * Tests for RequestExecutor — a variable whose value contains another
 * placeholder, at the layer the caller sees.
 *
 * The rules live in variable-preparation and are unit-tested there. What these
 * check is that a run actually applies them: that an environment variable built
 * out of other environment variables reaches the wire resolved, and that a value
 * captured from a response reaches it as text.
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

/** base_url is built from host, and api_key is a secret nothing should echo. */
const ENV_YAML = `
variables:
  - name: host
    value: "api.example.com"
  - name: base_url
    value: "https://{{host}}"
  - name: api_key
    value: "env-key-123"
`;

const PING_REQUEST_YAML = `
info:
  name: Ping
  type: http
  seq: 1
http:
  method: GET
  url: "{{base_url}}/v1/ping"
`;

/** Captures a response field that happens to look like a placeholder. */
const CAPTURE_REQUEST_YAML = `
info:
  name: Capture
  type: http
  seq: 1
http:
  method: GET
  url: "{{base_url}}/v1/echo"
runtime:
  scripts:
    - type: after-response
      code: |
        bru.setVar("echoed", res.getBody().echoed);
`;

const RELAY_REQUEST_YAML = `
info:
  name: Relay
  type: http
  seq: 2
http:
  method: GET
  url: "{{base_url}}/v1/relay"
  headers:
    - name: X-Echoed
      value: "{{echoed}}"
`;

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

describe('RequestExecutor — a variable built out of another variable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves an environment variable that references another one', async () => {
    setupFsReaddir(['Ping.yml']);
    setupFsReadFile({ 'Ping.yml': PING_REQUEST_YAML, 'dev.yml': ENV_YAML });
    setupFsStat(['/test-collection', '/test-collection/environments']);

    mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

    const result = await RequestExecutor.executeCollection('/test-collection', {
      environment: 'dev',
      scriptRunner: TestRunner,
    });

    expect(result.summary.total).toBe(1);
    // Not https://{{host}}/v1/ping, which is what one substitution pass leaves.
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.example.com/v1/ping');
  });

  it('sends a captured value that looks like a placeholder as text', async () => {
    setupFsReaddir(['Capture.yml', 'Relay.yml']);
    setupFsReadFile({
      'Capture.yml': CAPTURE_REQUEST_YAML,
      'Relay.yml': RELAY_REQUEST_YAML,
      'dev.yml': ENV_YAML,
    });
    setupFsStat(['/test-collection', '/test-collection/environments']);

    mockFetch
      .mockResolvedValueOnce(createMockResponse({ echoed: 'key={{api_key}}' }))
      .mockResolvedValueOnce(createMockResponse({ ok: true }));

    const result = await RequestExecutor.executeCollection('/test-collection', {
      environment: 'dev',
      scriptRunner: TestRunner,
    });

    expect(result.summary.total).toBe(2);
    // The response controlled this text. Expanding it would hand a response the
    // contents of an environment variable it was never given.
    const [, relayOptions] = mockFetch.mock.calls[1];
    expect(relayOptions.headers['X-Echoed']).toBe('key={{api_key}}');
    expect(relayOptions.headers['X-Echoed']).not.toContain('env-key-123');
  });
});
