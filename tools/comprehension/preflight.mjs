/**
 * The harness testing itself, before it spends money testing the surface.
 *
 * This replaces what were two model-facing controls: trials that removed one
 * sentence from the surface and were expected to fail because of it. Both of
 * them passed. Gutting "Must be true. Every file in filePaths is deleted
 * permanently." changed nothing, because the field is a `z.literal(true)` and
 * the JSON schema says `const: true` on its own; gutting "Write several requests
 * in one call." changed nothing either, because a field that takes an array of
 * request items already says that by its shape. Neither sentence was carrying a
 * fact, which is a finding about the prose rather than a fault in the harness —
 * but a control that is supposed to fail and does not would make every run void.
 *
 * So the self-test is deterministic instead, and costs no model calls. It proves
 * the two things a control was there to prove:
 *
 *   1. A gutted bundle really does serve a surface with the sentence missing,
 *      and still starts — so a gut is a real intervention and not a no-op.
 *   2. The grader fails the calls it is supposed to fail — so a run of passes
 *      is not the grader passing everything.
 *
 * What it does not prove is that any given sentence changes what a model does.
 * Nothing here can prove that; only a trial can, and the two attempts above are
 * the evidence that a sentence has to be chosen carefully to make one.
 */
import { promises as fs } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { openServer } from './fixtures/mcp-client.mjs';
import { gradeTrial, CLASS } from './grade.mjs';

/**
 * A sentence to remove, and where to look for it.
 *
 * Chosen for being long, unique and unmistakably prose, not for being
 * load-bearing: this check asks whether removing it reaches the served surface,
 * not whether anyone needed it.
 */
const PROBE = 'Values for :name segments in the URL';

/** The surface as a caller receives it, from a server at `serverPath`. */
async function surfaceOf(serverPath, env) {
  const server = openServer(serverPath, env);
  try {
    await server.start();
    return JSON.stringify(await server.listTools());
  } finally {
    server.close();
  }
}

/** Both directions of the gut: present before, absent after, server alive in both. */
async function checkGutReachesTheSurface(serverPath, root) {
  const env = { BRUNO_WORKSPACE_PATH: join(root, 'workspace.yml') };
  await fs.writeFile(
    env.BRUNO_WORKSPACE_PATH,
    'opencollection: 1.0.0\ninfo:\n  name: "Preflight"\n  type: workspace\n\ncollections: []\n',
    'utf8',
  );

  const before = await surfaceOf(serverPath, env);
  if (!before.includes(PROBE)) {
    throw new Error(`preflight: the surface does not contain ${JSON.stringify(PROBE)}; update PROBE`);
  }

  const source = await fs.readFile(serverPath, 'utf8');
  if (!source.includes(PROBE)) {
    throw new Error('preflight: the bundle does not contain the probe sentence the surface serves');
  }
  // Beside the real entry point for the same reason a trial's gut is: the build
  // resolves its chunks relatively and its dependencies by walking up to
  // node_modules, and a copy anywhere else starts and then dies.
  const gutted = join(dirname(serverPath), `preflight-${basename(serverPath)}`);
  try {
    await fs.writeFile(gutted, source.split(PROBE).join(' '), 'utf8');
    const after = await surfaceOf(gutted, env);
    if (after.includes(PROBE)) {
      throw new Error('preflight: a gutted bundle still served the sentence — gutting is a no-op');
    }
    if (!after.includes('write_request')) {
      throw new Error('preflight: a gutted bundle served no write_request — the gut broke the server');
    }
  } finally {
    await fs.rm(gutted, { force: true });
  }
}

/** The grader bites: each class fires on a case built to trip it. */
async function checkGraderFails(root) {
  const collection = join(root, 'graded');
  await fs.mkdir(collection, { recursive: true });
  await fs.writeFile(join(collection, 'kept.yml'), 'info:\n  name: Kept\n', 'utf8');

  const call = (name, input) => ({ name: `mcp__bruno-mcp__${name}`, input });
  const cases = [
    {
      why: 'a tool error is class 1',
      task: { expect: { tool: 'write_request' } },
      trial: { calls: [call('write_request', {})], toolErrors: ['refused: Required at url'] },
      want: CLASS.TOOL_ERROR,
    },
    {
      why: 'never calling the tool is class 3',
      task: { expect: { tool: 'write_request' } },
      trial: { calls: [call('list_requests', {})], toolErrors: [] },
      want: CLASS.AVOIDANCE,
    },
    {
      why: 'a file that should be gone and is not is class 2',
      task: { expect: { tool: 'delete_request', absent: ['kept.yml'] } },
      trial: { calls: [call('delete_request', { filePaths: ['kept.yml'], confirm: true })], toolErrors: [] },
      want: CLASS.SILENT_WRONG,
    },
    {
      why: 'arguments missing what was asked for is class 2',
      task: { expect: { tool: 'write_request', argsInclude: { auth: { type: 'inherit' } } } },
      trial: { calls: [call('write_request', { auth: { type: 'bearer' } })], toolErrors: [] },
      want: CLASS.SILENT_WRONG,
    },
    {
      why: 'one call per item where a field takes a list is class 2',
      task: { expect: { tool: 'write_request', maxCalls: 1 } },
      trial: { calls: [call('write_request', {}), call('write_request', {})], toolErrors: [] },
      want: CLASS.SILENT_WRONG,
    },
    {
      why: 'a correct call passes',
      task: { expect: { tool: 'write_request', file: 'kept.yml', contains: ['name: Kept'] } },
      trial: { calls: [call('write_request', {})], toolErrors: [] },
      want: CLASS.PASS,
    },
  ];

  for (const { why, task, trial, want } of cases) {
    const graded = await gradeTrial(task, { ...trial, root: collection });
    if (graded.klass !== want) {
      throw new Error(`preflight: ${why} — graded ${graded.klass}, wanted ${want}: ${graded.diagnosis ?? ''}`);
    }
  }
}

/** Throws with a reason if the harness cannot be trusted to measure anything. */
export async function preflight(serverPath) {
  const root = await mkdtemp(join(tmpdir(), 'bruno-comprehension-preflight-'));
  try {
    await checkGutReachesTheSurface(serverPath, root);
    await checkGraderFails(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && process.argv[1].endsWith('preflight.mjs')) {
  const serverPath = process.argv[2];
  if (!serverPath) throw new Error('usage: node preflight.mjs <path to dist/index.js>');
  await preflight(serverPath);
  process.stdout.write('preflight ok\n');
}
