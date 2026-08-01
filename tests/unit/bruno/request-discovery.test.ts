/**
 * Discovering what a run should execute.
 *
 * Two things are under test here. `.yaml` was recognised nowhere, so a
 * collection written with it enumerated as empty — no requests, no error. And
 * `resolveRunTargets` used to live inside the executor, which put the "is this a
 * request file" decision next to the execution loop instead of next to the walk
 * making the same decision; these pin the behaviour that moved.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverRequests, resolveRunTargets } from '../../../src/bruno/request-discovery';

let dir: string;

const YML = `info:
  name: R
  type: http
  seq: 1
http:
  method: GET
  url: https://api.test/x
`;

const BRU = `meta {
  name: R
  type: http
  seq: 1
}

get {
  url: https://api.test/x
}
`;

async function write(relPath: string, content: string): Promise<string> {
  const full = join(dir, relPath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content, 'utf-8');
  return full;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bruno-discovery-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('discoverRequests', () => {
  it('finds a .yaml request instead of reporting an empty collection', async () => {
    await write('Get.yaml', YML);

    const { requests, parseFailures } = await discoverRequests(dir);

    expect(parseFailures).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0].yaml.info.name).toBe('R');
    expect(requests[0].filePath.endsWith('.yaml')).toBe(true);
  });

  it('parses .yaml with the YAML parser, not the .bru one', async () => {
    // The failure this guards: `.yaml` falling through to the `.bru` branch
    // would report a parse failure for a perfectly good file.
    await write('Get.yaml', YML);

    const { requests } = await discoverRequests(dir);

    expect(requests[0].yaml.http.url).toBe('https://api.test/x');
  });

  it('warns that Bruno will not read the .yaml files it just read', async () => {
    await write('Get.yaml', YML);
    await write('Other.yml', YML);

    const { warnings } = await discoverRequests(dir);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Get.yaml');
    expect(warnings[0]).not.toContain('Other.yml');
  });

  it('says nothing when every request uses an extension Bruno reads', async () => {
    await write('Get.yml', YML);
    await write('Post.bru', BRU);

    const { requests, warnings } = await discoverRequests(dir);

    expect(requests).toHaveLength(2);
    expect(warnings).toEqual([]);
  });

  it('warns about a .yaml file that also failed to parse', async () => {
    // It is still a file to rename, and the parse failure does not explain why
    // Bruno cannot see it.
    await write('Broken.yaml', 'info: [unclosed');

    const { requests, parseFailures, warnings } = await discoverRequests(dir);

    expect(requests).toEqual([]);
    expect(parseFailures).toHaveLength(1);
    expect(warnings[0]).toContain('Broken.yaml');
  });

  it('still skips the collection and folder metadata files', async () => {
    await write('collection.bru', 'auth {\n  mode: none\n}\n');
    await write('sub/folder.bru', 'meta {\n  name: sub\n}\n');
    await write('sub/Get.yaml', YML);

    const { requests } = await discoverRequests(dir);

    expect(requests).toHaveLength(1);
    expect(requests[0].filePath.endsWith('Get.yaml')).toBe(true);
  });
});

describe('resolveRunTargets', () => {
  it('discovers the whole collection when no path is named', async () => {
    await write('Get.yml', YML);
    await write('Post.bru', BRU);

    const { requests } = await resolveRunTargets(undefined, dir);

    expect(requests).toHaveLength(2);
  });

  it('runs a single named .yaml request, and warns about it', async () => {
    const filePath = await write('Get.yaml', YML);

    const { requests, warnings } = await resolveRunTargets(filePath, dir);

    expect(requests).toHaveLength(1);
    expect(requests[0].filePath).toBe(filePath);
    expect(warnings[0]).toContain('Get.yaml');
  });

  it('runs a single named .bru request with nothing to warn about', async () => {
    const filePath = await write('Post.bru', BRU);

    const { requests, warnings, parseFailures } = await resolveRunTargets(filePath, dir);

    expect(requests).toHaveLength(1);
    expect(parseFailures).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('discovers a named directory rather than treating it as a file', async () => {
    await write('sub/Get.yml', YML);
    await write('Top.yml', YML);

    const { requests } = await resolveRunTargets(join(dir, 'sub'), dir);

    // Scoped to the directory named, not the whole collection.
    expect(requests).toHaveLength(1);
    expect(requests[0].filePath.includes('sub')).toBe(true);
  });

  it('throws for a named file that is not a request at all', async () => {
    const filePath = await write('notes.md', '# not a request');

    await expect(resolveRunTargets(filePath, dir)).rejects.toThrow(
      /Unsupported request file format/,
    );
  });

  it('throws naming the file when a single named request will not parse', async () => {
    // A named request that will not parse is a hard failure, not a tally:
    // nothing else was asked for, so there is no partial run to report.
    const filePath = await write('Broken.bru', 'meta {\n  unclosed: yes\n');

    await expect(resolveRunTargets(filePath, dir)).rejects.toThrow(/Broken\.bru/);
  });

  it('throws for a path that does not exist', async () => {
    await expect(resolveRunTargets(join(dir, 'nope'), dir)).rejects.toThrow();
  });

  it('warns when a named directory holds no runnable requests', async () => {
    // Zero requests, zero failures and no explanation reads as a pass, which is
    // how a misaimed subset hides.
    await mkdir(join(dir, 'Empty'));

    const { requests, warnings } = await resolveRunTargets(join(dir, 'Empty'), dir);

    expect(requests).toHaveLength(0);
    expect(warnings.join('\n')).toContain('No runnable requests were found');
    expect(warnings.join('\n')).toContain(join(dir, 'Empty'));
  });

  it('warns when the whole collection holds no runnable requests', async () => {
    const { requests, warnings } = await resolveRunTargets(undefined, dir);

    expect(requests).toHaveLength(0);
    expect(warnings.join('\n')).toContain('No runnable requests were found');
  });

  it('does not warn when the directory does hold requests', async () => {
    await write('sub/Get.yml', YML);

    const { requests, warnings } = await resolveRunTargets(join(dir, 'sub'), dir);

    expect(requests).toHaveLength(1);
    expect(warnings.join('\n')).not.toContain('No runnable requests were found');
  });
});
