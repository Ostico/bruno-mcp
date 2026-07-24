/**
 * TEMPORARY test-guard self-test probe.
 *
 * Intentionally shipped WITHOUT a matching test file and with an uncovered
 * branch, so the test-guard adequacy gate flags it on the PR. Delete this
 * file (and close the PR) once the gate has been verified to fail/block.
 */
export function gateProbe(value: number): string {
  if (value > 0) {
    return 'positive';
  }
  return 'non-positive';
}
