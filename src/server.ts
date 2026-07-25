/**
 * Bruno MCP Server
 * Main MCP server implementation for Bruno API testing file generation
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import path from 'path';
import { readFile, writeFile, unlink } from 'node:fs/promises';

// Import our Bruno modules
import { createCollectionManager } from './bruno/collection.js';
import { createEnvironmentManager } from './bruno/environment.js';
import { createRequestBuilder } from './bruno/request.js';
import { createWorkspaceResolver } from './bruno/workspace.js';
import { listCollectionsHandler } from './bruno/list-collections-handler.js';
import { getCollectionStats } from './bruno/collection-stats.js';
import { RequestExecutor } from './bruno/request-executor.js';
import { validatePath } from './bruno/path-validator.js';
import {
  CreateCollectionInput,
  CreateEnvironmentInput,
  CreateRequestInput,
  AddTestScriptInput,
  CreateTestSuiteInput,
  HttpMethod,
  AuthType,
  BodyType
} from './bruno/types.js';
import { findCollectionRoot, detectFormat } from './bruno/format-detector.js';
import type { CollectionFormat } from './bruno/format-detector.js';
import { createWriter, normalizeScriptType } from './bruno/format-factory.js';

/**
 * Inline-scripts input schema shared by create_request and modify_request.
 * Canonical keys are pre-request/post-response/tests; the aliases
 * before-request (→ pre-request) and after-response (→ post-response) are
 * also accepted and normalized when persisted.
 */
const inlineScriptsSchema = z.object({
  'pre-request': z.string().optional(),
  'post-response': z.string().optional(),
  tests: z.string().optional(),
  'before-request': z.string().optional(),
  'after-response': z.string().optional(),
}).optional().describe(
  'Inline scripts to persist with the request. Keys: pre-request, post-response, tests ' +
  '(aliases before-request/after-response accepted). Avoids a separate add_test_script call. ' +
  'IMPORTANT for tests/post-response: only assertions inside a test() block are reported. ' +
  'Write test("status is 200", function() { expect(res.getStatus()).to.equal(200); }); — a bare ' +
  'expect() at the top level still runs, but a passing one records nothing, so run_collection ' +
  'reports "tests": [] and the request looks green with no assertions. Available in scripts: ' +
  'res.getStatus()/getStatusText()/getHeader(name)/getHeaders()/getBody()/getResponseTime(), ' +
  'bru.setVar(name, value)/getVar(name), and expect(actual) with .to.equal/.contain/.include, ' +
  '.to.have.property/.lengthOf, .to.be.a/.an/.below/.above, and .to.not.* negations. ' +
  'RETURN TYPE: res.getBody() returns the response already parsed into a JS object/array when the ' +
  'Content-Type is application/json or a +json type (raw text otherwise). Access fields directly — res.getBody().field — ' +
  'and do NOT JSON.parse() it, which throws SyntaxError: "[object Object]" is not valid JSON.',
);

export class BrunoMcpServer {
  private server: McpServer;
  private collectionManager;
  private environmentManager;
  private requestBuilder;
  private workspaceResolver;

  constructor() {
    // Initialize MCP server
    this.server = new McpServer(
      {
        name: 'bruno-mcp',
        version: '1.2.0'
      },
      {
        instructions: 'When the user asks to test, call, or run API endpoints, use this server first. ' +
          'Workflow: list_collections → list_requests (to discover request file paths) → run_collection. ' +
          'Do not fall back to curl or direct HTTP calls when Bruno collections already cover the endpoints.',
      },
    );

    // Initialize Bruno managers
    this.collectionManager = createCollectionManager();
    this.environmentManager = createEnvironmentManager();
    this.requestBuilder = createRequestBuilder();
    this.workspaceResolver = createWorkspaceResolver();

    this.setupTools();
  }

  /**
   * Validate a tool input path for traversal attacks and null bytes.
   *
   * When `basePath` is provided the path must resolve within it (uses the
   * full `validatePath` from path-validator).  Otherwise a lightweight
   * check rejects `..` segments and null bytes.
   */
  private validateToolPath(
    inputPath: string,
    basePath?: string,
  ): { valid: boolean; resolved: string; reason?: string } {
    if (!inputPath) {
      return { valid: false, resolved: '', reason: 'Path is required' };
    }
    // Reject null bytes
    if (inputPath.includes('\0')) {
      return { valid: false, resolved: '', reason: 'Path contains null bytes' };
    }
    // If basePath provided, validate path is within it
    if (basePath) {
      return validatePath(inputPath, basePath);
    }
    // Otherwise just validate no obvious traversal
    const resolved = path.resolve(inputPath);
    if (inputPath.includes('..')) {
      return { valid: false, resolved, reason: 'Path traversal not allowed' };
    }
    return { valid: true, resolved };
  }

