/**
 * Collection- and folder-level scripts and tests actually run (L12).
 *
 * `collection-roots.ts` read them for several releases and reported them, per
 * request, as "not applied to requests yet". A collection that put its
 * authentication in `collection.bru`'s `script:pre-request` — the normal way to
 * write one — ran every request without it.
 *
 * Order is the substance of the port, so most of these assert a sequence rather
 * than a presence. Each layer appends one letter to a run variable, and the
 * finished string is read back through `captureVariables`; a test that only
 * checked "the collection script ran" would pass against three different wrong
 * orderings.
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RequestExecutor } from '../../../src/bruno/request-executor';
import { TestRunner } from '../../../src/bruno/test-runner';

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
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ ok: true }),
  });
});

/** Appends one letter to `order`, so a sequence is observable end to end. */
const mark = (letter: string): string =>
  `bru.setVar("order", (bru.getVar("order") || "") + "${letter}");`;

async function collection(layout: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'root-scripts-'));
  for (const [relativePath, content] of Object.entries(layout)) {
    const full = join(root, relativePath);
    await fs.mkdir(join(full, '..'), { recursive: true });
    await fs.writeFile(full, content);
  }
  return root;
}

/** A .yml request carrying whichever script slots are given. */
function request(scripts: { type: string; code: string }[] = []): string {
  const body = scripts
    .map((s) => `    - type: ${s.type}\n      code: |\n        ${s.code}`)
    .join('\n');
  return `info:
  name: req
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/thing"
${scripts.length > 0 ? `runtime:\n  scripts:\n${body}\n` : ''}`;
}

async function run(
  root: string,
  capture: string[] = ['order'],
): Promise<Awaited<ReturnType<typeof RequestExecutor.executeCollection>>> {
  return RequestExecutor.executeCollection(root, {
    scriptRunner: TestRunner,
    captureVariables: capture,
  });
}

