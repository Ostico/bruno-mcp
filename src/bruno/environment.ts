/**
 * Bruno environment management
 * Handles creation and management of Bruno environment files
 */

import { promises as fs } from 'fs';
import { writeFileAtomic } from './atomic-write.js';
import { withPathLock } from './path-mutex.js';
import { join } from 'path';
import {
  BrunoEnvironment,
  CreateEnvironmentInput,
  FileOperationResult,
  BrunoError,
  BruFileError,
  EnvFile,
  EnvVariable,
} from './types.js';
import { parse as parseYaml } from 'yaml';
import { detectFormat } from './format-detector.js';
import { generateYamlEnvironment } from './yaml-generator.js';
import { parseBruEnvironment, parseBruEnvironmentRaw, generateBruEnvironmentFull } from './bru-parser.js';

/**
 * Lock key identifying one environment.
 *
 * Deliberately extension-free: an environment is a single exclusion domain
 * whether it is stored as .yml or .bru, and this is computable without touching
 * the filesystem, so a caller can take the lock before any format detection.
 */
function environmentLockKey(collectionPath: string, environmentName: string): string {
  return join(collectionPath, 'environments', environmentName);
}

export class EnvironmentManager {

  /**
   * Create a new environment file
   */
  async createEnvironment(input: CreateEnvironmentInput): Promise<FileOperationResult> {
    try {
      // Validate input
      this.validateEnvironmentInput(input);

      // Detect collection format
      const detection = await detectFormat(input.collectionPath);

      // Ensure environments directory exists
      const envDir = join(input.collectionPath, 'environments');
      await this.ensureDirectory(envDir);

      if (detection.format === 'yaml') {
        // Build EnvFile and write .yml
        const envFile: EnvFile = {
          name: input.name,
          variables: Object.entries(input.variables).map(
            ([name, value]): EnvVariable => ({ name, value }),
          ),
        };
        const yamlContent = generateYamlEnvironment(envFile);
        const envFilePath = join(envDir, `${input.name}.yml`);
        await writeFileAtomic(envFilePath, yamlContent);
        return { success: true, path: envFilePath };
      } else {
        // Existing BRU behavior
        const envFilePath = join(envDir, `${input.name}.bru`);
        const envContent = this.generateEnvironmentFile(input.name, input.variables);
        await writeFileAtomic(envFilePath, envContent);
        return { success: true, path: envFilePath };
      }

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Load an existing environment
   */
  async loadEnvironment(collectionPath: string, environmentName: string): Promise<BrunoEnvironment> {
    try {
      const detection = await detectFormat(collectionPath);
      const ext = detection.format === 'yaml' ? '.yml' : '.bru';
      const envFilePath = join(collectionPath, 'environments', `${environmentName}${ext}`);
      const envContent = await fs.readFile(envFilePath, 'utf-8');

      if (detection.format === 'yaml') {
        const parsed = parseYaml(envContent) as Record<string, unknown>;
        const variables: Record<string, string | number | boolean> = {};
        if (Array.isArray(parsed?.variables)) {
          for (const v of parsed.variables as Array<Record<string, unknown>>) {
            if (v.name != null && String(v.name) !== '' && !v.disabled) {
              variables[String(v.name)] = (v.value as string | number | boolean) ?? '';
            }
          }
        }
        return { name: environmentName, variables };
      }

      return this.parseEnvironmentFile(envContent, environmentName);

    } catch (error) {
      throw new BruFileError(
        `Failed to load environment ${environmentName}`,
        { originalError: error }
      );
    }
  }

  /**
   * Load an environment preserving ALL variables including DISABLED ones and
   * their enabled/disabled flag. Unlike loadEnvironment (which returns only the
   * enabled variables as a flat map for the executor), this is the full-fidelity
   * read used by the merge/write path so disabled variables are never dropped.
   */
  async loadEnvironmentRaw(collectionPath: string, environmentName: string): Promise<EnvVariable[]> {
    try {
      const detection = await detectFormat(collectionPath);
      const ext = detection.format === 'yaml' ? '.yml' : '.bru';
      const envFilePath = join(collectionPath, 'environments', `${environmentName}${ext}`);
      const envContent = await fs.readFile(envFilePath, 'utf-8');

      if (detection.format === 'yaml') {
        const parsed = parseYaml(envContent) as Record<string, unknown>;
        const variables: EnvVariable[] = [];
        if (Array.isArray(parsed?.variables)) {
          for (const v of parsed.variables as Array<Record<string, unknown>>) {
            if (v.name == null || String(v.name) === '') continue;
            const item: EnvVariable = {
              name: String(v.name),
              value: (v.value as string | number | boolean) ?? '',
            };
            if (v.disabled === true) item.disabled = true;
            variables.push(item);
          }
        }
        return variables;
      }

      return parseBruEnvironmentRaw(envContent);

    } catch (error) {
      throw new BruFileError(
        `Failed to load environment ${environmentName}`,
        { originalError: error }
      );
    }
  }

  /**
   * Write the FULL variable list (including disabled entries and their flags)
   * to an existing environment file. This is the full-fidelity counterpart to
   * updateEnvironment (which takes a flat enabled-only map).
   */
  async updateEnvironmentVariables(
    collectionPath: string,
    environmentName: string,
    variables: EnvVariable[]
  ): Promise<FileOperationResult> {
    return withPathLock(environmentLockKey(collectionPath, environmentName), () =>
      this.writeEnvironmentVariables(collectionPath, environmentName, variables),
    );
  }

  /**
   * Write the variables without taking the per-environment lock.
   *
   * The read-modify-write helpers below already hold that lock across their own
   * read, so they must not re-enter it — the lock is not re-entrant and would
   * deadlock. Every other caller goes through updateEnvironmentVariables.
   */
  private async writeEnvironmentVariables(
    collectionPath: string,
    environmentName: string,
    variables: EnvVariable[]
  ): Promise<FileOperationResult> {
    try {
      const detection = await detectFormat(collectionPath);
      const envDir = join(collectionPath, 'environments');
      const ext = detection.format === 'yaml' ? '.yml' : '.bru';
      const envFilePath = join(envDir, `${environmentName}${ext}`);

      const exists = await this.fileExists(envFilePath);
      if (!exists) {
        throw new BrunoError(
          `Environment ${environmentName} does not exist`,
          'NOT_FOUND'
        );
      }

      if (detection.format === 'yaml') {
        const envFile: EnvFile = { name: environmentName, variables };
        await writeFileAtomic(envFilePath, generateYamlEnvironment(envFile));
      } else {
        await writeFileAtomic(envFilePath, generateBruEnvironmentFull(variables));
      }

      return { success: true, path: envFilePath };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Partially merge the given variables into an existing environment WITHOUT
   * clobbering the others. Pre-existing variables not listed are preserved,
   * INCLUDING disabled ones and their enabled/disabled flag.
   */
  async mergeEnvironment(
    collectionPath: string,
    environmentName: string,
    overrides: Record<string, string | number | boolean>
  ): Promise<FileOperationResult> {
    try {
      const existing = await this.loadEnvironmentRaw(collectionPath, environmentName);
      const byName = new Map<string, EnvVariable>();
      for (const v of existing) byName.set(v.name, v);

      for (const [key, value] of Object.entries(overrides)) {
        const prev = byName.get(key);
        const entry: EnvVariable = { name: key, value };
        // Preserve the disabled flag of an existing variable being overridden.
        if (prev?.disabled === true) entry.disabled = true;
        byName.set(key, entry);
      }

      return await this.writeEnvironmentVariables(
        collectionPath,
        environmentName,
        [...byName.values()],
      );

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Update an existing environment
   */
  async updateEnvironment(
    collectionPath: string,
    environmentName: string,
    variables: Record<string, string | number | boolean>
  ): Promise<FileOperationResult> {
    // Hold the lock across the read and the write so a concurrent edit is not lost (D8).
    return withPathLock(environmentLockKey(collectionPath, environmentName), () =>
      this.updateEnvironmentLocked(collectionPath, environmentName, variables),
    );
  }

  private async updateEnvironmentLocked(
    collectionPath: string,
    environmentName: string,
    variables: Record<string, string | number | boolean>
  ): Promise<FileOperationResult> {
    try {
      const detection = await detectFormat(collectionPath);
      const envDir = join(collectionPath, 'environments');
      const ext = detection.format === 'yaml' ? '.yml' : '.bru';
      const envFilePath = join(envDir, `${environmentName}${ext}`);

      // Check if environment exists
      const exists = await this.fileExists(envFilePath);
      if (!exists) {
        throw new BrunoError(
          `Environment ${environmentName} does not exist`,
          'NOT_FOUND'
        );
      }

      if (detection.format === 'yaml') {
        const envFile: EnvFile = {
          name: environmentName,
          variables: Object.entries(variables).map(([name, value]): EnvVariable => ({ name, value })),
        };
        await writeFileAtomic(envFilePath, generateYamlEnvironment(envFile));
      } else {
        const envContent = this.generateEnvironmentFile(environmentName, variables);
        await writeFileAtomic(envFilePath, envContent);
      }

      return {
        success: true,
        path: envFilePath
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Delete an environment
   */
  async deleteEnvironment(collectionPath: string, environmentName: string): Promise<FileOperationResult> {
    try {
      const detection = await detectFormat(collectionPath);
      const ext = detection.format === 'yaml' ? '.yml' : '.bru';
      const envFilePath = join(collectionPath, 'environments', `${environmentName}${ext}`);

      const exists = await this.fileExists(envFilePath);
      if (!exists) {
        return {
          success: false,
          error: `Environment ${environmentName} does not exist`
        };
      }

      await fs.unlink(envFilePath);

      return {
        success: true,
        path: envFilePath
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * List all environments in a collection
   */
  async listEnvironments(collectionPath: string): Promise<string[]> {
    try {
      const envDir = join(collectionPath, 'environments');
      
      const exists = await this.directoryExists(envDir);
      if (!exists) {
        return [];
      }

      const entries = await fs.readdir(envDir, { withFileTypes: true });

      return entries
        .filter(entry => entry.isFile() && (entry.name.endsWith('.bru') || entry.name.endsWith('.yml')))
        .map(entry => entry.name.replace(/\.(bru|yml)$/, ''))
        .sort();

    } catch (error) {
      throw new BruFileError(
        `Failed to list environments in ${collectionPath}`,
        { originalError: error }
      );
    }
  }

  /**
   * Copy environment with new name
   */
  async copyEnvironment(
    collectionPath: string,
    sourceEnv: string,
    targetEnv: string,
    variableOverrides?: Record<string, string | number | boolean>
  ): Promise<FileOperationResult> {
    try {
      // Load source environment
      const sourceEnvironment = await this.loadEnvironment(collectionPath, sourceEnv);
      
      // Merge variables with overrides
      const variables = variableOverrides 
        ? { ...sourceEnvironment.variables, ...variableOverrides }
        : sourceEnvironment.variables;

      // Create new environment
      return await this.createEnvironment({
        collectionPath,
        name: targetEnv,
        variables
      });

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Get environment variables as key-value pairs
   */
  async getEnvironmentVariables(
    collectionPath: string, 
    environmentName: string
  ): Promise<Record<string, string | number | boolean>> {
    const environment = await this.loadEnvironment(collectionPath, environmentName);
    return environment.variables;
  }

  /**
   * Set (add or update) a specific variable in an environment. Reads the FULL
   * variable set so pre-existing variables — including disabled ones and their
   * enabled/disabled flag — are preserved on write.
   *
   * @param enabled  Optional. When provided, persists the variable's
   *   enabled/disabled state (enabled === false → written as disabled).
   *   When omitted, an existing variable keeps its current state and a new
   *   variable defaults to enabled.
   */
  async setEnvironmentVariable(
    collectionPath: string,
    environmentName: string,
    key: string,
    value: string | number | boolean,
    enabled?: boolean
  ): Promise<FileOperationResult> {
    // Hold the lock across the read and the write so a concurrent edit is not lost (D8).
    return withPathLock(environmentLockKey(collectionPath, environmentName), () =>
      this.setEnvironmentVariableLocked(collectionPath, environmentName, key, value, enabled),
    );
  }

  private async setEnvironmentVariableLocked(
    collectionPath: string,
    environmentName: string,
    key: string,
    value: string | number | boolean,
    enabled?: boolean
  ): Promise<FileOperationResult> {
    try {
      const variables = await this.loadEnvironmentRaw(collectionPath, environmentName);
      const idx = variables.findIndex(v => v.name === key);

      // Resolve the disabled flag: explicit `enabled` wins; otherwise preserve
      // the existing variable's flag (undefined → enabled for a new variable).
      const disabled = enabled === undefined
        ? (idx >= 0 ? variables[idx].disabled : undefined)
        : !enabled;

      const entry: EnvVariable = { name: key, value };
      if (disabled === true) entry.disabled = true;

      if (idx >= 0) {
        variables[idx] = entry;
      } else {
        variables.push(entry);
      }

      return await this.writeEnvironmentVariables(collectionPath, environmentName, variables);

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Remove a variable from an environment. Reads the FULL variable set so all
   * other variables — including disabled ones and their flags — are preserved.
   */
  async removeEnvironmentVariable(
    collectionPath: string,
    environmentName: string,
    key: string
  ): Promise<FileOperationResult> {
    // Hold the lock across the read and the write so a concurrent edit is not lost (D8).
    return withPathLock(environmentLockKey(collectionPath, environmentName), () =>
      this.removeEnvironmentVariableLocked(collectionPath, environmentName, key),
    );
  }

  private async removeEnvironmentVariableLocked(
    collectionPath: string,
    environmentName: string,
    key: string
  ): Promise<FileOperationResult> {
    try {
      const variables = await this.loadEnvironmentRaw(collectionPath, environmentName);
      const filtered = variables.filter(v => v.name !== key);

      return await this.writeEnvironmentVariables(collectionPath, environmentName, filtered);

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Generate environment file content in BRU format
   */
  private generateEnvironmentFile(
    name: string,
    variables: Record<string, string | number | boolean>
  ): string {
    const lines: string[] = [];

    // Add header comment
    lines.push(`# ${name} Environment`);
    lines.push(`# Generated on ${new Date().toISOString()}`);
    lines.push('');

    // Add variables block
    if (Object.keys(variables).length > 0) {
      lines.push('vars {');
      
      Object.entries(variables).forEach(([key, value]) => {
        const formattedValue = this.formatVariableValue(value);
        lines.push(`  ${key}: ${formattedValue}`);
      });
      
      lines.push('}');
    } else {
      lines.push('vars {');
      lines.push('  # Add your environment variables here');
      lines.push('  # baseUrl: \'https://api.example.com\'');
      lines.push('  # apiKey: \'your-api-key\'');
      lines.push('}');
    }

    return lines.join('\n') + '\n';
  }

  private parseEnvironmentFile(content: string, name: string): BrunoEnvironment {
    return parseBruEnvironment(content, name);
  }

  /**
   * Format variable value for BRU file
   */
  private formatVariableValue(value: string | number | boolean): string {
    if (typeof value === 'string') {
      // Use single quotes for strings in BRU format
      return `'${value.replace(/'/g, "\\'")}'`;
    }
    return String(value);
  }

  /**
   * Validate environment input
   */
  private validateEnvironmentInput(input: CreateEnvironmentInput): void {
    if (!input.name || input.name.trim().length === 0) {
      throw new BrunoError('Environment name is required', 'VALIDATION_ERROR');
    }

    if (!input.collectionPath || input.collectionPath.trim().length === 0) {
      throw new BrunoError('Collection path is required', 'VALIDATION_ERROR');
    }

    // Check for invalid characters in environment name
    const invalidChars = /[<>:"/\\|?*\s]/;
    if (invalidChars.test(input.name)) {
      throw new BrunoError(
        'Environment name contains invalid characters or spaces',
        'VALIDATION_ERROR'
      );
    }

    if (!input.variables || typeof input.variables !== 'object') {
      throw new BrunoError('Variables must be an object', 'VALIDATION_ERROR');
    }
  }

  /**
   * Ensure directory exists
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
   * Check if directory exists
   */
  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      const stats = await fs.stat(dirPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }
}

/**
 * Create a new environment manager instance
 */
export function createEnvironmentManager(): EnvironmentManager {
  return new EnvironmentManager();
}

/**
 * Create common environment configurations
 */
export const commonEnvironments = {
  development: {
    baseUrl: 'http://localhost:3000',
    apiKey: '{{API_KEY}}',
    timeout: 5000,
    debug: true
  },
  staging: {
    baseUrl: 'https://staging-api.example.com',
    apiKey: '{{API_KEY}}',
    timeout: 10000,
    debug: false
  },
  production: {
    baseUrl: 'https://api.example.com',
    apiKey: '{{API_KEY}}',
    timeout: 30000,
    debug: false
  }
};