import {
  createReader,
  createWriter,
  mapScriptType,
  normalizeScriptType,
  type FormatReader,
  type FormatWriter,
} from '../../../src/bruno/format-factory.js';
import { BrunoError } from '../../../src/bruno/types.js';

// ---------------------------------------------------------------------------
// Mock dependencies — bru-parser, yaml-parser, yaml-generator, env-loader
// These modules may not exist yet (Tasks 1-3); mocking ensures format-factory
// tests are self-contained.
// ---------------------------------------------------------------------------

// bru-parser mocks
jest.mock('../../../src/bruno/bru-parser.js', () => ({
  parseBruRequest: jest.fn((content: string) => ({
    meta: { name: 'mock-bru', type: 'http' },
    http: { method: 'GET', url: 'https://example.com', body: 'none', auth: 'none' },
  })),
  generateBruRequest: jest.fn((_data: unknown) => 'meta {\n  name: mock\n}\n'),
  parseBruEnvironment: jest.fn((_content: string, name: string) => ({
    name,
    variables: { key: 'value' },
  })),
  generateBruEnvironment: jest.fn((_data: unknown) => 'vars {\n  key: value\n}\n'),
  injectBruScript: jest.fn(
    (_content: string, _type: string, code: string, _mode: string) =>
      `injected-bru:${code}`,
  ),
  removeBruScript: jest.fn(
    (_content: string, type: string) => `removed-bru:${type}`,
  ),
}));

// yaml-parser mocks
jest.mock('../../../src/bruno/yaml-parser.js', () => ({
  parseYamlRequest: jest.fn((content: string) => ({
    info: { name: 'mock-yaml', type: 'http' },
    http: { method: 'GET', url: 'https://example.com' },
  })),
}));

// yaml-generator mocks
jest.mock('../../../src/bruno/yaml-generator.js', () => ({
  generateYamlRequest: jest.fn((_data: unknown) => 'info:\n  name: mock\n'),
  generateYamlEnvironment: jest.fn((_data: unknown) => 'variables:\n  - name: key\n'),
  injectYamlScript: jest.fn(
    (_content: string, _type: string, code: string, _mode: string) =>
      `injected-yaml:${code}`,
  ),
  removeYamlScript: jest.fn(
    (_content: string, type: string) => `removed-yaml:${type}`,
  ),
}));

// env-loader uses loadEnvironment (file-based), but the factory needs a pure
// content parser for YAML environments. We provide parseYamlEnvironment inline
// in the factory for YAML, using the yaml lib directly. No mock needed for
// env-loader since format-factory does not import it.

// ---------------------------------------------------------------------------
// Import mocked modules so we can inspect calls
// ---------------------------------------------------------------------------
import { parseBruRequest, generateBruRequest, parseBruEnvironment, generateBruEnvironment, injectBruScript, removeBruScript } from '../../../src/bruno/bru-parser.js';
import { parseYamlRequest } from '../../../src/bruno/yaml-parser.js';
import { generateYamlRequest, generateYamlEnvironment, injectYamlScript, removeYamlScript } from '../../../src/bruno/yaml-generator.js';

