/**
 * Taking a collection back out: the registry entry, and the collection itself.
 *
 * Nothing in the toolset could remove either, which is why a mistyped path was
 * permanent from inside the server and why a registry fills up with entries whose
 * directories are gone. These go through the registered tools against real
 * directories and real workspace files, because what is under test is what the
 * two ends do together.
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

import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrunoMcpServer } from '../../../src/server';
import { WorkspaceResolver } from '../../../src/bruno/workspace';

const EMPTY_WORKSPACE = 'opencollection: 1.0.0\ninfo:\n  name: "W"\n  type: workspace\n\ncollections:\n';

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolHandler(server: BrunoMcpServer, name: string): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any).server._tools.get(name).handler;
}

let server: BrunoMcpServer;
let dir: string;
let workspacePath: string;

beforeEach(async () => {
  jest.clearAllMocks();
  server = new BrunoMcpServer();
  dir = await mkdtemp(join(tmpdir(), 'collection-lifecycle-'));
  workspacePath = join(dir, 'workspace.yml');
  await writeFile(workspacePath, EMPTY_WORKSPACE);
});

async function create(args: Record<string, unknown> = {}): Promise<ToolResult> {
  return await toolHandler(server, 'create_collection')({
    name: 'Doomed',
    outputPath: dir,
    format: 'yaml',
    workspacePath,
    ...args,
  }) as ToolResult;
}

function unregister(args: Record<string, unknown> = {}): Promise<ToolResult> {
  return toolHandler(server, 'unregister_collection')({
    collectionPath: join(dir, 'Doomed'),
    workspacePath,
    ...args,
  }) as Promise<ToolResult>;
}

function remove(args: Record<string, unknown> = {}): Promise<ToolResult> {
  return toolHandler(server, 'delete_collection')({
    collectionPath: join(dir, 'Doomed'),
    confirm: true,
    workspacePath,
    ...args,
  }) as Promise<ToolResult>;
}

describe('unregistering a collection', () => {
  it('takes the entry out and leaves the directory where it is', async () => {
    await create();
    expect(await readFile(workspacePath, 'utf-8')).toContain('name: "Doomed"');

    const result = await unregister();

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('Unregistered "Doomed"');
    expect(result.content[0]!.text).toContain('files are untouched');
    expect(await readFile(workspacePath, 'utf-8')).toBe(EMPTY_WORKSPACE);
    // The point of having this as well as delete_collection: the collection is
    // still on disk and still usable by path.
    await expect(access(join(dir, 'Doomed', 'opencollection.yml'))).resolves.toBeUndefined();
  });

  it('says there was nothing to remove rather than inventing a failure', async () => {
    const result = await unregister({ collectionPath: join(dir, 'Never registered') });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('Nothing to remove');
    expect(await readFile(workspacePath, 'utf-8')).toBe(EMPTY_WORKSPACE);
  });

  it('falls back to the path when the entry carries no name', async () => {
    // A registry the app or a hand edit wrote without a name still identifies a
    // collection by its path, and the report has to say which one went.
    await writeFile(workspacePath, `${EMPTY_WORKSPACE}  - path: "${join(dir, 'Doomed')}"\n`);

    const result = await unregister();

    expect(result.content[0]!.text).toContain(`Unregistered "${join(dir, 'Doomed')}"`);
  });

  it('is an error when the registry cannot be edited a line at a time', async () => {
    const flow = join(dir, 'flow.yml');
    await writeFile(flow, `collections: [{name: "Doomed", path: "${join(dir, 'Doomed')}"}]\n`);

    const result = await unregister({ workspacePath: flow });

    // Unlike create_collection, editing the registry is the whole of what this
    // call does, so a registry it cannot edit is a failed call.
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Could not unregister it');
  });

  it('uses the workspace list_collections would read when none is named', async () => {
    const fromEnv = join(dir, 'from-env.yml');
    await writeFile(fromEnv, EMPTY_WORKSPACE);
    const previous = process.env.BRUNO_WORKSPACE_PATH;
    process.env.BRUNO_WORKSPACE_PATH = fromEnv;

    try {
      await create({ workspacePath: undefined });
      const result = await unregister({ workspacePath: undefined });

      expect(result.content[0]!.text).toContain(fromEnv);
      expect(await readFile(fromEnv, 'utf-8')).toBe(EMPTY_WORKSPACE);
    } finally {
      if (previous === undefined) {
        delete process.env.BRUNO_WORKSPACE_PATH;
      } else {
        process.env.BRUNO_WORKSPACE_PATH = previous;
      }
    }
  });

  it('refuses a path it will not touch, naming which one', async () => {
    const badCollection = await unregister({ collectionPath: `${dir}/../escape` });
    const badWorkspace = await unregister({ workspacePath: `${dir}/../escape/workspace.yml` });

    expect(badCollection.isError).toBe(true);
    expect(badCollection.content[0]!.text).toContain('Invalid collectionPath');
    expect(badWorkspace.isError).toBe(true);
    expect(badWorkspace.content[0]!.text).toContain('Invalid workspacePath');
  });

  it('reports an unexpected failure instead of throwing out of the tool', async () => {
    const spy = jest.spyOn(WorkspaceResolver.prototype, 'resolveWorkspacePath')
      .mockImplementation(() => { throw new Error('no workspace for you'); });

    try {
      const result = await unregister();

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('Error unregistering collection: no workspace for you');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('listing a registry that has collected stale entries', () => {
  function list(): Promise<ToolResult> {
    return toolHandler(server, 'list_collections')({ workspacePath }) as Promise<ToolResult>;
  }

  it('says what the dead entries are and what removes them', async () => {
    await writeFile(
      workspacePath,
      `${EMPTY_WORKSPACE}  - name: "Gone"\n    path: "${join(dir, 'gone')}"\n`,
    );

    const result = await list();

    // Marked in the payload as `"exists": false` before this, and only there: a
    // caller reading forty-five of them had nothing telling them the entries could
    // be removed at all.
    expect(result.content[0]!.text).toContain('"exists": false');
    expect(result.content[1]!.text).toContain('1 of these entry points at a directory');
    expect(result.content[1]!.text).toContain('unregister_collection');
  });

  it('counts them, in the plural', async () => {
    await writeFile(
      workspacePath,
      `${EMPTY_WORKSPACE}  - name: "One"\n    path: "${join(dir, 'one')}"\n`
        + `  - name: "Two"\n    path: "${join(dir, 'two')}"\n`,
    );

    const result = await list();

    expect(result.content[1]!.text).toContain('2 of these entries point at a directory');
  });

  it('says nothing when every entry is live', async () => {
    await create();

    const result = await list();

    expect(result.content[0]!.text).toContain('"exists": true');
    expect(result.content).toHaveLength(1);
  });
});

describe('deleting a collection', () => {
  it('removes the directory and its entry, and says so', async () => {
    await create();

    const result = await remove();

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('Deleted collection Doomed (opencollection.yml)');
    expect(result.content[0]!.text).toContain('Removed its entry ("Doomed")');
    await expect(access(join(dir, 'Doomed'))).rejects.toThrow();
    expect(await readFile(workspacePath, 'utf-8')).toBe(EMPTY_WORKSPACE);
  });

  it('does not quote a name the entry never had', async () => {
    await create({ registerInWorkspace: false });
    await writeFile(workspacePath, `${EMPTY_WORKSPACE}  - path: "${join(dir, 'Doomed')}"\n`);

    const result = await remove();

    expect(result.content[0]!.text).toContain('Removed its entry from');
  });

  it('names bruno.json when that is what marks the collection', async () => {
    await create({ format: 'bru' });

    const result = await remove();

    expect(result.content[0]!.text).toContain('(bruno.json)');
  });

  it('refuses without confirm, and deletes nothing', async () => {
    await create();

    const result = await remove({ confirm: false });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('Refusing to delete: confirm must be true.');
    await expect(access(join(dir, 'Doomed', 'opencollection.yml'))).resolves.toBeUndefined();
  });

  it('refuses a directory that is not a collection root', async () => {
    // The directory a doubled outputPath produces: it contains a collection, but
    // is not one, and deleting it would take a tree this tool never inspected.
    const wrapper = join(dir, 'Wrapper');
    await mkdir(join(wrapper, 'Inner'), { recursive: true });
    await writeFile(join(wrapper, 'Inner', 'opencollection.yml'), 'info:\n  name: Inner\n');

    const result = await toolHandler(server, 'delete_collection')({
      collectionPath: wrapper,
      confirm: true,
      workspacePath,
    }) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('neither opencollection.yml nor bruno.json');
    await expect(access(join(wrapper, 'Inner', 'opencollection.yml'))).resolves.toBeUndefined();
  });

  it('refuses a path it will not touch, naming which one', async () => {
    const badWorkspace = await remove({ workspacePath: `${dir}/../escape/workspace.yml` });

    expect(badWorkspace.isError).toBe(true);
    expect(badWorkspace.content[0]!.text).toContain('Invalid workspacePath');
  });

  it('says the registry held no entry rather than claiming one was removed', async () => {
    await create({ registerInWorkspace: false });

    const result = await remove();

    expect(result.content[0]!.text).toContain('No entry in');
    expect(result.content[0]!.text).toContain('nothing was removed there');
  });

  it('reports a registry it could not edit, without failing the deletion', async () => {
    await create();
    const flow = join(dir, 'flow.yml');
    await writeFile(flow, `collections: [{name: "Doomed", path: "${join(dir, 'Doomed')}"}]\n`);

    const result = await remove({ workspacePath: flow });

    // The files are gone, which is what was asked for. A leftover entry is a
    // caveat on that, and unregister_collection is not the thing that can fix it
    // — so the caveat says what happened rather than pretending it did not.
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('was left alone');
    await expect(access(join(dir, 'Doomed'))).rejects.toThrow();
  });

  it('reports a registry write that failed, and says the entry is still listed', async () => {
    await create();
    const unregistrar = await import('../../../src/bruno/workspace-unregistrar');
    const spy = jest.spyOn(unregistrar, 'unregisterCollectionFromWorkspace')
      .mockRejectedValue(new Error('EROFS: read-only file system'));

    try {
      const result = await remove();

      expect(result.isError).toBeUndefined();
      expect(result.content[0]!.text).toContain('EROFS');
      expect(result.content[0]!.text).toContain('still listed');
      expect(result.content[0]!.text).toContain('points at a directory that is gone');
    } finally {
      spy.mockRestore();
    }
  });

  it('reports a rejection that is not an Error', async () => {
    await create();
    const unregistrar = await import('../../../src/bruno/workspace-unregistrar');
    const spy = jest.spyOn(unregistrar, 'unregisterCollectionFromWorkspace')
      .mockRejectedValue('a string, as anything can be thrown');

    try {
      const result = await remove();

      expect(result.content[0]!.text).toContain('a string, as anything can be thrown');
    } finally {
      spy.mockRestore();
    }
  });

  it('reports an unexpected failure instead of throwing out of the tool', async () => {
    await create();
    const spy = jest.spyOn(WorkspaceResolver.prototype, 'resolveWorkspacePath')
      .mockImplementation(() => { throw new Error('no workspace for you'); });

    try {
      const result = await remove();

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('Error deleting collection: no workspace for you');
    } finally {
      spy.mockRestore();
    }
  });
});
