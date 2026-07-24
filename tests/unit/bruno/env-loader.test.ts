import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadEnvironment, substitute } from '../../../src/bruno/env-loader.js';

describe('Environment Loader', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'bruno-env-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('loadEnvironment', () => {
    it('should load a YAML environment file and return a Map of active variables', async () => {
      const envDir = join(tempDir, 'environments');
      await fs.mkdir(envDir, { recursive: true });
      await fs.writeFile(join(envDir, 'dev.yml'), `name: dev\nvariables:\n  - name: url\n    value: https://dev.matecat.com\n  - name: api-key\n    value: a87ff679a2f3e71d9181a67b7542122c\n  - name: token\n    value: srrzdz7us9x47v6c936i\n`);

      const vars = await loadEnvironment(tempDir, 'dev');
      expect(vars).toBeInstanceOf(Map);
      expect(vars.size).toBe(3);
      expect(vars.get('url')).toBe('https://dev.matecat.com');
      expect(vars.get('api-key')).toBe('a87ff679a2f3e71d9181a67b7542122c');
      expect(vars.get('token')).toBe('srrzdz7us9x47v6c936i');
    });

    it('should skip variables with disabled: true', async () => {
      const envDir = join(tempDir, 'environments');
      await fs.mkdir(envDir, { recursive: true });
      await fs.writeFile(join(envDir, 'dev.yml'), `name: dev\nvariables:\n  - name: url\n    value: https://dev.matecat.com\n  - name: api-key-airbnb\n    value: MTg1ZjZjMyMDYmI4MjMD\n    disabled: true\n  - name: token\n    value: srrzdz7us9x47v6c936i\n`);

      const vars = await loadEnvironment(tempDir, 'dev');
      expect(vars.size).toBe(2);
      expect(vars.has('url')).toBe(true);
      expect(vars.has('token')).toBe(true);
      expect(vars.has('api-key-airbnb')).toBe(false);
    });

    it('should include variables with disabled: false', async () => {
      const envDir = join(tempDir, 'environments');
      await fs.mkdir(envDir, { recursive: true });
      await fs.writeFile(join(envDir, 'dev.yml'), `name: dev\nvariables:\n  - name: url\n    value: https://dev.matecat.com\n    disabled: false\n`);

      const vars = await loadEnvironment(tempDir, 'dev');
      expect(vars.size).toBe(1);
      expect(vars.get('url')).toBe('https://dev.matecat.com');
    });

    it('should return an empty map when the environment file is missing', async () => {
      const vars = await loadEnvironment(tempDir, 'nonexistent');
      expect(vars).toBeInstanceOf(Map);
      expect(vars.size).toBe(0);
    });

    it('should return an empty map when environments directory does not exist', async () => {
      const vars = await loadEnvironment('/tmp/no-such-collection-path-xyz', 'dev');
      expect(vars).toBeInstanceOf(Map);
      expect(vars.size).toBe(0);
    });

    it('should return an empty map when YAML has no variables array', async () => {
      const envDir = join(tempDir, 'environments');
      await fs.mkdir(envDir, { recursive: true });
      await fs.writeFile(join(envDir, 'empty.yml'), `name: empty\n`);

      const vars = await loadEnvironment(tempDir, 'empty');
      expect(vars).toBeInstanceOf(Map);
      expect(vars.size).toBe(0);
    });

    it('should handle numeric values by converting them to strings', async () => {
      const envDir = join(tempDir, 'environments');
      await fs.mkdir(envDir, { recursive: true });
      await fs.writeFile(join(envDir, 'dev.yml'), `name: dev\nvariables:\n  - name: port\n    value: 8080\n  - name: timeout\n    value: 30000\n`);

      const vars = await loadEnvironment(tempDir, 'dev');
      expect(vars.size).toBe(2);
      expect(vars.get('port')).toBe('8080');
      expect(vars.get('timeout')).toBe('30000');
    });

    it('should handle empty string values', async () => {
      const envDir = join(tempDir, 'environments');
      await fs.mkdir(envDir, { recursive: true });
      await fs.writeFile(join(envDir, 'dev.yml'), `name: dev\nvariables:\n  - name: empty-var\n    value: ""\n  - name: another\n    value: ""\n`);

      const vars = await loadEnvironment(tempDir, 'dev');
      expect(vars.size).toBe(2);
      expect(vars.get('empty-var')).toBe('');
      expect(vars.get('another')).toBe('');
    });

    it('should handle variables with no value field gracefully', async () => {
      const envDir = join(tempDir, 'environments');
      await fs.mkdir(envDir, { recursive: true });
      await fs.writeFile(join(envDir, 'dev.yml'), `name: dev\nvariables:\n  - name: no-value-var\n  - name: with-value\n    value: hello\n`);

      const vars = await loadEnvironment(tempDir, 'dev');
      expect(vars.get('no-value-var')).toBe('');
      expect(vars.get('with-value')).toBe('hello');
    });

    it('should return an empty map when the YAML content is malformed and cannot be parsed', async () => {
      const envDir = join(tempDir, 'environments');
      await fs.mkdir(envDir, { recursive: true });
      // Unterminated double-quoted scalar — the YAML parser throws on this.
      await fs.writeFile(join(envDir, 'broken.yml'), 'name: "unterminated\nvariables: []\n');

      const vars = await loadEnvironment(tempDir, 'broken');
      expect(vars).toBeInstanceOf(Map);
      expect(vars.size).toBe(0);
    });

    it('should skip entries that are null or lack a string name', async () => {
      const envDir = join(tempDir, 'environments');
      await fs.mkdir(envDir, { recursive: true });
      // First entry is null, second has a non-string name, third has no name,
      // fourth is valid — only the valid one survives.
      await fs.writeFile(
        join(envDir, 'dev.yml'),
        `name: dev\nvariables:\n  - null\n  - name: 123\n    value: numeric-name\n  - value: nameless\n  - name: good\n    value: yes\n`,
      );

      const vars = await loadEnvironment(tempDir, 'dev');
      expect(vars.size).toBe(1);
      expect(vars.get('good')).toBe('yes');
    });
  });

  describe('substitute', () => {
    it('should replace {{variable}} placeholders with values', () => {
      const vars = new Map<string, string>([['url', 'https://dev.matecat.com']]);
      const result = substitute('{{url}}/api/v3/test', vars);
      expect(result).toBe('https://dev.matecat.com/api/v3/test');
    });

    it('should replace multiple variables in a single string', () => {
      const vars = new Map<string, string>([['url', 'https://dev.matecat.com'], ['api-key', 'abc123']]);
      const result = substitute('{{url}}/api?key={{api-key}}', vars);
      expect(result).toBe('https://dev.matecat.com/api?key=abc123');
    });

    it('should leave unresolved variables as-is', () => {
      const vars = new Map<string, string>([['url', 'https://x.com']]);
      const result = substitute('{{url}}/{{missing}}', vars);
      expect(result).toBe('https://x.com/{{missing}}');
    });

    it('should return the original string when no variables are provided', () => {
      const vars = new Map<string, string>();
      const result = substitute('{{url}}/api/v3', vars);
      expect(result).toBe('{{url}}/api/v3');
    });

    it('should handle strings with no placeholders', () => {
      const vars = new Map<string, string>([['url', 'https://dev.matecat.com']]);
      const result = substitute('https://literal-url.com/api', vars);
      expect(result).toBe('https://literal-url.com/api');
    });

    it('should handle empty string input', () => {
      const vars = new Map<string, string>([['url', 'https://x.com']]);
      const result = substitute('', vars);
      expect(result).toBe('');
    });

    it('should replace the same variable used multiple times', () => {
      const vars = new Map<string, string>([['host', 'example.com']]);
      const result = substitute('https://{{host}}/api and https://{{host}}/web', vars);
      expect(result).toBe('https://example.com/api and https://example.com/web');
    });

    it('should handle variable names with hyphens and underscores', () => {
      const vars = new Map<string, string>([['api-key', 'key123'], ['base_url', 'https://example.com']]);
      const result = substitute('{{base_url}}/api?key={{api-key}}', vars);
      expect(result).toBe('https://example.com/api?key=key123');
    });

    it('should not perform nested/recursive substitution', () => {
      const vars = new Map<string, string>([['inner', 'world'], ['outer', '{{inner}}']]);
      const result = substitute('hello {{outer}}', vars);
      expect(result).toBe('hello {{inner}}');
    });
  });
});