describe('format-factory', () => {
  // =========================================================================
  // createReader
  // =========================================================================
  describe('createReader', () => {
    describe('yaml format', () => {
      let reader: FormatReader;

      beforeEach(() => {
        reader = createReader('yaml');
      });

      it('returns a reader with correct request extension', () => {
        expect(reader.getRequestExtension()).toBe('.yml');
      });

      it('returns a reader with correct environment extension', () => {
        expect(reader.getEnvironmentExtension()).toBe('.yml');
      });

      it('delegates parseRequest to parseYamlRequest', () => {
        const content = 'info:\n  name: Test\nhttp:\n  method: GET\n  url: https://example.com';
        reader.parseRequest(content);
        expect(parseYamlRequest).toHaveBeenCalledWith(content);
      });

      it('parseEnvironment parses YAML env content into EnvFile', () => {
        // YAML environment parsing is handled inline (yaml.parse)
        // We test that it returns an EnvFile-shaped object
        const envYaml = 'variables:\n  - name: base_url\n    value: http://localhost\n';
        const result = reader.parseEnvironment(envYaml, 'dev');
        expect(result).toBeDefined();
        // Should have variables array (EnvFile shape)
        expect(result).toHaveProperty('variables');
      });
    });

    describe('bru format', () => {
      let reader: FormatReader;

      beforeEach(() => {
        reader = createReader('bru');
      });

      it('returns a reader with correct request extension', () => {
        expect(reader.getRequestExtension()).toBe('.bru');
      });

      it('returns a reader with correct environment extension', () => {
        expect(reader.getEnvironmentExtension()).toBe('.bru');
      });

      it('delegates parseRequest to parseBruRequest', () => {
        const content = 'meta {\n  name: Test\n}\n';
        reader.parseRequest(content);
        expect(parseBruRequest).toHaveBeenCalledWith(content);
      });

      it('delegates parseEnvironment to parseBruEnvironment', () => {
        const content = 'vars {\n  key: value\n}\n';
        reader.parseEnvironment(content, 'production');
        expect(parseBruEnvironment).toHaveBeenCalledWith(content, 'production');
      });
    });

    describe('invalid format', () => {
      it('throws BrunoError for unknown format', () => {
        expect(() => createReader('xml' as any)).toThrow(BrunoError);
      });

      it('error includes descriptive message', () => {
        expect(() => createReader('unknown' as any)).toThrow(/unsupported.*format/i);
      });
    });
  });

  // =========================================================================
  // createWriter
  // =========================================================================
  describe('createWriter', () => {
    describe('yaml format', () => {
      let writer: FormatWriter;

      beforeEach(() => {
        writer = createWriter('yaml');
      });

      it('returns a writer with correct request extension', () => {
        expect(writer.getRequestExtension()).toBe('.yml');
      });

      it('delegates generateRequest to generateYamlRequest', () => {
        const data = { info: { name: 'Test', type: 'http' as const }, http: { method: 'GET', url: 'https://example.com' } };
        writer.generateRequest(data);
        expect(generateYamlRequest).toHaveBeenCalledWith(data);
      });

      it('delegates generateEnvironment to generateYamlEnvironment', () => {
        const data = { variables: [{ name: 'key', value: 'val' }] };
        writer.generateEnvironment(data);
        expect(generateYamlEnvironment).toHaveBeenCalledWith(data);
      });

      it('injectScript maps pre-request to before-request for YAML', () => {
        const content = 'info:\n  name: Test\n';
        writer.injectScript(content, 'pre-request', 'console.log("hi")', 'append');
        expect(injectYamlScript).toHaveBeenCalledWith(
          content,
          'before-request',
          'console.log("hi")',
          'append',
        );
      });

      it('injectScript maps post-response to after-response for YAML', () => {
        const content = 'info:\n  name: Test\n';
        writer.injectScript(content, 'post-response', 'code', 'replace');
        expect(injectYamlScript).toHaveBeenCalledWith(
          content,
          'after-response',
          'code',
          'replace',
        );
      });

      it('injectScript maps tests to after-response for YAML', () => {
        const content = 'info:\n  name: Test\n';
        writer.injectScript(content, 'tests', 'test code', 'append');
        expect(injectYamlScript).toHaveBeenCalledWith(
          content,
          'after-response',
          'test code',
          'append',
        );
      });
    });

    describe('bru format', () => {
      let writer: FormatWriter;

      beforeEach(() => {
        writer = createWriter('bru');
      });

      it('returns a writer with correct request extension', () => {
        expect(writer.getRequestExtension()).toBe('.bru');
      });

      it('delegates generateRequest to generateBruRequest', () => {
        const data = {
          meta: { name: 'Test', type: 'http' as const },
          http: { method: 'GET' as const, url: 'https://example.com', body: 'none' as const, auth: 'none' as const },
        };
        writer.generateRequest(data);
        expect(generateBruRequest).toHaveBeenCalledWith(data);
      });

      it('delegates generateEnvironment to generateBruEnvironment', () => {
        const data = { name: 'dev', variables: { key: 'val' } };
        writer.generateEnvironment(data);
        expect(generateBruEnvironment).toHaveBeenCalledWith(data);
      });

      it('injectScript passes pre-request as-is for BRU', () => {
        const content = 'meta {\n  name: Test\n}\n';
        writer.injectScript(content, 'pre-request', 'console.log("hi")', 'append');
        expect(injectBruScript).toHaveBeenCalledWith(
          content,
          'pre-request',
          'console.log("hi")',
          'append',
        );
      });

      it('injectScript passes post-response as-is for BRU', () => {
        const content = 'meta {\n  name: Test\n}\n';
        writer.injectScript(content, 'post-response', 'code', 'replace');
        expect(injectBruScript).toHaveBeenCalledWith(
          content,
          'post-response',
          'code',
          'replace',
        );
      });

      it('injectScript maps tests to tests for BRU', () => {
        const content = 'meta {\n  name: Test\n}\n';
        writer.injectScript(content, 'tests', 'test code', 'append');
        expect(injectBruScript).toHaveBeenCalledWith(
          content,
          'tests',
          'test code',
          'append',
        );
      });
    });

    describe('invalid format', () => {
      it('throws BrunoError for unknown format', () => {
        expect(() => createWriter('xml' as any)).toThrow(BrunoError);
      });
    });
  });

  // =========================================================================
  // mapScriptType
  // =========================================================================
  describe('mapScriptType', () => {
    it('maps pre-request to before-request for yaml', () => {
      expect(mapScriptType('pre-request', 'yaml')).toBe('before-request');
    });

    it('maps post-response to after-response for yaml', () => {
      expect(mapScriptType('post-response', 'yaml')).toBe('after-response');
    });

    it('maps tests to after-response for yaml', () => {
      expect(mapScriptType('tests', 'yaml')).toBe('after-response');
    });

    it('maps pre-request to pre-request for bru', () => {
      expect(mapScriptType('pre-request', 'bru')).toBe('pre-request');
    });

    it('maps post-response to post-response for bru', () => {
      expect(mapScriptType('post-response', 'bru')).toBe('post-response');
    });

    it('maps tests to tests for bru', () => {
      expect(mapScriptType('tests', 'bru')).toBe('tests');
    });

    it('throws BrunoError for invalid format', () => {
      expect(() => mapScriptType('pre-request', 'xml' as any)).toThrow(BrunoError);
    });
  });

  // =========================================================================
  // normalizeScriptType
  // =========================================================================
  describe('normalizeScriptType', () => {
    it('returns canonical script types unchanged', () => {
      expect(normalizeScriptType('pre-request')).toBe('pre-request');
      expect(normalizeScriptType('post-response')).toBe('post-response');
      expect(normalizeScriptType('tests')).toBe('tests');
    });

    it('maps aliases to their canonical type', () => {
      expect(normalizeScriptType('before-request')).toBe('pre-request');
      expect(normalizeScriptType('after-response')).toBe('post-response');
    });

    it('throws a VALIDATION_ERROR for an unknown script type', () => {
      expect(() => normalizeScriptType('bogus')).toThrow(BrunoError);
      try {
        normalizeScriptType('bogus');
      } catch (e) {
        expect((e as BrunoError).code).toBe('VALIDATION_ERROR');
      }
    });
  });

  // =========================================================================
  // YAML environment content parsing (inline)
  // =========================================================================
  describe('yaml environment parsing', () => {
    it('parses variables with name, value, and disabled fields', () => {
      const reader = createReader('yaml');
      const envYaml =
        'name: dev\nvariables:\n  - name: base_url\n    value: http://localhost\n    disabled: true\n  - {}\n';
      const result = reader.parseEnvironment(envYaml, 'ignored') as any;
      expect(result.name).toBe('dev');
      expect(result.variables).toHaveLength(2);
      expect(result.variables[0]).toEqual({ name: 'base_url', value: 'http://localhost', disabled: true });
      // The empty entry falls back to defaults.
      expect(result.variables[1]).toEqual({ name: '', value: undefined, disabled: undefined });
    });

    it('returns an empty variables list when content is not an object', () => {
      const reader = createReader('yaml');
      const result = reader.parseEnvironment('42', 'dev') as any;
      expect(result).toEqual({ variables: [] });
    });

    it('returns an empty variables list when variables is not an array', () => {
      const reader = createReader('yaml');
      const result = reader.parseEnvironment('name: x\nvariables: nope\n', 'dev') as any;
      expect(result.variables).toEqual([]);
    });

    it('throws PARSE_ERROR on malformed YAML content', () => {
      const reader = createReader('yaml');
      expect(() => reader.parseEnvironment('{ unclosed: [', 'dev')).toThrow(BrunoError);
    });
  });

  // =========================================================================
  // createWriter — YAML shared after-response slot
  // =========================================================================
  describe('createWriter YAML tests replace mode', () => {
    it('passes replace through for tests scripts (no silent downgrade)', () => {
      const writer = createWriter('yaml');
      writer.injectScript('info:\n  name: T\n', 'tests', 'test code', 'replace');
      expect(injectYamlScript).toHaveBeenCalledWith(
        'info:\n  name: T\n',
        'after-response',
        'test code',
        'replace',
      );
    });
  });

  // =========================================================================
  // createWriter — removeScript
  // =========================================================================
  describe('createWriter removeScript', () => {
    it('maps tests to after-response for the YAML writer', () => {
      const writer = createWriter('yaml');
      writer.removeScript('info:\n  name: T\n', 'tests');
      expect(removeYamlScript).toHaveBeenCalledWith(
        'info:\n  name: T\n',
        'after-response',
      );
    });

    it('maps pre-request to before-request for the YAML writer', () => {
      const writer = createWriter('yaml');
      writer.removeScript('info:\n  name: T\n', 'pre-request');
      expect(removeYamlScript).toHaveBeenCalledWith(
        'info:\n  name: T\n',
        'before-request',
      );
    });

    it('keeps the canonical type for the .bru writer', () => {
      const writer = createWriter('bru');
      writer.removeScript('meta {\n  name: T\n}\n', 'tests');
      expect(removeBruScript).toHaveBeenCalledWith('meta {\n  name: T\n}\n', 'tests');
    });

    it('maps post-response to post-response for the .bru writer', () => {
      const writer = createWriter('bru');
      writer.removeScript('meta {\n  name: T\n}\n', 'post-response');
      expect(removeBruScript).toHaveBeenCalledWith(
        'meta {\n  name: T\n}\n',
        'post-response',
      );
    });
  });
});
