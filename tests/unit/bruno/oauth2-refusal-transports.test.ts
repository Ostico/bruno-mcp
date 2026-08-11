/**
 * What a failed oauth2 token exchange does to a gRPC or WebSocket request.
 *
 * The HTTP side of this is in `request-executor-digest-oauth2.test.ts`. These two
 * kinds are worth their own file because they reach the wire through their own
 * transports, and the thing being proven is a negative: the transport is never
 * entered, so nothing is dialled and nothing is sent. A request whose file names
 * an identity must not quietly go out as nobody.
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RequestExecutor } from '../../../src/bruno/request-executor';
import { TestRunner } from '../../../src/bruno/test-runner';
import { executeGrpcRequest } from '../../../src/bruno/grpc-transport';
import { executeWebsocketRequest } from '../../../src/bruno/ws-transport';

const mockFetch = jest.fn();
(global as unknown as { fetch: unknown }).fetch = mockFetch;

jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockResolvedValue({ valid: true }),
  ssrfRemediation: jest.fn().mockReturnValue(''),
}));

// Spread the real modules: only the entry point is replaced, so the constants
// these files also export stay real for anything else that reads them.
jest.mock('../../../src/bruno/grpc-transport', () => ({
  ...jest.requireActual('../../../src/bruno/grpc-transport'),
  executeGrpcRequest: jest.fn(),
}));
jest.mock('../../../src/bruno/ws-transport', () => ({
  ...jest.requireActual('../../../src/bruno/ws-transport'),
  executeWebsocketRequest: jest.fn(),
}));

const mockedGrpc = executeGrpcRequest as jest.Mock;
const mockedWs = executeWebsocketRequest as jest.Mock;

beforeEach(() => jest.clearAllMocks());

/** A token endpoint that answers with an error instead of an access token. */
const tokenRefused = (): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ error: 'invalid_client' }),
  }) as unknown as Response;

const OAUTH2 = `  auth:
    type: oauth2
    grantType: client_credentials
    accessTokenUrl: "https://idp.test/token"
    clientId: id
    clientSecret: nope
`;

async function collection(name: string, content: string): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'oauth2-refusal-'));
  await fs.writeFile(join(root, name), content);
  return root;
}

const run = (root: string) =>
  RequestExecutor.executeCollection(root, { scriptRunner: TestRunner });

describe('a failed oauth2 exchange on a transport request', () => {
  it('refuses a grpc request without entering the transport', async () => {
    mockFetch.mockResolvedValue(tokenRefused());
    const root = await collection(
      'g.yml',
      `info:
  name: Streamer
  type: grpc
  seq: 1
grpc:
  url: grpc://localhost:50051
  method: /pkg.Svc/Method
  methodType: unary
${OAUTH2}`,
    );

    const result = await run(root);

    expect(mockedGrpc).not.toHaveBeenCalled();
    const refused = result.groups[0]!.results![0]!;
    expect(refused.status).toBe(0);
    expect(refused.method).toBe('GRPC');
    expect(refused.url).toContain('localhost:50051');
    expect(refused.error).toContain('invalid_client');
    expect(refused.error).toContain('was not sent');
    expect(result.summary.failed).toBe(1);
  });

  it('refuses a websocket request without opening a socket', async () => {
    mockFetch.mockResolvedValue(tokenRefused());
    const root = await collection(
      'w.yml',
      `info:
  name: Socket
  type: websocket
  seq: 1
websocket:
  url: ws://localhost:8080/feed
  message:
    - title: hello
      message:
        type: text
        data: '{"op":"subscribe"}'
${OAUTH2}`,
    );

    const result = await run(root);

    expect(mockedWs).not.toHaveBeenCalled();
    const refused = result.groups[0]!.results![0]!;
    expect(refused.status).toBe(0);
    expect(refused.method).toBe('WS');
    expect(refused.url).toContain('localhost:8080');
    expect(refused.error).toContain('invalid_client');
    expect(result.summary.failed).toBe(1);
  });
});
