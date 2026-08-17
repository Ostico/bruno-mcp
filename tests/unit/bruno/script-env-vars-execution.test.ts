/**
 * The environment layer reaching a script through the executor.
 *
 * The unit tests in script-env-vars.test.ts prove the sandbox keeps two stores
 * apart once both are handed to it. What is proved here is that the executor
 * hands over the narrower one at all, on each of the three seams that lead to a
 * script: an HTTP pre-request script, an HTTP post-response script, and a
 * transport pre-request script, which reaches the sandbox by its own path.
 *
 * `options.variables` is the environment layer for these runs — it is applied
 * over whatever an environment file supplied, before any `vars:pre-request`
 * entry or runtime write is merged on top.
 *
 * Mocking pattern follows request-executor-runtime-variables.test.ts for the
 * HTTP side and transport-pre-request.test.ts for the WebSocket side: the
 * transport module is spread so `handshakeHeaders` stays real and only the
 * entry point is replaced. Nothing is dialled.
 */

import { RequestExecutor } from '../../../src/bruno/request-executor';
// Opts out of the forking default: this lane has no built dist/ worker to fork.
import { TestRunner } from '../../../src/bruno/test-runner';
import { executeWebsocketRequest } from '../../../src/bruno/ws-transport';
import * as fs from 'node:fs/promises';

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

jest.mock('node:fs/promises');
const mockedFs = jest.mocked(fs);

jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
  ssrfRemediation: jest.fn().mockReturnValue('REMEDIATION_SENTINEL'),
}));

jest.mock('../../../src/bruno/ws-transport', () => ({
  ...jest.requireActual('../../../src/bruno/ws-transport'),
  executeWebsocketRequest: jest.fn(),
}));

const mockedWs = executeWebsocketRequest as jest.Mock;

/**
 * The two accessors, written onto the request's own header surface so the
 * answers can be read off what was sent rather than out of the sandbox.
 */
const READ_BOTH = `
        bru.setVar("token", "runtime-token");
        req.setHeader("X-Env", bru.getEnvVar("token"));
        req.setHeader("X-Any", bru.getVar("token"));
        req.setHeader("X-Declared", String(bru.hasEnvVar("token")));
`;

const HTTP_PRE_REQUEST_YAML = `
info:
  name: Fetch
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/profile"
runtime:
  scripts:
    - type: before-request
      code: |${READ_BOTH}`;

const HTTP_POST_RESPONSE_YAML = `
info:
  name: Fetch
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/profile"
runtime:
  scripts:
    - type: before-request
      code: |
        bru.setVar("token", "runtime-token");
    - type: after-response
      code: |
        test("getEnvVar answers from the environment", function() {
          expect(bru.getEnvVar("token")).to.equal("env-token");
        });
        test("getVar answers from the merged view", function() {
          expect(bru.getVar("token")).to.equal("runtime-token");
        });
`;

const WS_YAML = `
info:
  name: Socket
  type: websocket
  seq: 1
websocket:
  url: "ws://feed.test/room"
  message:
    - title: hello
      message:
        type: text
        data: '{"op":"subscribe"}'
runtime:
  scripts:
    - type: before-request
      code: |${READ_BOTH}`;

function createMockResponse(body: any, status = 200): Response {
  return {
    status,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    ok: status >= 200 && status < 300,
  } as unknown as Response;
}

function setupFs(files: Record<string, string>, requestFiles: string[]): void {
  mockedFs.readdir.mockImplementation(async (dirPath: any) => {
    const p = typeof dirPath === 'string' ? dirPath : dirPath.toString();
    if (p === '/test-collection') {
      return requestFiles.map((f) => ({
        name: f,
        isFile: () => true,
        isDirectory: () => false,
      })) as any;
    }
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });

  mockedFs.readFile.mockImplementation(async (filePath: any) => {
    const p = typeof filePath === 'string' ? filePath : filePath.toString();
    for (const [key, value] of Object.entries(files)) {
      if (p.endsWith(key) || p === key) {
        return value;
      }
    }
    const err = new Error(`ENOENT: no such file - ${p}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });

  mockedFs.stat.mockImplementation(async () => (
    { isDirectory: () => true, isFile: () => false } as any
  ));
}

/** A session that connected and said nothing, so verification has a response. */
const wsOutcome = () => ({
  result: {
    name: 'Socket',
    method: 'WS',
    url: 'ws://feed.test/room',
    status: 0,
    statusText: 'closed',
    duration_ms: 1,
    tests: [],
  },
  response: { status: 0, statusText: 'closed', headers: {}, body: [], rawBody: '[]' },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedWs.mockImplementation(async () => wsOutcome());
});

describe('the environment layer reaching a script', () => {
  it('reaches an HTTP pre-request script, unshadowed by a runtime write', async () => {
    setupFs({ 'Fetch.yml': HTTP_PRE_REQUEST_YAML }, ['Fetch.yml']);
    mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

    await RequestExecutor.executeCollection('/test-collection', {
      variables: { token: 'env-token' },
      scriptRunner: TestRunner,
    });

    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-Env']).toBe('env-token');
    expect(headers['X-Any']).toBe('runtime-token');
    expect(headers['X-Declared']).toBe('true');
  });

  it('reaches an HTTP post-response script', async () => {
    setupFs({ 'Fetch.yml': HTTP_POST_RESPONSE_YAML }, ['Fetch.yml']);
    mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

    const result = await RequestExecutor.executeCollection('/test-collection', {
      variables: { token: 'env-token' },
      scriptRunner: TestRunner,
    });

    const tests = result.groups[0]!.results[0].tests;
    expect(tests).toHaveLength(2);
    expect(tests.map((t) => t.status)).toEqual(['pass', 'pass']);
  });

  it('reaches a WebSocket pre-request script, which is seeded by its own path', async () => {
    setupFs({ 'Socket.yml': WS_YAML }, ['Socket.yml']);

    await RequestExecutor.executeCollection('/test-collection', {
      variables: { token: 'env-token' },
      scriptRunner: TestRunner,
    });

    expect(mockedWs).toHaveBeenCalledTimes(1);
    const overrides = mockedWs.mock.calls[0][0].headerOverrides as Record<string, string>;
    expect(overrides['X-Env']).toBe('env-token');
    expect(overrides['X-Any']).toBe('runtime-token');
    expect(overrides['X-Declared']).toBe('true');
  });
});
