/**
 * read_request and read_environment, driven through the registered handlers.
 *
 * Everything runs against real collections in a temp directory rather than a
 * mocked filesystem: these two tools exist so an agent can see what was
 * actually written, so a test that reads back a stubbed value would not be
 * testing the thing the tools are for.
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
import { createEnvironmentManager } from '../../../src/bruno/environment';

/* eslint-disable @typescript-eslint/no-explicit-any */

const server = new BrunoMcpServer();

function getHandler(toolName: string): Function {
  const tool = (server as any).server._tools.get(toolName);
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);
  return tool.handler;
}

const readRequest = getHandler('read_request');
const readEnvironment = getHandler('read_environment');

function textOf(result: any): string {
  return result.content[0].text as string;
}

/** Everything after the document block: the warnings, if any were emitted. */
function warningsOf(result: any): string {
  return (result.content as { text: string }[]).slice(1).map((block) => block.text).join('\n');
}

function jsonOf(result: any): any {
  const text = textOf(result);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`expected JSON, tool returned: ${text}`);
  }
}

async function makeCollection(label: string, format: 'bru' | 'yaml'): Promise<string> {
  const tmpDir = await fs.mkdtemp(join(tmpdir(), `bruno-read-${label}-`));
  const result = await createCollectionManager().createCollection({
    name: 'ReadAPI',
    outputPath: tmpDir,
    format,
  });
  if (!result.success) throw new Error(`collection setup failed: ${result.error}`);
  return join(tmpDir, 'ReadAPI');
}

describe('read_request', () => {
  const builder = createRequestBuilder();

  it('reads a .bru request back as structured JSON', async () => {
    const collectionPath = await makeCollection('bru', 'bru');
    // The writer lowercases the filename, so the returned path is the only
    // path that is guaranteed to exist — rebuilding it from the name would
    // pass on a case-insensitive filesystem and fail everywhere else.
    const created = await builder.createRequest({
      collectionPath,
      name: 'GetUser',
      method: 'GET',
      url: 'https://api.example.com/users/1',
      headers: { Accept: 'application/json' },
    });
    expect(created.success).toBe(true);

    const view = jsonOf(await readRequest({ filePath: created.path }));

    expect(view.filePath).toBe(created.path);
    expect(view.format).toBe('bru');
    expect(view.name).toBe('GetUser');
    expect(view.method).toBe('GET');
    expect(view.url).toBe('https://api.example.com/users/1');
    expect(view.headers).toContainEqual({ name: 'Accept', value: 'application/json' });
  });

  it('reads a .yml request back in the same shape', async () => {
    const collectionPath = await makeCollection('yaml', 'yaml');
    const created = await builder.createRequest({
      collectionPath,
      name: 'GetUser',
      method: 'GET',
      url: 'https://api.example.com/users/1',
      headers: { Accept: 'application/json' },
    });
    expect(created.success).toBe(true);

    const view = jsonOf(await readRequest({ filePath: created.path }));

    expect(view.format).toBe('yaml');
    expect(view.name).toBe('GetUser');
    expect(view.method).toBe('GET');
    expect(view.headers).toContainEqual({ name: 'Accept', value: 'application/json' });
  });

  it('shows a body that write_request wrote', async () => {
    const collectionPath = await makeCollection('body', 'bru');
    const created = await builder.createRequest({
      collectionPath,
      name: 'PostUser',
      method: 'POST',
      url: 'https://api.example.com/users',
      body: { type: 'json', content: '{"name":"ada"}' },
    });
    expect(created.success).toBe(true);

    const view = jsonOf(await readRequest({ filePath: created.path }));
    expect(view.body.type).toBe('json');
    expect(view.body.content).toContain('ada');
  });

  it('rejects a path that tries to traverse out of the collection', async () => {
    const result = await readRequest({ filePath: '/tmp/c/../../etc/passwd.bru' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid filePath');
  });

  it('reads a hand-written .yaml request in a YAML collection', async () => {
    // `.yaml` was recognised nowhere, so this file could not be read at all.
    // Nothing here writes one — it is the extension a hand-authored or
    // openapi-synced file arrives with.
    const collectionPath = await makeCollection('yamlext', 'yaml');
    const filePath = join(collectionPath, 'handwritten.yaml');
    await fs.writeFile(
      filePath,
      'info:\n  name: HandWritten\n  type: http\n  seq: 1\nhttp:\n  method: GET\n'
        + '  url: https://api.example.com/x\n',
      'utf-8',
    );

    const view = jsonOf(await readRequest({ filePath }));

    expect(view.format).toBe('yaml');
    expect(view.name).toBe('HandWritten');
    expect(view.url).toBe('https://api.example.com/x');
  });

  it('reads a .yaml request in a .bru collection, warning that Bruno will not', async () => {
    // `.yaml` counts as the YAML dialect, so it mismatches a native collection
    // exactly as `.yml` would. Two things make it invisible to Bruno at once,
    // and only the dialect is reported: renaming it to `.yml`, which is what the
    // `.yaml` warning says, would leave it just as invisible here.
    const collectionPath = await makeCollection('yamlinbru', 'bru');
    const filePath = join(collectionPath, 'handwritten.yaml');
    await fs.writeFile(
      filePath,
      'info:\n  name: X\n  type: http\n  seq: 1\nhttp:\n  method: GET\n'
        + '  url: https://api.example.com/x\n',
      'utf-8',
    );

    const result = await readRequest({ filePath });

    expect(result.isError).toBeUndefined();
    expect(jsonOf(result).name).toBe('X');
    expect(warningsOf(result)).toContain('rename them to ".bru"');
  });

  it('reads a .bru request in a YAML collection with the .bru parser', async () => {
    // The dialect follows the FILE. Reading this with the YAML parser — the
    // collection's dialect — would fail on the first brace.
    const collectionPath = await makeCollection('bruinyaml', 'yaml');
    const filePath = join(collectionPath, 'handwritten.bru');
    await fs.writeFile(filePath, 'meta {\n  name: X\n}\n', 'utf-8');

    const result = await readRequest({ filePath });

    expect(result.isError).toBeUndefined();
    expect(jsonOf(result).name).toBe('X');
    expect(warningsOf(result)).toContain('rename them to ".yml"');
  });

  it('rejects a file whose extension names no request dialect', async () => {
    const result = await readRequest({ filePath: '/tmp/c/request.json' });
    expect(result.isError).toBe(true);
    // The message lists what IS accepted, so the caller can fix the argument
    // without guessing — `.yaml` is now among them.
    expect(textOf(result)).toContain('expected .bru, .yml, .yaml');
  });

  it('rejects a file that sits in no collection', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'bruno-read-orphan-'));
    const orphan = join(dir, 'lonely.bru');
    await fs.writeFile(orphan, 'meta {\n  name: Lonely\n}\n');

    const result = await readRequest({ filePath: orphan });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Could not determine collection format');
  });

  it('names the file in the warning, since the fix is a rename', async () => {
    const collectionPath = await makeCollection('mismatch', 'bru');
    const wrong = join(collectionPath, 'wrong.yml');
    await fs.writeFile(
      wrong,
      'info:\n  name: Wrong\n  type: http\n  seq: 1\nhttp:\n  method: GET\n'
        + '  url: https://api.example.com/x\n',
    );

    const result = await readRequest({ filePath: wrong });
    expect(result.isError).toBeUndefined();
    expect(warningsOf(result)).toContain(wrong);
  });

  it('says nothing about the extension when it matches the collection', async () => {
    const collectionPath = await makeCollection('matching', 'bru');
    const right = join(collectionPath, 'right.bru');
    await fs.writeFile(right, 'meta {\n  name: Right\n}\n');

    const result = await readRequest({ filePath: right });
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
  });

  it('reports a missing file as an error rather than throwing', async () => {
    const collectionPath = await makeCollection('missing', 'bru');
    const result = await readRequest({ filePath: join(collectionPath, 'nope.bru') });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Error reading request');
  });
});

