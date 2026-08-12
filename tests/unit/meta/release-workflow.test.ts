/**
 * The release workflow has two jobs, and which events reach which job is the
 * whole safety story.
 *
 * `release` publishes to npm, which is irreversible and cannot be repeated for a
 * version npm already serves. `registry` only lists an already-published version,
 * which is why it is a separate job and why it is the one a human may run by
 * hand: 2.3.0 published to npm and then failed to list, and the failed job could
 * not be re-run because it needs `release`, which would have tried to publish
 * 2.3.0 to npm a second time.
 *
 * Nothing exercises a workflow file locally, so these are the only checks that
 * the manual entry point stays reachable and stays unable to publish.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const workflowPath = join(__dirname, '..', '..', '..', '.github', 'workflows', 'release.yml');
const source = readFileSync(workflowPath, 'utf8');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface Job {
  if?: string;
  needs?: string | string[];
  steps: Step[];
}

// `on` is the YAML 1.1 boolean true, which is why it is read by key lookup on an
// unknown-shaped object rather than as a property named "on".
const workflow = parseYaml(source) as Record<string, unknown> & { jobs: Record<string, Job> };
const triggers = (workflow['on'] ?? workflow[true as unknown as string]) as Record<string, unknown>;

describe('the release workflow', () => {
  it('can be started by a tag or by hand, and by nothing else', () => {
    expect(Object.keys(triggers).sort()).toEqual(['push', 'workflow_dispatch']);
    expect((triggers.push as { tags: string[] }).tags).toEqual(['v*.*.*']);
  });

  it('requires the version to list on a manual run', () => {
    const inputs = (triggers.workflow_dispatch as { inputs: Record<string, { required?: boolean }> })
      .inputs;
    expect(inputs.version.required).toBe(true);
  });

  it('publishes to npm on a tag only, so a manual run cannot republish', () => {
    // Without this the manual entry point would re-enter `npm publish` for a
    // version npm already serves, which is a hard error, and the listing this
    // exists to repair would never be reached.
    expect(workflow.jobs.release.if).toBe("github.event_name == 'push'");
  });

  it('reaches the registry job on a manual run, and only after a successful release otherwise', () => {
    const condition = workflow.jobs.registry.if ?? '';
    // A skipped dependency skips whatever needs it, so without always() a manual
    // run never reaches this job at all — `release` is skipped by design.
    expect(workflow.jobs.registry.needs).toBe('release');
    expect(condition).toContain('always()');
    expect(condition).toContain("github.event_name == 'workflow_dispatch'");
    // And with always(), the success of `release` has to be spelled out or a
    // failed npm publish would be followed by a listing attempt.
    expect(condition).toContain("needs.release.result == 'success'");
  });

  it('checks out the tag rather than the default ref', () => {
    // On a manual run the default ref is the branch, so the listing would
    // describe whatever main says now instead of the released version.
    const checkout = workflow.jobs.registry.steps.find((s) => s.uses?.startsWith('actions/checkout'));
    expect(checkout?.with?.ref).toBe('refs/tags/v${{ steps.target.outputs.version }}');
  });

  it('never interpolates a dispatch input into a shell script', () => {
    // A `${{ }}` inside a run block is pasted in as text before any shell sees
    // it, so an interpolated input is executed rather than read. Passing it
    // through the environment is what makes the input data.
    const shellSteps = Object.values(workflow.jobs).flatMap((job) => job.steps.filter((s) => s.run));
    for (const step of shellSteps) {
      expect(step.run).not.toMatch(/\$\{\{\s*(inputs|github\.event)\b/);
    }
  });
});
