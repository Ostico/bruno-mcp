/**
 * The version the server reports on connect and the version in package.json.
 *
 * Both are hand-maintained and they had already drifted two releases apart once,
 * which is invisible from inside a run: the client is simply told the wrong
 * version, and every bug report filed against it names a release that does not
 * contain the code being reported on.
 *
 * Read as text rather than imported, because the value is a literal inside the
 * server constructor and importing the module would stand a server up.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..', '..', '..');

describe('the reported server version', () => {
  it('matches the version in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    const source = readFileSync(join(repoRoot, 'src', 'server.ts'), 'utf8');

    const declared = /version:\s*'([^']+)'/.exec(source);

    expect(declared).not.toBeNull();
    expect(declared?.[1]).toBe(pkg.version);
  });
});