describe('read_environment', () => {
  const environments = createEnvironmentManager();

  it('lists the collection environments when no name is given', async () => {
    const collectionPath = await makeCollection('env-list', 'bru');
    for (const name of ['dev', 'prod']) {
      const created = await environments.createEnvironment({
        collectionPath,
        name,
        variables: { host: `https://${name}.example.com` },
      });
      expect(created.success).toBe(true);
    }

    const result = jsonOf(await readEnvironment({ collectionPath }));
    expect(result.collectionPath).toBe(collectionPath);
    expect([...result.environments].sort()).toEqual(['dev', 'prod']);
  });

  it('reads a named environment back with its values', async () => {
    const collectionPath = await makeCollection('env-read', 'bru');
    await environments.createEnvironment({
      collectionPath,
      name: 'dev',
      variables: { host: 'https://dev.example.com', retries: 3 },
    });

    // Also the round-trip guard for the writer: a `.bru` environment that
    // create_environment produced must parse back. It did not until the
    // hand-rolled serializer — `# ...` header, single-quoted values — was
    // replaced, and nothing in the mocked environment suite could see that.
    const raw = await fs.readFile(join(collectionPath, 'environments', 'dev.bru'), 'utf-8');
    expect(raw).not.toMatch(/^#/m);
    expect(raw).toContain('host: https://dev.example.com');

    const view = jsonOf(await readEnvironment({ collectionPath, name: 'dev' }));
    expect(view.name).toBe('dev');
    expect(view.variables).toContainEqual({ name: 'host', value: 'https://dev.example.com' });
    expect(view.notes).toEqual([]);
  });

  it('returns a secret by name only, and says why', async () => {
    const collectionPath = await makeCollection('env-secret', 'bru');
    await environments.createEnvironment({
      collectionPath,
      name: 'dev',
      variables: { host: 'https://dev.example.com' },
    });
    const set = await environments.setEnvironmentVariable(
      collectionPath,
      'dev',
      'API_KEY',
      'never-written',
      true,
      true,
    );
    expect(set.success).toBe(true);

    const raw = textOf(await readEnvironment({ collectionPath, name: 'dev' }));
    expect(raw).not.toContain('never-written');

    const view = JSON.parse(raw);
    expect(view.variables).toContainEqual({ name: 'API_KEY', secret: true });
    expect(view.notes[0]).toContain('never the value');
  });

  it('reads a .yml environment through the same tool', async () => {
    const collectionPath = await makeCollection('env-yaml', 'yaml');
    await environments.createEnvironment({
      collectionPath,
      name: 'dev',
      variables: { host: 'https://dev.example.com' },
    });

    const view = jsonOf(await readEnvironment({ collectionPath, name: 'dev' }));
    expect(view.variables).toContainEqual({ name: 'host', value: 'https://dev.example.com' });
  });

  it('rejects a traversing collectionPath', async () => {
    const result = await readEnvironment({ collectionPath: '/tmp/../etc' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid collectionPath');
  });

  it('reports a missing environment as an error rather than throwing', async () => {
    const collectionPath = await makeCollection('env-missing', 'bru');
    const result = await readEnvironment({ collectionPath, name: 'nope' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Error reading environment');
  });
});