  /**
   * Set up all MCP tools
   */
  private setupTools(): void {
    this.setupCreateCollectionTool();
    this.setupCreateEnvironmentTool();
    this.setupUpdateEnvironmentTool();
    this.setupSetEnvironmentVariableTool();
    this.setupRemoveEnvironmentVariableTool();
    this.setupCreateRequestTool();
    this.setupModifyRequestTool();
    this.setupAddTestScriptTool();
    this.setupRemoveScriptTool();
    this.setupDeleteRequestTool();
    this.setupCreateTestSuiteTool();
    this.setupCreateCrudRequestsTool();
    this.setupListCollectionsTool();
    this.setupListRequestsTool();
    this.setupGetCollectionStatsTool();
    this.setupRunCollectionTool();
  }

  /**
   * Tool: create_collection
   */
  private setupCreateCollectionTool(): void {
    this.server.registerTool(
      'create_collection',
      {
        title: 'Create Bruno Collection',
        description: 'Create a new Bruno API testing collection with configuration',
        inputSchema: {
          name: z.string().min(1, 'Collection name is required'),
          description: z.string().optional(),
          baseUrl: z.string().url().optional(),
          outputPath: z.string().min(1, 'Output path is required').describe('Absolute path where the new collection directory will be created.'),
          ignore: z.array(z.string()).optional(),
          format: z.enum(['yaml', 'bru']).optional().default('yaml')
        }
      },
      async (args) => {
        try {
          const pathCheck = this.validateToolPath(args.outputPath);
          if (!pathCheck.valid) {
            return {
              content: [{ type: 'text', text: `Invalid outputPath: ${pathCheck.reason}` }],
              isError: true,
            };
          }

          const input: CreateCollectionInput = {
            name: args.name,
            description: args.description,
            baseUrl: args.baseUrl,
            outputPath: args.outputPath,
            ignore: args.ignore,
            format: args.format as 'yaml' | 'bru',
          };

          const result = await this.collectionManager.createCollection(input);

          if (result.success) {
            return {
              content: [
                {
                  type: 'text',
                  text: `✅ Bruno collection "${args.name}" created successfully at: ${result.path}`
                }
              ]
            };
          } else {
            return {
              content: [
                {
                  type: 'text',
                  text: `❌ Failed to create collection: ${result.error}`
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
                text: `❌ Error creating collection: ${error instanceof Error ? error.message : 'Unknown error'}`
              }
            ],
            isError: true
          };
        }
      }
    );
  }

  /**
   * Tool: create_environment
   */
  private setupCreateEnvironmentTool(): void {
    this.server.registerTool(
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
          const pathCheck = this.validateToolPath(args.collectionPath);
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

          const result = await this.environmentManager.createEnvironment(input);

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

  /**
   * Tool: update_environment
   */
  private setupUpdateEnvironmentTool(): void {
    this.server.registerTool(
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
          const pathCheck = this.validateToolPath(args.collectionPath);
          if (!pathCheck.valid) {
            return {
              content: [{ type: 'text', text: `Invalid collectionPath: ${pathCheck.reason}` }],
              isError: true,
            };
          }

          // Partial merge preserving all existing variables (including disabled
          // ones and their flags); only the provided keys are overlaid.
          const result = await this.environmentManager.mergeEnvironment(
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

  /**
   * Tool: set_environment_variable
   */
  private setupSetEnvironmentVariableTool(): void {
    this.server.registerTool(
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
          secret: z.boolean().optional().describe('Whether the variable is a secret. Ignored — not representable in the environment variable model (EnvVariable) or the YAML format.')
        }
      },
      async (args) => {
        try {
          const pathCheck = this.validateToolPath(args.collectionPath);
          if (!pathCheck.valid) {
            return {
              content: [{ type: 'text', text: `Invalid collectionPath: ${pathCheck.reason}` }],
              isError: true,
            };
          }

          const result = await this.environmentManager.setEnvironmentVariable(
            args.collectionPath,
            args.environment,
            args.name,
            args.value,
            args.enabled,
          );

          if (result.success) {
            return {
              content: [
                {
                  type: 'text',
                  text: `✅ Variable "${args.name}" set in environment "${args.environment}" at: ${result.path}`
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

  /**
   * Tool: remove_environment_variable
   */
  private setupRemoveEnvironmentVariableTool(): void {
    this.server.registerTool(
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
          const pathCheck = this.validateToolPath(args.collectionPath);
          if (!pathCheck.valid) {
            return {
              content: [{ type: 'text', text: `Invalid collectionPath: ${pathCheck.reason}` }],
              isError: true,
            };
          }

          const result = await this.environmentManager.removeEnvironmentVariable(
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

  /**
   * Tool: create_request
   */
  private setupCreateRequestTool(): void {
    this.server.registerTool(
      'create_request',
      {
        title: 'Create Bruno Request',
        description: 'Generate request files for API testing (supports .bru and .yml formats). Supports multipart/form-data with file uploads and per-part contentType (body.type "form-data" with formData entries of type "file"), and inline scripts (pre-request/post-response/tests) so no separate add_test_script call is needed.',
        inputSchema: {
          collectionPath: z.string().min(1, 'Collection path is required').describe('Absolute path to existing collection directory.'),
          name: z.string().min(1, 'Request name is required'),
          method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']),
          url: z.string().min(1, 'URL is required'),
          headers: z.record(z.string()).optional(),
          body: z.object({
            type: z.enum(['none', 'json', 'text', 'xml', 'form-data', 'form-urlencoded', 'binary']),
            content: z.string().optional(),
            formData: z.array(z.object({
              name: z.string(),
              value: z.union([z.string(), z.array(z.string())]),
              type: z.enum(['text', 'file']).optional(),
              contentType: z.string().optional()
            })).optional()
          }).optional(),
          auth: z.object({
            type: z.enum(['none', 'bearer', 'basic', 'oauth2', 'api-key', 'digest']),
            config: z.record(z.string())
          }).optional(),
          query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
          folder: z.string().optional(),
          sequence: z.number().optional(),
          scripts: inlineScriptsSchema
        }
      },
      async (args) => {
        try {
          const pathCheck = this.validateToolPath(args.collectionPath);
          if (!pathCheck.valid) {
            return {
              content: [{ type: 'text', text: `Invalid collectionPath: ${pathCheck.reason}` }],
              isError: true,
            };
          }

          const input: CreateRequestInput = {
            collectionPath: args.collectionPath,
            name: args.name,
            method: args.method as HttpMethod,
            url: args.url,
            headers: args.headers,
            body: args.body ? {
              type: args.body.type as BodyType,
              content: args.body.content,
              formData: args.body.formData
            } : undefined,
            auth: args.auth ? {
              type: args.auth.type as AuthType,
              config: args.auth.config
            } : undefined,
            query: args.query,
            folder: args.folder,
            sequence: args.sequence,
            scripts: args.scripts as Record<string, string> | undefined
          };

          const result = await this.requestBuilder.createRequest(input);

          if (result.success) {
            return {
              content: [
                {
                  type: 'text',
                  text: `✅ Request "${args.name}" created successfully at: ${result.path}`
                }
              ]
            };
          } else {
            return {
              content: [
                {
                  type: 'text',
                  text: `❌ Failed to create request: ${result.error}`
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
                text: `❌ Error creating request: ${error instanceof Error ? error.message : 'Unknown error'}`
              }
            ],
            isError: true
          };
        }
      }
    );
  }

  /**
   * Tool: modify_request
   */
  private setupModifyRequestTool(): void {
    this.server.registerTool(
      'modify_request',
      {
        title: 'Modify Request',
        description: 'Update an existing Bruno request file with partial-merge semantics. Only provided fields are updated; all other fields are preserved. Supports multipart/form-data with file uploads and per-part contentType. Inline scripts REPLACE the existing script of the same type by default (idempotent — repeated calls do not accumulate duplicate blocks); pass scriptMode:"append" to concatenate instead. Use remove_script to clear a script entirely.',
        inputSchema: {
          filePath: z.string().min(1, 'File path is required').describe('Absolute path to the .yml or .bru request file to modify. Get from list_requests or get_collection_stats.'),
          name: z.string().optional(),
          method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']).optional(),
          url: z.string().optional(),
          headers: z.record(z.string()).optional(),
          body: z.object({
            type: z.enum(['none', 'json', 'text', 'xml', 'form-data', 'form-urlencoded', 'binary']),
            content: z.string().optional(),
            formData: z.array(z.object({
              name: z.string(),
              value: z.union([z.string(), z.array(z.string())]),
              type: z.enum(['text', 'file']).optional(),
              contentType: z.string().optional()
            })).optional()
          }).optional(),
          auth: z.object({
            type: z.enum(['none', 'bearer', 'basic', 'oauth2', 'api-key', 'digest']),
            config: z.record(z.string())
          }).optional(),
          query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
          scripts: inlineScriptsSchema,
          scriptMode: z.enum(['replace', 'append']).optional().default('replace').describe(
            'How to write the scripts field. "replace" (default) overwrites the existing script ' +
            'of each provided type, so calling modify_request repeatedly is idempotent. "append" ' +
            'concatenates onto the existing script, which accumulates blocks across calls. ' +
            'In .yml collections post-response and tests share one after-response slot, so ' +
            'replacing either overwrites that shared block; supplying both in one call merges them.',
          )
        }
      },
      async (args) => {
        try {
          // 1. Path validation (traversal + null bytes)
          const pathCheck = this.validateToolPath(args.filePath);
          if (!pathCheck.valid) {
            return {
              content: [{ type: 'text', text: `Invalid filePath: ${pathCheck.reason}` }],
              isError: true,
            };
          }

          // 2. File extension validation
          const ext = path.extname(args.filePath).toLowerCase();
          if (ext !== '.bru' && ext !== '.yml') {
            return {
              content: [{ type: 'text', text: `Invalid file extension "${ext}": expected .bru or .yml` }],
              isError: true,
            };
          }

          // 3. Find collection root
          const collectionRoot = await findCollectionRoot(args.filePath);
          if (!collectionRoot) {
            return {
              content: [{ type: 'text', text: 'Could not determine collection format: no opencollection.yml or bruno.json found within 10 parent directories' }],
              isError: true,
            };
          }

          // 4. Detect format and verify extension matches
          const detection = await detectFormat(collectionRoot);
          const expectedExt = detection.format === 'yaml' ? '.yml' : '.bru';
          if (ext !== expectedExt) {
            return {
              content: [{ type: 'text', text: `File extension "${ext}" does not match collection format "${detection.format}" (expected "${expectedExt}")` }],
              isError: true,
            };
          }

          // 5. Build partial update input from provided fields
          const updates: Partial<CreateRequestInput> = {};
          if (args.name !== undefined) updates.name = args.name;
          if (args.method !== undefined) updates.method = args.method as HttpMethod;
          if (args.url !== undefined) updates.url = args.url;
          if (args.headers !== undefined) updates.headers = args.headers;
          if (args.body !== undefined) {
            updates.body = {
              type: args.body.type as BodyType,
              content: args.body.content,
              formData: args.body.formData,
            };
          }
          if (args.auth !== undefined) {
            updates.auth = {
              type: args.auth.type as AuthType,
              config: args.auth.config,
            };
          }
          if (args.query !== undefined) updates.query = args.query;
          if (args.scripts !== undefined) {
            updates.scripts = args.scripts as Record<string, string>;
            // Default explicitly: the zod default only applies when the SDK
            // validates input, not when the handler is invoked directly.
            updates.scriptMode = args.scriptMode ?? 'replace';
          }

          // 6. Call updateRequest with partial merge
          const result = await this.requestBuilder.updateRequest(args.filePath, updates);

          if (result.success) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Successfully modified request "${path.basename(args.filePath)}"`
                }
              ]
            };
          } else {
            return {
              content: [
                {
                  type: 'text',
                  text: `Failed to modify request: ${result.error}`
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
                text: `Error modifying request: ${error instanceof Error ? error.message : 'Unknown error'}`
              }
            ],
            isError: true
          };
        }
      }
    );
  }

  /**
   * Tool: add_test_script
   */
  private setupAddTestScriptTool(): void {
    this.server.registerTool(
      'add_test_script',
      {
        title: 'Add Test Script',
        description: 'Add pre-request, post-response, or tests scripts to a Bruno request. Canonical scriptType values are pre-request/post-response/tests; the aliases before-request (→ pre-request) and after-response (→ post-response) are also accepted. Appends to any existing script of that type by default — pass scriptMode:"replace" to overwrite it, or use remove_script to clear it. Assertions must be wrapped in test("name", function() { ... }) to be reported.',
        inputSchema: {
          bruFilePath: z.string().min(1, 'BRU file path is required').describe('Absolute path to the .yml or .bru request file. Get from list_requests or get_collection_stats.'),
          scriptType: z.enum(['pre-request', 'post-response', 'tests', 'before-request', 'after-response']).describe('Script type. Canonical: pre-request, post-response, tests. Aliases: before-request (→ pre-request), after-response (→ post-response).'),
          script: z.string().min(1, 'Script content is required').describe(
            'Script body. For post-response/tests, wrap every assertion in a test() block — ' +
            'test("status is 200", function() { expect(res.getStatus()).to.equal(200); }); — ' +
            'because only test() blocks are recorded in run_collection results. A bare passing ' +
            'expect() at the top level records nothing and the run reports "tests": []. ' +
            'res.getBody() returns the response already parsed into a JS object/array for ' +
            'application/json and +json content-types, so read fields directly ' +
            '(res.getBody().field) and do NOT JSON.parse() it.',
          ),
          scriptMode: z.enum(['append', 'replace']).optional().default('append').describe(
            'How to write the script. "append" (default) concatenates onto any existing script ' +
            'of this type; "replace" overwrites it. In .yml collections post-response and tests ' +
            'share one after-response slot, so replacing either overwrites that shared block.',
          )
        }
      },
      async (args) => {
        try {
          // 1. Path validation (traversal + null bytes)
          const pathCheck = this.validateToolPath(args.bruFilePath);
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

          // 3. File extension validation
          const ext = path.extname(args.bruFilePath).toLowerCase();
          if (ext !== '.bru' && ext !== '.yml') {
            return {
              content: [{ type: 'text', text: `Invalid file extension "${ext}": expected .bru or .yml` }],
              isError: true,
            };
          }

          // 4. Find collection root
          const collectionRoot = await findCollectionRoot(args.bruFilePath);
          if (!collectionRoot) {
            return {
              content: [{ type: 'text', text: 'Could not determine collection format: no opencollection.yml or bruno.json found within 10 parent directories' }],
              isError: true,
            };
          }

          // 5. Detect format
          const detection = await detectFormat(collectionRoot);

          // 6. Verify extension matches detected format
          const expectedExt = detection.format === 'yaml' ? '.yml' : '.bru';
          if (ext !== expectedExt) {
            return {
              content: [{ type: 'text', text: `File extension "${ext}" does not match collection format "${detection.format}" (expected "${expectedExt}")` }],
              isError: true,
            };
          }

          // 7. Read file content (also serves as existence check — ENOENT caught below)
          // Note: read-modify-write is not atomic. Concurrent writes to the same file
          // may lose data. Single-client MCP usage is safe; multi-client needs locking.
          const content = await readFile(args.bruFilePath, 'utf-8');

          // 8. Normalize aliases to canonical script type, then inject
          const canonicalScriptType = normalizeScriptType(args.scriptType);
          const writer = createWriter(detection.format);
          // Default explicitly: the zod default only applies when the SDK
          // validates input, not when the handler is invoked directly.
          const scriptMode = args.scriptMode ?? 'append';
          const updated = writer.injectScript(content, canonicalScriptType, args.script, scriptMode);

          // 9. Write back
          await writeFile(args.bruFilePath, updated);

          // 10. Return success
          return {
            content: [
              {
                type: 'text',
                text: `Successfully ${scriptMode === 'replace' ? 'replaced' : 'appended'} ${canonicalScriptType} script in ${path.basename(args.bruFilePath)} (${detection.format} format)`
                  + (detection.format === 'yaml' && (canonicalScriptType === 'tests' || canonicalScriptType === 'post-response')
                    ? '. Note: .yml collections store post-response and tests in one shared after-response block.'
                    : '')
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

  /**
   * Shared preflight for tools that operate on an existing request file:
   * path traversal / null bytes, extension, collection root, format match.
   */
  private async resolveRequestFile(
    filePath: string,
    argName: string,
  ): Promise<
    | { ok: true; format: CollectionFormat }
    | { ok: false; message: string }
  > {
    const pathCheck = this.validateToolPath(filePath);
    if (!pathCheck.valid) {
      return { ok: false, message: `Invalid ${argName}: ${pathCheck.reason}` };
    }

    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.bru' && ext !== '.yml') {
      return {
        ok: false,
        message: `Invalid file extension "${ext}": expected .bru or .yml`,
      };
    }

    const collectionRoot = await findCollectionRoot(filePath);
    if (!collectionRoot) {
      return {
        ok: false,
        message:
          'Could not determine collection format: no opencollection.yml or bruno.json found within 10 parent directories',
      };
    }

    const detection = await detectFormat(collectionRoot);
    const expectedExt = detection.format === 'yaml' ? '.yml' : '.bru';
    if (ext !== expectedExt) {
      return {
        ok: false,
        message: `File extension "${ext}" does not match collection format "${detection.format}" (expected "${expectedExt}")`,
      };
    }

    return { ok: true, format: detection.format };
  }

  /**
   * Tool: remove_script
   */
  private setupRemoveScriptTool(): void {
    this.server.registerTool(
      'remove_script',
      {
        title: 'Remove Script',
        description: 'Delete a pre-request, post-response, or tests script from a Bruno request, leaving the rest of the request intact. Use this to undo or clean up a script written by create_request/modify_request/add_test_script — including duplicate blocks accumulated by appending. Canonical scriptType values are pre-request/post-response/tests; the aliases before-request and after-response are accepted. Removing all scripts also drops the now-empty script container.',
        inputSchema: {
          bruFilePath: z.string().min(1, 'BRU file path is required').describe('Absolute path to the .yml or .bru request file. Get from list_requests or get_collection_stats.'),
          scriptType: z.enum(['pre-request', 'post-response', 'tests', 'before-request', 'after-response']).describe(
            'Which script to remove. In .yml collections post-response and tests share one ' +
            'after-response block, so removing either clears that shared block; .bru files keep ' +
            'the three slots separate and removal is precise.',
          )
        }
      },
      async (args) => {
        try {
          const resolved = await this.resolveRequestFile(args.bruFilePath, 'bruFilePath');
          if (!resolved.ok) {
            return {
              content: [{ type: 'text', text: resolved.message }],
              isError: true,
            };
          }

          // Read-modify-write is not atomic; single-client MCP usage is safe.
          const content = await readFile(args.bruFilePath, 'utf-8');
          const canonicalScriptType = normalizeScriptType(args.scriptType);
          const writer = createWriter(resolved.format);
          const updated = writer.removeScript(content, canonicalScriptType);

          if (updated === content) {
            return {
              content: [
                {
                  type: 'text',
                  text: `No ${canonicalScriptType} script found in ${path.basename(args.bruFilePath)} — nothing to remove.`
                }
              ]
            };
          }

          await writeFile(args.bruFilePath, updated);

          return {
            content: [
              {
                type: 'text',
                text: `Removed ${canonicalScriptType} script from ${path.basename(args.bruFilePath)} (${resolved.format} format)`
                  + (resolved.format === 'yaml' && (canonicalScriptType === 'tests' || canonicalScriptType === 'post-response')
                    ? '. Note: .yml collections store post-response and tests in one shared after-response block, so both are now cleared.'
                    : '')
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

  /**
   * Tool: delete_request
   */
  private setupDeleteRequestTool(): void {
    this.server.registerTool(
      'delete_request',
      {
        title: 'Delete Request',
        description: 'Permanently delete a Bruno request file from a collection. Use this to remove a request created by mistake; the file is unlinked from disk and cannot be recovered through this server. Only .yml/.bru files inside a detected Bruno collection can be deleted. To clear just a script and keep the request, use remove_script instead.',
        inputSchema: {
          filePath: z.string().min(1, 'File path is required').describe('Absolute path to the .yml or .bru request file to delete. Get from list_requests or get_collection_stats.'),
          confirm: z.literal(true).describe('Must be true. Explicit acknowledgement that the file is deleted permanently.')
        }
      },
      async (args) => {
        try {
          // Re-checked here, not only in the schema: deletion is irreversible
          // and the handler must not depend on upstream validation.
          if (args.confirm !== true) {
            return {
              content: [{ type: 'text', text: 'Refusing to delete: confirm must be true.' }],
              isError: true,
            };
          }

          const resolved = await this.resolveRequestFile(args.filePath, 'filePath');
          if (!resolved.ok) {
            return {
              content: [{ type: 'text', text: resolved.message }],
              isError: true,
            };
          }

          await unlink(args.filePath);

          return {
            content: [
              {
                type: 'text',
                text: `Deleted request ${path.basename(args.filePath)} (${resolved.format} format)`
              }
            ]
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Error deleting request: ${error instanceof Error ? error.message : 'Unknown error'}`
              }
            ],
            isError: true
          };
        }
      }
    );
  }

  /**
   * Tool: create_test_suite
   */
  private setupCreateTestSuiteTool(): void {
    this.server.registerTool(
      'create_test_suite',
      {
        title: 'Create Test Suite',
        description: 'Generate comprehensive test collections with multiple related requests',
        inputSchema: {
          collectionPath: z.string().min(1, 'Collection path is required').describe('Absolute path to existing collection directory.'),
          suiteName: z.string().min(1, 'Suite name is required'),
          requests: z.array(z.object({
            name: z.string(),
            method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']),
            url: z.string(),
            headers: z.record(z.string()).optional(),
            body: z.object({
              type: z.enum(['none', 'json', 'text', 'xml', 'form-data', 'form-urlencoded']),
              content: z.string().optional()
            }).optional(),
            auth: z.object({
              type: z.enum(['none', 'bearer', 'basic', 'oauth2', 'api-key']),
              config: z.record(z.string())
            }).optional(),
            folder: z.string().optional()
          })),
          dependencies: z.array(z.object({
            from: z.string(),
            to: z.string(),
          })).optional()
        }
      },
      async (args) => {
        try {
          const pathCheck = this.validateToolPath(args.collectionPath);
          if (!pathCheck.valid) {
            return {
              content: [{ type: 'text', text: `Invalid collectionPath: ${pathCheck.reason}` }],
              isError: true,
            };
          }

          // Map request names to their created file paths
          const nameToPath: Map<string, string> = new Map();
          const results = [];

          for (let i = 0; i < args.requests.length; i++) {
            const req = args.requests[i];
            const input: CreateRequestInput = {
              collectionPath: args.collectionPath,
              name: req.name,
              method: req.method as HttpMethod,
              url: req.url,
              headers: req.headers,
              body: req.body ? {
                type: req.body.type as BodyType,
                content: req.body.content
              } : undefined,
              auth: req.auth ? {
                type: req.auth.type as AuthType,
                config: req.auth.config
              } : undefined,
              folder: req.folder || args.suiteName,
              sequence: i + 1
            };

            const result = await this.requestBuilder.createRequest(input);
            results.push(result);
            if (result.success && result.path) {
              nameToPath.set(req.name, result.path);
            }
          }

          // Apply dependency ordering if dependencies are provided
          if (args.dependencies && args.dependencies.length > 0) {
            const requestNames = args.requests.map(r => r.name);
            const sortResult = this.topologicalSort(requestNames, args.dependencies);

            if (sortResult.error) {
              return {
                content: [{ type: 'text', text: sortResult.error }],
                isError: true,
              };
            }

            // Update seq values based on topological order
            for (let i = 0; i < sortResult.order!.length; i++) {
              const name = sortResult.order![i];
              const filePath = nameToPath.get(name);
              if (filePath) {
                await this.requestBuilder.updateRequest(filePath, { sequence: i + 1 });
              }
            }
          }

          const successCount = results.filter(r => r.success).length;
          const failCount = results.filter(r => !r.success).length;

          return {
            content: [
              {
                type: 'text',
                text: `✅ Test suite "${args.suiteName}" created with ${successCount} requests${failCount > 0 ? ` (${failCount} failed)` : ''}`
              }
            ]
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Error creating test suite: ${error instanceof Error ? error.message : 'Unknown error'}`
              }
            ],
            isError: true
          };
        }
      }
    );
  }

  /**
   * Topological sort using Kahn's algorithm.
   * Returns ordered names or an error if a cycle is detected.
   */
  private topologicalSort(
    names: string[],
    dependencies: Array<{ from: string; to: string }>
  ): { order?: string[]; error?: string } {
    // Build adjacency list and in-degree map
    const adjacency: Map<string, string[]> = new Map();
    const inDegree: Map<string, number> = new Map();

    for (const name of names) {
      adjacency.set(name, []);
      inDegree.set(name, 0);
    }

    for (const dep of dependencies) {
      // "from" must run before "to", so from → to is an edge
      const neighbors = adjacency.get(dep.from);
      if (neighbors) {
        neighbors.push(dep.to);
      }
      inDegree.set(dep.to, (inDegree.get(dep.to) || 0) + 1);
    }

    // Initialize queue with nodes that have no incoming edges
    const queue: string[] = [];
    for (const name of names) {
      if (inDegree.get(name) === 0) {
        queue.push(name);
      }
    }

    const order: string[] = [];
    while (queue.length > 0) {
      const node = queue.shift()!;
      order.push(node);

      for (const neighbor of adjacency.get(node) || []) {
        const newDegree = (inDegree.get(neighbor) || 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }

    if (order.length !== names.length) {
      // Cycle detected — find the nodes involved
      const cycleNodes = names.filter(n => !order.includes(n));
      return { error: `Circular dependency detected between: ${cycleNodes.join(', ')}` };
    }

    return { order };
  }

  /**
   * Tool: create_crud_requests
   */
  private setupCreateCrudRequestsTool(): void {
    this.server.registerTool(
      'create_crud_requests',
      {
        title: 'Create CRUD Requests',
        description: 'Generate a complete set of CRUD operations for an entity',
        inputSchema: {
          collectionPath: z.string().min(1, 'Collection path is required').describe('Absolute path to existing collection directory.'),
          entityName: z.string().min(1, 'Entity name is required'),
          baseUrl: z.string().min(1, 'Base URL is required'),
          folder: z.string().optional()
        }
      },
      async (args) => {
        try {
          const pathCheck = this.validateToolPath(args.collectionPath);
          if (!pathCheck.valid) {
            return {
              content: [{ type: 'text', text: `Invalid collectionPath: ${pathCheck.reason}` }],
              isError: true,
            };
          }

          const results = await this.requestBuilder.createCrudRequests(
            args.collectionPath,
            args.entityName,
            args.baseUrl,
            args.folder
          );

          const successCount = results.filter(r => r.success).length;
          const failCount = results.filter(r => !r.success).length;

          return {
            content: [
              {
                type: 'text',
                text: `✅ CRUD operations for "${args.entityName}" created with ${successCount} requests${failCount > 0 ? ` (${failCount} failed)` : ''}`
              }
            ]
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Error creating CRUD requests: ${error instanceof Error ? error.message : 'Unknown error'}`
              }
            ],
            isError: true
          };
        }
      }
    );
  }

  /**
   * Tool: list_collections
   */
  private setupListCollectionsTool(): void {
    this.server.registerTool(
      'list_collections',
      {
        title: 'List Collections',
        description: 'List the Bruno collections REGISTERED IN workspace.yml, with their names and paths. This is a registry listing, not a filesystem scan: a collection that exists on disk but is not registered will NOT appear, and registered entries that no longer exist are returned with "exists": false. If you already know a collection\'s absolute path, pass it directly to the other tools — it does not need to appear here. Use the returned path as collectionPath in other tools (get_collection_stats, list_requests, run_collection).',
        inputSchema: {
          workspacePath: z.string().optional().describe('Optional explicit path to workspace.yml')
        }
      },
      async (args) => {
        try {
          // Validate workspacePath if provided (basic traversal check)
          if (args.workspacePath) {
            const wsCheck = this.validateToolPath(args.workspacePath);
            if (!wsCheck.valid) {
              return {
                content: [{ type: 'text', text: `Invalid workspacePath: ${wsCheck.reason}` }],
                isError: true,
              };
            }
          }

          const collections = await listCollectionsHandler(
            this.workspaceResolver,
            { workspacePath: args.workspacePath }
          );

          if (collections.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    collections: [],
                    message: 'No collections found. Ensure Bruno workspace.yml exists or provide an explicit workspacePath.'
                  }, null, 2)
                }
              ]
            };
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ collections }, null, 2)
              }
            ]
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Error listing collections: ${error instanceof Error ? error.message : 'Unknown error'}`
              }
            ],
            isError: true
          };
        }
      }
    );
  }

  /**
   * Tool: list_requests
   */
  private setupListRequestsTool(): void {
    this.server.registerTool(
      'list_requests',
      {
        title: 'List Requests',
        description: 'List all request files (.yml/.bru) in a Bruno collection. Returns absolute file paths that can be used as requestPath in run_collection.',
        inputSchema: {
          collectionPath: z.string().min(1).describe('Absolute path to collection directory. Use the path returned by list_collections.')
        }
      },
      async (args) => {
        try {
          const pathCheck = this.validateToolPath(args.collectionPath);
          if (!pathCheck.valid) {
            return {
              content: [{ type: 'text', text: `Invalid collectionPath: ${pathCheck.reason}` }],
              isError: true,
            };
          }

          const requests = await this.collectionManager.listRequests(args.collectionPath);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ requests }, null, 2)
              }
            ]
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Error listing requests: ${error instanceof Error ? error.message : 'Unknown error'}`
              }
            ],
            isError: true
          };
        }
      }
    );
  }

