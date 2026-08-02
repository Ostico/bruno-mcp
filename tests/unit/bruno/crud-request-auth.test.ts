/**
 * What auth a generated CRUD set is born with.
 *
 * `createCrudRequests` took no auth at all, so all five files were written with
 * an explicit `auth: none`. That is not an absence of opinion — in both dialects
 * it is an opt-OUT that stops the collection's own auth block from applying, so
 * a generated set against an authenticated API returned 401 on every request
 * until each file was edited by hand. The default is now `inherit`, which is
 * what Bruno's own new-request path uses (`auth ?? { mode: 'inherit' }` in
 * bruno-app's collections actions).
 *
 * These read the bytes on disk rather than what the builder was called with:
 * `inherit` is declared by a line in the http block and by the *absence* of an
 * auth block, so a test that inspects the intermediate object can agree with
 * itself while the file says something else.
 */
import { promises as fs } from 'fs';
import { join, sep } from 'path';
import { tmpdir } from 'os';
import { createCollectionManager } from '../../../src/bruno/collection.js';
import { createRequestBuilder } from '../../../src/bruno/request.js';
import type { FileOperationResult } from '../../../src/bruno/types.js';

const builder = createRequestBuilder();
const collections = createCollectionManager();

/** A collection in the given dialect, returning its root. */
async function collection(format: 'yaml' | 'bru'): Promise<string> {
  const parent = await fs.mkdtemp(join(tmpdir(), `crud-auth-${format}-`));
  const result = await collections.createCollection({
    name: 'API',
    outputPath: parent,
    format,
  });
  expect(result.success).toBe(true);
  return join(parent, 'API');
}

/** The bytes of all five generated files, keyed by the path actually written. */
async function generated(results: FileOperationResult[]): Promise<string[]> {
  expect(results).toHaveLength(5);
  expect(results.every((r) => r.success)).toBe(true);
  // The writer lowercases filenames, so the path is read back off the result
  // rather than rebuilt from the request name.
  return Promise.all(results.map((r) => fs.readFile(r.path!, 'utf-8')));
}

describe.each(['yaml', 'bru'] as const)('CRUD auth in a %s collection', (format) => {
  it('writes inherit into all five files when no auth is given', async () => {
    const root = await collection(format);

    const files = await generated(
      await builder.createCrudRequests(root, 'User', 'https://api.example.com'),
    );

    for (const contents of files) {
      expect(contents).toMatch(/auth:\s*inherit/);
      expect(contents).not.toMatch(/auth:\s*none/);
    }
  });

  it('still writes none when a caller asks for it', async () => {
    // The opt-out has to remain reachable; it just stops being what you get by
    // saying nothing. The two dialects spell it differently — `.bru` writes the
    // word, `.yml` writes no auth key at all — and both mean the same thing to
    // the runner, which returns no credential for an absent auth and does not
    // fall back to the collection (`applyAuth`: `if (!auth) return undefined`).
    const root = await collection(format);

    const files = await generated(
      await builder.createCrudRequests(root, 'User', 'https://api.example.com', undefined, {
        type: 'none',
        config: {},
      }),
    );

    for (const contents of files) {
      expect(contents).not.toMatch(/auth:\s*inherit/);
      if (format === 'bru') {
        expect(contents).toMatch(/auth:\s*none/);
      } else {
        expect(contents).not.toMatch(/^\s*auth:/m);
      }
    }
  });

  it('applies a real auth mode to every request, not just the first', async () => {
    const root = await collection(format);

    const files = await generated(
      await builder.createCrudRequests(root, 'User', 'https://api.example.com', undefined, {
        type: 'bearer',
        config: { token: '{{access_token}}' },
      }),
    );

    for (const contents of files) {
      // `.bru` names the mode on one line and carries the token in its own
      // `auth:bearer` block; `.yml` nests both under a single mapping.
      expect(contents).toMatch(/(auth:\s*bearer|type:\s*bearer)/);
      expect(contents).toContain('{{access_token}}');
    }
  });

  it('puts the set in the folder it was asked for', async () => {
    const root = await collection(format);

    const results = await builder.createCrudRequests(
      root,
      'User',
      'https://api.example.com',
      'users',
    );

    await generated(results);
    for (const result of results) {
      expect(result.path).toContain(`${join(root, 'users')}${sep}`);
    }
  });
});
