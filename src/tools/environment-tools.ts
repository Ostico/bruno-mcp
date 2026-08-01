/**
 * MCP tool registrations: environment tools.
 *
 * Moved out of server.ts unchanged apart from `this.` becoming `ctx.`.
 */

import { z } from 'zod';
import {
  CreateEnvironmentInput,
} from '../bruno/types.js';
import { toEnvironmentView } from '../bruno/request-view.js';
import { validateToolPath } from './tool-path.js';
import type { ToolContext } from './context.js';

/** Render one of the conflict report's name lists, spelling out an empty one. */
function describeNames(names: string[]): string {
  return names.length > 0 ? names.join(', ') : '(none)';
}

export function registerCreateEnvironmentTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'create_environment',
    {
      title: 'Create Bruno Environment',
      description: 'Create an environment file for a Bruno collection. Writes the WHOLE file, so it REFUSES a name that already exists rather than overwriting it — the error names the existing variables and says which ones a replace would delete, so you can choose between merging with update_environment, picking another name, and retrying with overwrite: true.',
      inputSchema: {
        collectionPath: z.string().min(1, 'Collection path is required').describe('Absolute path to existing collection directory.'),
        name: z.string().min(1, 'Environment name is required'),
        variables: z.union([
          z.record(z.union([z.string(), z.number(), z.boolean()])),
          z.array(z.object({
            name: z.string().min(1),
            value: z.union([z.string(), z.number(), z.boolean()]).optional(),
            secret: z.boolean().optional(),
            disabled: z.boolean().optional(),
            dataType: z.string().optional(),
          })),
        ]).describe('Either a flat name-to-value map, or a list of variable objects when you need flags. Use the list form to declare a secret at create time: a secret variable is stored as a name only (no format persists a secret\'s value), so `value` is dropped for it.'),
        overwrite: z.boolean().optional().describe('Replace an environment that already exists. Without this an existing name is refused. Keys in the file that this tool does not model are preserved either way.'),
      }
    },
    async (args) => {
      try {
        const pathCheck = validateToolPath(args.collectionPath);
        if (!pathCheck.valid) {
          return {
            content: [{ type: 'text', text: `Invalid collectionPath: ${pathCheck.reason}` }],
            isError: true,
          };
        }

        const input: CreateEnvironmentInput = {
          collectionPath: args.collectionPath,
          name: args.name,
          variables: args.variables
        };
        if (args.overwrite !== undefined) input.overwrite = args.overwrite;

        const result = await ctx.environmentManager.createEnvironment(input);

        if (result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `✅ Environment "${args.name}" created successfully at: ${result.path}`
              }
            ]
          };
        } else {
          // A refused create is reported with its comparison attached, so the
          // caller can decide between merging and a new name without a second
          // call. Values are never included — only names and flags.
          const conflict = result.conflict
            ? `\n\nAlready present: ${describeNames(result.conflict.alreadyPresent)}`
              + `\nWould be added: ${describeNames(result.conflict.added)}`
              + `\nWould be DELETED by a replace: ${describeNames(result.conflict.wouldBeLost)}`
              + '\n\nNext: update_environment to merge, a different name for a new environment, '
              + 'or overwrite: true to replace.'
            : '';
          return {
            content: [
              {
                type: 'text',
                text: `❌ Failed to create environment: ${result.error}${conflict}`
              }
            ],
            isError: true
          };
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Error creating environment: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function registerUpdateEnvironmentTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'update_environment',
    {
      title: 'Update Bruno Environment',
      description: 'Partially update an existing Bruno environment by MERGING the provided variables into the existing ones. Pre-existing variables not listed are preserved (unlike create_environment, which replaces the whole file).',
      inputSchema: {
        collectionPath: z.string().min(1, 'Collection path is required').describe('Absolute path to existing collection directory.'),
        name: z.string().min(1, 'Environment name is required').describe('Name of the existing environment to update.'),
        variables: z.record(z.union([z.string(), z.number(), z.boolean()])).describe('Variables to merge into the environment. Existing variables not listed here are kept.')
      }
    },
    async (args) => {
      try {
        const pathCheck = validateToolPath(args.collectionPath);
        if (!pathCheck.valid) {
          return {
            content: [{ type: 'text', text: `Invalid collectionPath: ${pathCheck.reason}` }],
            isError: true,
          };
        }

        // Partial merge preserving all existing variables (including disabled
        // ones and their flags); only the provided keys are overlaid.
        const result = await ctx.environmentManager.mergeEnvironment(
          args.collectionPath,
          args.name,
          args.variables,
        );

        if (result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `✅ Environment "${args.name}" updated (merged) at: ${result.path}`
              }
            ]
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Failed to update environment: ${result.error}`
              }
            ],
            isError: true
          };
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Error updating environment: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function registerSetEnvironmentVariableTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'set_environment_variable',
    {
      title: 'Set Environment Variable',
      description: 'Set (add or update) a single variable in an existing Bruno environment. MERGES into the environment — all other variables are preserved.',
      inputSchema: {
        collectionPath: z.string().min(1, 'Collection path is required').describe('Absolute path to existing collection directory.'),
        environment: z.string().min(1, 'Environment name is required').describe('Name of the existing environment.'),
        name: z.string().min(1, 'Variable name is required').describe('Variable key to set.'),
        value: z.union([z.string(), z.number(), z.boolean()]).describe('Variable value.'),
        enabled: z.boolean().optional().describe('Whether the variable is enabled. Persisted: enabled=false is written as a disabled variable.'),
        secret: z.boolean().optional().describe('Whether the variable is a secret. Persisted. IMPORTANT: marking a variable secret means its VALUE IS NOT SAVED — Bruno stores a secret variable as a name only (.bru lists it under vars:secret, .yml writes secret: true with no value) and keeps the value outside the collection, so `value` is discarded. Omit this to leave an existing variable\'s secret state untouched; pass false to convert a secret variable back to a plain one carrying `value`.')
      }
    },
    async (args) => {
      try {
        const pathCheck = validateToolPath(args.collectionPath);
        if (!pathCheck.valid) {
          return {
            content: [{ type: 'text', text: `Invalid collectionPath: ${pathCheck.reason}` }],
            isError: true,
          };
        }

        const result = await ctx.environmentManager.setEnvironmentVariable(
          args.collectionPath,
          args.environment,
          args.name,
          args.value,
          args.enabled,
          args.secret,
        );

        if (result.success) {
          // Say so when the value was deliberately not written, so the caller
          // does not assume the credential is now resolvable from the file.
          const secretNote = args.secret === true
            ? ' (marked secret — the name is recorded, the value is not stored in the file)'
            : '';
          return {
            content: [
              {
                type: 'text',
                text: `✅ Variable "${args.name}" set in environment "${args.environment}"${secretNote} at: ${result.path}`
              }
            ]
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Failed to set variable: ${result.error}`
              }
            ],
            isError: true
          };
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Error setting variable: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function registerRemoveEnvironmentVariableTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'remove_environment_variable',
    {
      title: 'Remove Environment Variable',
      description: 'Remove a single variable from an existing Bruno environment. MERGES into the environment — all other variables are preserved.',
      inputSchema: {
        collectionPath: z.string().min(1, 'Collection path is required').describe('Absolute path to existing collection directory.'),
        environment: z.string().min(1, 'Environment name is required').describe('Name of the existing environment.'),
        name: z.string().min(1, 'Variable name is required').describe('Variable key to remove.')
      }
    },
    async (args) => {
      try {
        const pathCheck = validateToolPath(args.collectionPath);
        if (!pathCheck.valid) {
          return {
            content: [{ type: 'text', text: `Invalid collectionPath: ${pathCheck.reason}` }],
            isError: true,
          };
        }

        const result = await ctx.environmentManager.removeEnvironmentVariable(
          args.collectionPath,
          args.environment,
          args.name,
        );

        if (result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `✅ Variable "${args.name}" removed from environment "${args.environment}" at: ${result.path}`
              }
            ]
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Failed to remove variable: ${result.error}`
              }
            ],
            isError: true
          };
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Error removing variable: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function registerReadEnvironmentTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'read_environment',
    {
      title: 'Read Bruno Environment',
      description: 'Read an environment back as structured JSON: every variable with its value, plus its disabled and secret flags. Omit "name" to list the collection\'s environments instead. Secret variables are returned by name only — Bruno stores no value for a secret in either file format, so there is none to return.',
      inputSchema: {
        collectionPath: z.string().min(1, 'Collection path is required')
          .describe('Absolute path to the collection directory.'),
        name: z.string().min(1).optional()
          .describe('Environment name, without extension. Omit to list the available environment names.'),
      },
    },
    async (args) => {
      try {
        const pathCheck = validateToolPath(args.collectionPath);
        if (!pathCheck.valid) {
          return {
            content: [{ type: 'text', text: `Invalid collectionPath: ${pathCheck.reason}` }],
            isError: true,
          };
        }

        if (!args.name) {
          const environments = await ctx.environmentManager.listEnvironments(args.collectionPath);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ collectionPath: args.collectionPath, environments }, null, 2)
              }
            ],
          };
        }

        const envFile = await ctx.environmentManager.loadEnvironmentFile(
          args.collectionPath,
          args.name,
        );
        const view = toEnvironmentView(envFile, args.collectionPath, args.name);

        return {
          content: [{ type: 'text', text: JSON.stringify(view, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Error reading environment: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}
