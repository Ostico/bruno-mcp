/**
 * Run the comprehension trials and report what failed, and why.
 *
 * Every trial is one fresh model, one fresh working directory, and the tool
 * surface as its only source of knowledge about this server. The point is not a
 * score: it is a per-failure diagnosis naming the field whose wording was at
 * fault, because compressing descriptions is a search and a search needs a
 * gradient.
 *
 * Usage:
 *   node tools/comprehension/run.mjs --server "$PWD/dist/index.js" \
 *     --trials 30 --out tools/comprehension/reference.json
 *
 * Options:
 *   --server PATH     the built server to drive (required)
 *   --trials N        total trials; the task set repeats in weight order
 *   --out FILE        where to write the JSON report
 *   --concurrency K   trials in flight (default 4)
 *   --only a,b,c      run only these task ids
 *   --model ID        override the model (default Haiku 4.5)
 *   --keep            leave the trial directories on disk for inspection
 */

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFixtureServer } from './fixtures/http-server.mjs';
import { buildShop } from './fixtures/shop.mjs';
import { gradeTrial, CLASS } from './grade.mjs';
import { preflight } from './preflight.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Every tool the CLI offers that is not this server.
 *
 * An allow-list alone is not enough: a non-allowed tool is still *offered* to
 * the model, which then spends a turn being refused, and ToolSearch will hand it
 * more. Naming them all as disallowed is what makes the surface under test the
 * only way to get the job done.
 */
const DENIED_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Task', 'Agent', 'Monitor', 'ToolSearch', 'Skill',
  'Artifact', 'SlashCommand', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
  'TaskOutput', 'TaskStop', 'CronCreate', 'CronList', 'CronDelete', 'SendMessage',
  'ListAgents', 'EnterWorktree', 'ExitWorktree', 'Workflow', 'AskUserQuestion',
  'ScheduleWakeup', 'KillShell', 'BashOutput', 'DesignSync', 'PushNotification',
  'RemoteTrigger', 'ReportFindings', 'ShareOnboardingGuide', 'EnterPlanMode',
  'ExitPlanMode', 'ListMcpResourcesTool', 'ReadMcpResourceTool',
];

function parseArgs(argv) {
  const args = { trials: 0, concurrency: 4, model: DEFAULT_MODEL };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--server') { args.server = value; index += 1; }
    else if (flag === '--trials') { args.trials = Number(value); index += 1; }
    else if (flag === '--out') { args.out = value; index += 1; }
    else if (flag === '--concurrency') { args.concurrency = Number(value); index += 1; }
    else if (flag === '--only') { args.only = value.split(','); index += 1; }
    else if (flag === '--model') { args.model = value; index += 1; }
    else if (flag === '--tasks') { args.tasks = value; index += 1; }
    else if (flag === '--keep') { args.keep = true; }
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!args.server) throw new Error('--server is required');
  return args;
}

/**
 * Redact anything a trial artefact could carry out of this machine.
 *
 * The prompts are authored here and name only the fixture server, but the
 * recorded call arguments are whatever the model passed, and the paths in them
 * are real. GitGuardian catches shaped credentials; it does not catch a home
 * directory or an internal hostname.
 */
function sanitise(text, { root, baseUrl }) {
  return String(text)
    .split(root).join('<trial>')
    .split(baseUrl).join('<fixture>')
    // The host and port on their own too: a model writes them into its prose
    // without the scheme, and `baseUrl` alone then misses them.
    .split(baseUrl.replace(/^https?:\/\//, '')).join('<fixture>')
    .split(homedir()).join('<home>')
    .split(tmpdir()).join('<tmp>')
    .replace(/(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,})/g, '<redacted>');
}

/**
 * A copy of the server bundle with one description string blanked out.
 *
 * The positive control: a gate that cannot fail is theatre, and the only honest
 * way to show this one can is to take away a sentence the task depends on and
 * watch the same task fail. Done on a copy of the built bundle, so no production
 * code carries a switch that exists for the harness.
 */
async function gutBundle(serverPath, substring, index) {
  const source = await fs.readFile(serverPath, 'utf8');
  if (!source.includes(substring)) {
    throw new Error(`Cannot gut: the bundle does not contain ${JSON.stringify(substring)}`);
  }
  // Beside the real entry point, not off in the trial directory. The build is
  // not self-contained in either direction: it imports its own chunks by
  // relative path, and it imports the SDK from `node_modules`, which Node
  // resolves by walking up from the file. A copy anywhere else satisfies
  // neither, the server dies before it answers `initialize`, and the control
  // then fails as a harness error rather than as the control it is meant to be.
  // The name carries the trial index so concurrent trials cannot collide.
  const gutted = join(dirname(serverPath), `gutted-${index}-${basename(serverPath)}`);
  await fs.writeFile(gutted, source.split(substring).join(' '), 'utf8');
  return gutted;
}

/** Read the tool_use / tool_result blocks out of a stream-json transcript. */
function readTranscript(lines) {
  const calls = [];
  const toolErrors = [];
  const texts = [];
  for (const raw of lines) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      continue;
    }
    const content = message.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_use') {
        calls.push({ id: block.id, name: block.name, input: block.input, result: '' });
      }
      if (block.type === 'text' && block.text.trim()) texts.push(block.text);
      if (block.type === 'tool_result') {
        // The blocks' own text, not a JSON dump of the blocks: a dump escapes
        // every quote and newline in the payload, so a needle written the way
        // the server prints it matches nothing.
        const text = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((part) => (typeof part?.text === 'string' ? part.text : JSON.stringify(part))).join('\n')
            : JSON.stringify(block.content);
        if (block.is_error) toolErrors.push(text);
        // Kept against the call, because a call can succeed and still report
        // that it did nothing: a run whose requests were all refused comes back
        // as a successful call with every request failed inside it, and grading
        // only that the tool was called would pass it.
        const call = calls.find((candidate) => candidate.id === block.tool_use_id);
        if (call) call.result = text;
      }
    }
  }
  return { calls, toolErrors, texts };
}

