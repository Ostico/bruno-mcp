/**
 * Golden master of the MCP tool surface.
 *
 * Written BEFORE server.ts was split into per-tool modules, and deliberately
 * not touched by that refactor: it exists to prove the split changed nothing a
 * client can observe.
 *
 * The rest of the suite reaches handlers by name and calls them directly, so it
 * would catch a tool that disappeared — every test for it would fail — but not
 * a tool whose *schema* drifted, because those tests bypass validation
 * entirely. The input schema is the contract a client actually sees over
 * `tools/list`, which made it the one part of the surface with no guard at all.
 *
 * Two layers, on purpose:
 *   - an explicit, ordered list of tool names, so a dropped or renamed tool
 *     fails with an obvious diff rather than a snapshot blob;
 *   - one snapshot per tool of its title, description and field-by-field schema
 *     shape *and prose*, which is too large to spell out but is exactly what
 *     must not move. Per tool rather than per surface, so a diff is readable and
 *     two branches touching different tools do not conflict.
 *
 * If a future change intends to alter the surface, updating the snapshot is the
 * right move — but it must be a deliberate, reviewed edit, never a reflexive
 * `jest -u`.
 */

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

import { BrunoMcpServer } from '../../../src/server';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Render a zod validator as a stable descriptor: its shape, then the prose it
 * carries. The prose is the majority of what a client receives, so leaving it
 * out would let a field's documentation — including its security warnings — be
 * rewritten or deleted without a diff for anyone to review.
 *
 * Reaches into `_def` because zod 3 exposes no public reflection API. That is
 * acceptable here and nowhere else: this is a test-only descriptor, zod is
 * pinned, and if its internals move the descriptor fails loudly rather than
 * silently reporting the wrong shape.
 */
function describeZod(type: any): string {
  const shape = describeZodShape(type);
  const description = type?._def?.description;
  return typeof description === 'string' ? `${shape} — ${description}` : shape;
}

/**
 * The shape half of the descriptor, without the prose attached at this level.
 *
 * Nested calls go back through `describeZod`, not through this function, so a
 * description on an inner type is recorded too — `z.string().describe(…)`
 * wrapped in `.optional()` carries its prose on the inner string.
 */
function describeZodShape(type: any): string {
  const def = type?._def;
  if (!def) return 'unknown';
  switch (def.typeName) {
    case 'ZodOptional':
      return `${describeZod(def.innerType)}?`;
    case 'ZodNullable':
      return `${describeZod(def.innerType)}|null`;
    case 'ZodDefault':
      return `${describeZod(def.innerType)} = ${JSON.stringify(def.defaultValue())}`;
    case 'ZodString':
      return 'string';
    case 'ZodNumber':
      return 'number';
    case 'ZodBoolean':
      return 'boolean';
    case 'ZodArray':
      return `${describeZod(def.type)}[]`;
    case 'ZodEnum':
      return `enum(${[...def.values].join('|')})`;
    case 'ZodLiteral':
      return `literal(${JSON.stringify(def.value)})`;
    case 'ZodUnion':
      return `union(${def.options.map(describeZod).join(' | ')})`;
    case 'ZodRecord':
      return `record<${describeZod(def.valueType)}>`;
    case 'ZodObject':
      return `{ ${Object.entries(def.shape())
        .map(([k, v]) => `${k}: ${describeZod(v)}`)
        .sort()
        .join('; ')} }`;
    default:
      return String(def.typeName);
  }
}

interface ToolDescriptor {
  title: unknown;
  description: unknown;
  schema: Record<string, string>;
}

function readSurface(): Map<string, ToolDescriptor> {
  const server = new BrunoMcpServer();
  const tools = (server as any).server._tools as Map<string, { config: any }>;
  const surface = new Map<string, ToolDescriptor>();
  for (const [name, { config }] of tools) {
    const schema: Record<string, string> = {};
    for (const [field, validator] of Object.entries(config.inputSchema ?? {})) {
      schema[field] = describeZod(validator);
    }
    surface.set(name, { title: config.title, description: config.description, schema });
  }
  return surface;
}

/** The 20 tools the server registers, in registration order (setupTools). */
const EXPECTED_TOOLS = [
  'create_collection',
  'create_environment',
  'update_environment',
  'set_environment_variable',
  'remove_environment_variable',
  'write_request',
  'move_request',
  'add_test_script',
  'remove_script',
  'delete_request',
  'create_test_suite',
  'create_crud_requests',
  'list_collections',
  'list_requests',
  'get_collection_stats',
  'run_collection',
  'read_request',
  'read_environment',
  'unregister_collection',
  'delete_collection',
];

describe('MCP tool surface contract', () => {
  const surface = readSurface();

  it('registers exactly the expected tools, in the expected order', () => {
    expect([...surface.keys()]).toEqual(EXPECTED_TOOLS);
  });

  // Derived, not a literal: the ordered list above already carries the count,
  // and two sources of the same number disagree the moment one tool moves.
  it('registers exactly as many tools as the expected list names', () => {
    expect(surface.size).toBe(EXPECTED_TOOLS.length);
  });

  // Reported as one map per assertion so a failure names the offending tool
  // instead of just saying "expected true".
  it('gives every tool a title and a non-empty description', () => {
    const described = Object.fromEntries(
      [...surface].map(([name, t]) => [
        name,
        typeof t.title === 'string' && t.title.length > 0
          && typeof t.description === 'string' && t.description.length > 0,
      ]),
    );
    expect(described).toEqual(Object.fromEntries(EXPECTED_TOOLS.map((n) => [n, true])));
  });

  // Field descriptions are the majority of the bytes a client receives, so a
  // golden master that records only the tool-level description can watch a
  // security warning be deleted from a field and stay green.
  it('records field descriptions, not only tool descriptions', () => {
    const created = surface.get('write_request');
    expect(JSON.stringify(created?.schema)).toContain('Absolute path to existing collection');
  });

  it('gives every tool a non-empty input schema', () => {
    const populated = Object.fromEntries(
      [...surface].map(([name, t]) => [name, Object.keys(t.schema).length > 0]),
    );
    expect(populated).toEqual(Object.fromEntries(EXPECTED_TOOLS.map((n) => [n, true])));
  });

  // One snapshot per tool rather than one for the whole surface. A single blob
  // makes every change to any tool a diff against the same 25K literal, which
  // is both unreviewable and a guaranteed conflict between two branches that
  // touched different tools.
  it.each([...EXPECTED_TOOLS])('matches the recorded surface for %s', (name) => {
    expect(surface.get(name)).toMatchSnapshot(name);
  });
});
