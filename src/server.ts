/**
 * Bruno MCP Server
 * Main MCP server implementation for Bruno API testing file generation
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import path from 'path';
import { readFile, writeFile } from 'node:fs/promises';

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
import { createWriter } from './bruno/format-factory.js';

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
    this.setupCreateRequestTool();
    this.setupModifyRequestTool();
    this.setupAddTestScriptTool();
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
   * Tool: create_request
   */
  private setupCreateRequestTool(): void {
    this.server.registerTool(
      'create_request',
      {
        title: 'Create Bruno Request',
        description: 'Generate request files for API testing (supports .bru and .yml formats)',
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
              value: z.string(),
              type: z.enum(['text', 'file']).optional()
            })).optional()
          }).optional(),
          auth: z.object({
            type: z.enum(['none', 'bearer', 'basic', 'oauth2', 'api-key', 'digest']),
            config: z.record(z.string())
          }).optional(),
          query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
          folder: z.string().optional(),
          sequence: z.number().optional()
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
            sequence: args.sequence
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
        description: 'Update an existing Bruno request file with partial-merge semantics. Only provided fields are updated; all other fields are preserved.',
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
              value: z.string(),
              type: z.enum(['text', 'file']).optional()
            })).optional()
          }).optional(),
          auth: z.object({
            type: z.enum(['none', 'bearer', 'basic', 'oauth2', 'api-key', 'digest']),
            config: z.record(z.string())
          }).optional(),
          query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional()
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
        description: 'Add pre-request or post-response scripts to Bruno requests',
        inputSchema: {
          bruFilePath: z.string().min(1, 'BRU file path is required').describe('Absolute path to the .yml or .bru request file. Get from list_requests or get_collection_stats.'),
          scriptType: z.enum(['pre-request', 'post-response', 'tests']),
          script: z.string().min(1, 'Script content is required')
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

          // 8. Get format writer and inject script
          const writer = createWriter(detection.format);
          const updated = writer.injectScript(content, args.scriptType, args.script, 'append');

          // 9. Write back
          await writeFile(args.bruFilePath, updated);

          // 10. Return success
          return {
            content: [
              {
                type: 'text',
                text: `Successfully added ${args.scriptType} script to ${path.basename(args.bruFilePath)} (${detection.format} format)`
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
        description: 'List all Bruno collections from workspace.yml. Returns collection names and paths. Use the returned path as collectionPath in other tools (get_collection_stats, list_requests, run_collection).',
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
        description: 'Get statistics about a Bruno collection — request counts by method, folders, environments, and per-request details including file paths. Use filePath values as requestPath in run_collection.',
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
        description: 'Execute requests in a Bruno collection and run test scripts. Omit requestPath to run ALL requests. Provide requestPath as a .yml/.bru file to run one request, or as a subdirectory to run all requests in that folder.',
        inputSchema: {
          collectionPath: z.string().min(1, 'Collection path is required').describe('Absolute path to collection root directory. Use the path returned by list_collections.'),
          environment: z.string().optional().describe('Environment name to use (e.g. "dev", "staging"). Get available names from get_collection_stats.'),
          collectionRoot: z.string().optional().describe('Path to collection root for environment resolution (if different from collectionPath)'),
          requestPath: z.string().optional().describe('Path to a specific .yml or .bru request file, or a subdirectory within the collection. Get file paths from list_requests or get_collection_stats. Omit to run all requests in the collection.'),
          parallel: z.boolean().optional().default(false).describe('Run folders in parallel. Requests within each folder still run sequentially by seq order. Default: false.')
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