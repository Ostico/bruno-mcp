/**
 * Format Factory — routes read/write operations to the correct
 * format-specific implementation (.bru or .yml).
 *
 * Pure routing logic: no file I/O, no caching.
 */

import { parse as parseYaml } from 'yaml';
import type { CollectionFormat } from './format-detector.js';
import {
  parseBruRequest,
  generateBruRequest,
  parseBruEnvironment,
  generateBruEnvironment,
  injectBruScript,
} from './bru-parser.js';
import { parseYamlRequest } from './yaml-parser.js';
import {
  generateYamlRequest,
  generateYamlEnvironment,
  injectYamlScript,
} from './yaml-generator.js';
import {
  BrunoError,
  type BruFile,
  type YamlRequest,
  type BrunoEnvironment,
  type EnvFile,
} from './types.js';

// Re-export the CollectionFormat type for convenience
export type { CollectionFormat } from './format-detector.js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface FormatReader {
  parseRequest(content: string): BruFile | YamlRequest;
  parseEnvironment(content: string, name: string): BrunoEnvironment | EnvFile;
  getRequestExtension(): '.bru' | '.yml';
  getEnvironmentExtension(): '.bru' | '.yml';
}

export interface FormatWriter {
  generateRequest(data: BruFile | YamlRequest): string;
  generateEnvironment(data: BrunoEnvironment | EnvFile): string;
  injectScript(
    content: string,
    scriptType: string,
    code: string,
    mode: 'append' | 'replace',
  ): string;
  getRequestExtension(): '.bru' | '.yml';
}

// ---------------------------------------------------------------------------
// Script type mapping
// ---------------------------------------------------------------------------

type GenericScriptType = 'pre-request' | 'post-response' | 'tests';

// Canonical MCP-surface script types plus accepted aliases. The executor/YAML
// vocabulary ('before-request'/'after-response') is accepted at the MCP surface
// and normalized to the canonical types here.
const SCRIPT_TYPE_ALIASES: Record<string, GenericScriptType> = {
  'pre-request': 'pre-request',
  'post-response': 'post-response',
  tests: 'tests',
  'before-request': 'pre-request',
  'after-response': 'post-response',
};

/**
 * Normalize a caller-supplied script type to the canonical generic type.
 * Accepts the aliases 'before-request' (→ pre-request) and
 * 'after-response' (→ post-response).
 *
 * @throws {BrunoError} If the value is not a recognized script type or alias.
 */
export function normalizeScriptType(inputType: string): GenericScriptType {
  const normalized = SCRIPT_TYPE_ALIASES[inputType];
  if (!normalized) {
    throw new BrunoError(
      `Unknown script type "${inputType}": expected one of pre-request, post-response, tests, before-request, after-response`,
      'VALIDATION_ERROR',
    );
  }
  return normalized;
}

// In opencollection YAML format, both post-response and tests map to 'after-response'
// runtime.scripts entries. This is per-spec but means replace mode cannot distinguish them.
const YAML_SCRIPT_MAP: Record<GenericScriptType, string> = {
  'pre-request': 'before-request',
  'post-response': 'after-response',
  tests: 'after-response',
};

const BRU_SCRIPT_MAP: Record<GenericScriptType, string> = {
  'pre-request': 'pre-request',
  'post-response': 'post-response',
  tests: 'tests',
};

/**
 * Map a generic script type to the format-specific type string.
 *
 * @param inputType  One of 'pre-request', 'post-response', 'tests'
 * @param format     The collection format ('yaml' | 'bru')
 * @returns          The format-specific script type string
 * @throws {BrunoError} If the format is not supported
 */
export function mapScriptType(
  inputType: GenericScriptType,
  format: CollectionFormat,
): string {
  if (format === 'yaml') {
    return YAML_SCRIPT_MAP[inputType];
  }
  if (format === 'bru') {
    return BRU_SCRIPT_MAP[inputType];
  }
  throw new BrunoError(
    `Unsupported format "${String(format)}" for script type mapping`,
    'INVALID_FORMAT',
  );
}

