/**
 * Execution order is folder-scoped, not one global `seq` sort.
 *
 * `seq` is scoped to a folder in Bruno. Discovery used to collect every request
 * file anywhere under the collection and apply a single `Array.sort` on
 * `info.seq`, so two requests both numbered `seq: 1` in different folders came
 * out in whichever order the walk reached them — `readdir` order, which is
 * filesystem-dependent. `run_collection`'s own description meanwhile promised
 * "requests within each folder still run sequentially by seq order".
 *
 * These pin the ported rules from `bruno-cli/src/utils/collection.js`, including
 * the two that a reasonable person would guess wrong: subfolders run before
 * their parent's own loose requests, and folder `seq` is a *position* to insert
 * at rather than a key to sort on.
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { discoverRequests } from '../../../src/bruno/request-discovery';
import { RequestExecutor } from '../../../src/bruno/request-executor';

/**
 * Reverse the order the directory walk sees entries in.
 *
 * `node:fs/promises` exports are non-configurable, so `jest.spyOn` throws
 * "Cannot redefine property: readdir" — the interception has to happen at
 * module level. Off by default so every other test runs against the real walk.
 */
let mockReverseWalk = false;

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual('node:fs/promises');
  return {
    ...actual,
    readdir: async (...args: unknown[]) => {
      const entries = await actual.readdir(...args);
      return mockReverseWalk && Array.isArray(entries) ? [...entries].reverse() : entries;
    },
  };
});

const mockFetch = jest.fn();
(global as unknown as { fetch: unknown }).fetch = mockFetch;

jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockResolvedValue({ valid: true }),
  ssrfRemediation: jest.fn().mockReturnValue(''),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Map(),
    text: async () => '{}',
    json: async () => ({}),
  });
});

const request = (name: string, seq?: number): string => `meta {
  name: ${name}
  type: http
${seq === undefined ? '' : `  seq: ${seq}\n`}}

get {
  url: https://e.com/${name}
  auth: none
}
`;

/** Our `.yml` dialect keys the metadata section `info`, not `meta`. */
const yamlRequest = (name: string, seq?: number): string => `info:
  name: ${name}
  type: http
${seq === undefined ? '' : `  seq: ${seq}\n`}http:
  method: get
  url: https://e.com/${name}
`;

async function collection(
  layout: Record<string, string>,
): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'exec-order-'));
  for (const [relativePath, content] of Object.entries(layout)) {
    const full = join(root, relativePath);
    await fs.mkdir(join(full, '..'), { recursive: true });
    await fs.writeFile(full, content);
  }
  return root;
}

/** Names in the order they would run. */
async function order(root: string): Promise<string[]> {
  const { requests } = await discoverRequests(root);
  return requests.map((r) => r.yaml.info.name);
}

