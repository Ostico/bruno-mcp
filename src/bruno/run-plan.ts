/**
 * Turning caller input into an ordered list of groups.
 *
 * A group is the unit of isolation and of configuration; this module decides
 * only membership and ordering, and knows nothing about running anything. It
 * lives outside `request-executor.ts` because that file sits on the repo-wide
 * max-lines ceiling and this is the part with no execution state in it.
 */
import { isAbsolute, join, resolve } from 'node:path';
import { resolveRows } from './iteration-data.js';
import {
  resolveRunTargets,
  type DiscoveryResult,
  type ParsedRequest,
} from './request-discovery.js';
import type { ParseFailure } from './types.js';

export interface GroupInput {
  name?: string;
  /**
   * Absent and empty mean different things. Absent is "everything in the
   * collection", which is how one collection gets run under two identities.
   * An empty array is a selection that came out empty, and running the whole
   * collection for it would be the opposite of what the caller computed.
   */
  requests?: string[];
  environment?: string;
  variables?: Record<string, string>;
  parallel?: boolean;
  /** Rows to iterate this group over, given inline. Mutually exclusive with `dataFile`. */
  data?: Record<string, string>[];
  /** A CSV inside the collection whose rows this group iterates over. */
  dataFile?: string;
}

export interface ResolvedGroup {
  name?: string;
  index: number;
  /** In listed order, duplicates preserved: asking twice means running twice. */
  requests: ParsedRequest[];
  environment?: string;
  /** Always present, so no caller has to branch on an absent map. */
  variables: Record<string, string>;
  parallel: boolean;
  /** References that resolved to nothing. Empty when everything resolved. */
  missingRequests: string[];
  /**
   * Why this group cannot be run at all. Set when resolving its membership
   * failed for a reason that is not absence — a named file that will not parse,
   * most of it. The group is reported with this instead of results; every other
   * group is unaffected.
   */
  error?: string;
  /**
   * Which iteration of its group this is, counting from 0, when the group was
   * expanded over data rows. Absent when the group runs once.
   *
   * An iteration is a group, not a phase inside one: expansion happens here, and
   * everything downstream sees one more group. That is what gives a row its own
   * variable store, cookie jar and token cache without a line of code asking for
   * it, and what makes two rows differing only in a password two identities
   * rather than one identity tested twice.
   */
  iterationIndex?: number;
}

export interface RunPlanInput {
  requests?: string[];
  groups?: GroupInput[];
  parallel?: boolean;
  environment?: string;
  variables?: Record<string, string>;
  /** Rows every group iterates over unless it gives its own. */
  data?: Record<string, string>[];
  /** A CSV inside the collection whose rows every group iterates over. */
  dataFile?: string;
}

export interface RunPlan {
  groups: ResolvedGroup[];
  parseFailures: ParseFailure[];
  warnings: string[];
}

/**
 * Resolve one caller reference. A relative path is taken against the collection
 * root; an absolute one is used as given.
 *
 * Returns `undefined` when the reference names nothing on disk: that is recorded
 * rather than thrown, because a caller who cannot see which subset ran cannot
 * bisect. Only absence is swallowed. A file that is there but will not parse,
 * or is not a runnable shape at all, still throws with the file named — the
 * caller asked for that specific request and there is no partial answer to it.
 * That throw is caught one level up and attributed to the group that named the
 * file, so it takes down that group and nothing else.
 *
 * A group that names no list at all is the whole collection, and a collection
 * path that will not open is a real error — it is not routed through here.
 */
async function resolveReference(
  collectionPath: string,
  reference: string,
): Promise<DiscoveryResult | undefined> {
  const target = isAbsolute(reference)
    ? reference
    : resolve(join(collectionPath, reference));

  try {
    return await resolveRunTargets(target, collectionPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export async function buildRunPlan(
  collectionPath: string,
  input: RunPlanInput,
): Promise<RunPlan> {
  if (input.requests?.length && input.groups?.length) {
    throw new Error(
      'Received both `requests` and `groups`. Pass one or the other: they express ' +
        'two different intentions and there is no correct way to pick one for you.',
    );
  }

  const parseFailures: ParseFailure[] = [];
  const warnings: string[] = [];

  // With no groups the run itself is the group, and it inherits the run-level
  // settings directly rather than through a defaulting rule further down.
  const groupInputs: GroupInput[] = input.groups?.length
    ? input.groups
    : [{ requests: input.requests, parallel: input.parallel }];

  const groups: ResolvedGroup[] = [];
  for (const [index, group] of groupInputs.entries()) {
    const requests: ParsedRequest[] = [];
    const missingRequests: string[] = [];
    const references = group.requests;
    let error: string | undefined;

    // Membership is resolved inside a try so that a group whose references
    // cannot be resolved is the only casualty. Before this, the throw left
    // `buildRunPlan` and took the whole run with it: groups that had nothing to
    // do with the bad file reported nothing at all, and the caller could not
    // tell which of them would have passed.
    try {
      if (references === undefined) {
        // No list at all means the whole collection, which discovery spells as
        // an undefined target. A list that is present and empty falls through
        // to the empty-group warning below instead: the caller said which
        // requests they wanted and the answer was none of them.
        const discovered = await resolveRunTargets(undefined, collectionPath);
        requests.push(...discovered.requests);
        parseFailures.push(...discovered.parseFailures);
        warnings.push(...discovered.warnings);
      }

      for (const reference of references ?? []) {
        const discovered = await resolveReference(collectionPath, reference);
        if (discovered === undefined) {
          missingRequests.push(reference);
          continue;
        }
        requests.push(...discovered.requests);
        parseFailures.push(...discovered.parseFailures);
        warnings.push(...discovered.warnings);
      }
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    }

    if (error === undefined && requests.length === 0) {
      warnings.push(
        `Group ${group.name ?? index} resolved to no requests. ` +
          'An empty group is reported rather than passing silently.',
      );
    }

    // A group's own rows REPLACE the run's, rather than adding to them, for the
    // reason its `environment` does: the caller who wrote rows on one group was
    // describing that group, and appending the run's rows underneath would run
    // iterations they never asked for.
    const ownRows = group.data !== undefined || group.dataFile !== undefined;
    const rows = await resolveRows(
      ownRows ? { data: group.data, dataFile: group.dataFile } : { data: input.data, dataFile: input.dataFile },
      collectionPath,
      // Named for where the rows were written rather than where they were used,
      // so a refusal points at the line the caller has to edit.
      ownRows ? `Group ${group.name ?? index}` : 'The run',
    );

    const resolved = {
      name: group.name,
      requests,
      environment: group.environment ?? input.environment,
      variables: { ...input.variables, ...group.variables },
      parallel: group.parallel ?? false,
      missingRequests,
      error,
    };

    if (rows === undefined) {
      // `index` is the position in the plan rather than in the caller's list,
      // which are the same number until a group expands and different after.
      groups.push({ ...resolved, index: groups.length });
      continue;
    }

    for (const [iterationIndex, row] of rows.entries()) {
      groups.push({
        ...resolved,
        index: groups.length,
        // The row wins over both the run's variables and the group's, being the
        // most specific thing said about this execution. It goes in as an
        // authored override, which is the tier that recurses through
        // interpolation — a cell holding `{{host}}` resolves, exactly as the
        // same value written into `variables` by hand would.
        variables: { ...resolved.variables, ...row },
        iterationIndex,
      });
    }
  }

  return { groups, parseFailures, warnings: [...new Set(warnings)] };
}