function runClaude({ prompt, cwd, mcpConfig, model, timeoutMs = 300_000 }) {
  return new Promise((resolve) => {
    const child = spawn('claude', [
      '-p', prompt,
      '--model', model,
      '--effort', 'low',
      '--output-format', 'stream-json',
      '--verbose',
      // Project-only settings: the user's own settings bring hooks, plugins and
      // skills with them, and none of that is the surface under test. Auth is
      // not a setting source, so it survives. `--safe-mode` would blind the run
      // more thoroughly and was tried first: it also disables every MCP server,
      // including the one passed by --mcp-config, which leaves nothing to test.
      '--setting-sources', 'project',
      '--strict-mcp-config',
      '--mcp-config', mcpConfig,
      '--allowed-tools', 'mcp__bruno-mcp',
      '--disallowed-tools', ...DENIED_TOOLS,
    ], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DISABLE_OMC: '1', OMC_SKIP_HOOKS: 'all' },
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, lines: out.split('\n').filter(Boolean), stderr: err });
    });
  });
}

async function runTrial(task, index, context) {
  const { server, model, baseUrl, keep } = context;
  const root = await mkdtemp(join(tmpdir(), 'bruno-comprehension-'));
  // Declared out here because the cleanup in `finally` needs it.
  let guttedPath = null;

  try {
    let serverPath = server;
    if (task.gut) {
      serverPath = await gutBundle(server, task.gut, index);
      guttedPath = serverPath;
    }

    // Every trial gets its own workspace manifest. Without this the server
    // resolves the one under the user's application-support directory and every
    // collection a trial creates is registered there permanently, so a 30-trial
    // run leaves 30 entries behind in a file the Bruno app owns.
    const workspaceFile = join(root, 'workspace.yml');
    await fs.writeFile(
      workspaceFile,
      'opencollection: 1.0.0\ninfo:\n  name: "Comprehension"\n  type: workspace\n\ncollections: []\n',
      'utf8',
    );
    const serverEnv = {
      BRUNO_WORKSPACE_PATH: workspaceFile,
      // The fixture answers on loopback, and the server refuses loopback as
      // SSRF unless it is allowlisted. Without this every request in a run comes
      // back refused, which is not a tool error and not a missing file, so a
      // task graded on the call alone passes while nothing has run.
      BRUNO_SSRF_ALLOWLIST: '127.0.0.1',
    };

    const mcpConfig = join(root, 'mcp.json');
    await fs.writeFile(mcpConfig, JSON.stringify({
      mcpServers: {
        'bruno-mcp': { command: process.execPath, args: [serverPath], env: serverEnv },
      },
    }), 'utf8');

    // The working directory is where the model is told to write, and it is a
    // fresh temp directory rather than anywhere in this repository. That is what
    // makes the trial blind: a project CLAUDE.md and the per-project memory
    // notes are both keyed by the working directory, and both state facts the
    // compression under test would delete.
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });

    let collectionPath = '';
    if (task.setup === 'shop') {
      ({ collectionPath } = await buildShop(serverPath, workspace, baseUrl, serverEnv));
    }

    // Substituted over the whole task, not only the prompt: an expectation names
    // the same URL the prompt does, and a placeholder left standing in
    // `expect.contains` would be compared literally against the written bytes
    // and fail every trial. Round-tripped through JSON so every string in the
    // task is covered; the three values are a URL and two directories this
    // runner just created, none of which can contain a quote or a backslash.
    const fill = (text) => text
      .split('{{BASE}}').join(baseUrl)
      .split('{{DIR}}').join(workspace)
      .split('{{COLLECTION}}').join(collectionPath ?? '');
    const filled = JSON.parse(fill(JSON.stringify(task)));
    const prompt = filled.prompt;

    const started = Date.now();
    const { code, lines, stderr } = await runClaude({ prompt, cwd: workspace, mcpConfig, model });
    const { calls, toolErrors, texts } = readTranscript(lines);

    const graded = await gradeTrial(filled, { calls, toolErrors, root: workspace });

    const scrub = (value) => sanitise(value, { root, baseUrl });
    return {
      task: task.id,
      trial: index,
      control: task.control ?? null,
      klass: graded.klass,
      pass: graded.klass === CLASS.PASS,
      diagnosis: scrub(graded.diagnosis),
      field: graded.field ? scrub(graded.field) : undefined,
      recovered: graded.recovered,
      seconds: Math.round((Date.now() - started) / 1000),
      exitCode: code,
      calls: calls.map((call) => ({
        name: call.name,
        input: JSON.parse(scrub(JSON.stringify(call.input))),
        // Truncated: a run's report can be tens of kilobytes, and what the
        // record is for is reading back why a trial was graded as it was.
        result: scrub(call.result ?? '').slice(0, 600),
      })),
      toolErrors: toolErrors.map((text) => scrub(text).slice(0, 600)),
      finalText: texts.length > 0 ? scrub(texts[texts.length - 1]).slice(0, 400) : '',
      cliStderr: stderr ? scrub(stderr).slice(0, 300) : '',
    };
  } finally {
    if (!keep) await fs.rm(root, { recursive: true, force: true });
    // The gutted copy lives in the build directory rather than under the trial
    // root, so removing the root does not take it with it.
    if (guttedPath && !keep) await fs.rm(guttedPath, { force: true });
  }
}