describe('ordering requests across folders', () => {
  it('does not interleave two folders that both start at seq 1', async () => {
    const root = await collection({
      'a/first.bru': request('a-first', 1),
      'a/second.bru': request('a-second', 2),
      'b/first.bru': request('b-first', 1),
      'b/second.bru': request('b-second', 2),
    });

    // The old global sort produced a-first, b-first, a-second, b-second.
    expect(await order(root)).toEqual(['a-first', 'a-second', 'b-first', 'b-second']);
  });

  it('runs subfolders before the loose requests of their parent', async () => {
    const root = await collection({
      'root-request.bru': request('root-request', 1),
      'folder/inner.bru': request('inner', 99),
    });

    // Upstream's traverse ends `return folders.concat(requests)`, so seq 1 at
    // the root still runs after a folder's seq 99.
    expect(await order(root)).toEqual(['inner', 'root-request']);
  });

  it('places a folder by its folder.bru seq rather than its name', async () => {
    const root = await collection({
      'alpha/r.bru': request('from-alpha', 1),
      'zulu/folder.bru': 'meta {\n  name: zulu\n  seq: 1\n}\n',
      'zulu/r.bru': request('from-zulu', 1),
    });

    expect(await order(root)).toEqual(['from-zulu', 'from-alpha']);
  });

  it('reads a folder seq that the .bru grammar yields as a string', async () => {
    // collectionBruToJson returns seq: "2" — the grammar has no numbers — and an
    // uncoerced string fails the positive-integer check, leaving the folder
    // alphabetical and this test red.
    const root = await collection({
      'alpha/folder.bru': 'meta {\n  name: alpha\n  seq: 2\n}\n',
      'alpha/r.bru': request('from-alpha', 1),
      'bravo/folder.bru': 'meta {\n  name: bravo\n  seq: 1\n}\n',
      'bravo/r.bru': request('from-bravo', 1),
    });

    expect(await order(root)).toEqual(['from-bravo', 'from-alpha']);
  });

  it('orders by seq within one directory', async () => {
    const root = await collection({
      'c.bru': request('third', 3),
      'a.bru': request('first', 1),
      'b.bru': request('second', 2),
    });

    expect(await order(root)).toEqual(['first', 'second', 'third']);
  });

  it('puts a .yml request with no seq after the numbered ones', async () => {
    const root = await collection({
      'a.yml': yamlRequest('unnumbered'),
      'b.yml': yamlRequest('numbered', 5),
    });

    expect(await order(root)).toEqual(['numbered', 'unnumbered']);
  });

  it('treats a .bru request with no seq as seq 1, because the grammar injects it', async () => {
    // Same shape as the `timeout: 0` injection behind H6: bruToJsonV2 fills
    // `seq: 1` into a meta block that omits it, so the unnumbered-last fallback
    // is unreachable for .bru and is really the .yml default. Asserting the
    // reachable behaviour rather than the intended-looking one.
    const root = await collection({
      'a.bru': request('unnumbered'),
      'b.bru': request('numbered', 5),
    });

    expect(await order(root)).toEqual(['unnumbered', 'numbered']);
  });

  it('breaks a seq tie on filename so repeated runs agree', async () => {
    // The walk order has to be forced, not assumed: readdir happens to return
    // alphabetically on macOS, so without this spy the assertion passes whether
    // or not a tie-break exists, and cannot fail if one is removed. That is the
    // very nondeterminism this fix is about — a test that inherits it proves
    // nothing about a filesystem that enumerates differently.
    const root = await collection({
      'apple.bru': request('apple', 1),
      'zebra.bru': request('zebra', 1),
    });

    mockReverseWalk = true;
    try {
      expect(await order(root)).toEqual(['apple', 'zebra']);
    } finally {
      mockReverseWalk = false;
    }
  });

  it('leaves a folder alphabetical when its root file will not parse', async () => {
    // Ordering must not be able to fail a run: the folder is simply unplaced.
    const root = await collection({
      'alpha/r.bru': request('from-alpha', 1),
      'zulu/folder.bru': 'this is not { valid bru',
      'zulu/r.bru': request('from-zulu', 1),
    });

    expect(await order(root)).toEqual(['from-alpha', 'from-zulu']);
  });

  it('reports folders in the same order whether the run is parallel or serial', async () => {
    // Parallel grouped by folder and then sorted the names alphabetically, which
    // was deterministic but disagreed with folder `seq` — so one collection
    // reported two different orders depending on the flag.
    const layout = {
      'alpha/folder.bru': 'meta {\n  name: alpha\n  seq: 2\n}\n',
      'alpha/r.bru': request('from-alpha', 1),
      'bravo/folder.bru': 'meta {\n  name: bravo\n  seq: 1\n}\n',
      'bravo/r.bru': request('from-bravo', 1),
    };

    const names = async (parallel: boolean): Promise<string[]> => {
      const root = await collection(layout);
      const result = await RequestExecutor.executeCollection(root, { parallel });
      return (result.results ?? []).map((r) => (r as { name: string }).name);
    };

    expect(await names(true)).toEqual(['from-bravo', 'from-alpha']);
    expect(await names(true)).toEqual(await names(false));
  });

  it('still reports parse failures and does not lose them to grouping', async () => {
    const root = await collection({
      'good.bru': request('good', 1),
      'folder/bad.bru': 'this is not { valid bru',
    });

    const { requests, parseFailures } = await discoverRequests(root);

    expect(requests.map((r) => r.yaml.info.name)).toEqual(['good']);
    expect(parseFailures).toHaveLength(1);
  });
});
