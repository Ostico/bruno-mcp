import {
  MockRequestData,
  MockResponseData,
  PreRequestScriptResult,
  ScriptResult,
  TestRunnerOptions,
} from './types.js';
import {
  DEFAULT_TIMEOUT,
  runPreRequestJob,
  runTestJob,
} from './sandbox-worker.js';

export type { TestResult, ScriptResult, PreRequestScriptResult } from './types.js';
// Re-exported so existing importers of these diagnostics keep their import path;
// the implementations now live with the sandbox they describe.
export {
  detectUnreportedAssertions,
  detectDoubleParse,
} from './sandbox-worker.js';

/**
 * Runs Bruno pre-request and test scripts in an isolated sandbox.
 *
 * This class is the stable seam its two callers in request-executor use. The
 * sandbox itself lives in sandbox-worker.ts, which is written to be run either
 * in-process (today) or inside a forked child (PR-b) without either caller
 * changing: both methods are already async, so relocating the work behind a
 * process boundary does not alter their signatures.
 */
export class TestRunner {
  static async runPreRequestScript(
    script: string,
    request: MockRequestData,
    options?: TestRunnerOptions,
  ): Promise<PreRequestScriptResult> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    return runPreRequestJob(
      script,
      request,
      timeout,
      options?.variables,
      options?.envVariables,
    );
  }

  static async runScript(
    script: string,
    response: MockResponseData,
    options?: TestRunnerOptions,
  ): Promise<ScriptResult> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    return runTestJob(
      script,
      response,
      timeout,
      options?.variables,
      options?.assertions,
      options?.postResponseVars,
      options?.envVariables,
    );
  }
}