describe('running root-level scripts', () => {
  it('runs a collection pre-request script that used to be reported as skipped', async () => {
    const root = await collection({
      'collection.bru': `script:pre-request {\n  ${mark('C')}\n}\n`,
      'req.yml': request(),
    });

    const result = await run(root);

    expect(result.capturedVariables).toEqual({ order: 'C' });
    // And it no longer claims the script was ignored.
    expect((result.results?.[0] as { warnings?: string[] })?.warnings?.join(' ') ?? '')
      .not.toContain('not applied');
  });

  it('runs pre-request outermost first: collection, folder, request', async () => {
    const root = await collection({
      'collection.bru': `script:pre-request {\n  ${mark('C')}\n}\n`,
      'sub/folder.bru': `script:pre-request {\n  ${mark('F')}\n}\n`,
      'sub/req.yml': request([{ type: 'before-request', code: mark('R') }]),
    });

    expect((await run(root)).capturedVariables).toEqual({ order: 'CFR' });
  });

  it('nests folders from the collection downwards', async () => {
    const root = await collection({
      'collection.bru': `script:pre-request {\n  ${mark('C')}\n}\n`,
      'a/folder.bru': `script:pre-request {\n  ${mark('1')}\n}\n`,
      'a/b/folder.bru': `script:pre-request {\n  ${mark('2')}\n}\n`,
      'a/b/req.yml': request(),
    });

    expect((await run(root)).capturedVariables).toEqual({ order: 'C12' });
  });

  it('reverses post-response by default, because the default flow is sandwich', async () => {
    // Upstream's default when bruno.json says nothing: request first, then
    // folders innermost-first, then the collection.
    const root = await collection({
      'collection.bru': `script:post-response {\n  ${mark('C')}\n}\n`,
      'sub/folder.bru': `script:post-response {\n  ${mark('F')}\n}\n`,
      'sub/req.yml': request([{ type: 'after-response', code: mark('R') }]),
    });

    expect((await run(root)).capturedVariables).toEqual({ order: 'RFC' });
  });

  it('keeps post-response outermost-first when bruno.json asks for sequential', async () => {
    const root = await collection({
      'bruno.json': JSON.stringify({ version: '1', name: 'x', scripts: { flow: 'sequential' } }),
      'collection.bru': `script:post-response {\n  ${mark('C')}\n}\n`,
      'sub/folder.bru': `script:post-response {\n  ${mark('F')}\n}\n`,
      'sub/req.yml': request([{ type: 'after-response', code: mark('R') }]),
    });

    expect((await run(root)).capturedVariables).toEqual({ order: 'CFR' });
  });

  it('falls back to sandwich when bruno.json is unreadable rather than failing the run', async () => {
    const root = await collection({
      'bruno.json': '{ this is not json',
      'collection.bru': `script:post-response {\n  ${mark('C')}\n}\n`,
      'req.yml': request([{ type: 'after-response', code: mark('R') }]),
    });

    expect((await run(root)).capturedVariables).toEqual({ order: 'RC' });
  });

  it('runs every post-response script before any tests', async () => {
    // Phases, not layers. A folder post-response script parking a value for a
    // request test to read is a supported shape, and only works this way round.
    const root = await collection({
      'collection.bru': `script:post-response {\n  bru.setVar("parked", "from-collection");\n}\n`,
      'req.yml': request([
        { type: 'tests', code: 'bru.setVar("seen", bru.getVar("parked") || "nothing");' },
      ]),
    });

    expect((await run(root, ['seen'])).capturedVariables).toEqual({ seen: 'from-collection' });
  });

  it('runs a collection-level test and reports it in the results', async () => {
    const root = await collection({
      'collection.bru': 'tests {\n  test("collection says ok", function() {\n    expect(1).to.equal(1);\n  });\n}\n',
      'req.yml': request(),
    });

    const result = await run(root, []);

    const tests = (result.results?.[0] as { tests?: { description: string; status: string }[] })
      ?.tests ?? [];
    expect(tests.map((t) => t.description)).toContain('collection says ok');
    expect(tests.every((t) => t.status === 'pass')).toBe(true);
    expect(result.summary.passed).toBe(1);
  });

  it('lets two layers declare the same const without colliding', async () => {
    // This is what the per-segment closure buys. Without it the second `const
    // token` is a redeclaration and the whole program throws before either runs.
    const root = await collection({
      'collection.bru': `script:pre-request {\n  const token = "c";\n  ${mark('C')}\n}\n`,
      'req.yml': request([
        { type: 'before-request', code: `const token = "r"; ${mark('R')}` },
      ]),
    });

    expect((await run(root)).capturedVariables).toEqual({ order: 'CR' });
  });

  it('reads root scripts out of a .yml collection too', async () => {
    const root = await collection({
      'opencollection.yml': `info:\n  name: API\nrequest:\n  scripts:\n    - type: before-request\n      code: |\n        ${mark('C')}\n`,
      'req.yml': request([{ type: 'before-request', code: mark('R') }]),
    });

    expect((await run(root)).capturedVariables).toEqual({ order: 'CR' });
  });

  it('reads the string spelling of a .yml root as well as the typed list', async () => {
    const root = await collection({
      'opencollection.yml': `info:\n  name: API\nrequest:\n  script:\n    req: |\n      ${mark('C')}\n`,
      'req.yml': request([{ type: 'before-request', code: mark('R') }]),
    });

    expect((await run(root)).capturedVariables).toEqual({ order: 'CR' });
  });

  it('leaves a request with no root scripts sharing one scope, as it always has', async () => {
    // The one place this deliberately stops short of upstream: with no second
    // source there is nothing to isolate from, so the request's own
    // post-response script and its tests keep the single scope they have always
    // had here. A const declared in one is still visible to the other.
    const root = await collection({
      'req.yml': request([
        { type: 'after-response', code: 'const shared = "yes";' },
        { type: 'tests', code: 'bru.setVar("order", shared);' },
      ]),
    });

    expect((await run(root)).capturedVariables).toEqual({ order: 'yes' });
  });

  it('does not let a folder root reach a request outside that folder', async () => {
    const root = await collection({
      'sub/folder.bru': `script:pre-request {\n  ${mark('F')}\n}\n`,
      'sub/inside.yml': request([{ type: 'before-request', code: mark('R') }]),
      'outside.yml': `info:\n  name: outside\n  type: http\n  seq: 1\nhttp:\n  method: GET\n  url: "https://api.example.com/o"\nruntime:\n  scripts:\n    - type: before-request\n      code: |\n        bru.setVar("outsideOrder", "R");\n`,
    });

    const result = await run(root, ['order', 'outsideOrder']);

    expect(result.capturedVariables).toEqual({ order: 'FR', outsideOrder: 'R' });
  });
});
