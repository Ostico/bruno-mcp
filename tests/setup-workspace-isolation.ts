/**
 * Points every test file's workspace registry at a throwaway file.
 *
 * `create_collection` registers what it creates, and the workspace it resolves by
 * default is the Bruno app's own — on a machine with Bruno installed, that is the
 * developer's real registry. Suites that create collections in temp directories
 * were therefore writing an entry per run into that file, and since the temp
 * directory is gone by the next run, `list_collections` filled with entries
 * reporting `exists: false`. Forty-five had accumulated in one checkout before
 * anybody noticed.
 *
 * The redirect is unconditional. Honouring an inherited BRUNO_WORKSPACE_PATH
 * would point the suite at whichever registry the developer had configured, which
 * is the file this exists to protect; a test that needs a particular workspace
 * sets the variable itself, inside the test, and restores it afterwards.
 *
 * One directory per test file, because jest runs files in parallel workers and a
 * shared registry would have several of them appending to one file at once.
 *
 * The file is written, not merely named: the registrar declines to invent a
 * workspace that is not there, so an absent file would turn every registration
 * into a skip and the suites would quietly stop covering the path they exist to
 * cover.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const directory = mkdtempSync(join(tmpdir(), 'bruno-mcp-test-workspace-'));
const workspacePath = join(directory, 'workspace.yml');

// The shape the app writes, reduced to what anything reads: a block-style
// `collections` key for the registrar to extend.
writeFileSync(
  workspacePath,
  'opencollection: 1.0.0\ninfo:\n  name: "bruno-mcp tests"\n  type: workspace\n\ncollections:\n',
  'utf-8',
);

process.env.BRUNO_WORKSPACE_PATH = workspacePath;

process.on('exit', () => {
  rmSync(directory, { recursive: true, force: true });
});
