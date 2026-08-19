/**
 * The body a caller can hand each tool, checked at the layer the caller sees.
 *
 * The writer-level tests call `createRequest` directly and so never touch the
 * zod schemas — which is exactly where the defect lived: every layer beneath
 * supported a graphql or file body while the schema in front of them refused
 * one. A test that bypasses the schema cannot see that, so these go through the
 * registered tool schemas instead, and assert the parsed body reaches the
 * builder with its parts intact.
 */
jest.mock('../../../src/bruno/request', () => ({
  createRequestBuilder: () => ({
    createRequest: jest.fn(),
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

/** Every member of BodyType. The schemas must offer all of them, not a subset. */
const ALL_BODY_TYPES = [
  'none',
  'json',
  'text',
  'xml',
  'sparql',
  'graphql',
  'form-data',
  'multipart-form',
  'form-urlencoded',
  'file',
  'binary',
];

/** The tools that take a body, and where the body schema sits in each. */
const TOOLS = ['write_request'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolConfig(server: BrunoMcpServer, name: string): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any).server._tools.get(name);
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return tool.config;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolHandler(server: BrunoMcpServer, name: string): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any).server._tools.get(name).handler;
}

/** The body validator each tool exposes, unwrapped from wherever it lives. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bodySchemaOf(server: BrunoMcpServer, name: string): z.ZodTypeAny {
  const schema = toolConfig(server, name).inputSchema;
  if (schema.body) return schema.body as z.ZodTypeAny;
  // A batch item carries its body inside requests[] instead.
  const element = (schema.requests as z.ZodArray<z.ZodObject<z.ZodRawShape>>).element;
  return element.shape.body as z.ZodTypeAny;
}

describe('body types accepted by the tool schemas', () => {
  let server: BrunoMcpServer;

  beforeEach(() => {
    jest.clearAllMocks();
    server = new BrunoMcpServer();
  });

  describe.each(TOOLS)('%s', (tool) => {
    it.each(ALL_BODY_TYPES)('accepts a %s body', (type) => {
      const parsed = bodySchemaOf(server, tool).safeParse({ type });

      expect(parsed.success).toBe(true);
    });

    it('rejects a type the writers cannot spell', () => {
      expect(bodySchemaOf(server, tool).safeParse({ type: 'protobuf' }).success).toBe(false);
    });

    it('accepts graphql variables', () => {
      const parsed = bodySchemaOf(server, tool).safeParse({
        type: 'graphql',
        content: '{ a }',
        variables: '{"x": 1}',
      });

      expect(parsed.success).toBe(true);
    });

    it('accepts file parts', () => {
      const parsed = bodySchemaOf(server, tool).safeParse({
        type: 'file',
        files: [{ filePath: 'a.pdf', contentType: 'application/pdf', selected: false }],
      });

      expect(parsed.success).toBe(true);
    });

    it('accepts multipart parts', () => {
      // A tool could once name a multipart body and then not describe it.
      const parsed = bodySchemaOf(server, tool).safeParse({
        type: 'multipart-form',
        formData: [{ name: 'a', value: '1' }],
      });

      expect(parsed.success).toBe(true);
    });
  });

  // Not a second copy to keep in step: the array reuses the very instance the
  // top-level field is, which is also what keeps the array from re-sending the
  // whole body description. Everything asserted above therefore holds inside a
  // batch item too, and asserting the identity is what makes that inference safe.
  it('validates a batch item body with the same schema instance', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shape = (toolConfig(server, 'write_request').inputSchema as any);
    const itemBody = shape.requests._def.innerType.element.shape.body;

    expect(itemBody).toBe(shape.body);
  });
});

describe('a body reaches the builder with its parts', () => {
  let server: BrunoMcpServer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let createRequest: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    server = new BrunoMcpServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createRequest = (server as any).requestBuilder.createRequest as jest.Mock;
    createRequest.mockResolvedValue({ success: true, path: '/col/r.bru' });
  });

  it('forwards a graphql body with its variables from write_request', async () => {
    await toolHandler(server, 'write_request')({
      collectionPath: '/col',
      name: 'r',
      method: 'POST',
      url: 'https://example.com/x',
      body: { type: 'graphql', content: '{ a }', variables: '{"x": 1}' },
    });

    expect(createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { type: 'graphql', content: '{ a }', variables: '{"x": 1}' },
      }),
    );
  });

  it('forwards file parts from write_request', async () => {
    await toolHandler(server, 'write_request')({
      collectionPath: '/col',
      name: 'r',
      method: 'POST',
      url: 'https://example.com/x',
      body: { type: 'file', files: [{ filePath: 'a.pdf' }] },
    });

    expect(createRequest).toHaveBeenCalledWith(
      expect.objectContaining({ body: { type: 'file', files: [{ filePath: 'a.pdf' }] } }),
    );
  });

  it('forwards multipart parts from a batch item', async () => {
    // A tool once forwarded {type, content} only, so the parts were dropped on
    // the way and the body reached the writer as a bare string.
    await toolHandler(server, 'write_request')({
      collectionPath: '/col',
      requests: [
        {
          name: 'r',
          method: 'POST',
          url: 'https://example.com/x',
          body: { type: 'multipart-form', formData: [{ name: 'a', value: '1' }] },
        },
      ],
    });

    expect(createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          type: 'multipart-form',
          formData: [{ name: 'a', value: '1' }],
        }),
      }),
    );
  });
});
