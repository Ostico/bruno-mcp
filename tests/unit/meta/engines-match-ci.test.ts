/**
 * The declared Node floor and the versions CI actually runs must agree.
 *
 * They did not: `engines` claimed `>=18.0.0` while the matrix had only run
 * 22.x and 24.x for a long time, so the declared floor was a promise nothing
 * kept. A caller on Node 18 would have been told they were supported by a
 * number no run had ever exercised.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(__dirname, '..', '..', '..');

const majorOf = (version: string): number => {
  const match = /(\d+)/.exec(version);
  if (!match) throw new Error(`Unparseable version: ${version}`);
  return Number(match[1]);
};

const readPackage = async (): Promise<{
  engines: { node: string };
  devDependencies: Record<string, string>;
}> => JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

describe('the declared Node floor', () => {
  it('is no lower than the lowest version CI runs', async () => {
    const pkg = await readPackage();
    const ci = await readFile(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

    const declared = majorOf(pkg.engines.node);
    const matrix = /node-version:\s*\[([^\]]+)\]/.exec(ci);
    expect(matrix).not.toBeNull();

    const tested = matrix![1]!.split(',').map((v) => majorOf(v.trim()));
    expect(Math.min(...tested)).toBeGreaterThanOrEqual(declared);
  });

  it('is at least 22, since Node 20 is end-of-life', async () => {
    const pkg = await readPackage();

    expect(majorOf(pkg.engines.node)).toBeGreaterThanOrEqual(22);
  });

  it('declares an @types/node major no lower than the floor', async () => {
    // A floor of 22 with `@types/node@^20` types away APIs that are present at
    // run time, and admits ones that are not.
    const pkg = await readPackage();

    expect(majorOf(pkg.devDependencies['@types/node']!)).toBeGreaterThanOrEqual(
      majorOf(pkg.engines.node),
    );
  });
});
