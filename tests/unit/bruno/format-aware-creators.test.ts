/**
 * Tests for Task 6: Format-aware create_collection, create_request, create_environment.
 *
 * Covers:
 *  - create_collection with default (yaml) and explicit 'bru' format
 *  - create_request auto-detecting collection format (yaml vs bru)
 *  - create_environment auto-detecting collection format (yaml vs bru)
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CollectionManager, createCollectionManager } from '../../../src/bruno/collection.js';
import { RequestBuilder, createRequestBuilder } from '../../../src/bruno/request.js';
import { EnvironmentManager, createEnvironmentManager } from '../../../src/bruno/environment.js';

// Helper to create a unique temp directory per test
async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), `bruno-t6-${prefix}-`));
}

// Helper to check if a file exists
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// create_collection — format awareness
// ============================================================================
describe('CollectionManager.createCollection — format awareness', () => {
  let manager: CollectionManager;

  beforeEach(() => {
    manager = createCollectionManager();
  });

  // --------------------------------------------------------------------------
  // YAML format (default)
  // --------------------------------------------------------------------------
  describe('YAML format (default)', () => {
    it('creates opencollection.yml when no format specified', async () => {
      const tmpDir = await makeTempDir('yaml-default');
      const result = await manager.createCollection({
        name: 'TestAPI',
        outputPath: tmpDir,
      });

      expect(result.success).toBe(true);
      const collectionPath = join(tmpDir, 'TestAPI');
      expect(await fileExists(join(collectionPath, 'opencollection.yml'))).toBe(true);
      expect(await fileExists(join(collectionPath, 'bruno.json'))).toBe(false);
    });

    it('creates opencollection.yml when format is explicitly yaml', async () => {
      const tmpDir = await makeTempDir('yaml-explicit');
      const result = await manager.createCollection({
        name: 'ExplicitYAML',
        outputPath: tmpDir,
        format: 'yaml',
      });

      expect(result.success).toBe(true);
      const collectionPath = join(tmpDir, 'ExplicitYAML');
      expect(await fileExists(join(collectionPath, 'opencollection.yml'))).toBe(true);
    });

    it('opencollection.yml contains correct structure', async () => {
      const tmpDir = await makeTempDir('yaml-content');
      await manager.createCollection({
        name: 'ContentCheck',
        outputPath: tmpDir,
        format: 'yaml',
      });

      const collectionPath = join(tmpDir, 'ContentCheck');
      const content = await fs.readFile(join(collectionPath, 'opencollection.yml'), 'utf-8');
      expect(content).toContain('opencollection');
      expect(content).toContain('ContentCheck');
    });

    it('creates environments directory for YAML format', async () => {
      const tmpDir = await makeTempDir('yaml-envdir');
      await manager.createCollection({
        name: 'EnvTest',
        outputPath: tmpDir,
      });

      const collectionPath = join(tmpDir, 'EnvTest');
      const envDir = join(collectionPath, 'environments');
      const stat = await fs.stat(envDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // BRU format (explicit)
  // --------------------------------------------------------------------------
  describe('BRU format (explicit)', () => {
    it('creates bruno.json when format is bru', async () => {
      const tmpDir = await makeTempDir('bru-explicit');
      const result = await manager.createCollection({
        name: 'BruAPI',
        outputPath: tmpDir,
        format: 'bru',
      });

      expect(result.success).toBe(true);
      const collectionPath = join(tmpDir, 'BruAPI');
      expect(await fileExists(join(collectionPath, 'bruno.json'))).toBe(true);
      expect(await fileExists(join(collectionPath, 'opencollection.yml'))).toBe(false);
    });

    it('bruno.json contains correct structure', async () => {
      const tmpDir = await makeTempDir('bru-content');
      await manager.createCollection({
        name: 'BruContent',
        outputPath: tmpDir,
        format: 'bru',
      });

      const collectionPath = join(tmpDir, 'BruContent');
      const content = await fs.readFile(join(collectionPath, 'bruno.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.name).toBe('BruContent');
      expect(parsed.version).toBe('1');
      expect(parsed.type).toBe('collection');
    });

    it('creates environments directory for BRU format', async () => {
      const tmpDir = await makeTempDir('bru-envdir');
      await manager.createCollection({
        name: 'BruEnvTest',
        outputPath: tmpDir,
        format: 'bru',
      });

      const collectionPath = join(tmpDir, 'BruEnvTest');
      const envDir = join(collectionPath, 'environments');
      const stat = await fs.stat(envDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });
});

// ============================================================================
// create_request — format-aware
// ============================================================================
describe('RequestBuilder.createRequest — format awareness', () => {
  let builder: RequestBuilder;

  beforeEach(() => {
    builder = createRequestBuilder();
  });

  describe('in a YAML collection', () => {
    let collectionPath: string;

    beforeEach(async () => {
      const tmpDir = await makeTempDir('req-yaml');
      collectionPath = join(tmpDir, 'YamlCollection');
      await fs.mkdir(collectionPath, { recursive: true });
      // Create opencollection.yml marker
      await fs.writeFile(
        join(collectionPath, 'opencollection.yml'),
        'opencollection: "1"\ninfo:\n  name: YamlCollection\n',
      );
    });

    it('creates a .yml file (not .bru)', async () => {
      const result = await builder.createRequest({
        collectionPath,
        name: 'GetUsers',
        method: 'GET',
        url: 'https://api.example.com/users',
      });

      expect(result.success).toBe(true);
      expect(result.path).toMatch(/\.yml$/);
      expect(result.path).not.toMatch(/\.bru$/);
    });

    it('creates a valid YAML request file', async () => {
      const result = await builder.createRequest({
        collectionPath,
        name: 'GetPosts',
        method: 'GET',
        url: 'https://api.example.com/posts',
      });

      expect(result.success).toBe(true);
      const content = await fs.readFile(result.path!, 'utf-8');
      expect(content).toContain('GetPosts');
      expect(content).toContain('GET');
      expect(content).toContain('https://api.example.com/posts');
    });

    it('creates request with headers in YAML format', async () => {
      const result = await builder.createRequest({
        collectionPath,
        name: 'PostData',
        method: 'POST',
        url: 'https://api.example.com/data',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer token123' },
      });

      expect(result.success).toBe(true);
      const content = await fs.readFile(result.path!, 'utf-8');
      expect(content).toContain('Content-Type');
      expect(content).toContain('application/json');
    });

    it('creates request in folder within YAML collection', async () => {
      const result = await builder.createRequest({
        collectionPath,
        name: 'SubRequest',
        method: 'GET',
        url: 'https://api.example.com/sub',
        folder: 'SubFolder',
      });

      expect(result.success).toBe(true);
      expect(result.path).toContain('SubFolder');
      expect(result.path).toMatch(/\.yml$/);
    });
  });

  describe('in a BRU collection', () => {
    let collectionPath: string;

    beforeEach(async () => {
      const tmpDir = await makeTempDir('req-bru');
      collectionPath = join(tmpDir, 'BruCollection');
      await fs.mkdir(collectionPath, { recursive: true });
      // Create bruno.json marker
      await fs.writeFile(
        join(collectionPath, 'bruno.json'),
        JSON.stringify({ version: '1', name: 'BruCollection', type: 'collection' }),
      );
    });

    it('creates a .bru file (not .yml)', async () => {
      const result = await builder.createRequest({
        collectionPath,
        name: 'GetUsers',
        method: 'GET',
        url: 'https://api.example.com/users',
      });

      expect(result.success).toBe(true);
      expect(result.path).toMatch(/\.bru$/);
      expect(result.path).not.toMatch(/\.yml$/);
    });

    it('creates a valid BRU request file', async () => {
      const result = await builder.createRequest({
        collectionPath,
        name: 'GetItems',
        method: 'GET',
        url: 'https://api.example.com/items',
      });

      expect(result.success).toBe(true);
      const content = await fs.readFile(result.path!, 'utf-8');
      expect(content).toContain('GetItems');
      expect(content).toContain('get');
      expect(content).toContain('https://api.example.com/items');
    });
  });

  describe('with no marker file (defaults to yaml)', () => {
    let collectionPath: string;

    beforeEach(async () => {
      const tmpDir = await makeTempDir('req-nomarker');
      collectionPath = join(tmpDir, 'NoMarkerCollection');
      await fs.mkdir(collectionPath, { recursive: true });
    });

    it('defaults to .yml when no marker file present', async () => {
      const result = await builder.createRequest({
        collectionPath,
        name: 'DefaultReq',
        method: 'GET',
        url: 'https://api.example.com/default',
      });

      expect(result.success).toBe(true);
      expect(result.path).toMatch(/\.yml$/);
    });
  });
});

// ============================================================================
// create_environment — format-aware
// ============================================================================
describe('EnvironmentManager.createEnvironment — format awareness', () => {
  let manager: EnvironmentManager;

  beforeEach(() => {
    manager = createEnvironmentManager();
  });

  describe('in a YAML collection', () => {
    let collectionPath: string;

    beforeEach(async () => {
      const tmpDir = await makeTempDir('env-yaml');
      collectionPath = join(tmpDir, 'YamlCollection');
      await fs.mkdir(collectionPath, { recursive: true });
      // Create opencollection.yml marker
      await fs.writeFile(
        join(collectionPath, 'opencollection.yml'),
        'opencollection: "1"\ninfo:\n  name: YamlCollection\n',
      );
    });

    it('creates a .yml environment file (not .bru)', async () => {
      const result = await manager.createEnvironment({
        collectionPath,
        name: 'dev',
        variables: { base_url: 'http://localhost:3000' },
      });

      expect(result.success).toBe(true);
      expect(result.path).toMatch(/\.yml$/);
      expect(result.path).not.toMatch(/\.bru$/);
    });

    it('creates environment file in environments directory', async () => {
      const result = await manager.createEnvironment({
        collectionPath,
        name: 'staging',
        variables: { base_url: 'https://staging.example.com' },
      });

      expect(result.success).toBe(true);
      expect(result.path).toContain('environments');
      expect(result.path).toContain('staging.yml');
    });

    it('environment YAML file contains variables', async () => {
      const result = await manager.createEnvironment({
        collectionPath,
        name: 'production',
        variables: { base_url: 'https://api.example.com', api_key: 'secret123' },
      });

      expect(result.success).toBe(true);
      const content = await fs.readFile(result.path!, 'utf-8');
      expect(content).toContain('base_url');
      expect(content).toContain('https://api.example.com');
      expect(content).toContain('api_key');
    });
  });

  describe('in a BRU collection', () => {
    let collectionPath: string;

    beforeEach(async () => {
      const tmpDir = await makeTempDir('env-bru');
      collectionPath = join(tmpDir, 'BruCollection');
      await fs.mkdir(collectionPath, { recursive: true });
      // Create bruno.json marker
      await fs.writeFile(
        join(collectionPath, 'bruno.json'),
        JSON.stringify({ version: '1', name: 'BruCollection', type: 'collection' }),
      );
    });

    it('creates a .bru environment file (not .yml)', async () => {
      const result = await manager.createEnvironment({
        collectionPath,
        name: 'dev',
        variables: { base_url: 'http://localhost:3000' },
      });

      expect(result.success).toBe(true);
      expect(result.path).toMatch(/\.bru$/);
      expect(result.path).not.toMatch(/\.yml$/);
    });

    it('creates environment file in environments directory', async () => {
      const result = await manager.createEnvironment({
        collectionPath,
        name: 'staging',
        variables: { base_url: 'https://staging.example.com' },
      });

      expect(result.success).toBe(true);
      expect(result.path).toContain('environments');
      expect(result.path).toContain('staging.bru');
    });

    it('environment BRU file contains variables', async () => {
      const result = await manager.createEnvironment({
        collectionPath,
        name: 'test',
        variables: { base_url: 'http://localhost', debug: true },
      });

      expect(result.success).toBe(true);
      const content = await fs.readFile(result.path!, 'utf-8');
      expect(content).toContain('base_url');
      expect(content).toContain('http://localhost');
    });
  });

  describe('with no marker file (defaults to yaml)', () => {
    let collectionPath: string;

    beforeEach(async () => {
      const tmpDir = await makeTempDir('env-nomarker');
      collectionPath = join(tmpDir, 'NoMarkerCollection');
      await fs.mkdir(collectionPath, { recursive: true });
    });

    it('defaults to .yml when no marker file present', async () => {
      const result = await manager.createEnvironment({
        collectionPath,
        name: 'default-env',
        variables: { key: 'value' },
      });

      expect(result.success).toBe(true);
      expect(result.path).toMatch(/\.yml$/);
    });
  });
});
