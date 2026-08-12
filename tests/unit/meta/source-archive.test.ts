/**
 * What `git archive` puts in a source archive.
 *
 * The `export-ignore` attributes in `.gitattributes` decide what GitHub serves as
 * "Download ZIP" and as the source tarball on every release. Two things can quietly
 * undo them: the repository's `.gitignore` starts with `.*`, so an un-ignored
 * `.gitattributes` is not an error but simply never takes effect; and a new top-level
 * directory is included by default, so the archive grows without anybody deciding it
 * should. Both are silent, and neither shows up anywhere except in an archive nobody
 * builds locally — hence these tests.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const repoRoot = join(__dirname, '../../..');

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

/** The top-level entries an archive is meant to carry: enough to build and run. */
const SHIPPED = [
  'CHANGELOG.md',
  'INTEGRATION.md',
  'LICENSE',
  'README.md',
  'package-lock.json',
  'package.json',
  'server.json',
  'src',
  'tsconfig.json',
];

/**
 * The paths of a source archive of HEAD, top level only.
 *
 * Attributes are read from the working tree rather than from HEAD so that an edit to
 * `.gitattributes` is what this test measures. The file contents still come from HEAD,
 * which is why a newly added and uncommitted file will not appear here.
 */
function archiveTopLevel(): Set<string> {
  const tar = execFileSync('git', ['archive', '--worktree-attributes', '--format=tar', 'HEAD'], {
    cwd: repoRoot,
    maxBuffer: 128 * 1024 * 1024,
  });
  const listed = execFileSync('tar', ['tf', '-'], {
    input: tar,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  return new Set(
    listed
      .split('\n')
      .filter((path) => path !== '')
      .map((path) => path.split('/')[0]),
  );
}

describe('the source archive', () => {
  it('is not silently disarmed by the `.*` rule in .gitignore', () => {
    // `git check-ignore` exits 0 when a path is ignored and 1 when it is not, so the
    // absence of output is the assertion. An ignored `.gitattributes` still sits in the
    // working tree and still reads correctly — it just governs nothing.
    let ignored = '';
    try {
      ignored = git('check-ignore', '--no-index', '--', '.gitattributes');
    } catch {
      ignored = '';
    }

    expect(ignored).toBe('');
    expect(git('ls-files', '--', '.gitattributes').trim()).toBe('.gitattributes');
  });

  it('carries what it takes to build and run the server', () => {
    const shipped = archiveTopLevel();

    for (const entry of SHIPPED) {
      expect([entry, [...shipped].includes(entry)]).toEqual([entry, true]);
    }
  });

  it('leaves out the repository-only material', () => {
    const shipped = archiveTopLevel();

    // Listed individually rather than as "everything not in SHIPPED", because the point
    // of each of these is different: the test suite is the bulk, `docs` and `SPEC.md` are
    // for whoever changes the server, `.github` cannot act from inside an archive.
    for (const entry of ['tests', 'docs', 'examples', '.github', 'CLAUDE.md', 'CONTRIBUTING.md', 'SPEC.md', 'jest.config.ts']) {
      expect([entry, [...shipped].includes(entry)]).toEqual([entry, false]);
    }
  });

  it('classifies every tracked top-level entry one way or the other', () => {
    // The guard that matters over time: a directory added later is shipped by default,
    // and nothing else would ever say so. Failing here is a prompt to decide, not a bug.
    const tracked = new Set(
      git('ls-files')
        .split('\n')
        .filter((path) => path !== '')
        .map((path) => path.split('/')[0]),
    );
    const shipped = archiveTopLevel();
    const excluded = new Set(
      git('check-attr', 'export-ignore', '--', ...[...tracked].map((entry) => `${entry}/`), ...tracked)
        .split('\n')
        .filter((line) => line.endsWith(': export-ignore: set'))
        .map((line) => line.slice(0, line.indexOf(': export-ignore: set')).replace(/\/$/, '')),
    );

    const unclassified = [...tracked].filter(
      (entry) => !SHIPPED.includes(entry) && !excluded.has(entry),
    );

    expect(unclassified).toEqual([]);
    // And the two agree: nothing is marked excluded yet present in the archive.
    expect([...excluded].filter((entry) => shipped.has(entry))).toEqual([]);
  });
});
