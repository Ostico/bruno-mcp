/**
 * MCP tool registrations: script tools.
 *
 * Moved out of server.ts unchanged apart from `this.` becoming `ctx.`.
 */

import { z } from 'zod';
import path from 'path';
import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../bruno/atomic-write.js';
import { withPathLock } from '../bruno/path-mutex.js';
import { createWriter, normalizeScriptType } from '../bruno/format-factory.js';
import { validateToolPath, resolveRequestFile } from './tool-path.js';
import type { ToolContext } from './context.js';

export function registerAddTestScriptTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'add_test_script',
    {
      title: 'Add Test Script',
      description: 'Add pre-request, post-response, or tests scripts to a Bruno request. Canonical scriptType values are pre-request/post-response/tests; the aliases before-request (→ pre-request) and after-response (→ post-response) are also accepted. Appends to any existing script of that type by default — pass scriptMode:"replace" to overwrite it, or use remove_script to clear it. Assertions must be wrapped in test("name", function() { ... }) to be reported. Scripts run as async functions: top-level await works, and bru.sleep(ms), setTimeout and setInterval spend the script timeout (settings.timeout, default 5000ms), which write_request\'s settings argument raises.',
      inputSchema: {
        bruFilePath: z.string().min(1, 'BRU file path is required').describe('Absolute path to the .yml or .bru request file. Get from list_requests or get_collection_stats.'),
        scriptType: z.enum(['pre-request', 'post-response', 'tests', 'before-request', 'after-response']).describe('Script type. Canonical: pre-request, post-response, tests. Aliases: before-request (→ pre-request), after-response (→ post-response).'),
        script: z.string().min(1, 'Script content is required').describe(
          'Script body. For post-response/tests, wrap every assertion in a test() block — test("status ' +
            'is 200", function() { expect(res.getStatus()).to.equal(200); }); — because only test() blocks ' +
            'are recorded in run_collection results; a bare passing top-level expect() records nothing and ' +
            'the run reports "tests": []. res.getBody() returns the response already parsed for ' +
            'application/json and +json content-types, so read fields directly (res.getBody().field) and ' +
            'do NOT JSON.parse() it.',
        ),
        scriptMode: z.enum(['append', 'replace']).optional().default('append').describe(
          'How to write the script. "append" (default) concatenates onto any existing script of this ' +
            'type; "replace" overwrites it. Each script type has its own slot in both .bru and .yml, so ' +
            'replacing one leaves the others untouched.',
        )
      }
    },
    async (args) => {
      try {
        // 1. Path validation (traversal + null bytes)
        const pathCheck = validateToolPath(args.bruFilePath);
        if (!pathCheck.valid) {
          return {
            content: [{ type: 'text', text: `Invalid bruFilePath: ${pathCheck.reason}` }],
            isError: true,
          };
        }

        // 2. Script content validation
        if (args.script.length > 50_000) {
          return {
            content: [{ type: 'text', text: 'Script exceeds maximum size limit of 50KB' }],
            isError: true,
          };
        }
        if (args.script.includes('\x00')) {
          return {
            content: [{ type: 'text', text: 'Script contains null bytes' }],
            isError: true,
          };
        }

        // 3. Extension, collection root and dialect. `resolvedFile.format` follows the FILE,
        // not the collection, and that distinction is load-bearing here: it
        // picks the serializer below. Deriving it from the collection would
        // write `.bru` text into a file named `.yml` whenever the two disagree —
        // which the old refusal hid rather than prevented.
        const resolvedFile = await resolveRequestFile(args.bruFilePath, 'bruFilePath');
        if (!resolvedFile.ok) {
          return {
            content: [{ type: 'text', text: resolvedFile.message }],
            isError: true,
          };
        }

        // 7. Normalize aliases to canonical script type
        const canonicalScriptType = normalizeScriptType(args.scriptType);
        // Default explicitly: the zod default only applies when the SDK
        // validates input, not when the handler is invoked directly.
        const scriptMode = args.scriptMode ?? 'append';

        // 8. Read, inject, write back under a per-file lock. The pair is what
        // needs guarding: two concurrent injections would both read the
        // original and the second write would discard the first script.
        // The read also serves as an existence check — ENOENT caught below.
        await withPathLock(args.bruFilePath, async () => {
          const content = await readFile(args.bruFilePath, 'utf-8');
          const writer = createWriter(resolvedFile.format);
          const updated = writer.injectScript(
            content,
            canonicalScriptType,
            args.script,
            scriptMode,
          );
          await writeFileAtomic(args.bruFilePath, updated);
        });

        // 10. Return success
        return {
          content: [
            {
              type: 'text',
              text: [
                `Successfully ${scriptMode === 'replace' ? 'replaced' : 'appended'} ${canonicalScriptType} script in ${path.basename(args.bruFilePath)} (${resolvedFile.format} format)`,
                ...resolvedFile.warnings,
              ].join('\n\n')
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Error adding test script: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function registerRemoveScriptTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'remove_script',
    {
      title: 'Remove Script',
      description: 'Delete a pre-request, post-response, or tests script from a Bruno request, leaving the rest of the request intact, including duplicate blocks accumulated by appending. Canonical scriptType values are pre-request/post-response/tests; the aliases before-request and after-response are accepted. Removing all scripts also drops the now-empty script container.',
      inputSchema: {
        bruFilePath: z.string().min(1, 'BRU file path is required').describe('Absolute path to the .yml or .bru request file. Get from list_requests or get_collection_stats.'),
        scriptType: z.enum(['pre-request', 'post-response', 'tests', 'before-request', 'after-response']).describe(
          'Which script to remove. Both .bru and .yml keep the three script types in ' +
          'separate slots, so removal is precise: clearing tests leaves a post-response ' +
          'script in place, and vice versa.',
        )
      }
    },
    async (args) => {
      try {
        const resolved = await resolveRequestFile(args.bruFilePath, 'bruFilePath');
        if (!resolved.ok) {
          return {
            content: [{ type: 'text', text: resolved.message }],
            isError: true,
          };
        }

        const canonicalScriptType = normalizeScriptType(args.scriptType);

        // Read and write under one lock: unguarded, a concurrent injection
        // landing between them would be erased by this write.
        const removed = await withPathLock(args.bruFilePath, async () => {
          const content = await readFile(args.bruFilePath, 'utf-8');
          const writer = createWriter(resolved.format);
          const updated = writer.removeScript(content, canonicalScriptType);

          if (updated === content) {
            return false;
          }

          await writeFileAtomic(args.bruFilePath, updated);
          return true;
        });

        if (!removed) {
          return {
            content: [
              {
                type: 'text',
                text: `No ${canonicalScriptType} script found in ${path.basename(args.bruFilePath)} — nothing to remove.`
              }
            ]
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: [
                `Removed ${canonicalScriptType} script from ${path.basename(args.bruFilePath)} (${resolved.format} format)`,
                ...resolved.warnings,
              ].join('\n\n')
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Error removing script: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}
