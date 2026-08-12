/**
 * server.json is what lists this package on the MCP registry, and every value in
 * it has to agree with package.json.
 *
 * The registry proves we own the npm package by fetching the published manifest
 * and requiring `mcpName` to equal the server name, character for character. A
 * mismatch is not caught by anything local: it surfaces as a 4xx from the
 * registry after the tag is already pushed and npm has already published, at
 * which point the version number is spent and the fix needs a new release.
 *
 * The two version fields are stamped from the tag during the release run, so
 * what is committed here is documentation rather than the value that ships.
 * Left unchecked it goes stale, which is exactly how the version the server
 * reports on connect drifted two releases behind — see
 * version-matches-package.test.ts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..', '..', '..');

interface ServerManifest {
  name: string;
  version: string;
  description: string;
  packages: {
    registryType: string;
    identifier: string;
    version: string;
  }[];
}

const manifest = JSON.parse(
  readFileSync(join(repoRoot, 'server.json'), 'utf8'),
) as ServerManifest;

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  mcpName?: string;
};

describe('the MCP registry manifest', () => {
  it('claims the npm package this repository publishes', () => {
    expect(manifest.packages).toHaveLength(1);
    expect(manifest.packages[0].registryType).toBe('npm');
    expect(manifest.packages[0].identifier).toBe(pkg.name);
  });

  it('is claimed back by package.json, which is how the registry proves ownership', () => {
    expect(pkg.mcpName).toBe(manifest.name);
  });

  it('is published under the namespace GitHub OIDC grants this repository', () => {
    // The registry grants `io.github.<repository_owner>/*` from the OIDC claim
    // and matches it against the server name with a case-sensitive prefix test,
    // so the owner segment has to carry GitHub's own capitalisation.
    expect(manifest.name.startsWith('io.github.Ostico/')).toBe(true);
  });

  it('agrees with package.json on the version', () => {
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.packages[0].version).toBe(pkg.version);
  });

  it('keeps the description inside the length the registry accepts', () => {
    // Measured, not guessed. Publishing 2.3.0 returned
    //   422 { "message": "expected length <= 100", "location": "body.description" }
    // for a 126-character description, after the tag had fired and npm had already
    // published. The npm description is a separate field with no such limit, so
    // there is nothing to keep the two in step and nothing else to notice this.
    expect(manifest.description.length).toBeLessThanOrEqual(100);
    // Non-empty as well: the registry has this description and the package has its
    // own, so an empty one here would list the server with no summary at all.
    expect(manifest.description.trim().length).toBeGreaterThan(0);
  });
});
