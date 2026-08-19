/**
 * The non-HTTP halves of `write_request`, checked at the layer the caller sees.
 *
 * The writer-level tests call `createRequest` directly, so they never touch the
 * zod schemas or the handler in front of them. Two things can only go wrong
 * here: the schema can refuse a shape the writer supports — `method` was a hard
 * requirement before this, so no WebSocket or gRPC request could be spelled at
 * all — and the handler can drop or rename a field on the way through. `kind` is
 * renamed deliberately (`websocket` on the wire, `ws` on disk), which is
 * precisely the kind of translation that silently stops happening.
 *
 * The cross-key refusals themselves (a method on a WebSocket request, a
 * `websocket` object on a gRPC one) live in the builder and are tested against
 * the real builder in tests/unit/bruno/websocket-authoring.test.ts and
 * tests/unit/bruno/grpc-authoring.test.ts. A zod `.refine()` would have hidden
 * the whole object from the tool-surface snapshot, so they are not schema rules.
 */
jest.mock('../../../src/bruno/request', () => ({
  createRequestBuilder: () => ({
    createRequest: jest.fn(),
    createCrudRequests: jest.fn(),
    updateRequest: jest.fn(),
  }),
}));
jest.mock('../../../src/bruno/workspace', () => ({
  createWorkspaceResolver: () => ({
    resolve: jest.fn(),
    resolveWorkspacePath: jest.fn(),
    getDefaultPath: jest.fn(),
    parseWorkspaceYaml: jest.fn(),
  }),
}));
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  const tools: Map<string, { config: unknown; handler: unknown }> = new Map();
  return {
    McpServer: jest.fn().mockImplementation(() => ({
      registerTool: jest.fn((name: string, config: unknown, handler: unknown) => {
        tools.set(name, { config, handler });
      }),
      connect: jest.fn(),
      _tools: tools,
    })),
  };
});
jest.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: jest.fn(),
}));

import { z } from 'zod';
import { BrunoMcpServer } from '../../../src/server';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function inputSchema(server: BrunoMcpServer, name: string): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any).server._tools.get(name);
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return tool.config.inputSchema;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolHandler(server: BrunoMcpServer, name: string): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any).server._tools.get(name).handler;
}

describe('the write_request schema for a WebSocket request', () => {
  let server: BrunoMcpServer;

  beforeEach(() => {
    jest.clearAllMocks();
    server = new BrunoMcpServer();
  });

  it('offers all three transports and refuses a fourth', () => {
    const kind = inputSchema(server, 'write_request').kind as z.ZodTypeAny;

    expect(kind.safeParse('http').success).toBe(true);
    expect(kind.safeParse('websocket').success).toBe(true);
    expect(kind.safeParse('grpc').success).toBe(true);
    expect(kind.safeParse('socketio').success).toBe(false);
  });

  it('lets a request omit the method, which it could not before', () => {
    // `method` was required, so kind "websocket" was unspellable whatever the
    // writer supported.
    const method = inputSchema(server, 'write_request').method as z.ZodTypeAny;

    expect(method.safeParse(undefined).success).toBe(true);
  });

  it('accepts a message described by content alone', () => {
    const websocket = inputSchema(server, 'write_request').websocket as z.ZodTypeAny;

    expect(websocket.safeParse({ messages: [{ content: 'ping' }] }).success).toBe(true);
  });

  it('accepts a titled, typed, deselected message', () => {
    // Deselection is refused for .bru by the builder, not here — the schema must
    // carry it through so the builder can say which dialect can record it.
    const websocket = inputSchema(server, 'write_request').websocket as z.ZodTypeAny;

    const parsed = websocket.safeParse({
      messages: [{ title: 'first', type: 'text', content: 'ping', selected: false }],
    });

    expect(parsed.success).toBe(true);
  });

  it('refuses a message with no content', () => {
    const websocket = inputSchema(server, 'write_request').websocket as z.ZodTypeAny;

    expect(websocket.safeParse({ messages: [{ title: 'first' }] }).success).toBe(false);
  });
});

