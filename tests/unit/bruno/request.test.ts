import { RequestBuilder, createRequestBuilder } from '../../../src/bruno/request';
import { BrunoError, BruFileError } from '../../../src/bruno/types';

// Writers now go through writeFileAtomic instead of a plain fs write. Route it
// back to the same fs mock so these tests keep asserting on the content and path
// written; the write mechanism itself is covered by the atomic-write suites.
jest.mock('../../../src/bruno/atomic-write.js', () => ({
  writeFileAtomic: (...args: unknown[]) =>
    (jest.requireMock('fs') as { promises: { writeFile: (...a: unknown[]) => Promise<void> } })
      .promises.writeFile(...args),
}));

jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    access: jest.fn(),
    mkdir: jest.fn(),
  },
}));

jest.mock('../../../src/bruno/format-detector.js', () => ({
  detectFormat: jest.fn(),
}));

jest.mock('../../../src/bruno/yaml-generator.js', () => ({
  generateYamlRequest: jest.fn(() => 'info:\n  name: test\n'),
}));

jest.mock('../../../src/bruno/bru-parser.js', () => ({
  parseBruRequest: jest.fn((content: string) => ({
    meta: { name: 'parsed', type: 'http' },
    http: { method: 'GET', url: 'https://example.com', body: 'none', auth: 'none' },
  })),
  generateBruRequest: jest.fn(() => 'meta {\n  name: test\n}\n'),
}));

jest.mock('../../../src/bruno/yaml-parser.js', () => ({
  parseYamlRequest: jest.fn(),
}));

const fs = require('fs').promises;
const { detectFormat } = require('../../../src/bruno/format-detector.js');
const { parseYamlRequest } = require('../../../src/bruno/yaml-parser.js');
const { generateYamlRequest } = require('../../../src/bruno/yaml-generator.js');
const { generateBruRequest } = require('../../../src/bruno/bru-parser.js');

