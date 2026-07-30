import {
  generateYamlRequest,
  generateYamlCollection,
  generateYamlEnvironment,
  injectYamlScript,
} from '../../../src/bruno/yaml-generator';
import { BrunoError } from '../../../src/bruno/types';

describe('yaml-generator', () => {
  describe('generateYamlRequest()', () => {
    it('should generate minimal request', () => {
      const yaml = generateYamlRequest({
        info: { name: 'Get Users' },
        http: { method: 'GET', url: 'https://api.example.com/users' },
      });
      expect(yaml).toContain('name: Get Users');
      expect(yaml).toContain('method: GET');
      expect(yaml).toContain('url: https://api.example.com/users');
    });

    it('should include type and seq in info', () => {
      const yaml = generateYamlRequest({
        info: { name: 'Test', type: 'http', seq: 3 },
        http: { method: 'POST', url: 'https://example.com' },
      });
      expect(yaml).toContain('type: http');
      expect(yaml).toContain('seq: 3');
    });

    it('should include headers', () => {
      const yaml = generateYamlRequest({
        info: { name: 'Test' },
        http: {
          method: 'GET',
          url: 'https://example.com',
          headers: [
            { name: 'Accept', value: 'application/json' },
            { name: 'X-Custom', value: 'val' },
          ],
        },
      });
      expect(yaml).toContain('Accept');
      expect(yaml).toContain('application/json');
    });

    it('should include body', () => {
      const yaml = generateYamlRequest({
        info: { name: 'Test' },
        http: {
          method: 'POST',
          url: 'https://example.com',
          body: { type: 'json', data: '{"key":"val"}' },
        },
      });
      expect(yaml).toContain('type: json');
    });

    it('should include params', () => {
      const yaml = generateYamlRequest({
        info: { name: 'Test' },
        http: {
          method: 'GET',
          url: 'https://example.com',
          params: [
            { name: 'page', value: '1', type: 'query' },
            { name: 'disabled', value: 'x', type: 'query', disabled: true },
          ],
        },
      });
      expect(yaml).toContain('page');
      expect(yaml).toContain('disabled: true');
    });

    it('should include auth', () => {
      const yaml = generateYamlRequest({
        info: { name: 'Test' },
        http: {
          method: 'GET',
          url: 'https://example.com',
          auth: { type: 'bearer', token: 'abc' },
        },
      });
      expect(yaml).toContain('auth');
      expect(yaml).toContain('bearer');
    });

    it('should include runtime scripts', () => {
      const yaml = generateYamlRequest({
        info: { name: 'Test' },
        http: { method: 'GET', url: 'https://example.com' },
        runtime: {
          scripts: [{ type: 'before-request', code: 'console.log("pre")' }],
        },
      });
      expect(yaml).toContain('runtime');
      expect(yaml).toContain('before-request');
    });

    it('should include settings', () => {
      const yaml = generateYamlRequest({
        info: { name: 'Test' },
        http: { method: 'GET', url: 'https://example.com' },
        settings: { timeout: 5000, followRedirects: true },
      });
      expect(yaml).toContain('timeout: 5000');
      expect(yaml).toContain('followRedirects: true');
    });

    it('should include docs', () => {
      const yaml = generateYamlRequest({
        info: { name: 'Test' },
        http: { method: 'GET', url: 'https://example.com' },
        docs: 'Some documentation',
      });
      expect(yaml).toContain('docs: Some documentation');
    });

    it('should strip null/undefined values', () => {
      const yaml = generateYamlRequest({
        info: { name: 'Test' },
        http: {
          method: 'GET',
          url: 'https://example.com',
          body: { type: 'json', data: undefined as any },
        },
      });
      expect(yaml).not.toContain('data');
    });
  });

  describe('generateYamlCollection()', () => {
    it('should generate minimal collection', () => {
      const yaml = generateYamlCollection({
        opencollection: '1',
        info: { name: 'My API' },
      });
      expect(yaml).toContain('opencollection: "1"');
      expect(yaml).toContain('name: My API');
    });

    it('should include bundled flag', () => {
      const yaml = generateYamlCollection({
        opencollection: '1',
        info: { name: 'Test' },
        bundled: true,
      });
      expect(yaml).toContain('bundled: true');
    });

    it('should include extensions', () => {
      const yaml = generateYamlCollection({
        opencollection: '1',
        info: { name: 'Test' },
        extensions: {
          bruno: { ignore: ['node_modules', '.git'] },
        },
      });
      expect(yaml).toContain('extensions');
      expect(yaml).toContain('node_modules');
    });
  });

  describe('generateYamlEnvironment()', () => {
    it('should generate environment with name and variables', () => {
      const yaml = generateYamlEnvironment({
        name: 'dev',
        variables: [
          { name: 'baseUrl', value: 'http://localhost:3000' },
          { name: 'debug', value: true },
        ],
      });
      expect(yaml).toContain('name: dev');
      expect(yaml).toContain('baseUrl');
    });

    it('should handle disabled variables', () => {
      const yaml = generateYamlEnvironment({
        name: 'test',
        variables: [{ name: 'secret', value: 'hidden', disabled: true }],
      });
      expect(yaml).toContain('disabled: true');
    });

    it('should handle empty variables', () => {
      const yaml = generateYamlEnvironment({ name: 'empty' });
      expect(yaml).toContain('name: empty');
      expect(yaml).not.toContain('variables');
    });

    it('should handle no name', () => {
      const yaml = generateYamlEnvironment({
        variables: [{ name: 'key', value: 'val' }],
      });
      expect(yaml).toContain('key');
      expect(yaml).not.toMatch(/^name:/m);
    });
  });

  describe('injectYamlScript()', () => {
    const baseYaml = [
      'info:',
      '  name: Test',
      'http:',
      '  method: GET',
      '  url: https://example.com',
    ].join('\n');

    it('should append script to empty runtime', () => {
      const result = injectYamlScript(baseYaml, 'after-response', 'test("ok", () => true)', 'append');
      expect(result).toContain('after-response');
      expect(result).toContain('test("ok", () => true)');
    });

    it('should append script to existing runtime', () => {
      const withRuntime = baseYaml + '\nruntime:\n  scripts:\n    - type: before-request\n      code: "pre"';
      const result = injectYamlScript(withRuntime, 'after-response', 'post code', 'append');
      expect(result).toContain('before-request');
      expect(result).toContain('after-response');
    });

    it('should replace scripts of same type', () => {
      const withRuntime = baseYaml + '\nruntime:\n  scripts:\n    - type: after-response\n      code: "old"';
      const result = injectYamlScript(withRuntime, 'after-response', 'new code', 'replace');
      expect(result).toContain('new code');
      expect(result).not.toContain('old');
    });

    it('should throw on invalid script type', () => {
      expect(() => {
        injectYamlScript(baseYaml, 'invalid' as any, 'code', 'append');
      }).toThrow(BrunoError);
    });

    it('should throw on null bytes in script', () => {
      expect(() => {
        injectYamlScript(baseYaml, 'after-response', 'code\0evil', 'append');
      }).toThrow(BrunoError);
    });

    it('should throw on script exceeding 50KB', () => {
      const bigScript = 'x'.repeat(50_001);
      expect(() => {
        injectYamlScript(baseYaml, 'after-response', bigScript, 'append');
      }).toThrow(BrunoError);
    });

    it('should handle runtime with non-array scripts', () => {
      const withBadRuntime = baseYaml + '\nruntime:\n  scripts: null';
      const result = injectYamlScript(withBadRuntime, 'before-request', 'code', 'append');
      expect(result).toContain('before-request');
    });

    it('should handle runtime as non-object', () => {
      const withBadRuntime = baseYaml + '\nruntime: null';
      const result = injectYamlScript(withBadRuntime, 'before-request', 'code', 'append');
      expect(result).toContain('before-request');
    });
  });

  describe('stripEmpty pruning (empty collections collapse to undefined)', () => {
    it('drops an array field that becomes empty after cleaning', () => {
      // body.data is an empty array → stripEmpty returns undefined for it,
      // so the emitted body keeps only `type`.
      const yaml = generateYamlRequest({
        info: { name: 'R' },
        http: {
          method: 'GET',
          url: 'https://example.com',
          body: { type: 'json', data: [] as unknown as string },
        },
      });
      expect(yaml).toContain('type: json');
      expect(yaml).not.toMatch(/data:/);
    });

    it('drops an object field that becomes empty after cleaning', () => {
      // settings is a truthy but empty object → stripEmpty returns undefined,
      // so no `settings:` key is emitted.
      const yaml = generateYamlRequest({
        info: { name: 'R' },
        http: { method: 'GET', url: 'https://example.com' },
        settings: {},
      });
      expect(yaml).not.toMatch(/settings:/);
    });
  });

  describe('document formatting', () => {
    // Bruno writes these files with its own yaml options and its own blank-line
    // pass. Anything we emit differently is a diff Bruno silently rewrites the
    // first time a user saves the request in the app.
    const SCRIPT = [
      '// the gateway rewrites this header on every redirect hop that it performs',
      "const id = res.body.id;",
      '// keep it for the next request',
      "bru.setVar('id', id);",
    ].join('\n');

    const scripted = () =>
      generateYamlRequest({
        info: { name: 'R' },
        http: { method: 'GET', url: 'https://example.com' },
        runtime: { scripts: [{ type: 'after-response', code: SCRIPT }] },
      });

    it('writes a multi-line script as a literal block, not a folded one', () => {
      const yaml = scripted();
      expect(yaml).toMatch(/code: \|-/);
      expect(yaml).not.toMatch(/code: >-/);
    });

    it('keeps every script line on its own line, with no blank lines between them', () => {
      const yaml = scripted();
      // A folded block encodes each newline as a blank line, so the same four
      // lines would arrive seven lines apart and read as separate statements.
      const body = yaml.split('code: |-\n')[1].split('\n').slice(0, 4);
      expect(body.map((l) => l.trim())).toEqual(SCRIPT.split('\n'));
    });

    it('does not wrap a long line', () => {
      const url = `https://example.com/${'segment/'.repeat(30)}end`;
      const yaml = generateYamlRequest({
        info: { name: 'R' },
        http: { method: 'GET', url },
      });
      expect(yaml).toContain(`url: ${url}\n`);
    });

    it('puts a blank line before each top-level block', () => {
      const yaml = scripted();
      expect(yaml).toMatch(/\n\nhttp:\n/);
      expect(yaml).toMatch(/\n\nruntime:\n/);
      // Not before the first key, and not before a nested one.
      expect(yaml.startsWith('info:\n')).toBe(true);
      expect(yaml).not.toMatch(/\n\n\s+scripts:/);
    });

    it('applies the same formatting to collection and environment files', () => {
      // Neither document has a key on Bruno's blank-line list, so both get the
      // options and no blank lines — asserted so a stray one would be caught.
      const name = `C ${'very '.repeat(30)}long`;
      const collection = generateYamlCollection({ info: { name } });
      expect(collection).toContain(`name: ${name}\n`);
      expect(collection).not.toMatch(/\n\n/);

      const env = generateYamlEnvironment({
        name: 'dev',
        variables: [{ name: 'host', value: 'https://dev.example.com' }],
      });
      expect(env).not.toMatch(/\n\n/);
    });

    it('formats a script injected into an existing document the same way', () => {
      const yaml = injectYamlScript(scripted(), 'before-request', SCRIPT);
      expect(yaml).toMatch(/code: \|-/);
      expect(yaml).not.toMatch(/code: >-/);
      expect(yaml).toMatch(/\n\nruntime:\n/);
    });
  });
});
