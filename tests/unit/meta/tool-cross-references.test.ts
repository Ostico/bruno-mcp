/**
 * A tool description must not name a tool that does not exist.
 *
 * The surface is the only documentation a caller reads, and it points at other
 * tools constantly ("get it from list_requests", "use remove_script to clear
 * it"). A rename that misses one of those leaves a description telling the
 * caller to call something the server will reject — and nothing else notices,
 * because the golden master records whatever text is there and the budget only
 * counts its length.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { BrunoMcpServer } from '../../../src/server';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Anything shaped like one of this server's tool names.
 *
 * Anchored on the verbs the tools actually start with rather than on snake_case
 * alone: the descriptions are full of snake_case that is not a tool name, and a
 * pattern loose enough to catch those would have to be exempted case by case
 * until it caught nothing.
 */
const TOOL_SHAPED = new RegExp(
  '\\b(?:create|modify|write|read|list|run|delete|move|add|remove|set|update|get)'
    + '_[a-z0-9_]+\\b',
  'g',
);

function namesMentioned(text: string): string[] {
  return [...text.matchAll(TOOL_SHAPED)].map((match) => match[0]);
}

/** Every string in a tool's description and anywhere inside its input schema. */
function proseOf(tool: { description?: string; inputSchema?: unknown }): string[] {
  const collected: string[] = [];
  if (typeof tool.description === 'string') collected.push(tool.description);

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'description' && typeof value === 'string') collected.push(value);
      else walk(value);
    }
  };
  walk(tool.inputSchema);

  return collected;
}

describe('cross-references between tool descriptions', () => {
  let tools: { name: string; description?: string; inputSchema?: unknown }[];

  beforeAll(async () => {
    const server = new BrunoMcpServer();
    const client = new Client({ name: 'cross-references', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    // Reaches the private McpServer because the public entry point binds stdio.
    await (server as any).server.connect(serverTransport);
    await client.connect(clientTransport);
    tools = (await client.listTools()).tools;
    await client.close();
  });

  it('names only tools the server actually registers', () => {
    const registered = new Set(tools.map((tool) => tool.name));
    const dangling: string[] = [];

    for (const tool of tools) {
      for (const text of proseOf(tool)) {
        for (const mentioned of namesMentioned(text)) {
          if (!registered.has(mentioned)) dangling.push(`${tool.name} names ${mentioned}`);
        }
      }
    }

    expect(dangling).toEqual([]);
  });

  // Without this the test above passes when the pattern matches nothing at all,
  // which is exactly what a small mistake in the pattern would produce.
  it('finds the cross-references that are actually there', () => {
    const mentioned = new Set(
      tools.flatMap((tool) => proseOf(tool)).flatMap(namesMentioned),
    );

    expect(mentioned.has('list_requests')).toBe(true);
    expect(mentioned.has('remove_script')).toBe(true);
    expect(mentioned.size).toBeGreaterThan(4);
  });
});

describe('namesMentioned', () => {
  it('reports a tool-shaped name that is not registered', () => {
    expect(namesMentioned('Get it from list_requests, then call modify_request.'))
      .toEqual(['list_requests', 'modify_request']);
  });

  it('ignores snake_case that is not tool-shaped', () => {
    expect(namesMentioned('form_data parts carry a content_type per part.')).toEqual([]);
  });
});
