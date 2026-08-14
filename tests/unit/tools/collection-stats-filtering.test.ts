/**
 * What `get_collection_stats` reports, and how much of it.
 *
 * Two defects, one surface. The response carried every request in the
 * collection with no way to ask for fewer — tens of kilobytes on a collection
 * of any size, which makes the tool expensive to call casually — and it left
 * out the URL, which is the field most wanted when triaging an unfamiliar
 * collection: two requests named "Create" say nothing, their targets say
 * everything. Learning a URL meant reading every file back one at a time.
 *
 * The filter is deliberately NOT allowed to touch the counts. `totalRequests`
 * and `requestsByMethod` answer "how big is this collection", and a filter that
 * shrank them would answer that with the size of the caller's own question.
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

import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { getCollectionStats, filterCollectionStats } from '../../../src/bruno/collection-stats';
import { BrunoMcpServer } from '../../../src/server';
import type { CollectionStats } from '../../../src/bruno/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const server = new BrunoMcpServer();

function getHandler(toolName: string): Function {
  const tool = (server as any).server._tools.get(toolName);
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);
  return tool.handler;
}

const collectionStats = getHandler('get_collection_stats');

/** The JSON document block, parsed. Anything after it is a warning. */
function documentOf(result: any): CollectionStats {
  return JSON.parse((result.content as { text: string }[])[0].text) as CollectionStats;
}

function warningsOf(result: any): string {
  return (result.content as { text: string }[]).slice(1).map((block) => block.text).join('\n');
}

