/**
 * Bruno collection management
 * Handles creation and management of Bruno collections
 */

import { promises as fs } from 'fs';
import { writeFileAtomic } from './atomic-write.js';
import { withPathLock } from './path-mutex.js';
import { join } from 'path';
import {
  BrunoCollection,
  CreateCollectionInput,
  FileOperationResult,
  BrunoError,
  BruFileError,
  YamlCollection,
} from './types.js';
import { generateYamlCollection } from './yaml-generator.js';
import { detectFormat } from './format-detector.js';
import { parseYamlCollection } from './yaml-parser.js';

export class CollectionManager {
  
  /**
   * Create a new Bruno collection
   */
  async createCollection(input: CreateCollectionInput): Promise<FileOperationResult> {
    try {
      // Validate input
      this.validateCollectionInput(input);

      // Determine format — default to 'yaml'
      const format = input.format || 'yaml';

      // Create collection directory
      const collectionPath = join(input.outputPath, input.name);
      await this.ensureDirectory(collectionPath);

      if (format === 'bru') {
        // Create bruno.json configuration (legacy BRU format)
        const brunoConfig: BrunoCollection = {
          version: '1',
          name: input.name,
          type: 'collection',
          ignore: input.ignore || ['node_modules', '.git', '.env']
        };

        const configPath = join(collectionPath, 'bruno.json');
        await writeFileAtomic(configPath, JSON.stringify(brunoConfig, null, 2));
      } else {
        // Create opencollection.yml (YAML format — default)
        const yamlCollection: YamlCollection = {
          opencollection: '1',
          info: {
            name: input.name,
          },
        };

        const yamlContent = generateYamlCollection(yamlCollection);
        const configPath = join(collectionPath, 'opencollection.yml');
        await writeFileAtomic(configPath, yamlContent);
      }

      // Create environments directory
      const envPath = join(collectionPath, 'environments');
      await this.ensureDirectory(envPath);

      // Create .gitignore if it doesn't exist
      const gitignorePath = join(collectionPath, '.gitignore');
      const gitignoreExists = await this.fileExists(gitignorePath);
      if (!gitignoreExists) {
        await this.createGitignore(gitignorePath);
      }

      // Create README.md with basic collection info
      const readmePath = join(collectionPath, 'README.md');
      await this.createCollectionReadme(readmePath, input);

      return {
        success: true,
        path: collectionPath
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Load an existing Bruno collection
   */
  async loadCollection(collectionPath: string): Promise<BrunoCollection> {
    try {
      const detection = await detectFormat(collectionPath);

      if (detection.format === 'yaml') {
        const configPath = join(collectionPath, 'opencollection.yml');
        const configContent = await fs.readFile(configPath, 'utf-8');
        const yamlCol = parseYamlCollection(configContent);
        // Map YamlCollection fields to BrunoCollection shape
        const config: BrunoCollection = {
          version: yamlCol.opencollection,
          name: yamlCol.info.name,
          type: 'collection',
          ignore: yamlCol.extensions?.bruno?.ignore ?? [],
        };
        this.validateCollectionConfig(config);
        return config;
      }

      const configPath = join(collectionPath, 'bruno.json');
      const configContent = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(configContent) as BrunoCollection;

      this.validateCollectionConfig(config);
      return config;

    } catch (error) {
      throw new BruFileError(
        `Failed to load collection from ${collectionPath}`,
        { originalError: error }
      );
    }
  }

  /**
   * Update collection configuration
   */
  async updateCollection(
    collectionPath: string,
    updates: Partial<BrunoCollection>
  ): Promise<FileOperationResult> {
    // The config is loaded, merged with `updates`, and written back. Hold the
    // lock across the pair so a concurrent update is not silently discarded (D8).
    return withPathLock(collectionPath, () => this.updateCollectionLocked(collectionPath, updates));
  }

  private async updateCollectionLocked(
    collectionPath: string,
    updates: Partial<BrunoCollection>
  ): Promise<FileOperationResult> {
    try {
      const existingConfig = await this.loadCollection(collectionPath);
      const updatedConfig = { ...existingConfig, ...updates };

      this.validateCollectionConfig(updatedConfig);

      const detection = await detectFormat(collectionPath);
      if (detection.format === 'yaml') {
        const yamlCollection: YamlCollection = {
          opencollection: updatedConfig.version,
          info: { name: updatedConfig.name },
        };
        const yamlContent = generateYamlCollection(yamlCollection);
        const configPath = join(collectionPath, 'opencollection.yml');
        await writeFileAtomic(configPath, yamlContent);
        return { success: true, path: configPath };
      }

      const configPath = join(collectionPath, 'bruno.json');
      await writeFileAtomic(configPath, JSON.stringify(updatedConfig, null, 2));

      return {
        success: true,
        path: configPath
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * List all .bru files in a collection
   */
  async listRequests(collectionPath: string): Promise<string[]> {
    try {
      const bruFiles: string[] = [];
      await this.findBruFiles(collectionPath, bruFiles);
      return bruFiles.sort();

    } catch (error) {
      throw new BruFileError(
        `Failed to list requests in collection ${collectionPath}`,
        { originalError: error }
      );
    }
  }

  /**
   * Create a folder structure within the collection
   */
  async createFolder(collectionPath: string, folderPath: string): Promise<FileOperationResult> {
    try {
      const fullPath = join(collectionPath, folderPath);
      await this.ensureDirectory(fullPath);

      return {
        success: true,
        path: fullPath
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Get collection statistics
   */
  async getCollectionStats(collectionPath: string): Promise<{
    totalRequests: number;
    requestsByMethod: Record<string, number>;
    folders: string[];
    environments: string[];
  }> {
    try {
      const requests = await this.listRequests(collectionPath);
      const folders = await this.listFolders(collectionPath);
      const environments = await this.listEnvironments(collectionPath);

      // Count requests by method (would need to parse .bru files)
      const requestsByMethod: Record<string, number> = {};
      
      // For now, return basic stats
      return {
        totalRequests: requests.length,
        requestsByMethod,
        folders,
        environments
      };

    } catch (error) {
      throw new BruFileError(
        `Failed to get collection stats for ${collectionPath}`,
        { originalError: error }
      );
    }
  }

  /**
   * Validate collection input
   */
  private validateCollectionInput(input: CreateCollectionInput): void {
    if (!input.name || input.name.trim().length === 0) {
      throw new BrunoError('Collection name is required', 'VALIDATION_ERROR');
    }

    if (!input.outputPath || input.outputPath.trim().length === 0) {
      throw new BrunoError('Output path is required', 'VALIDATION_ERROR');
    }

    // Check for invalid characters in collection name
    const invalidChars = /[<>:"/\\|?*]/;
    if (invalidChars.test(input.name)) {
      throw new BrunoError(
        'Collection name contains invalid characters',
        'VALIDATION_ERROR'
      );
    }
  }

  /**
   * Validate collection configuration
   */
  private validateCollectionConfig(config: BrunoCollection): void {
    if (!config.name || config.name.trim().length === 0) {
      throw new BrunoError('Collection name is required', 'VALIDATION_ERROR');
    }

    if (!config.version) {
      throw new BrunoError('Collection version is required', 'VALIDATION_ERROR');
    }

    if (config.type !== 'collection') {
      throw new BrunoError('Collection type must be "collection"', 'VALIDATION_ERROR');
    }
  }

  /**
   * Ensure directory exists, create if it doesn't
   */
  private async ensureDirectory(dirPath: string): Promise<void> {
    try {
      await fs.access(dirPath);
    } catch {
      await fs.mkdir(dirPath, { recursive: true });
    }
  }

  /**
   * Check if file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create .gitignore file for Bruno collection
   */
  private async createGitignore(gitignorePath: string): Promise<void> {
    const gitignoreContent = `# Bruno collection files to ignore
*.tmp
*.temp
.env
.env.local
.env.*.local

# OS generated files
.DS_Store
Thumbs.db

# Editor files
.vscode/
.idea/
*.swp
*.swo
`;

    await writeFileAtomic(gitignorePath, gitignoreContent);
  }

  /**
   * Create README.md for collection
   */
  private async createCollectionReadme(
    readmePath: string, 
    input: CreateCollectionInput
  ): Promise<void> {
    const readmeContent = `# ${input.name}

${input.description || 'Bruno API testing collection'}

## Overview

This collection was generated using the Bruno MCP server.

${input.baseUrl ? `**Base URL:** \`${input.baseUrl}\`` : ''}

## Structure

- \`environments/\` - Environment configurations
- \`*.bru\` - API request files

## Usage

Run all tests:
\`\`\`bash
bruno-cli run
\`\`\`

Run specific environment:
\`\`\`bash
bruno-cli run --env production
\`\`\`

## Generated

Created on: ${new Date().toISOString()}
`;

    await writeFileAtomic(readmePath, readmeContent);
  }

  private static readonly EXCLUDED_YML = new Set(['opencollection.yml', 'folder.yml']);

  /**
   * Recursively find all .bru and .yml request files
   */
  private async findBruFiles(dirPath: string, bruFiles: string[]): Promise<void> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'environments') {
        await this.findBruFiles(fullPath, bruFiles);
      } else if (entry.isFile() && (entry.name.endsWith('.bru') || (entry.name.endsWith('.yml') && !CollectionManager.EXCLUDED_YML.has(entry.name)))) {
        bruFiles.push(fullPath);
      }
    }
  }

  /**
   * List all folders in collection
   */
  private async listFolders(collectionPath: string): Promise<string[]> {
    const folders: string[] = [];
    const entries = await fs.readdir(collectionPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory() && 
          entry.name !== 'environments' && 
          entry.name !== 'node_modules' && 
          entry.name !== '.git') {
        folders.push(entry.name);
      }
    }

    return folders.sort();
  }

  /**
   * List all environment files
   */
  private async listEnvironments(collectionPath: string): Promise<string[]> {
    try {
      const envPath = join(collectionPath, 'environments');
      const entries = await fs.readdir(envPath, { withFileTypes: true });
      
      return entries
        .filter(entry => entry.isFile() && (entry.name.endsWith('.bru') || entry.name.endsWith('.yml')))
        .map(entry => entry.name.replace(/\.(bru|yml)$/, ''))
        .sort();

    } catch {
      return [];
    }
  }
}

/**
 * Create a new collection manager instance
 */
export function createCollectionManager(): CollectionManager {
  return new CollectionManager();
}