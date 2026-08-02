/**
 * Turning caller input into an ordered list of groups.
 *
 * A group is the unit of isolation and of configuration; this module decides
 * only membership and ordering, and knows nothing about running anything. It
 * lives outside `request-executor.ts` because that file sits on the repo-wide
 * max-lines ceiling and this is the part with no execution state in it.
 */
import { isAbsolute, join, resolve } from 'node:path';
import {
  resolveRunTargets,
  type DiscoveryResult,
  type ParsedRequest,
} from './request-discovery.js';
import type { ParseFailure } from './types.js';

export interface GroupInput {
  name?: string;
  requests: string[];
  environment?: string;
  variables?: Record<string, string>;
  parallel?: boolean;
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
}

export interface RunPlanInput {
  requests?: string[];
  groups?: GroupInput[];
  parallel?: boolean;
  environment?: string;
  variables?: Record<string, string>;
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
 *
 * A group with no references at all is the whole collection, and a collection
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
    : [{ requests: input.requests ?? [], parallel: input.parallel }];

  const groups: ResolvedGroup[] = [];
  for (const [index, group] of groupInputs.entries()) {
    const requests: ParsedRequest[] = [];
    const missingRequests: string[] = [];

    if (group.requests.length === 0) {
      // No references at all means the whole collection, which discovery spells
      // as an undefined target.
      const discovered = await resolveRunTargets(undefined, collectionPath);
      requests.push(...discovered.requests);
      parseFailures.push(...discovered.parseFailures);
      warnings.push(...discovered.warnings);
    }

    for (const reference of group.requests) {
      const discovered = await resolveReference(collectionPath, reference);
      if (discovered === undefined) {
        missingRequests.push(reference);
        continue;
      }
      requests.push(...discovered.requests);
      parseFailures.push(...discovered.parseFailures);
      warnings.push(...discovered.warnings);
    }

    if (requests.length === 0) {
      warnings.push(
        `Group ${group.name ?? index} resolved to no requests. ` +
          'An empty group is reported rather than passing silently.',
      );
    }

    groups.push({
      name: group.name,
      index,
      requests,
      environment: group.environment ?? input.environment,
      variables: { ...input.variables, ...group.variables },
      parallel: group.parallel ?? false,
      missingRequests,
    });
  }

  return { groups, parseFailures, warnings: [...new Set(warnings)] };
}
