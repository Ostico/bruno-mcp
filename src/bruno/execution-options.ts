import type { GroupInput } from './run-plan.js';
import type { ScriptRunner } from './sandbox-host.js';
import type { WebsocketRunOptions } from './ws-transport.js';

/**
 * What a caller may ask of a collection run.
 *
 * Its own module because `request-executor.ts` sits on the repo-wide max-lines
 * ceiling and this is the part of it with no runtime behaviour to break.
 */
export interface ExecutionOptions {
  environment?: string;
  collectionRoot?: string;
  /**
   * Ordered selection when no groups are given, each entry a request file or a
   * directory, relative to the collection or absolute. Mutually exclusive with
   * `groups`. Omit to run the whole collection.
   */
  requests?: string[];
  /** Explicit groups. Each owns its store, jar, environment and variables. */
  groups?: GroupInput[];
  /**
   * Fan out. At the run level this means the groups run concurrently; within a
   * group it is the group's own `parallel` that decides, defaulting to serial.
   */
  parallel?: boolean;
  /**
   * In-flight request ceiling for the whole run. Omit to derive it from the
   * machine; 0 is unbounded, at the caller's risk.
   *
   * A cap below the number of contending requests silently serialises them, so
   * a run trying to reproduce a race needs a cap at least as large as the
   * number of racers.
   */
  maxConcurrency?: number;
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
  /**
   * Bounds for any WebSocket request in the run.
   *
   * Every one of them has a default, because a socket has no natural end and an
   * unbounded recording would hold the tool call open for as long as the peer
   * keeps talking. They are overridable per run rather than per request: the
   * caller, not the collection file, is the one who knows how long it is prepared
   * to wait.
   */
  websocket?: WebsocketRunOptions;
}