/**
 * The trial list.
 *
 * Weights come from the measured call histogram, so the trials land where the
 * callers landed. Controls are never repeated: each proves one thing once, and
 * spending samples on them would take them from the tasks whose wording is
 * actually under test.
 */
function buildTrialList(tasks, total) {
  const controls = tasks.filter((task) => task.control);
  const weighted = tasks.filter((task) => !task.control);
  const list = [...controls];
  const budget = Math.max(0, total - controls.length);

  const expanded = [];
  for (const task of weighted) {
    for (let n = 0; n < (task.weight ?? 1); n += 1) expanded.push(task);
  }
  for (let index = 0; index < budget; index += 1) {
    list.push(expanded[index % expanded.length]);
  }
  return list;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tasksPath = args.tasks ?? join(HERE, 'tasks.json');
  const all = JSON.parse(await fs.readFile(tasksPath, 'utf8')).tasks;
  const tasks = args.only ? all.filter((task) => args.only.includes(task.id)) : all;
  if (tasks.length === 0) throw new Error('No tasks selected');

  // Before spending anything: prove the harness can still tell a pass from a
  // failure, and that patching the bundle reaches the surface a trial reads.
  await preflight(args.server);

  const fixture = await startFixtureServer();
  const list = buildTrialList(tasks, args.trials || tasks.length);
  const context = { server: args.server, model: args.model, baseUrl: fixture.baseUrl, keep: args.keep };

  process.stdout.write(`${list.length} trials, ${args.concurrency} at a time, model ${args.model}\n`);

  const results = [];
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const index = next;
      next += 1;
      const task = list[index];
      let result;
      try {
        result = await runTrial(task, index, context);
      } catch (error) {
        // A harness failure is not a surface failure, and must never be counted
        // as one: it gets its own class so a broken fixture cannot read as
        // evidence about a description.
        result = {
          task: task.id,
          trial: index,
          klass: 'harness-error',
          pass: false,
          diagnosis: String(error.message).slice(0, 400),
        };
      }
      results.push(result);
      process.stdout.write(
        `  [${results.length}/${list.length}] ${result.task}: ${result.klass}`
        + `${result.diagnosis ? ` — ${result.diagnosis.slice(0, 120)}` : ''}\n`,
      );
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker));
  await fixture.close();

  results.sort((a, b) => a.trial - b.trial);
  const byClass = {};
  for (const result of results) byClass[result.klass] = (byClass[result.klass] ?? 0) + 1;

  const report = {
    model: args.model,
    // Recorded relative to the repository when it is inside it, so the file does
    // not carry one machine's directory layout.
    server: relative(process.cwd(), args.server).startsWith('..')
      ? args.server.replace(homedir(), '<home>')
      : relative(process.cwd(), args.server),
    trials: results.length,
    byClass,
    controls: results
      .filter((result) => result.control)
      .map((result) => ({ task: result.task, control: result.control, klass: result.klass, mustFail: true })),
    results,
  };

  if (args.out) {
    await fs.writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`\nwrote ${args.out}\n`);
  }

  process.stdout.write(`\n${JSON.stringify(byClass)}\n`);
  for (const result of results.filter((r) => !r.pass)) {
    process.stdout.write(`FAIL ${result.task} [${result.klass}] ${result.diagnosis}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
