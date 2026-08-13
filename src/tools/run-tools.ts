/**
 * MCP tool registrations: run tools.
 *
 * Moved out of server.ts unchanged apart from `this.` becoming `ctx.`.
 */

import { isAbsolute, resolve, sep } from 'node:path';
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
      description: 'Execute requests in a Bruno collection and run test scripts. HOW TO RUN A SUBSET: requests takes an ORDERED list of entries, each a .yml/.bru request file or a directory (which expands to every request under it, recursively). Absolute, or relative to collectionPath. Order is yours and duplicates are allowed \u2014 naming the same request twice runs it twice. Omit requests to run the whole collection. GROUPS: pass groups instead when one call needs more than one identity or configuration. Each group owns its OWN variable store and cookie jar, so nothing a group sets \u2014 a bru.setVar, a session cookie \u2014 is visible to any other group. That is what makes running the same five requests as alice and as bob in one call safe. Passing both requests and groups is REJECTED rather than resolved for you. ITERATIONS: data or dataFile runs a group once per row of a table, with the row bound as variables — one call to check the same requests against 50 accounts, or one login against 50 credential pairs. Each row is reported as its own group, with the same name, its own index and an iterationIndex, because each row IS a separate group: it gets that isolation, so two rows differing only in a password authenticate separately instead of one silently reusing the other\'s token. Rows are independent, so a failing row does not stop the rows after it. Ceiling of 1000 rows per scope. PARALLELISM: parallel on the RUN fans the groups out against each other; parallel on a GROUP fans that group\'s own requests out. A group is serial unless it says otherwise, whatever the run does. seq no longer constrains execution \u2014 it is the default order and the reporting order only, so two requests in one parallel group genuinely run at the same time and may contend on the store they share. A group can also WAIT for another: startAfter holds it until the named group has completed a given number of its requests, which is how you get a listener connected before a trigger fires without a bru.sleep tuned to whatever the latency was the day it was written. It needs parallel on the run, chains are allowed, and cycles or gates that could never open are refused before anything runs; if the group being waited on ends early, the waiting group reports that as its error instead of starting. RESULTS are group-shaped: groups[] each carry their own summary, results, capturedVariableNames, capturedVariables and warnings, and the top-level summary is the run. There is no top-level results array, in the no-groups case either. A group that crashed outright reports error and counts as one failure in the run summary. Each result includes the response body (response_body, response_content_type, response_body_truncated) by default \u2014 disable with includeResponseBody=false or cap the size with maxResponseBodyBytes. Each result also carries response_headers, with no flag and no test script needed: credential-named values are masked, and set-cookie is a LIST \u2014 one entry per cookie \u2014 whose entries keep every attribute (HttpOnly, Secure, SameSite, Path, Max-Age) and withhold only the cookie value, so a cookie-flag or HSTS check is one call. includeResponseBody=false does not suppress headers; it bounds the body only. A websocket result carries response_headers too, holding the handshake response (the 101) — the only place a session cookie or an agreed sec-websocket-protocol is visible for that transport; a gRPC result reports its own metadata under the grpc detail instead. Within a group, requests run in the order given; a directory expands by seq, scoped to its own folder, with subfolders before that directory\'s own loose requests, ties broken by filename. A request file that cannot be parsed is skipped when it was DISCOVERED — by running the whole collection, or by expanding a directory: the count is parseErrors and each skipped file is named with its reason in parseFailures. A file you NAMED yourself is different: you asked for that specific request and there is no partial answer to it, so it fails the group that named it, reported as that group\'s error, and the other groups still run. A named request that does not exist is reported in that group\'s missingRequests rather than failing anything, so you can see which subset ran. TRANSPORTS: http, graphql, grpc and websocket requests all run; any other kind is refused per-request with status 0 and a named reason, leaving the rest of the group alone. A gRPC result carries a grpc detail — the gRPC status code (0 is OK, and is NOT the refusal sentinel: status 0 with an error and no grpc detail is a refusal), the method, and redacted metadata. A WebSocket result carries a websocket detail — the transcript, stop_reason naming what ended the session (count, timeout, bytes, closed or error), and truncated, which is true for the three that cut a session short. Frame contents are recorded only if you ask for them, via websocket.includePayloads. ASSERTING ON A TRANSPORT: on a websocket result res.getBody() IS the transcript array — the frames, handed over as a structure — and res.getStatus() is ALWAYS 0, because a session has no status; the outcome is res.statusText, carrying the stop reason. A test written against res.getStatus() on a websocket asserts on a constant and cannot fail. On a gRPC result res.getStatus() is the gRPC code, res.statusText the server details or the code name, and res.getBody() the parsed message. CONCURRENCY ACROSS CALLS: separate run_collection calls are NOT promised to overlap and may serialise, so a test needing genuine simultaneity must be ONE call with a parallel group rather than several calls issued together. Each result carries the path of the request file it came from, so a failure can be read back or re-run by name. STOPPING EARLY: bail stops the run at the first request that fails or whose tests fail, so a chain of dependent requests reports one cause instead of one failure plus every consequence of it. Everything after it comes back with skipped: true and skipReason: "bail", counted in summary.skipped and in neither passed nor failed, and the run carries a bail object naming the reason, the request it stopped at and how many were skipped. Nothing cancels a request already in flight, so with parallel the requests that had already started still finish and are reported normally. REPORT FILES: pass report to also write the run to disk — JUnit XML for CI, HTML for a person — at a path inside the collection; the files written come back under reports. Outbound requests are SSRF-filtered: targets resolving to private, loopback, link-local or otherwise reserved addresses are refused unless the server operator has allowlisted them, and a refusal is reported per-request as an "SSRF blocked" error with status 0.',
      inputSchema: {
        collectionPath: z.string().min(1, 'Collection path is required').describe('Absolute path to collection root directory. Use the path returned by list_collections.'),
        environment: z.string().optional().describe('Environment name to use (e.g. "dev", "staging"). Get available names from get_collection_stats.'),
        collectionRoot: z.string().optional().describe('The collection that collectionPath belongs to, when running a subfolder of one: environments and the collection- and folder-level scripts are resolved from here. Must be collectionPath itself or an ancestor of it — a root that does not contain the collection is rejected, because its root scripts would then run against these requests.'),
        requests: z.array(z.string().min(1, 'A request entry must not be empty')).optional().describe('The requests to run, IN THE ORDER GIVEN. Each entry is a .yml or .bru request file, or a directory, which expands to every request under it, recursively. Absolute, or relative to collectionPath. Get paths from list_requests or get_collection_stats. Duplicates are allowed: naming the same request twice runs it twice. Omit to run every request in the collection; an empty [] is a selection of nothing and runs nothing. Cannot be combined with groups. An entry naming nothing is reported in missingRequests rather than failing the run, so you can see which subset ran.'),
        groups: z.array(z.object({
          name: z.string().optional().describe('Your label for this group, echoed back on its result. Omit and the group is addressed by its index.'),
          requests: z.array(z.string().min(1, 'A request entry must not be empty')).optional().describe('This group\'s requests, in the order given. Same forms as the top-level requests: a file, or a directory that expands. Duplicates allowed. OMIT to run the whole collection under this group\'s identity — that is how one collection runs as two users. An empty [] is not the same thing: it is a selection of nothing, and runs nothing.'),
          environment: z.string().optional().describe('Environment file for this group, REPLACING the run-level environment rather than merging with it. Bruno\'s UI runs one environment per run; here two groups can run two.'),
          variables: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe('Variables for this group, MERGED over the run-level variables with this group winning per name. So a run-level baseUrl survives a group that only overrides user.'),
          parallel: z.boolean().optional().describe('Run this group\'s own requests concurrently. Default false, whatever the run-level parallel says. Two concurrent requests in one group share that group\'s store, so they can genuinely contend on a bru.setVar — which is the point when reproducing a race, and a reason to keep a group serial when it is not.'),
          startAfter: z.object({
            group: z.string().min(1, 'startAfter.group cannot be empty').describe('The name of the group to wait on. It must be a group in this same call, it must be named, and it must not iterate over rows — several groups under one name give the gate no single position to watch.'),
            requestsCompleted: z.number().int().min(1, 'requestsCompleted must be at least 1').optional().describe('How many of that group\'s requests must have finished. Default 1, which is the usual meaning of "once it is up". A request that failed still counts: the gate marks a position in the group, not a verdict on it, and waiting for a verdict would hang the run rather than report the failure.'),
          }).optional().describe('Hold this group until another group has got that far — the barrier for a listener that must be connected before a trigger fires. Needs parallel: true on the run, since it is only meaningful while both groups are running. Chains are allowed (A waits on B waits on C); cycles, self-references and gates that could never open are refused before anything runs. If the group being waited on ends early — a crash, or bail — the waiting group does not start and reports that as its error, naming what it was still waiting for, rather than hanging. Use this instead of bru.sleep, which is tuned to whatever the latency was the day it was written.'),
          data: z.array(z.record(z.union([z.string(), z.number(), z.boolean()]))).min(1, 'data needs at least one row').optional().describe('Rows to iterate this group over: run it once per row, with the row\'s columns bound as variables over this group\'s own. Each iteration is reported as its own group, with the same name and its own index and iterationIndex, because that is what it is — a separate run with a separate store, cookie jar and OAuth2 token cache. Two rows differing only in a password therefore authenticate separately, which is the whole reason to have this rather than a loop inside one group. Mutually exclusive with dataFile. A row overrides both the run-level and the group-level variables per name.'),
          dataFile: z.string().min(1, 'dataFile cannot be empty').optional().describe('A CSV inside the collection whose rows this group iterates over, as data but read from disk. Relative to the collection root; must resolve inside the collection. First line is the header and names the variables. Mutually exclusive with data. Rows are not echoed back in the result, since a column named password is file content this tool will not copy into a transcript — an iteration is identified by its iterationIndex, counting from 0 in file order.'),
        })).optional().describe('Run the same collection under more than one identity or configuration in one call. Each group owns its OWN variable store and cookie jar: nothing a group sets is visible to any other group, in either direction, at any parallel setting. Groups are reported in the order given. The same request may appear in several groups. Cannot be combined with requests; omit both to run the whole collection as one group.'),
        data: z.array(z.record(z.union([z.string(), z.number(), z.boolean()]))).min(1, 'data needs at least one row').optional().describe('Rows every group iterates over, as the group-level data but applied to all of them. A group that gives its own data or dataFile REPLACES this rather than adding to it, the same rule environment follows. With no groups given, the run is one group and these rows are its iterations. Mutually exclusive with dataFile.'),
        dataFile: z.string().min(1, 'dataFile cannot be empty').optional().describe('A CSV inside the collection whose rows every group iterates over. Same rules as the group-level dataFile, and likewise replaced by a group that names its own rows. Ceiling of 1000 rows, because every row runs every request in the group and a spreadsheet passed by mistake is an outbound request storm; slice the file and run it in parts.'),
        parallel: z.boolean().optional().default(false).describe('Fan out. At the run level this runs the GROUPS concurrently; a group\'s own requests are serial unless that group sets its own parallel. With no groups given the run is one group, so parallel here runs every selected request concurrently. Reporting order is the listed order regardless. Default: false.'),
        maxConcurrency: z.number().int().min(0).optional().describe('Ceiling on requests in flight across the whole run. Omit to derive one from this machine\'s cores and memory, held below capacity. 0 lifts it entirely, at your own risk. Applies to THIS run and is given back when it ends, so it neither re-caps another run already in flight nor outlives the call that asked for it. A ceiling below the number of requests you meant to run at once silently serialises them, so reproducing a race needs a value at least as large as the number of racers.'),
        bail: z.boolean().optional().default(false).describe('Stop at the first request that errors or fails a test, instead of running the rest. Bruno\'s CLI calls this --bail. Use it when the requests depend on each other: without it, a failed login is followed by every request that needed its token failing too, which is four failures to read for one cause. What it stops is bounded by what has already started. Requests not yet started are skipped — in the failing group and in every group after it — and each comes back as a result with skipped:true rather than being left out, so you can see which ones still need running. Requests already in flight are NOT cancelled, so with parallel:true or a parallel group this skips the tail rather than the remainder, and the run says so in its warnings. A skipped request counts in summary.skipped and in neither passed nor failed. Where the run stopped is reported in the result\'s bail field. Default: false.'),
        includeResponseBody: z.boolean().optional().default(true).describe('Include the response body of each request in the results. Default: true.'),
        maxResponseBodyBytes: z.number().optional().default(10240).describe('Maximum response body size (bytes) to return per request; longer bodies are truncated and response_body_truncated is set. Default: 10240.'),
        variables: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe('Variables for this run only, as {name: value}. They override the environment file and work without one. Held in memory and never written to any file — this is the only correct way to supply a secret, because neither Bruno file format stores a secret value. Referenced as {{name}} in urls, headers, bodies and auth. A request-level vars:pre-request entry or a bru.setVar in a script still overrides these, matching Bruno\'s --env-var precedence.'),
        captureVariables: z.array(z.string()).optional().describe('Names of variables set by bru.setVar during the run whose values you want back, e.g. ["token"]. A script that captures a value out of a response — bru.setVar("token", res.body.token) — makes it available to later requests as {{token}}, and this is the only way to see it yourself; without it the value exists only inside the run. Every name a script set is listed in capturedVariableNames on every run, so run once to see what is there and then ask for the one you need. Values are only returned for names you list here, and they are returned verbatim. Nothing is captured from the environment file or from variables you supplied — only what a script set.'),
        websocket: z.object({
          maxMessages: z.number().int().min(1, 'maxMessages must be at least 1').max(1000, 'maxMessages must be at most 1000').optional().default(50).describe('Inbound frames to record before the session stops, per request. Default: 50. A session that stops here reports stop_reason "count" and truncated true, so a transcript cut short always says so.'),
          maxDurationMs: z.number().int().min(100, 'maxDurationMs must be at least 100').max(60000, 'maxDurationMs must be at most 60000').optional().default(5000).describe('Wall-clock ceiling for one session, in milliseconds. Default: 5000. A socket has no natural end, so this is what makes a silent server finish rather than hold the call open; stop_reason is "timeout".'),
          idleTimeoutMs: z.number().int().min(0).max(60000, 'idleTimeoutMs must be at most 60000').optional().default(1500).describe('End a session after this much silence, in milliseconds. Default: 1500. The wall-clock ceiling is a safety bound rather than a schedule, and a request/response session spent all of it waiting on a peer that had already answered; this ends it once nothing has arrived for a while and reports stop_reason "idle", which is NOT truncated because no cap bit. The clock starts at the first frame, so a listen-only request that authors no messages still waits out maxDurationMs. Set 0 to wait for the ceiling, which is what a protocol whose gaps are longer than this needs.'),
          sendIntervalMs: z.number().int().min(0).max(60000, 'sendIntervalMs must be at most 60000').optional().default(0).describe('Wait this long between the messages a request sends, in milliseconds. Default: 0, which sends them all in one tick — right for a stream, useless for a protocol that answers, since the reply to the first message arrives after the last one already left. Set a gap and a send-wait-send exchange becomes drivable: the transcript then carries the replies interleaved with the sends, at the offsets they actually arrived. maxDurationMs has to cover the whole paced sequence — a session stopped part way through reports which messages never went out, by name. The idle bound is not armed while the sequence is still going out, so sendIntervalMs above idleTimeoutMs is safe.'),
          includePayloads: z.boolean().optional().default(false).describe('Record frame CONTENTS, not just their direction, timing and size. Default: false, and the default is a security property: outbound frames are recorded after {{var}} interpolation, so a transcript that included them by default would write every secret you passed in variables into a result that is returned by default. Turn it on when you need to assert on what came back IN THE RESULT. A test script does NOT need it: res.getBody() always carries the real payloads, exactly as res.body always carries a full HTTP body while response_body is gated by includeResponseBody. So includePayloads=false together with content assertions is the intended CI shape, not a workaround — the script checks the payloads and the returned transcript holds only direction, timing and sizes.'),
          maxFrameBytes: z.number().int().min(1, 'maxFrameBytes must be at least 1').max(1048576, 'maxFrameBytes must be at most 1048576').optional().default(65536).describe('Per-frame ceiling on recorded payload, in bytes. Default: 65536. Only affects what is KEPT: a longer frame is truncated rather than dropped, and its entry still reports the full wire size. No effect unless includePayloads is on.'),
          maxTranscriptBytes: z.number().int().min(1, 'maxTranscriptBytes must be at least 1').max(8388608, 'maxTranscriptBytes must be at most 8388608').optional().default(1048576).describe('Cumulative ceiling for one session, in bytes. Default: 1048576. Counted from wire sizes, not from what was recorded, so turning includePayloads off does not quietly raise it; stop_reason is "bytes".'),
          engineIoKeepalive: z.boolean().optional().default(false).describe('Answer an engine.io PING (the frame "2") with a PONG ("3"), which is what a socket.io server needs to not disconnect you at pingTimeout. Default: false, because it puts a frame on the wire the request did not author, and it is only ever sent after an OPEN frame has actually been seen. This is the whole of the socket.io support: there is no socketio request kind, and the handshake and event frames are yours to write as ordinary messages.'),
        // Strict on purpose. Every key above rejects an out-of-range value BY
        // NAME, so a caller gets told precisely what it got wrong — except for
        // a misspelled key, which was accepted and then ignored, silently
        // restoring the default. `maxMessage` for `maxMessages` is one
        // character from a bound that looks applied and is not.
        }).strict().optional().describe('Bounds for websocket requests in this run. Applies to every websocket request in the call; there is no per-request form. Omit and the defaults below apply. A session always ends on one of these bounds or on the peer closing, and nothing is held open past the call. Each transcript entry carries its frame type ("text", "binary", "ping", "pong" or "close"), the authored title of a message the session sent, and, on a close frame, the close_code the peer gave — 1000 is an ordinary goodbye, 1006 a peer that vanished, 1008 a refusal, 1011 a server error. Control frames do not count toward maxMessages. A binary frame\'s payload is base64; bytes is the true wire size for every kind. A subprotocol is not a bound and is not set here: author it as a Sec-WebSocket-Protocol header on the request, comma-separated for more than one, and it is negotiated at the handshake — the one the server agreed to comes back in that result\'s response_headers.'),
        report: z.object({
          junit: z.string().min(1, 'junit must name a file').optional().describe('Path for a JUnit XML report, relative to collectionPath or absolute inside it, e.g. "reports/junit.xml". Written for CI: one testsuite per request, one testcase per assertion or test, with a request that errored reported as a suite error. What a run could not do is in the file too — a request file that would not parse, a named request that resolved to nothing and a group that crashed each get their own suite, so the report never says a subset ran without saying it was a subset. A request that ran and verified nothing is one SKIPPED testcase rather than an empty suite, because an empty suite is invisible in a CI summary and reads as a pass.'),
          html: z.string().min(1, 'html must name a file').optional().describe('Path for a self-contained HTML report, relative to collectionPath or absolute inside it, e.g. "reports/run.html". Written for a person to open: around 30 KB, rendered by Bruno\'s own report generator, with execution groups as its iterations so a two-identity run reads as two sections. Two limits worth knowing: the request pane is empty, because a result does not retain the request as it was sent, and assertions and script tests share one list, because a result does not tell them apart.'),
        // No `.refine()` for "name at least one": a refinement wraps the object
        // in a ZodEffects, and the tool-surface contract snapshot then records
        // the whole argument as an opaque effect instead of its two keys — so a
        // later change to either one would move nothing. The check lives in the
        // handler, where the other cross-key rules already are.
        }).strict().optional().describe('Write the run to a file, in addition to returning it here. Name at least one format. Paths are CONFINED TO THE COLLECTION: a path resolving outside it is refused, with the reason as a run warning, because writing wherever a caller points is a far bigger authorization than running its requests — copy the file afterwards if your pipeline collects it elsewhere. Missing parent directories inside the collection are created, and an existing report is overwritten. The result reports each file written under reports, with its absolute path and size; a report that could not be written never fails the run, it adds a warning naming the format and the reason. A report holds what the results hold — response bodies included, response headers masked exactly as they are here — so it lands on disk with whatever the run saw.'),
        cookieJar: z.boolean().optional().default(true).describe('Keep cookies from each response and send them on later requests in the same run, so a login carries into the requests after it. Scoped to the group — nothing crosses from one group to another, at any parallel setting — held in memory, never written to disk, and matched by host/path/expiry — a cookie set by one host is not sent to another. Precedence, per cookie name: a Cookie header the request writes itself WINS over the jar, and the jar only adds names the request did not set, so a request that pins a specific credential keeps it and a run that relies on the jar is unaffected. This diverges from Bruno\'s CLI, where the stored value wins the clash; a warning names any cookie whose stored value was dropped. Default: true, matching Bruno\'s CLI. Set false to send only the Cookie headers a request writes itself.')
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
          ...(args.groups ?? []).flatMap((group) => group.requests ?? []),
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

        // An empty `report` object asks for a file without saying which kind,
        // and silently writing nothing would look exactly like a run that never
        // asked for a report.
        if (args.report && args.report.junit === undefined && args.report.html === undefined) {
          return {
            content: [{
              type: 'text',
              text: 'Invalid report: name at least one of `junit` or `html`, each a path '
                + 'inside the collection.',
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

          // And it has to be the root OF THIS COLLECTION. The argument exists so
          // a run scoped to a subfolder still resolves the collection's
          // environments, which means the collection path sits underneath it.
          // Pointed anywhere else it is a different collection, whose
          // collection- and folder-level SCRIPTS are then executed against
          // these requests — the one input here that runs code the caller did
          // not name — and whose environment files are read and substituted in.
          const root = resolve(args.collectionRoot);
          const target = resolve(args.collectionPath);
          if (target !== root && !target.startsWith(root + sep)) {
            return {
              content: [{
                type: 'text',
                text: `Invalid collectionRoot: ${args.collectionRoot} does not contain ${args.collectionPath}. `
                  + 'collectionRoot names the collection that collectionPath belongs to, so it must be that path or an ancestor of it.',
              }],
              isError: true,
            };
          }
        }

        // Rejected rather than dropped: an override under a name no
        // {{placeholder}} can reference would be accepted and then silently
        // never applied, which looks identical to the request being wrong.
        // A data row is a set of variable values, so its names go through the
        // same gate rather than a laxer one of their own: a column heading no
        // {{placeholder}} can reference would bind nothing, and a run that
        // iterated 200 times over a name nothing reads is indistinguishable from
        // one where the requests were wrong.
        const normalizeRows = (
          rows: Record<string, string | number | boolean>[] | undefined,
          label: string,
          into: string[],
        ): Record<string, string>[] | undefined => rows?.map((row, rowIndex) => {
          const normalized = normalizeVariableOverrides(row);
          if (normalized.errors.length > 0) {
            into.push(`${label} row ${rowIndex}: ${normalized.errors.join('; ')}`);
          }
          return normalized.variables;
        });

        const { variables, errors } = normalizeVariableOverrides(args.variables);
        const rowErrors: string[] = [];
        const data = normalizeRows(args.data, 'data', rowErrors);
        if (rowErrors.length > 0) {
          return {
            content: [{ type: 'text', text: `Invalid variables: ${rowErrors.join('; ')}` }],
            isError: true,
          };
        }
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
          const { variables: supplied, data: rows, ...rest } = group;
          const normalized = normalizeVariableOverrides(supplied);
          if (normalized.errors.length > 0) {
            groupErrors.push(`group ${group.name ?? index}: ${normalized.errors.join('; ')}`);
          }
          const normalizedRows = normalizeRows(rows, `group ${group.name ?? index} data`, groupErrors);
          // Only when the caller supplied some: adding an empty map would put a
          // key on a group the caller left plain, and an explicit `data:
          // undefined` is a key that reads as "this group has its own rows" to
          // the replace-or-inherit rule in `buildRunPlan`.
          return {
            ...rest,
            ...(supplied ? { variables: normalized.variables } : {}),
            ...(normalizedRows ? { data: normalizedRows } : {}),
          };
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
            bail: args.bail,
            includeResponseBody: args.includeResponseBody,
            maxResponseBodyBytes: args.maxResponseBodyBytes,
            variables,
            // Absent rather than undefined for the same reason a group's are: a
            // present key means "this scope has its own rows".
            ...(data ? { data } : {}),
            ...(args.dataFile ? { dataFile: args.dataFile } : {}),
            captureVariables: args.captureVariables,
            cookieJar: args.cookieJar,
            // Only when the caller supplied some. Passing an empty object would
            // be harmless today, but the transport reads each bound with `??`,
            // so an absent key and a key set to its default must stay the same
            // thing here too.
            ...(args.websocket ? { websocket: args.websocket } : {}),
            // Same rule as `websocket`: absent means "write nothing", so an
            // empty object must not be manufactured here.
            ...(args.report ? { report: args.report } : {}),
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