describe('RequestBuilder', () => {
  let builder: RequestBuilder;

  beforeEach(() => {
    jest.clearAllMocks();
    builder = createRequestBuilder();
    fs.access.mockRejectedValue(new Error('ENOENT'));
    fs.mkdir.mockResolvedValue(undefined);
    fs.writeFile.mockResolvedValue(undefined);
  });

  const baseInput = {
    collectionPath: '/col',
    name: 'Get Users',
    method: 'GET' as const,
    url: 'https://api.example.com/users',
  };

  describe('createRequest()', () => {
    it('should create yaml request when format is yaml', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      const result = await builder.createRequest(baseInput);
      expect(result.success).toBe(true);
      expect(result.path).toMatch(/\.yml$/);
    });

    it('should create bru request when format is bru', async () => {
      detectFormat.mockResolvedValue({ format: 'bru' });
      const result = await builder.createRequest(baseInput);
      expect(result.success).toBe(true);
      expect(result.path).toMatch(/\.bru$/);
    });

    it('should place request in folder when specified', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      const result = await builder.createRequest({ ...baseInput, folder: 'users' });
      expect(result.path).toContain('/users/');
    });

    it('should place request in a legitimate nested folder', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      const result = await builder.createRequest({ ...baseInput, folder: 'v1/users' });
      expect(result.success).toBe(true);
      expect(result.path).toContain('/v1/users/');
    });

    it('should reject a folder that traverses outside the collection', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      const result = await builder.createRequest({
        ...baseInput,
        folder: '../../../tmp/evil',
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/folder/i);
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('should reject an absolute-path folder', async () => {
      detectFormat.mockResolvedValue({ format: 'bru' });
      const result = await builder.createRequest({
        ...baseInput,
        folder: '/etc/cron.d',
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/absolute/i);
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('should reject a folder containing a null byte', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      const result = await builder.createRequest({
        ...baseInput,
        folder: 'evil\u0000segment',
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/folder/i);
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('should handle body and headers', async () => {
      detectFormat.mockResolvedValue({ format: 'bru' });
      const result = await builder.createRequest({
        ...baseInput,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { type: 'json', content: '{"name":"test"}' },
      });
      expect(result.success).toBe(true);
    });

    it('should handle form data body', async () => {
      detectFormat.mockResolvedValue({ format: 'bru' });
      const result = await builder.createRequest({
        ...baseInput,
        method: 'POST',
        body: {
          type: 'form-data',
          formData: [{ name: 'file', value: 'test.txt', type: 'file' }],
        },
      });
      expect(result.success).toBe(true);
    });

    it('should handle bearer auth', async () => {
      detectFormat.mockResolvedValue({ format: 'bru' });
      const result = await builder.createRequest({
        ...baseInput,
        auth: { type: 'bearer', config: { token: 'abc123' } },
      });
      expect(result.success).toBe(true);
    });

    it('should handle basic auth', async () => {
      detectFormat.mockResolvedValue({ format: 'bru' });
      const result = await builder.createRequest({
        ...baseInput,
        auth: { type: 'basic', config: { username: 'user', password: 'pass' } },
      });
      expect(result.success).toBe(true);
    });

    it('should handle api-key auth', async () => {
      detectFormat.mockResolvedValue({ format: 'bru' });
      const result = await builder.createRequest({
        ...baseInput,
        auth: { type: 'api-key', config: { key: 'X-API-Key', value: 'secret', in: 'header' } },
      });
      expect(result.success).toBe(true);
    });

    it('should handle query params for yaml format', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      const result = await builder.createRequest({
        ...baseInput,
        query: { page: '1', limit: '10' },
      });
      expect(result.success).toBe(true);
    });

    it('should handle query params for bru format', async () => {
      detectFormat.mockResolvedValue({ format: 'bru' });
      const result = await builder.createRequest({
        ...baseInput,
        query: { page: '1' },
      });
      expect(result.success).toBe(true);
    });

    it('should handle yaml auth types', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });

      for (const authCase of [
        { type: 'bearer' as const, config: { token: 'tok' } },
        { type: 'basic' as const, config: { username: 'u', password: 'p' } },
        { type: 'api-key' as const, config: { key: 'k', value: 'v', in: 'header' } },
      ]) {
        const result = await builder.createRequest({ ...baseInput, auth: authCase });
        expect(result.success).toBe(true);
      }
    });

    it('should return error on empty name', async () => {
      const result = await builder.createRequest({ ...baseInput, name: '' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/name is required/i);
    });

    it('should return error on empty collectionPath', async () => {
      const result = await builder.createRequest({ ...baseInput, collectionPath: '' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/collection path is required/i);
    });

    it('should return error on missing method', async () => {
      const result = await builder.createRequest({ ...baseInput, method: undefined as any });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/method is required/i);
    });

    it('should return error on empty url', async () => {
      const result = await builder.createRequest({ ...baseInput, url: '' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/url is required/i);
    });

    it('should return error on invalid method', async () => {
      const result = await builder.createRequest({ ...baseInput, method: 'INVALID' as any });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/invalid http method/i);
    });

    it('should return error on bearer auth without token', async () => {
      const result = await builder.createRequest({
        ...baseInput,
        auth: { type: 'bearer', config: {} },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/token is required/i);
    });

    it('should return error on basic auth without credentials', async () => {
      const result = await builder.createRequest({
        ...baseInput,
        auth: { type: 'basic', config: { username: 'u' } },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/password/i);
    });

    it('should return error on api-key auth without key/value', async () => {
      const result = await builder.createRequest({
        ...baseInput,
        auth: { type: 'api-key', config: {} },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/key and value/i);
    });
  });

  describe('loadRequest()', () => {
    it('should load .yml request file', async () => {
      parseYamlRequest.mockReturnValue({
        info: { name: 'Test', type: 'http', seq: 1 },
        http: {
          method: 'POST',
          url: 'https://api.example.com',
          headers: [{ name: 'Accept', value: 'application/json' }],
          body: { type: 'json', data: '{}' },
          auth: { type: 'bearer', token: 'tok' },
        },
        runtime: {
          scripts: [
            { type: 'before-request', code: 'console.log("pre")' },
            { type: 'after-response', code: 'console.log("post")' },
          ],
        },
        docs: 'Some docs',
      });
      fs.readFile.mockResolvedValue('yaml content');

      const result = await builder.loadRequest('/col/test.yml');
      expect(result.meta.name).toBe('Test');
      expect(result.headers).toEqual({ Accept: 'application/json' });
      expect(result.body?.type).toBe('json');
      expect(result.auth?.type).toBe('bearer');
      expect(result.script?.['pre-request']).toBeDefined();
      expect(result.script?.['post-response']).toBeDefined();
      expect(result.docs).toBe('Some docs');
    });

    it('should load .yml with auth string inherit', async () => {
      parseYamlRequest.mockReturnValue({
        info: { name: 'Test', type: 'http' },
        http: { method: 'GET', url: 'https://example.com', auth: 'inherit' },
      });
      fs.readFile.mockResolvedValue('');

      const result = await builder.loadRequest('/col/test.yml');
      expect(result.http.auth).toBe('none');
    });

    it('should load .yml with no auth', async () => {
      parseYamlRequest.mockReturnValue({
        info: { name: 'Test' },
        http: { method: 'GET', url: 'https://example.com' },
      });
      fs.readFile.mockResolvedValue('');

      const result = await builder.loadRequest('/col/test.yml');
      expect(result.http.auth).toBe('none');
    });

    it('should load .bru request file', async () => {
      fs.readFile.mockResolvedValue('meta { name: test }');
      const result = await builder.loadRequest('/col/test.bru');
      expect(result.meta.name).toBe('parsed');
    });

    it('should throw on unsupported extension', async () => {
      fs.readFile.mockResolvedValue('content');
      await expect(builder.loadRequest('/col/test.json')).rejects.toThrow(BruFileError);
    });

    it('should throw BruFileError on read error', async () => {
      fs.readFile.mockRejectedValue(new Error('ENOENT'));
      await expect(builder.loadRequest('/col/test.yml')).rejects.toThrow(BruFileError);
    });
  });

  describe('updateRequest()', () => {
    it('should update .yml request', async () => {
      parseYamlRequest.mockReturnValue({
        info: { name: 'Old', type: 'http' },
        http: { method: 'GET', url: 'https://old.com' },
      });
      fs.readFile.mockResolvedValue('yaml content');

      const result = await builder.updateRequest('/col/test.yml', {
        name: 'New',
        method: 'POST',
        url: 'https://new.com',
        headers: { 'X-Custom': 'val' },
        body: { type: 'json', content: '{}' },
        auth: { type: 'bearer', config: { token: 'tok' } },
      });
      expect(result.success).toBe(true);
    });

    it('should update .bru request', async () => {
      fs.readFile.mockResolvedValue('meta { name: old }');

      const result = await builder.updateRequest('/col/test.bru', {
        name: 'New',
        method: 'PUT',
        url: 'https://new.com',
        headers: { 'X-H': 'v' },
        body: { type: 'json', content: '{}' },
        auth: { type: 'bearer', config: { token: 't' } },
      });
      expect(result.success).toBe(true);
    });

    it('should return error on failure', async () => {
      fs.readFile.mockRejectedValue(new Error('ENOENT'));
      const result = await builder.updateRequest('/col/test.yml', { name: 'x' });
      expect(result.success).toBe(false);
    });

    it('should update .yml request with a multipart form-data body', async () => {
      parseYamlRequest.mockReturnValue({
        info: { name: 'Old', type: 'http' },
        http: { method: 'POST', url: 'https://old.com' },
      });
      fs.readFile.mockResolvedValue('yaml content');

      const result = await builder.updateRequest('/col/test.yml', {
        body: {
          type: 'form-data',
          formData: [
            { name: 'file', value: '/tmp/a.txt', type: 'file' },
            { name: 'field', value: 'v' },
          ],
        },
      });

      expect(result.success).toBe(true);
      const generated = generateYamlRequest.mock.calls.at(-1)[0];
      expect(generated.http.body.type).toBe('multipart-form');
      expect(generated.http.body.data).toHaveLength(2);
    });

    it('should update .bru request sequence', async () => {
      fs.readFile.mockResolvedValue('meta { name: old }');

      const result = await builder.updateRequest('/col/test.bru', { sequence: 7 });

      expect(result.success).toBe(true);
      const generated = generateBruRequest.mock.calls.at(-1)[0];
      expect(generated.meta.seq).toBe(7);
    });

    // Modify_request must not drop auth credentials. Before the fix,
    // applyUpdates only copied auth.type and discarded updates.auth.config,
    // wiping the bearer/basic/api-key secret on every .bru modify.
    it('should apply the bearer credential from config on .bru modify', async () => {
      const { parseBruRequest } = require('../../../src/bruno/bru-parser.js');
      parseBruRequest.mockReturnValueOnce({
        meta: { name: 'Old', type: 'http' },
        http: { method: 'GET', url: 'https://old.com', body: 'none', auth: 'bearer' },
        auth: { type: 'bearer', bearer: { token: 'oldtoken' } },
      });
      fs.readFile.mockResolvedValue('meta { name: old }');

      const result = await builder.updateRequest('/col/test.bru', {
        auth: { type: 'bearer', config: { token: 'token123' } },
      });

      expect(result.success).toBe(true);
      const generated = generateBruRequest.mock.calls.at(-1)[0];
      expect(generated.auth.type).toBe('bearer');
      // The credential must survive the modify, sourced from updates.auth.config.
      expect(generated.auth.bearer).toEqual({ token: 'token123' });
    });

    it('should apply the basic credentials from config on .bru modify', async () => {
      const { parseBruRequest } = require('../../../src/bruno/bru-parser.js');
      parseBruRequest.mockReturnValueOnce({
        meta: { name: 'Old', type: 'http' },
        http: { method: 'GET', url: 'https://old.com', body: 'none', auth: 'none' },
      });
      fs.readFile.mockResolvedValue('meta { name: old }');

      const result = await builder.updateRequest('/col/test.bru', {
        auth: { type: 'basic', config: { username: 'user123', password: 'pass123' } },
      });

      expect(result.success).toBe(true);
      const generated = generateBruRequest.mock.calls.at(-1)[0];
      expect(generated.auth.type).toBe('basic');
      expect(generated.auth.basic).toEqual({ username: 'user123', password: 'pass123' });
    });

    it('should apply the api-key credentials from config on .bru modify', async () => {
      const { parseBruRequest } = require('../../../src/bruno/bru-parser.js');
      parseBruRequest.mockReturnValueOnce({
        meta: { name: 'Old', type: 'http' },
        http: { method: 'GET', url: 'https://old.com', body: 'none', auth: 'none' },
      });
      fs.readFile.mockResolvedValue('meta { name: old }');

      const result = await builder.updateRequest('/col/test.bru', {
        auth: { type: 'api-key', config: { key: 'X-API-Key', value: 'value123', in: 'query' } },
      });

      expect(result.success).toBe(true);
      const generated = generateBruRequest.mock.calls.at(-1)[0];
      // The tool still accepts the legacy `in: query`; the FILE gets Bruno's
      // spelling, `placement: queryparams`, which is the only one its parser
      // keeps. The mode line goes out as `apikey` for the same reason.
      expect(generated.http.auth).toBe('apikey');
      expect(generated.auth.apikey).toEqual({
        key: 'X-API-Key',
        value: 'value123',
        placement: 'queryparams',
      });
    });

    it('should fall back to placeholders when auth config is missing on .bru modify', async () => {
      const { parseBruRequest } = require('../../../src/bruno/bru-parser.js');
      parseBruRequest.mockReturnValueOnce({
        meta: { name: 'Old', type: 'http' },
        http: { method: 'GET', url: 'https://old.com', body: 'none', auth: 'none' },
      });
      fs.readFile.mockResolvedValue('meta { name: old }');

      const result = await builder.updateRequest('/col/test.bru', {
        auth: { type: 'bearer', config: undefined as any },
      });

      expect(result.success).toBe(true);
      const generated = generateBruRequest.mock.calls.at(-1)[0];
      expect(generated.auth.type).toBe('bearer');
      expect(generated.auth.bearer).toEqual({ token: '{{token}}' });
    });

    it('should set only type for auth: none on .bru modify', async () => {
      const { parseBruRequest } = require('../../../src/bruno/bru-parser.js');
      parseBruRequest.mockReturnValueOnce({
        meta: { name: 'Old', type: 'http' },
        http: { method: 'GET', url: 'https://old.com', body: 'none', auth: 'bearer' },
        auth: { type: 'bearer', bearer: { token: 'oldtoken' } },
      });
      fs.readFile.mockResolvedValue('meta { name: old }');

      const result = await builder.updateRequest('/col/test.bru', {
        auth: { type: 'none', config: {} },
      });

      expect(result.success).toBe(true);
      const generated = generateBruRequest.mock.calls.at(-1)[0];
      expect(generated.auth).toEqual({ type: 'none' });
    });
  });

  describe('createCrudRequests()', () => {
    it('should create 5 CRUD requests', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });

      const results = await builder.createCrudRequests(
        '/col',
        'User',
        'https://api.example.com',
        'users',
      );
      expect(results).toHaveLength(5);
      expect(results.every((r) => r.success)).toBe(true);
    });

    it('should create CRUD without folder', async () => {
      detectFormat.mockResolvedValue({ format: 'bru' });

      const results = await builder.createCrudRequests(
        '/col',
        'Post',
        'https://api.example.com',
      );
      expect(results).toHaveLength(5);
    });
  });

  describe('createAuthRequests()', () => {
    it('should create 4 auth requests with bearer type', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });

      const results = await builder.createAuthRequests(
        '/col',
        'https://api.example.com',
        'bearer',
      );
      expect(results).toHaveLength(4);
      expect(results.every((r) => r.success)).toBe(true);
    });

    it('should create auth requests with basic type', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });

      const results = await builder.createAuthRequests(
        '/col',
        'https://api.example.com',
        'basic',
        'authentication',
      );
      expect(results).toHaveLength(4);
    });

    it('should create auth requests with none type', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });

      const results = await builder.createAuthRequests(
        '/col',
        'https://api.example.com',
        'none',
      );
      expect(results).toHaveLength(4);
    });
  });
});