// ---------------------------------------------------------------------------
// YAML environment content parser (inline — no file I/O)
// ---------------------------------------------------------------------------

function parseYamlEnvironmentContent(
  content: string,
  _name: string,
): EnvFile {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BrunoError(
      `Failed to parse YAML environment: ${message}`,
      'PARSE_ERROR',
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    return { variables: [] };
  }

  const doc = parsed as Record<string, unknown>;
  const variables = Array.isArray(doc.variables) ? doc.variables : [];

  return {
    name: typeof doc.name === 'string' ? doc.name : undefined,
    variables: variables.map((v: Record<string, unknown>) => ({
      name: String(v.name ?? ''),
      value: v.value !== undefined ? v.value as string | number | boolean : undefined,
      disabled: typeof v.disabled === 'boolean' ? v.disabled : undefined,
    })),
  };
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * Create a format-specific reader.
 *
 * @param format  The collection format ('yaml' | 'bru')
 * @returns       A FormatReader that delegates to the correct parser
 * @throws {BrunoError} If the format is not supported
 */
export function createReader(format: CollectionFormat): FormatReader {
  if (format === 'yaml') {
    return {
      parseRequest: (content: string) => parseYamlRequest(content),
      parseEnvironment: (content: string, name: string) =>
        parseYamlEnvironmentContent(content, name),
      getRequestExtension: () => '.yml',
      getEnvironmentExtension: () => '.yml',
    };
  }

  if (format === 'bru') {
    return {
      parseRequest: (content: string) => parseBruRequest(content),
      parseEnvironment: (content: string, name: string) =>
        parseBruEnvironment(content, name),
      getRequestExtension: () => '.bru',
      getEnvironmentExtension: () => '.bru',
    };
  }

  throw new BrunoError(
    `Unsupported format "${String(format)}": expected "yaml" or "bru"`,
    'INVALID_FORMAT',
  );
}

/**
 * Create a format-specific writer.
 *
 * @param format  The collection format ('yaml' | 'bru')
 * @returns       A FormatWriter that delegates to the correct generator
 * @throws {BrunoError} If the format is not supported
 */
export function createWriter(format: CollectionFormat): FormatWriter {
  if (format === 'yaml') {
    return {
      generateRequest: (data: BruFile | YamlRequest) =>
        generateYamlRequest(data as YamlRequest),
      generateEnvironment: (data: BrunoEnvironment | EnvFile) =>
        generateYamlEnvironment(data as EnvFile),
      injectScript: (
        content: string,
        scriptType: string,
        code: string,
        mode: 'append' | 'replace',
      ) => {
        const mapped = mapScriptType(
          scriptType as GenericScriptType,
          'yaml',
        );
        // Guard: 'tests' and 'post-response' both map to 'after-response' in YAML.
        // Replace mode would wipe both — force append to prevent data loss.
        const safeMode = (scriptType === 'tests' && mode === 'replace') ? 'append' : mode;
        return injectYamlScript(
          content,
          mapped as 'before-request' | 'after-response',
          code,
          safeMode,
        );
      },
      getRequestExtension: () => '.yml',
    };
  }

  if (format === 'bru') {
    return {
      generateRequest: (data: BruFile | YamlRequest) =>
        generateBruRequest(data as BruFile),
      generateEnvironment: (data: BrunoEnvironment | EnvFile) =>
        generateBruEnvironment(data as BrunoEnvironment),
      injectScript: (
        content: string,
        scriptType: string,
        code: string,
        mode: 'append' | 'replace',
      ) => {
        const mapped = mapScriptType(
          scriptType as GenericScriptType,
          'bru',
        );
        return injectBruScript(
          content,
          mapped as 'pre-request' | 'post-response' | 'tests',
          code,
          mode,
        );
      },
      getRequestExtension: () => '.bru',
    };
  }

  throw new BrunoError(
    `Unsupported format "${String(format)}": expected "yaml" or "bru"`,
    'INVALID_FORMAT',
  );
}
