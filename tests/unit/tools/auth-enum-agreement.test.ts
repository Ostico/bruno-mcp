/**
 * The auth modes the tool surface accepts, across every tool that accepts any.
 *
 * Four tools used to take an `auth.type`, and they disagreed: two accepted all
 * seven modes while a third stopped at `api-key` and rejected `digest` and
 * `inherit`. Nothing downstream justified the difference — every one of them
 * mapped its auth straight into the same `CreateRequestInput` and called the
 * same `createRequest` — so the same auth was accepted or refused depending only
 * on which tool you reached for, and `inherit`, which is what a request inside
 * an authenticated collection normally wants, was the one most likely to be
 * asked for. Three of those four tools have since been merged or deleted, which
 * removes the disagreement by removing the copies.
 *
 * The agreement test below is the guard: it finds every auth enum on the surface
 * by walking the schemas rather than naming them, so a tool added later is
 * covered without anyone remembering this file exists.
 */
import { z } from 'zod';

jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  const tools = new Map<string, { config: unknown; handler: unknown }>();
  return {
    McpServer: jest.fn().mockImplementation(() => ({
      registerTool: (name: string, config: unknown, handler: unknown) => {
        tools.set(name, { config, handler });
      },
      connect: jest.fn(),
      _tools: tools,
    })),
  };
});

jest.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: jest.fn(),
}));

import { BrunoMcpServer } from '../../../src/server';

/** Every auth mode the writer can be given, in the order the schemas list them. */
const ALL_AUTH_MODES = ['none', 'bearer', 'basic', 'oauth2', 'api-key', 'digest', 'inherit'];

/**
 * Collect the options of every `z.enum` reachable from a validator.
 *
 * Walks rather than indexes by path, so an enum that moves — into an array of
 * requests, behind an `.optional()`, one object deeper — is still found.
 */
function collectEnums(validator: unknown, seen = new Set<unknown>()): string[][] {
  if (validator == null || typeof validator !== 'object' || seen.has(validator)) return [];
  seen.add(validator);

  const def = (validator as { _def?: Record<string, unknown> })._def;
  if (!def) return [];

  const found: string[][] = [];
  if (def.typeName === 'ZodEnum' && Array.isArray(def.values)) {
    found.push(def.values as string[]);
  }

  for (const key of ['innerType', 'type', 'element', 'valueType', 'schema']) {
    found.push(...collectEnums(def[key], seen));
  }
  if (typeof def.shape === 'function') {
    for (const child of Object.values((def.shape as () => Record<string, unknown>)())) {
      found.push(...collectEnums(child, seen));
    }
  }
  return found;
}

/** Auth enums are the ones offering `bearer`; nothing else on the surface does. */
function authEnumsByTool(): Map<string, string[][]> {
  const server = new BrunoMcpServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any).server._tools as Map<string, { config: any }>;

  const byTool = new Map<string, string[][]>();
  for (const [name, { config }] of tools) {
    const enums: string[][] = [];
    for (const validator of Object.values(config.inputSchema ?? {})) {
      enums.push(...collectEnums(validator).filter((options) => options.includes('bearer')));
    }
    if (enums.length > 0) byTool.set(name, enums);
  }
  return byTool;
}

describe('auth modes accepted by the tool surface', () => {
  const byTool = authEnumsByTool();

  it('finds an auth enum on exactly the tool that takes auth', () => {
    expect([...byTool.keys()]).toEqual(['write_request']);
  });

  it('offers the same auth modes on every one of them', () => {
    const offered = Object.fromEntries(
      [...byTool].map(([name, enums]) => [name, enums.map((options) => [...options].sort())]),
    );
    // One entry per occurrence, not per tool: the batch array carries the same
    // auth field as the single-write shape, and every occurrence must offer the
    // same modes for the same reason the tools had to.
    const expected = Object.fromEntries(
      [...byTool].map(([name, enums]) => [
        name,
        enums.map(() => [...ALL_AUTH_MODES].sort()),
      ]),
    );

    expect(offered).toEqual(expected);
  });

  it.each(['digest', 'inherit'])('accepts %s', (mode) => {
    // These two were the missing pair. Asserted through the schema itself so the
    // test fails on the rejection, not on some downstream symptom of it.
    const [options] = byTool.get('write_request') ?? [];
    const parsed = z.enum(options as [string, ...string[]]).safeParse(mode);

    expect(parsed.success).toBe(true);
  });

  it('still rejects a mode the writer cannot spell', () => {
    const [options] = byTool.get('write_request') ?? [];

    expect(z.enum(options as [string, ...string[]]).safeParse('kerberos').success).toBe(false);
  });
});
