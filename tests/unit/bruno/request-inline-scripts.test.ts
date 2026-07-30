/**
 * Round-trip tests for inline scripts on create_request / modify_request.
 *
 * Uses the REAL generators/parsers (yaml-generator, bru-parser, yaml-parser,
 * format-factory) with an in-memory fs so we can assert that scripts supplied
 * inline are persisted to the request file exactly as add_test_script would,
 * including alias normalization (before-request/after-response).
 */

import { createRequestBuilder } from '../../../src/bruno/request';
import { parseYamlRequest } from '../../../src/bruno/yaml-parser';
import { parseBruRequest } from '../../../src/bruno/bru-parser';

// In-memory fs
const store = new Map<string, string>();
// Writers now go through writeFileAtomic instead of a plain fs write. Route it
// back to the same fs mock so these tests keep asserting on the content and path
// written; the write mechanism itself is covered by the atomic-write suites.
jest.mock('../../../src/bruno/atomic-write.js', () => ({
  writeFileAtomic: (...args: unknown[]) =>
    (jest.requireMock('fs') as { promises: { writeFile: (...a: unknown[]) => Promise<void> } })
      .promises.writeFile(...args),
}));

jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(async (p: string) => {
      const key = typeof p === 'string' ? p : String(p);
      if (store.has(key)) return store.get(key);
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${key}`);
      err.code = 'ENOENT';
      throw err;
    }),
    writeFile: jest.fn(async (p: string, c: string) => {
      store.set(typeof p === 'string' ? p : String(p), c);
    }),
    access: jest.fn(async () => undefined),
    mkdir: jest.fn(async () => undefined),
  },
}));

// Only detectFormat is stubbed; generators/parsers are real.
jest.mock('../../../src/bruno/format-detector', () => ({
  detectFormat: jest.fn(),
}));
const { detectFormat } = require('../../../src/bruno/format-detector');

describe('inline scripts round-trip', () => {
  let builder = createRequestBuilder();

  beforeEach(() => {
    jest.clearAllMocks();
    store.clear();
    builder = createRequestBuilder();
  });

  const baseInput = {
    collectionPath: '/col',
    name: 'Get Users',
    method: 'GET' as const,
    url: 'https://api.example.com/users',
  };

  it('persists YAML inline scripts (pre-request/post-response/tests) so they round-trip', async () => {
    detectFormat.mockResolvedValue({ format: 'yaml' });

    const result = await builder.createRequest({
      ...baseInput,
      scripts: {
        'pre-request': 'req.setHeader("x-test", "1");',
        'post-response': 'test("status", () => expect(res.getStatus()).to.equal(200));',
        tests: 'test("body", () => expect(res.getBody()).to.be.ok);',
      },
    });

    expect(result.success).toBe(true);
    const content = store.get(result.path!)!;
    const parsed = parseYamlRequest(content);
    const scripts = parsed.runtime?.scripts ?? [];

    const before = scripts.filter(s => s.type === 'before-request');
    const after = scripts.filter(s => s.type === 'after-response');

    expect(before).toHaveLength(1);
    expect(before[0].code).toContain('req.setHeader("x-test", "1");');
    // Supplied together in one call, post-response and tests are merged into a
    // single after-response block rather than producing two competing writes.
    // (Written on their own, a tests script goes to the .yml `tests` slot.)
    expect(after).toHaveLength(1);
    expect(after[0].code).toContain('res.getStatus()');
    expect(after[0].code).toContain('res.getBody()');
  });

  // ── Regression: repeated updates must not accumulate duplicate blocks ───────

  it('replaces the tests script on update instead of appending a second block', async () => {
    detectFormat.mockResolvedValue({ format: 'yaml' });

    const created = await builder.createRequest({
      ...baseInput,
      scripts: { tests: 'test("AAA", () => {});' },
    });

    await builder.updateRequest(created.path!, {
      scripts: { tests: 'test("BBB", () => {});' },
    });

    const scripts = parseYamlRequest(store.get(created.path!)!).runtime?.scripts ?? [];
    const after = scripts.filter(s => s.type === 'tests');

    expect(after).toHaveLength(1);
    expect(after[0].code).toContain('BBB');
    expect(after[0].code).not.toContain('AAA');
  });

  it('is idempotent across repeated identical updates', async () => {
    detectFormat.mockResolvedValue({ format: 'yaml' });

    const created = await builder.createRequest({
      ...baseInput,
      scripts: { tests: 'test("AAA", () => {});' },
    });

    for (let i = 0; i < 3; i++) {
      await builder.updateRequest(created.path!, {
        scripts: { tests: 'test("SAME", () => {});' },
      });
    }

    const scripts = parseYamlRequest(store.get(created.path!)!).runtime?.scripts ?? [];
    expect(scripts.filter(s => s.type === 'tests')).toHaveLength(1);
  });

  it('accumulates blocks only when scriptMode is append', async () => {
    detectFormat.mockResolvedValue({ format: 'yaml' });

    const created = await builder.createRequest({
      ...baseInput,
      scripts: { tests: 'test("AAA", () => {});' },
    });

    await builder.updateRequest(created.path!, {
      scripts: { tests: 'test("BBB", () => {});' },
      scriptMode: 'append',
    });

    const scripts = parseYamlRequest(store.get(created.path!)!).runtime?.scripts ?? [];
    const after = scripts.filter(s => s.type === 'tests');

    expect(after).toHaveLength(2);
    expect(after.map(s => s.code).join('\n')).toContain('AAA');
    expect(after.map(s => s.code).join('\n')).toContain('BBB');
  });

  it('replaces only the targeted slot, leaving pre-request intact', async () => {
    detectFormat.mockResolvedValue({ format: 'yaml' });

    const created = await builder.createRequest({
      ...baseInput,
      scripts: {
        'pre-request': 'req.setHeader("x-keep", "1");',
        tests: 'test("AAA", () => {});',
      },
    });

    await builder.updateRequest(created.path!, {
      scripts: { tests: 'test("BBB", () => {});' },
    });

    const scripts = parseYamlRequest(store.get(created.path!)!).runtime?.scripts ?? [];
    expect(scripts.filter(s => s.type === 'before-request')[0].code).toContain('x-keep');
    expect(scripts.filter(s => s.type === 'tests')[0].code).toContain('BBB');
  });

  it('replaces the tests block in .bru files without touching post-response', async () => {
    detectFormat.mockResolvedValue({ format: 'bru' });

    const created = await builder.createRequest({
      ...baseInput,
      scripts: {
        'post-response': 'bru.setVar("keep", 1);',
        tests: 'test("AAA", () => {});',
      },
    });

    await builder.updateRequest(created.path!, {
      scripts: { tests: 'test("BBB", () => {});' },
    });

    // parseBruRequest exposes script bodies as { exec: string[] }
    const parsed = parseBruRequest(store.get(created.path!)!);
    const testsCode = JSON.stringify(parsed.tests);
    expect(testsCode).toContain('BBB');
    expect(testsCode).not.toContain('AAA');
    expect(JSON.stringify(parsed.script)).toContain('bru.setVar');
  });

  it('normalizes the after-response alias to a post-response (after-response) entry', async () => {
    detectFormat.mockResolvedValue({ format: 'yaml' });

    const result = await builder.createRequest({
      ...baseInput,
      scripts: {
        'after-response': 'test("aliased", () => expect(true).to.be.true);',
      },
    });

    expect(result.success).toBe(true);
    const parsed = parseYamlRequest(store.get(result.path!)!);
    const after = (parsed.runtime?.scripts ?? []).filter(s => s.type === 'after-response');
    expect(after).toHaveLength(1);
    expect(after[0].code).toContain('aliased');
  });

  it('persists .bru inline scripts so they round-trip', async () => {
    detectFormat.mockResolvedValue({ format: 'bru' });

    const result = await builder.createRequest({
      ...baseInput,
      scripts: {
        'pre-request': 'console.log("pre");',
        'post-response': 'console.log("post");',
      },
    });

    expect(result.success).toBe(true);
    const parsed = parseBruRequest(store.get(result.path!)!);
    expect(parsed.script?.['pre-request']?.exec.join('\n')).toContain('console.log("pre");');
    expect(parsed.script?.['post-response']?.exec.join('\n')).toContain('console.log("post");');
  });

  it('appends inline scripts on modify_request', async () => {
    detectFormat.mockResolvedValue({ format: 'yaml' });

    const created = await builder.createRequest(baseInput);
    expect(created.success).toBe(true);

    const updated = await builder.updateRequest(created.path!, {
      scripts: { 'pre-request': 'req.setHeader("y", "2");' },
    });

    expect(updated.success).toBe(true);
    const parsed = parseYamlRequest(store.get(created.path!)!);
    const before = (parsed.runtime?.scripts ?? []).filter(s => s.type === 'before-request');
    expect(before).toHaveLength(1);
    expect(before[0].code).toContain('req.setHeader("y", "2");');
  });
});
