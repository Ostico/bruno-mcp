import type { ScriptRunner } from './sandbox-host.js';

/**
 * What a caller may ask of a collection run.
 *
 * Its own module because `request-executor.ts` sits on the repo-wide max-lines
 * ceiling and this is the part of it with no runtime behaviour to break.
 */
export interface ExecutionOptions {
  environment?: string;
  collectionRoot?: string;
  requestPath?: string;
  parallel?: boolean;
  includeResponseBody?: boolean;
  maxResponseBodyBytes?: number;
  /**
   * How scripts are run. Defaults to the FORKING runner, so a caller that says
   * nothing gets the process boundary: scripts come from a collection on disk
   * that the operator did not write. Pass the in-process `TestRunner` only to
   * opt OUT of that boundary — it runs collection scripts in this process, with
   * no env scrubbing and no way to kill a runaway script. The unit suite passes
   * it deliberately, because forking needs the built worker at
   * dist/bruno/sandbox-worker.js, which that lane does not produce.
   */
  scriptRunner?: ScriptRunner;
  /**
   * Variables for this run only, overriding the environment file. Names are
   * assumed validated and values already strings — `normalizeVariableOverrides`
   * does that at the tool boundary. Never written anywhere.
   */
  variables?: Record<string, string>;
  /**
   * Whether responses' cookies are kept and sent on later requests in the same
   * run. Defaults to ON, matching Bruno's CLI, where the flag is the inverse
   * (`--disable-cookies`). Pass `false` to send only cookies a request writes
   * itself.
   *
   * The jar lives and dies with the run. Nothing is written to disk and nothing
   * is shared with another run — see `cookie-jar.ts` for why that differs from
   * upstream's process-wide jar.
   */
  cookieJar?: boolean;
  /**
   * Names of variables set by `bru.setVar` during the run whose values the
   * caller wants back. Names a run captured are always reported; values are not,
   * until asked for here. See `captured-variables.ts` for why that is the whole
   * of the policy.
   */
  captureVariables?: string[];
}