describe('the write_request schema for a gRPC request', () => {
  let server: BrunoMcpServer;

  beforeEach(() => {
    jest.clearAllMocks();
    server = new BrunoMcpServer();
  });

  it('accepts all four RPC shapes and refuses an invented one', () => {
    // Only unary runs here, but Bruno writes all four, so authoring must be able
    // to spell a file Bruno can open.
    const grpc = inputSchema(server, 'write_request').grpc as z.ZodTypeAny;

    for (const methodType of ['unary', 'client-streaming', 'server-streaming', 'bidi-streaming']) {
      expect(grpc.safeParse({ methodType }).success).toBe(true);
    }
    expect(grpc.safeParse({ methodType: 'duplex' }).success).toBe(false);
  });

  it('accepts a message described by content alone', () => {
    const grpc = inputSchema(server, 'write_request').grpc as z.ZodTypeAny;

    expect(grpc.safeParse({ messages: [{ content: '{}' }] }).success).toBe(true);
  });

  it('refuses a message with no content', () => {
    const grpc = inputSchema(server, 'write_request').grpc as z.ZodTypeAny;

    expect(grpc.safeParse({ messages: [{ title: 'first' }] }).success).toBe(false);
  });

  it('offers no `selected` or `type` on a message, which gRPC has no place for', () => {
    // A caller who passes one would otherwise believe it reached the file.
    const grpc = inputSchema(server, 'write_request').grpc as z.ZodTypeAny;

    const parsed = grpc.safeParse({
      messages: [{ content: '{}', selected: false, type: 'json' }],
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data.messages[0]).toEqual({ content: '{}' });
  });
});

describe('what the write_request handler forwards for a WebSocket request', () => {
  let server: BrunoMcpServer;
  let createRequest: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    server = new BrunoMcpServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createRequest = (server as any).requestBuilder.createRequest as jest.Mock;
    createRequest.mockResolvedValue({ success: true, path: '/col/echo.bru' });
  });

  it('translates the wire name into the on-disk kind', async () => {
    await toolHandler(server, 'write_request')({
      collectionPath: '/col',
      name: 'Echo',
      kind: 'websocket',
      url: 'ws://example.com/socket',
    });

    expect(createRequest).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ws' }));
  });

  it('leaves an unstated kind unstated, so the builder picks the default', async () => {
    // Substituting 'http' here would work today and diverge the moment the
    // builder's default changes.
    await toolHandler(server, 'write_request')({
      collectionPath: '/col',
      name: 'Plain',
      method: 'GET',
      url: 'https://example.com/x',
    });

    expect(createRequest.mock.calls[0][0].kind).toBeUndefined();
  });

  it('forwards every field of every message', async () => {
    await toolHandler(server, 'write_request')({
      collectionPath: '/col',
      name: 'Echo',
      kind: 'websocket',
      url: 'ws://example.com/socket',
      websocket: {
        messages: [
          { title: 'first', type: 'text', content: 'ping', selected: true },
          { content: 'pong' },
        ],
      },
    });

    expect(createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        websocket: {
          messages: [
            { title: 'first', type: 'text', content: 'ping', selected: true },
            { content: 'pong' },
          ],
        },
      }),
    );
  });

  it('reports the builder’s refusal to the caller as an error', async () => {
    createRequest.mockResolvedValue({
      success: false,
      error: 'A WebSocket request has no HTTP method',
    });

    const response = await toolHandler(server, 'write_request')({
      collectionPath: '/col',
      name: 'Echo',
      kind: 'websocket',
      method: 'GET',
      url: 'ws://example.com/socket',
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('A WebSocket request has no HTTP method');
  });
});

describe('what the write_request handler forwards for a gRPC request', () => {
  let server: BrunoMcpServer;
  let createRequest: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    server = new BrunoMcpServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createRequest = (server as any).requestBuilder.createRequest as jest.Mock;
    createRequest.mockResolvedValue({ success: true, path: '/col/greet.bru' });
  });

  it('passes the kind through unrenamed, unlike websocket', async () => {
    await toolHandler(server, 'write_request')({
      collectionPath: '/col',
      name: 'Greet',
      kind: 'grpc',
      url: 'grpc://127.0.0.1:50051',
    });

    expect(createRequest).toHaveBeenCalledWith(expect.objectContaining({ kind: 'grpc' }));
  });

  it('forwards every gRPC field, including every field of every message', async () => {
    await toolHandler(server, 'write_request')({
      collectionPath: '/col',
      name: 'Greet',
      kind: 'grpc',
      url: 'grpc://127.0.0.1:50051',
      grpc: {
        method: '/greet.Greeter/SayHello',
        protoPath: 'protos/greet.proto',
        methodType: 'server-streaming',
        messages: [{ title: 'first', content: '{"name":"world"}' }, { content: '{}' }],
      },
    });

    expect(createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        grpc: {
          method: '/greet.Greeter/SayHello',
          protoPath: 'protos/greet.proto',
          methodType: 'server-streaming',
          messages: [{ title: 'first', content: '{"name":"world"}' }, { content: '{}' }],
        },
      }),
    );
  });

  it('forwards headers unchanged, leaving the builder to make them metadata', async () => {
    // The rename to metadata is a dialect concern, so it belongs where the dialect
    // is known; doing it here would write a metadata block for HTTP too.
    await toolHandler(server, 'write_request')({
      collectionPath: '/col',
      name: 'Greet',
      kind: 'grpc',
      url: 'grpc://127.0.0.1:50051',
      headers: { 'X-Authored': 'yes' },
    });

    expect(createRequest).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { 'X-Authored': 'yes' } }),
    );
  });

  it('reports a refused proto path to the caller as an error', async () => {
    createRequest.mockResolvedValue({
      success: false,
      error: 'protoPath resolves outside the collection',
    });

    const response = await toolHandler(server, 'write_request')({
      collectionPath: '/col',
      name: 'Greet',
      kind: 'grpc',
      url: 'grpc://127.0.0.1:50051',
      grpc: { protoPath: '../../etc/passwd' },
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('outside the collection');
  });
});
