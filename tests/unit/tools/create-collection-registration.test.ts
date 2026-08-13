/**
 * What `create_collection` tells the caller about visibility.
 *
 * `list_collections` reads the workspace registry rather than the disk, so a
 * created collection that was never registered is invisible to it — which read as
 * silent failure. These go through the registered tool, with a real collection
 * written to a temporary directory and a real workspace file, because the thing
 * under test is what the two ends do together.
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

import { mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrunoMcpServer } from '../../../src/server';

const EMPTY_WORKSPACE = 'opencollection: 1.0.0\ninfo:\n  name: "W"\n  type: workspace\n\ncollections:\n';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolHandler(server: BrunoMcpServer, name: string): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any).server._tools.get(name).handler;
}

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

let server: BrunoMcpServer;
let dir: string;

beforeEach(async () => {
  jest.clearAllMocks();
  server = new BrunoMcpServer();
  dir = await mkdtemp(join(tmpdir(), 'create-collection-'));
});

async function create(args: Record<string, unknown>): Promise<ToolResult> {
  return await toolHandler(server, 'create_collection')({
    name: 'Fresh',
    outputPath: dir,
    format: 'yaml',
    ...args,
  }) as ToolResult;
}

describe('a collection created with a workspace to register it in', () => {
  it('is added to the registry, and the result says so', async () => {
    const workspacePath = join(dir, 'workspace.yml');
    await writeFile(workspacePath, EMPTY_WORKSPACE);

    const result = await create({ workspacePath });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('Registered in');
    expect(result.content[0]!.text).toContain(workspacePath);
    // The directory the collection actually lives in, which is one level below
    // the path asked for.
    expect(await readFile(workspacePath, 'utf-8')).toContain(`path: "${join(dir, 'Fresh')}"`);
  });

  it('uses the workspace list_collections would read when none is named', async () => {
    const workspacePath = join(dir, 'from-env.yml');
    await writeFile(workspacePath, EMPTY_WORKSPACE);
    const previous = process.env.BRUNO_WORKSPACE_PATH;
    process.env.BRUNO_WORKSPACE_PATH = workspacePath;

    try {
      const result = await create({});

      expect(result.content[0]!.text).toContain('Registered in');
      expect(await readFile(workspacePath, 'utf-8')).toContain('name: "Fresh"');
    } finally {
      if (previous === undefined) {
        delete process.env.BRUNO_WORKSPACE_PATH;
      } else {
        process.env.BRUNO_WORKSPACE_PATH = previous;
      }
    }
  });

  it('says nothing was added when the same path is already listed', async () => {
    const workspacePath = join(dir, 'workspace.yml');
    await writeFile(
      workspacePath,
      `${EMPTY_WORKSPACE}  - name: "Old name"\n    path: "${join(dir, 'Fresh')}"\n`,
    );

    const result = await create({ workspacePath });

    expect(result.content[0]!.text).toContain('Already listed');
  });
});

describe('a collection created with nowhere to register it', () => {
  it('reports the missing workspace instead of staying silent', async () => {
    const workspacePath = join(dir, 'absent.yml');

    const result = await create({ workspacePath });

    // Created, and honest about the consequence — the gap this closes was a
    // success message that mentioned neither.
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('created successfully');
    expect(result.content[0]!.text).toContain('no workspace file');
    expect(result.content[0]!.text).toContain('will not appear in list_collections');
    await expect(access(join(dir, 'Fresh'))).resolves.toBeUndefined();
  });

  it('says so when the caller asked not to register it', async () => {
    const workspacePath = join(dir, 'workspace.yml');
    await writeFile(workspacePath, EMPTY_WORKSPACE);

    const result = await create({ workspacePath, registerInWorkspace: false });

    expect(result.content[0]!.text).toContain('Not registered in a workspace, as asked');
    expect(await readFile(workspacePath, 'utf-8')).toBe(EMPTY_WORKSPACE);
  });
});

describe('a registry that cannot be written', () => {
  it('reports the write failure without failing the call', async () => {
    const workspacePath = join(dir, 'workspace.yml');
    await writeFile(workspacePath, EMPTY_WORKSPACE);
    // Spied rather than made read-only on disk: a permission bit is honoured or
    // ignored depending on who the test runs as, and this claim is about what the
    // tool does with the failure, not about how the failure arises.
    const registrar = await import('../../../src/bruno/workspace-registrar');
    const spy = jest.spyOn(registrar, 'registerCollectionInWorkspace')
      .mockRejectedValue(new Error('EROFS: read-only file system'));

    try {
      const result = await create({ workspacePath });

      // The collection exists and is usable by path, so losing the registry entry
      // is a caveat on a success, not a failure.
      expect(result.isError).toBeUndefined();
      expect(result.content[0]!.text).toContain('created successfully');
      expect(result.content[0]!.text).toContain('could not be written');
      expect(result.content[0]!.text).toContain('EROFS');
      expect(result.content[0]!.text).toContain('usable by path');
    } finally {
      spy.mockRestore();
    }
  });

  it('reports a rejection that is not an Error', async () => {
    const workspacePath = join(dir, 'workspace.yml');
    await writeFile(workspacePath, EMPTY_WORKSPACE);
    const registrar = await import('../../../src/bruno/workspace-registrar');
    const spy = jest.spyOn(registrar, 'registerCollectionInWorkspace')
      .mockRejectedValue('a string, as anything can be thrown');

    try {
      const result = await create({ workspacePath });

      expect(result.content[0]!.text).toContain('a string, as anything can be thrown');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('a manager that reports success without a path', () => {
  it('registers where the collection is written rather than the word undefined', async () => {
    const workspacePath = join(dir, 'workspace.yml');
    await writeFile(workspacePath, EMPTY_WORKSPACE);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const manager = (server as any).collectionManager;
    const spy = jest.spyOn(manager, 'createCollection').mockResolvedValue({ success: true });

    try {
      const result = await create({ workspacePath });

      expect(result.content[0]!.text).toContain('Registered in');
      // A collection lives in a directory named after it, below the path asked
      // for, so that is the path a registry entry has to carry.
      expect(await readFile(workspacePath, 'utf-8')).toContain(`path: "${join(dir, 'Fresh')}"`);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('a workspace path the tool will not touch', () => {
  it('is refused before anything is created', async () => {
    const result = await create({ workspacePath: `${dir}/../escape/workspace.yml` });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Invalid workspacePath');
    // Refused first, so there is no collection left behind that the same call
    // then declines to report on.
    await expect(access(join(dir, 'Fresh'))).rejects.toThrow();
  });
});
