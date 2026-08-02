/**
 * MCP tool registrations: run tools.
 *
 * Moved out of server.ts unchanged apart from `this.` becoming `ctx.`.
 */

import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { RequestExecutor } from '../bruno/request-executor.js';
import type { GroupInput } from '../bruno/run-plan.js';
import { forkingScriptRunner } from '../bruno/sandbox-host.js';
import { normalizeVariableOverrides } from '../bruno/runtime-variables.js';
import { validateToolPath } from './tool-path.js';
import type { ToolContext } from './context.js';

export function registerRunCollectionTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'run_collection',
    {
      title: 'Run Collection',
      description: 'Execute requests in a Bruno collection and run test scripts. HOW TO RUN A SUBSET: requests takes an ORDERED list of entries, each a .yml/.bru request file or a directory (which expands to every request under it, recursively). Absolute, or relative to collectionPath. Order is yours and duplicates are allowed \u2014 naming the same request twice runs it twice. Omit requests to run the whole collection. GROUPS: pass groups instead when one call needs more than one identity or configuration. Each group owns its OWN variable store and cookie jar, so nothing a group sets \u2014 a bru.setVar, a session cookie \u2014 is visible to any other group. That is what makes running the same five requests as alice and as bob in one call safe. Passing both requests and groups is REJECTED rather than resolved for you. PARALLELISM: parallel on the RUN fans the groups out against each other; parallel on a GROUP fans that group\'s own requests out. A group is serial unless it says otherwise, whatever the run does. seq no longer constrains execution \u2014 it is the default order and the reporting order only, so two requests in one parallel group genuinely run at the same time and may contend on the store they share. RESULTS are group-shaped: groups[] each carry their own summary, results, capturedVariableNames, capturedVariables and warnings, and the top-level summary is the run. There is no top-level results array, in the no-groups case either. A group that crashed outright reports error and counts as one failure in the run summary. Each result includes the response body (response_body, response_content_type, response_body_truncated) by default \u2014 disable with includeResponseBody=false or cap the size with maxResponseBodyBytes. Within a group, requests run in the order given; a directory expands by seq, scoped to its own folder, with subfolders before that directory\'s own loose requests, ties broken by filename. A request file that cannot be parsed is skipped rather than failing the run: the count is parseErrors and each skipped file is named with its reason in parseFailures. A named request that does not exist is reported in that group\'s missingRequests rather than failing the run, so you can see which subset ran. Outbound requests are SSRF-filtered: targets resolving to private, loopback, link-local or otherwise reserved addresses are refused unless the server operator has allowlisted them, and a refusal is reported per-request as an "SSRF blocked" error with status 0.',
      inputSchema: {
        collectionPath: z.string().min(1, 'Collection path is required').describe('Absolute path to collection root directory. Use the path returned by list_collections.'),
        environment: z.string().optional().describe('Environment name to use (e.g. "dev", "staging"). Get available names from get_collection_stats.'),
        collectionRoot: z.string().optional().describe('Path to collection root for environment resolution (if different from collectionPath)'),
        requests: z.array(z.string().min(1, 'A request entry must not be empty')).optional().describe('The requests to run, IN THE ORDER GIVEN. Each entry is a .yml or .bru request file, or a directory, which expands to every request under it, recursively. Absolute, or relative to collectionPath. Get paths from list_requests or get_collection_stats. Duplicates are allowed: naming the same request twice runs it twice. Omit to run every request in the collection. Cannot be combined with groups. An entry naming nothing is reported in missingRequests rather than failing the run, so you can see which subset ran.'),
        groups: z.array(z.object({
          name: z.string().optional().describe('Your label for this group, echoed back on its result. Omit and the group is addressed by its index.'),
          requests: z.array(z.string().min(1, 'A request entry must not be empty')).describe('This group\'s requests, in the order given. Same forms as the top-level requests: a file, or a directory that expands. Duplicates allowed.'),
          environment: z.string().optional().describe('Environment file for this group, REPLACING the run-level environment rather than merging with it. Bruno\'s UI runs one environment per run; here two groups can run two.'),
          variables: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe('Variables for this group, MERGED over the run-level variables with this group winning per name. So a run-level baseUrl survives a group that only overrides user.'),
          parallel: z.boolean().optional().describe('Run this group\'s own requests concurrently. Default false, whatever the run-level parallel says. Two concurrent requests in one group share that group\'s store, so they can genuinely contend on a bru.setVar — which is the point when reproducing a race, and a reason to keep a group serial when it is not.'),
        })).optional().describe('Run the same collection under more than one identity or configuration in one call. Each group owns its OWN variable store and cookie jar: nothing a group sets is visible to any other group, in either direction, at any parallel setting. Groups are reported in the order given. The same request may appear in several groups. Cannot be combined with requests; omit both to run the whole collection as one group.'),
        parallel: z.boolean().optional().default(false).describe('Fan out. At the run level this runs the GROUPS concurrently; a group\'s own requests are serial unless that group sets its own parallel. With no groups given the run is one group, so parallel here runs every selected request concurrently. Reporting order is the listed order regardless. Default: false.'),
        maxConcurrency: z.number().int().min(0).optional().describe('Ceiling on requests in flight across the whole run. Omit to derive one from this machine\'s cores and memory, held below capacity. 0 lifts it entirely, at your own risk. A ceiling below the number of requests you meant to run at once silently serialises them, so reproducing a race needs a value at least as large as the number of racers.'),
        includeResponseBody: z.boolean().optional().default(true).describe('Include the response body of each request in the results. Default: true.'),
        maxResponseBodyBytes: z.number().optional().default(10240).describe('Maximum response body size (bytes) to return per request; longer bodies are truncated and response_body_truncated is set. Default: 10240.'),
        variables: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe('Variables for this run only, as {name: value}. They override the environment file and work without one. Held in memory and never written to any file — this is the only correct way to supply a secret, because neither Bruno file format stores a secret value. Referenced as {{name}} in urls, headers, bodies and auth. A request-level vars:pre-request entry or a bru.setVar in a script still overrides these, matching Bruno\'s --env-var precedence.'),
        captureVariables: z.array(z.string()).optional().describe('Names of variables set by bru.setVar during the run whose values you want back, e.g. ["token"]. A script that captures a value out of a response — bru.setVar("token", res.body.token) — makes it available to later requests as {{token}}, and this is the only way to see it yourself; without it the value exists only inside the run. Every name a script set is listed in capturedVariableNames on every run, so run once to see what is there and then ask for the one you need. Values are only returned for names you list here, and they are returned verbatim. Nothing is captured from the environment file or from variables you supplied — only what a script set.'),
        cookieJar: z.boolean().optional().default(true).describe('Keep cookies from each response and send them on later requests in the same run, so a login carries into the requests after it. Scoped per run (per folder when parallel), held in memory, never written to disk, and matched by host/path/expiry — a cookie set by one host is not sent to another. Precedence, per cookie name: a Cookie header the request writes itself WINS over the jar, and the jar only adds names the request did not set, so a request that pins a specific credential keeps it and a run that relies on the jar is unaffected. This diverges from Bruno\'s CLI, where the stored value wins the clash; a warning names any cookie whose stored value was dropped. Default: true, matching Bruno\'s CLI. Set false to send only the Cookie headers a request writes itself.')
      }
    },
    async (args) => {
      try {
        // Validate collectionPath (no traversal, no null bytes)
        const collectionCheck = validateToolPath(args.collectionPath);
        if (!collectionCheck.valid) {
          return {
            content: [{ type: 'text', text: `Invalid collectionPath: ${collectionCheck.reason}` }],
            isError: true,
          };
        }

        // Every reference must stay under the collection. `buildRunPlan` will
        // happily open an absolute path anywhere, so containment is enforced
        // here, at the boundary where the caller's string first arrives.
        const escaped = [
          ...(args.requests ?? []),
          ...(args.groups ?? []).flatMap((group) => group.requests),
        ]
          .map((reference) => ({
            reference,
            check: validateToolPath(
              isAbsolute(reference) ? reference : resolve(args.collectionPath, reference),
              args.collectionPath,
            ),
          }))
          .filter(({ check }) => !check.valid);
        if (escaped.length > 0) {
          return {
            content: [{
              type: 'text',
              text: `Invalid requests: ${escaped
                .map(({ reference, check }) => `"${reference}": ${check.reason}`)
                .join('; ')}`,
            }],
            isError: true,
          };
        }

        // Refused rather than resolved by a precedence rule: the two express
        // different intentions and silently honouring one drops the other.
        if (args.requests?.length && args.groups?.length) {
          return {
            content: [{
              type: 'text',
              text: 'Pass `requests` or `groups`, not both. `requests` runs one ordered '
                + 'selection; `groups` runs several isolated ones. There is no correct '
                + 'way to pick one for you.',
            }],
            isError: true,
          };
        }

        // Validate collectionRoot if provided (no traversal, no null bytes)
        if (args.collectionRoot) {
          const rootCheck = validateToolPath(args.collectionRoot);
          if (!rootCheck.valid) {
            return {
              content: [{ type: 'text', text: `Invalid collectionRoot: ${rootCheck.reason}` }],
              isError: true,
            };
          }
        }

        // Rejected rather than dropped: an override under a name no
        // {{placeholder}} can reference would be accepted and then silently
        // never applied, which looks identical to the request being wrong.
        const { variables, errors } = normalizeVariableOverrides(args.variables);
        if (errors.length > 0) {
          return {
            content: [{ type: 'text', text: `Invalid variables: ${errors.join('; ')}` }],
            isError: true,
          };
        }

        // A group's variables go through the same gate as the run's, and the
        // error names the group: "Invalid variables" alone would leave a caller
        // with five groups reading all five.
        const groupErrors: string[] = [];
        const groups: GroupInput[] | undefined = args.groups?.map((group, index) => {
          const { variables: supplied, ...rest } = group;
          const normalized = normalizeVariableOverrides(supplied);
          if (normalized.errors.length > 0) {
            groupErrors.push(`group ${group.name ?? index}: ${normalized.errors.join('; ')}`);
          }
          // Only when the caller supplied some: adding an empty map would put a
          // key on a group the caller left plain.
          return supplied ? { ...rest, variables: normalized.variables } : rest;
        });
        if (groupErrors.length > 0) {
          return {
            content: [{ type: 'text', text: `Invalid variables: ${groupErrors.join('; ')}` }],
            isError: true,
          };
        }

        const result = await RequestExecutor.executeCollection(
          args.collectionPath,
          {
            environment: args.environment,
            collectionRoot: args.collectionRoot,
            ...(args.requests ? { requests: args.requests } : {}),
            ...(groups ? { groups } : {}),
            maxConcurrency: args.maxConcurrency,
            parallel: args.parallel,
            includeResponseBody: args.includeResponseBody,
            maxResponseBodyBytes: args.maxResponseBodyBytes,
            variables,
            captureVariables: args.captureVariables,
            cookieJar: args.cookieJar,
            // Production runs untrusted scripts behind the process boundary.
            // Named explicitly even though it is now the executor's default: a
            // security property this entry point depends on should be readable
            // here, not inferred from a default someone could change.
            scriptRunner: forkingScriptRunner,
          },
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error running collection: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}