  /**
   * Tool: get_collection_stats
   */
  private setupGetCollectionStatsTool(): void {
    this.server.registerTool(
      'get_collection_stats',
      {
        title: 'Get Collection Statistics',
        description: 'Get statistics about a Bruno collection — request counts by method, folders, environments, and per-request details including file paths. environmentDetails lists each environment with the NAMES of the variables it declares (values are withheld), so you can see what an environment already defines before merging into it with set_environment_variable. Use filePath values as requestPath in run_collection.',
        inputSchema: {
          collectionPath: z.string().min(1, 'Collection path is required').describe('Absolute path to collection directory. Use the path returned by list_collections.')
        }
      },
      async (args) => {
        try {
          // Validate collectionPath
          const pathCheck = this.validateToolPath(args.collectionPath);
          if (!pathCheck.valid) {
            return {
              content: [{ type: 'text', text: `Invalid collectionPath: ${pathCheck.reason}` }],
              isError: true,
            };
          }

          const stats = await getCollectionStats(args.collectionPath);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(stats, null, 2),
              }
            ]
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Error getting collection stats: ${error instanceof Error ? error.message : 'Unknown error'}`
              }
            ],
            isError: true
          };
        }
      }
    );
  }

  /**
   * Tool: run_collection
   */
  private setupRunCollectionTool(): void {
    this.server.registerTool(
      'run_collection',
      {
        title: 'Run Collection',
        description: 'Execute requests in a Bruno collection and run test scripts. Omit requestPath to run ALL requests. Provide requestPath as a .yml/.bru file to run one request, or as a subdirectory to run all requests in that folder. Each result includes the response body (response_body, response_content_type, response_body_truncated) by default — disable with includeResponseBody=false or cap the size with maxResponseBodyBytes. Outbound requests are SSRF-filtered: targets resolving to private, loopback, link-local or otherwise reserved addresses are refused unless the server operator has allowlisted them, and a refusal is reported per-request as an "SSRF blocked" error with status 0.',
        inputSchema: {
          collectionPath: z.string().min(1, 'Collection path is required').describe('Absolute path to collection root directory. Use the path returned by list_collections.'),
          environment: z.string().optional().describe('Environment name to use (e.g. "dev", "staging"). Get available names from get_collection_stats.'),
          collectionRoot: z.string().optional().describe('Path to collection root for environment resolution (if different from collectionPath)'),
          requestPath: z.string().optional().describe('Path to a specific .yml or .bru request file, or a subdirectory within the collection. Get file paths from list_requests or get_collection_stats. Omit to run all requests in the collection.'),
          parallel: z.boolean().optional().default(false).describe('Run folders in parallel. Requests within each folder still run sequentially by seq order. Default: false.'),
          includeResponseBody: z.boolean().optional().default(true).describe('Include the response body of each request in the results. Default: true.'),
          maxResponseBodyBytes: z.number().optional().default(10240).describe('Maximum response body size (bytes) to return per request; longer bodies are truncated and response_body_truncated is set. Default: 10240.')
        }
      },
      async (args) => {
        try {
          // Validate collectionPath (no traversal, no null bytes)
          const collectionCheck = this.validateToolPath(args.collectionPath);
          if (!collectionCheck.valid) {
            return {
              content: [{ type: 'text', text: `Invalid collectionPath: ${collectionCheck.reason}` }],
              isError: true,
            };
          }

          // Validate requestPath is within collectionPath if provided
          if (args.requestPath) {
            const requestCheck = this.validateToolPath(args.requestPath, args.collectionPath);
            if (!requestCheck.valid) {
              return {
                content: [{ type: 'text', text: `Invalid requestPath: ${requestCheck.reason}` }],
                isError: true,
              };
            }
          }

          // Validate collectionRoot if provided (no traversal, no null bytes)
          if (args.collectionRoot) {
            const rootCheck = this.validateToolPath(args.collectionRoot);
            if (!rootCheck.valid) {
              return {
                content: [{ type: 'text', text: `Invalid collectionRoot: ${rootCheck.reason}` }],
                isError: true,
              };
            }
          }

          const result = await RequestExecutor.executeCollection(
            args.collectionPath,
            {
              environment: args.environment,
              collectionRoot: args.collectionRoot,
              requestPath: args.requestPath,
              parallel: args.parallel,
              includeResponseBody: args.includeResponseBody,
              maxResponseBodyBytes: args.maxResponseBodyBytes,
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

  /**
   * Start the MCP server
   */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    
    console.error('Bruno MCP Server started successfully! 🚀');
    console.error('Ready to generate Bruno API testing files.');
  }
}

/**
 * Create and export server instance
 */
export function createBrunoMcpServer(): BrunoMcpServer {
  return new BrunoMcpServer();
}