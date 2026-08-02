/**
 * The flat `results` array is gone; every caller reads `groups[].results`, in
 * the single-implicit-group case too. Conditional flattening would force every
 * caller to branch on whether they passed groups.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestExecutor } from '../../../src/bruno/request-executor';
import { TestRunner } from '../../../src/bruno/test-runner';

// The executor validates every URL for SSRF, and `example.test` does not
// resolve. What is under test here is grouping, not the validator.
jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
  ssrfRemediation: jest.fn().mockReturnValue(''),
}));


describe('the shape of a run result', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'shape-'));
    await writeFile(
      join(root, 'one.bru'),
      'meta {\n  name: one\n  type: http\n  seq: 1\n}\n\nget {\n  url: https://example.test/one\n}\n',
    );
    global.fetch = jest.fn().mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    ) as never;
  });

  it('always nests results under a group, even with no groups given', async () => {
    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: TestRunner,
    });

    expect(result).not.toHaveProperty('results');
    expect(Array.isArray(result.groups)).toBe(true);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.index).toBe(0);
    expect(result.groups[0]!.results).toHaveLength(1);
  });

  it('summarises per group and across the run', async () => {
    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: TestRunner,
    });

    expect(result.summary.total).toBe(1);
    expect(result.groups[0]!.summary.total).toBe(1);
  });

  it('leaves an unnamed group unnamed rather than inventing a name', async () => {
    // `index` is what makes it addressable; a synthesised "Group 0" would read
    // as something the caller passed.
    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: TestRunner,
    });

    expect(result.groups[0]!.name).toBeUndefined();
  });
});
