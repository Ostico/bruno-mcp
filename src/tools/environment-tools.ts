/**
 * MCP tool registrations: environment tools.
 *
 * Moved out of server.ts unchanged apart from `this.` becoming `ctx.`.
 */

import { z } from 'zod';
import {
  CreateEnvironmentInput,
} from '../bruno/types.js';
import { validateToolPath } from './tool-path.js';
import type { ToolContext } from './context.js';

export function registerCreateEnvironmentTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'create_environment',
    {
      title: 'Create Bruno Environment',
      description: 'Create environment configuration files for Bruno collection',
      inputSchema: {
        collectionPath: z.string().min(1, 'Collection path is required').describe('Absolute path to existing collection directory.'),
        name: z.string().min(1, 'Environment name is required'),
        variables: z.record(z.union([z.string(), z.number(), z.boolean()]))
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
          return {
            content: [
              {
                type: 'text',
                text: `❌ Failed to create environment: ${result.error}`
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
