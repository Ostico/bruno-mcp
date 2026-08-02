/**
 * MCP tool registrations: run tools.
 *
 * Moved out of server.ts unchanged apart from `this.` becoming `ctx.`.
 */

import { z } from 'zod';
import { RequestExecutor } from '../bruno/request-executor.js';
import { forkingScriptRunner } from '../bruno/sandbox-host.js';
import { normalizeVariableOverrides } from '../bruno/runtime-variables.js';
import { validateToolPath } from './tool-path.js';
import { resolveRunTarget } from './run-target.js';
import type { ToolContext } from './context.js';

export function registerRunCollectionTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'run_collection',
    {
      title: 'Run Collection',
      description: 'Execute requests in a Bruno collection and run test scripts. HOW TO RUN A SUBSET — there are exactly two arguments for it and no others: folder runs every request under one directory, requestPath runs one .yml/.bru request file (or, for backwards compatibility, a directory, exactly as folder does). Both accept either an absolute path or a path relative to collectionPath, so folder="Auth" and folder="/abs/collection/Auth" are the same request. Supplying both folder and requestPath is REJECTED rather than resolved for you. Omit both to run ALL requests. Any other key you might reach for — a name, a tag, a glob — does not exist and is silently discarded before this tool sees it, which would run the whole collection while looking like a subset, so use folder or requestPath. A folder or requestPath that does not exist is an error, not a whole-collection run. Each result includes the response body (response_body, response_content_type, response_body_truncated) by default — disable with includeResponseBody=false or cap the size with maxResponseBodyBytes. Execution order matches Bruno\'s: seq is scoped to a folder, so requests are ordered by seq WITHIN their own directory, and two requests both numbered seq 1 in different folders no longer interleave. Sibling folders run in alphabetical order unless a folder root file (folder.bru / folder.yml) gives a seq, which names the POSITION that folder takes rather than a key it is sorted on. Within a directory, subfolders run BEFORE that directory\'s own loose requests — so a request at the collection root runs after every folder, however low its seq. Requests tied on seq are ordered by filename, which is stable across filesystems. A request file that cannot be parsed is skipped rather than failing the run: the count is parseErrors and each skipped file is named with its reason in parseFailures, so a run over a whole collection can be a subset without looking like one. Values captured by scripts come back out: every name a bru.setVar set during the run is listed in capturedVariableNames, and the values of the names you list in captureVariables are returned in capturedVariables — so a token a login captured no longer has to be echoed through a response body or a test name to be readable. Outbound requests are SSRF-filtered: targets resolving to private, loopback, link-local or otherwise reserved addresses are refused unless the server operator has allowlisted them, and a refusal is reported per-request as an "SSRF blocked" error with status 0.',
      inputSchema: {
        collectionPath: z.string().min(1, 'Collection path is required').describe('Absolute path to collection root directory. Use the path returned by list_collections.'),
        environment: z.string().optional().describe('Environment name to use (e.g. "dev", "staging"). Get available names from get_collection_stats.'),
        collectionRoot: z.string().optional().describe('Path to collection root for environment resolution (if different from collectionPath)'),
        requestPath: z.string().optional().describe('One .yml or .bru request file to run, or a subdirectory to run all requests under it (same effect as folder). Absolute, or relative to collectionPath. Get paths from list_requests or get_collection_stats. Omit — and omit folder — to run all requests in the collection. Cannot be combined with folder.'),
        folder: z.string().min(1, 'Folder must not be empty').optional().describe('One folder to run, e.g. "Auth" or "Auth/Login". Absolute, or relative to collectionPath. Runs every request underneath it, recursively. Equivalent to passing the same directory as requestPath; supply one or the other, never both. A value naming a file, or naming nothing, is an error rather than a whole-collection run.'),
        parallel: z.boolean().optional().default(false).describe('Run folders in parallel. Requests within each folder still run sequentially by seq order, and folders are reported in the same order a serial run would produce. Default: false.'),
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

        // One target from the two arguments that can name one: validated,
        // anchored to the collection, and confirmed to exist.
        const target = await resolveRunTarget(
          args.collectionPath,
          args.requestPath,
          args.folder,
        );
        if (!target.ok) {
          return {
            content: [{ type: 'text', text: target.message }],
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

        const result = await RequestExecutor.executeCollection(
          args.collectionPath,
          {
            environment: args.environment,
            collectionRoot: args.collectionRoot,
            ...(target.requestPath ? { requests: [target.requestPath] } : {}),
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