function bruRequest(name: string, seq: number, block: string): string {
  return `meta {\n  name: ${name}\n  type: ${
    block.startsWith('grpc') ? 'grpc' : block.startsWith('ws') ? 'ws' : 'http'
  }\n  seq: ${seq}\n}\n\n${block}\n`;
}

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bruno-stats-filter-'));
  await writeFile(
    join(root, 'bruno.json'),
    JSON.stringify({ version: '1', name: 'Filtered', type: 'collection' }),
  );
  await mkdir(join(root, 'auth', 'oauth2'), { recursive: true });
  await mkdir(join(root, 'orders'), { recursive: true });
  // Shares a prefix with 'auth' without being under it: the case a plain
  // startsWith would wrongly claim.
  await mkdir(join(root, 'authz'), { recursive: true });

  await writeFile(
    join(root, 'ping.bru'),
    bruRequest('Ping', 1, 'get {\n  url: https://api.test/ping\n}'),
  );
  await writeFile(
    join(root, 'auth', 'login.bru'),
    bruRequest('Login', 2, 'post {\n  url: https://api.test/auth/login\n}'),
  );
  await writeFile(
    join(root, 'auth', 'oauth2', 'token.bru'),
    bruRequest('Token exchange', 3, 'post {\n  url: https://api.test/auth/oauth2/token\n}'),
  );
  await writeFile(
    join(root, 'orders', 'create.bru'),
    bruRequest('Create', 4, 'post {\n  url: https://api.test/orders\n}'),
  );
  await writeFile(
    join(root, 'authz', 'check.bru'),
    bruRequest('Check', 7, 'get {\n  url: https://api.test/authz/check\n}'),
  );
  await writeFile(
    join(root, 'socket.bru'),
    bruRequest('Socket', 5, 'ws {\n  url: wss://api.test/socket\n}'),
  );
  await writeFile(
    join(root, 'streamer.bru'),
    bruRequest('Streamer', 6, 'grpc {\n  url: grpc://api.test:50051\n  method: /pkg.Svc/Method\n}'),
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the URL of each request', () => {
  it('reports an http request\'s target, which used to require reading the file', async () => {
    const stats = await getCollectionStats(root);
    const login = stats.requests.find((r) => r.name === 'Login');

    expect(login?.url).toBe('https://api.test/auth/login');
  });

  it('reads a ws and a grpc target from their own blocks, not from http', async () => {
    // These two keep their URL somewhere other than the http block, so a reader
    // that looked only there would report the kinds Bruno supports as having no
    // target at all.
    const stats = await getCollectionStats(root);

    expect(stats.requests.find((r) => r.name === 'Socket')?.url).toBe('wss://api.test/socket');
    expect(stats.requests.find((r) => r.name === 'Streamer')?.url).toBe('grpc://api.test:50051');
  });

  it('reports a .yml request\'s target too, and its websocket block', async () => {
    const yamlRoot = await mkdtemp(join(tmpdir(), 'bruno-stats-yaml-'));
    try {
      await writeFile(
        join(yamlRoot, 'opencollection.yml'),
        'version: "1"\nname: Yamlish\ntype: collection\n',
      );
      await writeFile(
        join(yamlRoot, 'fetch.yml'),
        'info:\n  name: Fetch\n  type: http\n  seq: 1\nhttp:\n  method: GET\n  url: https://api.test/fetch\n',
      );
      await writeFile(
        join(yamlRoot, 'stream.yml'),
        // `websocket` is the token a `.yml` spells the kind with; `.bru` spells
        // the same kind `ws`.
        'info:\n  name: Stream\n  type: websocket\n  seq: 2\nwebsocket:\n  url: wss://api.test/stream\n',
      );

      const stats = await getCollectionStats(yamlRoot);

      expect(stats.requests.find((r) => r.name === 'Fetch')?.url).toBe('https://api.test/fetch');
      expect(stats.requests.find((r) => r.name === 'Stream')?.url).toBe('wss://api.test/stream');
    } finally {
      await rm(yamlRoot, { recursive: true, force: true });
    }
  });

  it('omits the field entirely when no block carries a target', async () => {
    // Rather than an empty string, which reads as a URL that happens to be
    // blank. The request is still counted: a missing http block is why `method`
    // falls back to the kind.
    const bare = await mkdtemp(join(tmpdir(), 'bruno-stats-bare-'));
    try {
      await writeFile(
        join(bare, 'bruno.json'),
        JSON.stringify({ version: '1', name: 'Bare', type: 'collection' }),
      );
      await writeFile(join(bare, 'nothing.bru'), 'meta {\n  name: Nothing\n  type: http\n  seq: 1\n}\n');

      const stats = await getCollectionStats(bare);

      expect(stats.totalRequests).toBe(1);
      expect(stats.requests[0]).not.toHaveProperty('url');
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe('narrowing the per-request array', () => {
  let all: CollectionStats;

  beforeAll(async () => {
    all = await getCollectionStats(root);
  });

  it('takes a folder with everything nested below it', () => {
    // Asking for "auth" and not being given "auth/oauth2" would be a filter
    // that hides the very requests it was aimed at.
    const names = filterCollectionStats(all, { folder: 'auth' }).requests.map((r) => r.name);

    expect(names.sort()).toEqual(['Login', 'Token exchange']);
  });

  it('leaves out a sibling folder and the root-level requests', () => {
    const names = filterCollectionStats(all, { folder: 'orders' }).requests.map((r) => r.name);

    expect(names).toEqual(['Create']);
  });

  it('does not claim a sibling folder that merely starts with the same text', () => {
    // 'authz' is not inside 'auth'. Comparing prefixes without the separator
    // would hand the caller requests from a folder they did not ask about —
    // which, when the folders are named after permissions, is the difference
    // between reading auth requests and reading authorization requests.
    const names = filterCollectionStats(all, { folder: 'auth' }).requests.map((r) => r.name);

    expect(names).not.toContain('Check');
    expect(filterCollectionStats(all, { folder: 'authz' }).requests.map((r) => r.name))
      .toEqual(['Check']);
  });

  it('reads the collection root as nesting everything', () => {
    // '' and '.' both name the root, and the root nests every folder, so this
    // is the whole collection rather than the root-level files only.
    expect(filterCollectionStats(all, { folder: '' }).requests).toHaveLength(7);
    expect(filterCollectionStats(all, { folder: '.' }).requests).toHaveLength(7);
  });

  it('matches a method whatever case the caller used', () => {
    expect(filterCollectionStats(all, { method: 'post' }).requests).toHaveLength(3);
    expect(filterCollectionStats(all, { method: 'POST' }).requests).toHaveLength(3);
  });

  it('matches the kinds that have no method under their own label', () => {
    // A ws request is bucketed as WS in requestsByMethod, so that is the label
    // a caller reading the counts will reach for here.
    expect(filterCollectionStats(all, { method: 'ws' }).requests.map((r) => r.name))
      .toEqual(['Socket']);
    expect(filterCollectionStats(all, { method: 'grpc' }).requests.map((r) => r.name))
      .toEqual(['Streamer']);
  });

  it('matches part of a name, ignoring case', () => {
    expect(filterCollectionStats(all, { nameContains: 'ken exch' }).requests.map((r) => r.name))
      .toEqual(['Token exchange']);
    expect(filterCollectionStats(all, { nameContains: 'LOGIN' }).requests.map((r) => r.name))
      .toEqual(['Login']);
  });

  it('intersects the filters rather than adding their results together', () => {
    const result = filterCollectionStats(all, { folder: 'auth', method: 'POST' });

    expect(result.requests.map((r) => r.name).sort()).toEqual(['Login', 'Token exchange']);
    expect(filterCollectionStats(all, { folder: 'auth', method: 'GET' }).requests).toEqual([]);
  });

  it('keeps the counts describing the whole collection, and says how many matched', () => {
    const result = filterCollectionStats(all, { folder: 'orders' });

    expect(result.totalRequests).toBe(7);
    expect(result.requestsByMethod).toEqual(all.requestsByMethod);
    expect(result.matchedRequests).toBe(1);
  });

  it('adds neither field when nothing was narrowed', () => {
    // An unfiltered call has to keep its shape: a matchedRequests that is
    // always present would make every response look filtered.
    const result = filterCollectionStats(all, {});

    expect(result).not.toHaveProperty('matchedRequests');
    expect(result).not.toHaveProperty('requestsOmitted');
    expect(result.requests).toHaveLength(7);
  });

  it('drops the array for a counts-only call and flags that it did', () => {
    const result = filterCollectionStats(all, { includeRequests: false });

    expect(result.requests).toEqual([]);
    expect(result.requestsOmitted).toBe(true);
    expect(result.totalRequests).toBe(7);
    // Absent, not equal to the total: a counts-only call narrowed nothing, and a
    // matchedRequests on every response would make every response look filtered.
    expect(result).not.toHaveProperty('matchedRequests');
    expect(result.folders).toEqual(all.folders);
    expect(result.environmentDetails).toEqual(all.environmentDetails);
  });

  it('still reports the match count when a counts-only call also filtered', () => {
    // Otherwise the caller cannot tell an empty array that means "omitted" from
    // one that means "nothing matched".
    const result = filterCollectionStats(all, { folder: 'auth', includeRequests: false });

    expect(result.requests).toEqual([]);
    expect(result.matchedRequests).toBe(2);
    expect(result.requestsOmitted).toBe(true);
  });
});

describe('through the tool', () => {
  it('narrows what it returns without narrowing what it counts', async () => {
    const result = await collectionStats({ collectionPath: root, folder: 'orders' });
    const document = documentOf(result);

    expect(document.requests.map((r) => r.name)).toEqual(['Create']);
    expect(document.matchedRequests).toBe(1);
    expect(document.totalRequests).toBe(7);
  });

  it('returns every request when the caller asks for no filter', async () => {
    const result = await collectionStats({ collectionPath: root, includeRequests: true });
    const document = documentOf(result);

    expect(document.requests).toHaveLength(7);
    expect(document).not.toHaveProperty('matchedRequests');
  });

  it('returns counts without the array when asked', async () => {
    const result = await collectionStats({ collectionPath: root, includeRequests: false });
    const document = documentOf(result);

    expect(document.requests).toEqual([]);
    expect(document.requestsOmitted).toBe(true);
    expect(document.totalRequests).toBe(7);
  });

  it('still warns about an off-dialect file the filter excluded', async () => {
    // The warning is about the collection, not about the answer: a file whose
    // extension the collection's manifest does not declare is one Bruno will
    // never read, whether or not the caller's filter happened to cover it. A
    // warning computed from the filtered list would vanish exactly when someone
    // asked a narrower question.
    const mixed = await mkdtemp(join(tmpdir(), 'bruno-stats-mixed-'));
    try {
      await writeFile(
        join(mixed, 'bruno.json'),
        JSON.stringify({ version: '1', name: 'Mixed', type: 'collection' }),
      );
      await mkdir(join(mixed, 'kept'), { recursive: true });
      await writeFile(
        join(mixed, 'kept', 'in.bru'),
        bruRequest('Kept', 1, 'get {\n  url: https://api.test/kept\n}'),
      );
      await writeFile(
        join(mixed, 'stray.yml'),
        'info:\n  name: Stray\n  type: http\n  seq: 2\nhttp:\n  method: GET\n  url: https://api.test/stray\n',
      );

      const result = await collectionStats({ collectionPath: mixed, folder: 'kept' });

      expect(documentOf(result).requests.map((r) => r.name)).toEqual(['Kept']);
      expect(warningsOf(result)).toContain('stray.yml');
    } finally {
      await rm(mixed, { recursive: true, force: true });
    }
  });
});
