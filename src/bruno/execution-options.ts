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
  /**
   * Stop the run at the first request that errors or registers a failing test.
   * Off by default, which is what every run before this option did.
   *
   * Named as upstream names it: `bruno-cli` calls this `--bail`.
   *
   * What "stop" reaches is bounded by what has already been started, and the
   * boundary is worth knowing before choosing the flag. Requests not yet started
   * are skipped, in the failing group and in every group after it, each reported
   * as a result with `skipped: true` rather than omitted — a truncated run that
   * simply returned fewer results would be indistinguishable from a shorter one.
   * Requests already in flight are not cancelled: a `parallel` group starts all
   * of its own at once, and concurrent groups likewise, so with fan-out this
   * skips the tail rather than the remainder. A run that combines the two says
   * so in its warnings.
   */
  bail?: boolean;
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
   * Rows every group iterates over: the group runs once per row, with the row's
   * columns bound over its variables. A group naming its own rows replaces these.
   *
   * Mutually exclusive with `dataFile`, and refused rather than merged, since
   * two sources of rows in one scope have no obvious merge.
   */
  data?: Record<string, string>[];
  /** A CSV inside the collection, read into `data`'s place. */
  dataFile?: string;
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
  /**
   * Report files to write for this run. Omit and nothing is written.
   *
   * A report is a file rather than part of the result because the two consumers
   * that want one — a CI system and a person — read files, and the HTML page is
   * around 30 KB. Paths are confined to the collection; see `run-reports.ts` for
   * why that boundary is not negotiable, and why a report that cannot be written
   * is a warning rather than a failed run.
   */
  report?: RunReportRequest;
}

/**
 * Which report files a run should write, each naming its own path.
 *
 * Relative to the collection, or absolute and inside it. Two keys rather than a
 * format list plus a directory: a caller that wants `junit.xml` where its
 * pipeline already looks for one should not have to accept a name we invented.
 */
export interface RunReportRequest {
  junit?: string;
  html?: string;
}
