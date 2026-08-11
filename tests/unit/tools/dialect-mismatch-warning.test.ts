/**
 * A request whose extension disagrees with its collection's dialect, across every
 * tool surface that can meet one.
 *
 * The decision this pins is warn-and-operate, in both directions: Bruno reads only
 * the extension its root manifest declares, so an off-dialect request is a file
 * sitting in a directory as far as Bruno is concerned — but refusing to touch it
 * would leave the caller unable to perform the repair, which is a rename of the
 * very file being warned about.
 *
 * Everything here runs against real manifests on disk. The existing coverage of
 * this path mocks `detectFormat` and `findCollectionRoot`, which proves the wiring
 * downstream of a detection result but not that a real `bruno.json` produces one:
 * three fixtures in this repo declared their collection with a `collection.yml`,
 * which is not a manifest either detector recognises, so they were silently
 * getting the no-marker path — where the dialect warning cannot fire at all.
 */

jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  const tools: Map<string, { config: unknown; handler: Function }> = new Map();
  return {
    McpServer: jest.fn().mockImplementation(() => ({
      registerTool: jest.fn((name: string, config: unknown, handler: Function) => {
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

import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { BrunoMcpServer } from '../../../src/server';
import { createCollectionManager } from '../../../src/bruno/collection';
import { createRequestBuilder } from '../../../src/bruno/request';
import { resolveRequestFile } from '../../../src/tools/tool-path';

/* eslint-disable @typescript-eslint/no-explicit-any */

const server = new BrunoMcpServer();

function getHandler(toolName: string): Function {
  const tool = (server as any).server._tools.get(toolName);
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);
  return tool.handler;
}

const listRequests = getHandler('list_requests');
const collectionStats = getHandler('get_collection_stats');

/** Everything after the document block: the warnings, if any were emitted. */
function warningsOf(result: any): string {
  return (result.content as { text: string }[]).slice(1).map((block) => block.text).join('\n');
}

type Format = 'bru' | 'yaml';

/**
 * A real collection with a real manifest — `bruno.json` or `opencollection.yml`,
 * whichever the format calls for — written by the same code a caller's
 * `create_collection` runs.
 */
async function collection(label: string, format: Format): Promise<string> {
  const tmp = await fs.mkdtemp(join(tmpdir(), `dialect-${label}-${format}-`));
  const created = await createCollectionManager().createCollection({
    name: 'Mixed',
    outputPath: tmp,
    format,
  });
  if (!created.success) throw new Error(`collection setup failed: ${created.error}`);
  return join(tmp, 'Mixed');
}

/**
 * The bytes of a request in the given dialect, taken from our own writer.
 *
 * An off-dialect file has to be written by hand — the create path derives the
 * extension from the manifest and so cannot produce one — but its *contents*
 * should be a real request of the other dialect rather than something invented
 * here, or a listing that failed to parse would look like a dialect finding.
 */
async function requestBytes(dialect: Format): Promise<string> {
  const donor = await collection('donor', dialect);
  const created = await createRequestBuilder().createRequest({
    collectionPath: donor,
    name: 'Off',
    method: 'GET',
    url: 'https://example.test/off',
    sequence: 1,
  });
  if (!created.success) throw new Error(`donor request failed: ${created.error}`);
  return fs.readFile(created.path as string, 'utf-8');
}

/** A collection of one dialect holding one request file of the other. */
async function mixedCollection(label: string, format: Format): Promise<{
  root: string;
  offDialect: string;
}> {
  const root = await collection(label, format);
  const other: Format = format === 'yaml' ? 'bru' : 'yaml';
  const offDialect = join(root, other === 'yaml' ? 'off.yml' : 'off.bru');
  await fs.writeFile(offDialect, await requestBytes(other));
  return { root, offDialect };
}

describe('resolveRequestFile, against real manifests', () => {
  it('accepts a .yml request in a bruno.json collection and says Bruno cannot see it', async () => {
    const { offDialect } = await mixedCollection('resolve', 'bru');

    const resolved = await resolveRequestFile(offDialect, 'filePath');

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // The dialect follows the file: writing `.bru` text into a file named `.yml`
    // would destroy it, whatever the collection says.
    expect(resolved.format).toBe('yaml');
    expect(resolved.warnings).toHaveLength(1);
    expect(resolved.warnings[0]).toContain('rename them to ".bru"');
    expect(resolved.warnings[0]).toContain(offDialect);
  });

  it('accepts a .bru request in an opencollection.yml collection, mirroring the warning', async () => {
    const { offDialect } = await mixedCollection('resolve', 'yaml');

    const resolved = await resolveRequestFile(offDialect, 'filePath');

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.format).toBe('bru');
    expect(resolved.warnings).toHaveLength(1);
    expect(resolved.warnings[0]).toContain('rename them to ".yml"');
  });

  it.each<[Format, string]>([['bru', 'in.bru'], ['yaml', 'in.yml']])(
    'says nothing about a matching %s request',
    async (format, name) => {
      const root = await collection('match', format);
      const filePath = join(root, name);
      await fs.writeFile(filePath, await requestBytes(format));

      const resolved = await resolveRequestFile(filePath, 'filePath');

      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.format).toBe(format);
      expect(resolved.warnings).toEqual([]);
    },
  );

  it('warns about the extension, not the dialect, for .yaml in a yaml collection', async () => {
    const root = await collection('yaml-ext', 'yaml');
    const filePath = join(root, 'odd.yaml');
    await fs.writeFile(filePath, await requestBytes('yaml'));

    const resolved = await resolveRequestFile(filePath, 'filePath');

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.format).toBe('yaml');
    expect(resolved.warnings).toHaveLength(1);
    expect(resolved.warnings[0]).toContain('do not recognise');
    expect(resolved.warnings[0]).not.toContain('dialect does not read');
  });

  it('gives only the dialect warning for .yaml in a bru collection', async () => {
    // Both faults apply, and they contradict each other: the `.yaml` warning says
    // rename to `.yml`, which in a `.bru` collection leaves the file just as
    // invisible. The dialect is the stronger claim, so it takes the file.
    const root = await collection('yaml-in-bru', 'bru');
    const filePath = join(root, 'odd.yaml');
    await fs.writeFile(filePath, await requestBytes('yaml'));

    const resolved = await resolveRequestFile(filePath, 'filePath');

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.warnings).toHaveLength(1);
    expect(resolved.warnings[0]).toContain('rename them to ".bru"');
  });

  it('refuses a request with no manifest above it, having nothing to resolve against', async () => {
    const orphan = await fs.mkdtemp(join(tmpdir(), 'dialect-orphan-'));
    const filePath = join(orphan, 'lonely.bru');
    await fs.writeFile(filePath, await requestBytes('bru'));

    const resolved = await resolveRequestFile(filePath, 'filePath');

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.message).toContain('no opencollection.yml or bruno.json');
  });
});

