/**
 * The `.yml` `tests` script slot, write side.
 *
 * Bruno's .yml dialect has THREE runtime script slots, not two: alongside
 * `before-request` and `after-response` it stores a test script under
 * `type: tests`, and reads that entry back into the request's own `tests`
 * block. A test script written into `after-response` instead lands in Bruno's
 * `script.res`, which is a different slot in Bruno's editor and a different
 * field in its data model.
 *
 * These tests read the bytes that reach disk rather than round-tripping through
 * this project's own parser, which tolerates output Bruno would not accept.
 */

import * as fs from 'node:fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { parse as parseYamlDirect } from 'yaml';
import { createWriter, mapScriptType } from '../../../src/bruno/format-factory';
import { generateYamlRequest } from '../../../src/bruno/yaml-generator';
import { writeFileAtomic } from '../../../src/bruno/atomic-write';
import type { YamlRequest } from '../../../src/bruno/types';

const BARE_REQUEST_YML = `info:
  name: Checked Call
  type: http
  seq: 1
http:
  method: GET
  url: https://api.example.com/status
`;

const TEST_SCRIPT = 'test("is ok", function() { expect(res.getStatus()).to.equal(200); });';

/** Write `content` to a fresh temp file and read back what actually landed. */
async function writeAndReadBack(content: string): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'bruno-yml-tests-slot-'));
  const file = join(dir, 'Checked Call.yml');
  try {
    await writeFileAtomic(file, content);
    return await fs.readFile(file, 'utf-8');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('.yml tests script slot (write side)', () => {
  it('maps the tests script type to Bruno\'s own tests slot', () => {
    expect(mapScriptType('tests', 'yaml')).toBe('tests');
  });

  it('keeps post-response and tests as distinct slots', () => {
    expect(mapScriptType('post-response', 'yaml')).toBe('after-response');
    expect(mapScriptType('tests', 'yaml')).not.toBe(
      mapScriptType('post-response', 'yaml'),
    );
  });

  it('writes an injected tests script to disk under type: tests', async () => {
    const writer = createWriter('yaml');
    const updated = writer.injectScript(
      BARE_REQUEST_YML,
      'tests',
      TEST_SCRIPT,
      'append',
    );

    const onDisk = await writeAndReadBack(updated);

    // The bytes themselves, not a re-parse through this project's parser.
    expect(onDisk).toContain('type: tests');
    expect(onDisk).not.toContain('after-response');

    // The shape Bruno's own YAML reader sees.
    const doc = parseYamlDirect(onDisk) as {
      runtime: { scripts: Array<{ type: string; code: string }> };
    };
    expect(doc.runtime.scripts).toEqual([
      { type: 'tests', code: TEST_SCRIPT },
    ]);
  });

  it('keeps a post-response and a tests script as two separate entries', async () => {
    const writer = createWriter('yaml');
    const withPost = writer.injectScript(
      BARE_REQUEST_YML,
      'post-response',
      'bru.setVar("t", res.getStatus());',
      'append',
    );
    const withBoth = writer.injectScript(withPost, 'tests', TEST_SCRIPT, 'append');

    const onDisk = await writeAndReadBack(withBoth);
    const doc = parseYamlDirect(onDisk) as {
      runtime: { scripts: Array<{ type: string; code: string }> };
    };

    expect(doc.runtime.scripts).toEqual([
      { type: 'after-response', code: 'bru.setVar("t", res.getStatus());' },
      { type: 'tests', code: TEST_SCRIPT },
    ]);
  });

  it('replaces only the tests entry, leaving after-response intact', async () => {
    const writer = createWriter('yaml');
    let content = writer.injectScript(
      BARE_REQUEST_YML,
      'post-response',
      'bru.setVar("t", res.getStatus());',
      'append',
    );
    content = writer.injectScript(content, 'tests', 'test("old", function() {});', 'append');
    content = writer.injectScript(content, 'tests', TEST_SCRIPT, 'replace');

    const onDisk = await writeAndReadBack(content);
    const doc = parseYamlDirect(onDisk) as {
      runtime: { scripts: Array<{ type: string; code: string }> };
    };

    expect(doc.runtime.scripts).toHaveLength(2);
    expect(doc.runtime.scripts).toContainEqual({
      type: 'after-response',
      code: 'bru.setVar("t", res.getStatus());',
    });
    expect(doc.runtime.scripts).toContainEqual({ type: 'tests', code: TEST_SCRIPT });
    expect(onDisk).not.toContain('test("old"');
  });

  it('removes only the tests entry, leaving after-response intact', async () => {
    const writer = createWriter('yaml');
    let content = writer.injectScript(
      BARE_REQUEST_YML,
      'post-response',
      'bru.setVar("t", res.getStatus());',
      'append',
    );
    content = writer.injectScript(content, 'tests', TEST_SCRIPT, 'append');
    content = writer.removeScript(content, 'tests');

    const onDisk = await writeAndReadBack(content);
    const doc = parseYamlDirect(onDisk) as {
      runtime: { scripts: Array<{ type: string; code: string }> };
    };

    expect(doc.runtime.scripts).toEqual([
      { type: 'after-response', code: 'bru.setVar("t", res.getStatus());' },
    ]);
  });

  it('emits a modelled tests script rather than dropping it', async () => {
    const request: YamlRequest = {
      info: { name: 'Checked Call', type: 'http', seq: 1 },
      http: { method: 'GET', url: 'https://api.example.com/status' },
      runtime: { scripts: [{ type: 'tests', code: TEST_SCRIPT }] },
    };

    const onDisk = await writeAndReadBack(generateYamlRequest(request));

    expect(onDisk).toContain('type: tests');
    const doc = parseYamlDirect(onDisk) as {
      runtime: { scripts: Array<{ type: string; code: string }> };
    };
    expect(doc.runtime.scripts).toEqual([{ type: 'tests', code: TEST_SCRIPT }]);
  });
});
