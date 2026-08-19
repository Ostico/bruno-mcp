/**
 * A cap on the tool surface.
 *
 * The surface is sent in the cached prefix of every request, so a character
 * added to a field description is paid on every call for the life of that
 * description, not once per session. Nothing else in the suite notices growth:
 * the golden master proves the surface did not change *by accident*, and says
 * nothing about whether a deliberate change made it larger.
 *
 * Measured against a real client over a real transport rather than against the
 * zod registrations, because what a caller pays for is the JSON Schema the SDK
 * emits, not the validators it was derived from.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { BrunoMcpServer } from '../../../src/server';
import { surfaceMetrics, type SurfaceTool } from '../../../src/tools/surface-metrics';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The budget, in characters of `tools/list`.
 *
 * Measured at 64,920 on 2026-08-19, down from 79,525 before create_request and
 * modify_request became one write_request and before create_test_suite and
 * create_crud_requests were deleted. It only ever moves down: raising it
 * requires a deliberate edit in the same commit as the change that justifies it,
 * so the cost of a larger surface is argued in a review rather than discovered
 * later.
 */
const SURFACE_BUDGET = 65_000;

async function readSurface(): Promise<SurfaceTool[]> {
  const server = new BrunoMcpServer();
  const client = new Client({ name: 'surface-budget', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  // Reaches the private McpServer because the public entry point binds stdio.
  // Test-only, and the alternative is spawning a build.
  await (server as any).server.connect(serverTransport);
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  await client.close();

  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

describe('tool surface budget', () => {
  it('stays within the recorded budget, and reports the breakdown', async () => {
    const metrics = surfaceMetrics(await readSurface());

    // Printed so the compression work can read the number it is moving without
    // a second instrument that could disagree with this one.
    const expensive = Object.entries(metrics.perTool)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([name, chars]) => `${name} ${chars}`)
      .join(', ');
    // eslint-disable-next-line no-console
    console.log(
      `tool surface: ${metrics.total} chars`
        + ` (tool descriptions ${metrics.toolDescriptions},`
        + ` field prose ${metrics.fieldProse},`
        + ` structure ${metrics.structure});`
        + ` largest: ${expensive}`,
    );

    expect(metrics.total).toBeLessThanOrEqual(SURFACE_BUDGET);
  });

  it('splits the surface into prose and structure that add up', async () => {
    const metrics = surfaceMetrics(await readSurface());

    expect(metrics.total).toBe(
      metrics.toolDescriptions + metrics.fieldProse + metrics.structure,
    );
    expect(metrics.fieldProse).toBeGreaterThan(0);
    expect(metrics.structure).toBeGreaterThan(0);
  });
});

describe('surfaceMetrics', () => {
  it('counts a tool with neither a description nor a schema as two braces', () => {
    const metrics = surfaceMetrics([{ name: 'bare' }]);

    expect(metrics).toEqual({
      total: 2,
      toolDescriptions: 0,
      fieldProse: 0,
      structure: 2,
      perTool: { bare: 2 },
    });
  });

  it('counts nested descriptions wherever they appear, including inside arrays', () => {
    const metrics = surfaceMetrics([
      {
        name: 'nested',
        description: 'abcd',
        inputSchema: {
          type: 'object',
          properties: {
            outer: {
              description: 'xyz',
              anyOf: [{ type: 'string', description: 'ab' }, { type: 'number' }],
            },
          },
          required: ['outer'],
        },
      },
    ]);

    expect(metrics.toolDescriptions).toBe(4);
    expect(metrics.fieldProse).toBe(5);
  });

  it('walks a field named description instead of counting it', () => {
    const metrics = surfaceMetrics([
      {
        name: 'awkward',
        inputSchema: {
          properties: { description: { type: 'string', description: 'ab' } },
        },
      },
    ]);

    // 2 for the nested prose, and nothing for `properties.description` itself.
    expect(metrics.fieldProse).toBe(2);
  });

  it('ignores nulls and non-string description values', () => {
    const metrics = surfaceMetrics([
      {
        name: 'odd',
        inputSchema: { nothing: null, description: 42, flag: true, count: 7 },
      },
    ]);

    expect(metrics.fieldProse).toBe(0);
  });
});