describe('the tools that only enumerate requests', () => {
  // These walk both dialects and used to report neither the mismatch nor its
  // consequence, which is the surface where it matters most: every other tool's
  // description sends the caller here to find out which requests exist.
  it.each<[Format]>([['bru'], ['yaml']])(
    'list_requests names the off-dialect file in a %s collection',
    async (format) => {
      const { root, offDialect } = await mixedCollection('list', format);

      const result = await listRequests({ collectionPath: root });

      const warnings = warningsOf(result);
      expect(warnings).toContain('dialect does not read');
      expect(warnings).toContain(offDialect);
      // And the file is still listed: the warning is about Bruno, not about us.
      expect(result.content[0].text).toContain(offDialect);
    },
  );

  it('list_requests says nothing when every request matches the collection', async () => {
    const root = await collection('list-clean', 'bru');
    await fs.writeFile(join(root, 'fine.bru'), await requestBytes('bru'));

    const result = await listRequests({ collectionPath: root });

    expect(warningsOf(result)).toBe('');
  });

  it('get_collection_stats warns that its counts disagree with Bruno', async () => {
    const { root, offDialect } = await mixedCollection('stats', 'bru');

    const result = await collectionStats({ collectionPath: root });

    const warnings = warningsOf(result);
    expect(warnings).toContain('dialect does not read');
    expect(warnings).toContain(offDialect);
    // The count includes it, which is exactly why the warning is needed.
    expect(JSON.parse(result.content[0].text).totalRequests).toBe(1);
  });

  it('get_collection_stats says nothing about a collection of one dialect', async () => {
    const root = await collection('stats-clean', 'yaml');
    await fs.writeFile(join(root, 'fine.yml'), await requestBytes('yaml'));

    const result = await collectionStats({ collectionPath: root });

    expect(warningsOf(result)).toBe('');
  });
});
