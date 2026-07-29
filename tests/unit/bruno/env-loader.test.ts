import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadEnvironment,
  substitute,
  findUnresolvedPlaceholders,
} from '../../../src/bruno/env-loader.js';
import { generateBruEnvironmentFull } from '../../../src/bruno/bru-parser.js';

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

  describe('loadEnvironment — native .bru format', () => {
    it('should load variables from a native .bru environment file when no .yml exists', async () => {
      const envDir = join(tempDir, 'environments');
      await fs.mkdir(envDir, { recursive: true });
      await fs.writeFile(
        join(envDir, 'dev.bru'),
        `vars {\n  base_url: https://api.example.com\n  api_key: secret123\n}\n`,
      );

      const vars = await loadEnvironment(tempDir, 'dev');
      expect(vars).toBeInstanceOf(Map);
      expect(vars.size).toBe(2);
      expect(vars.get('base_url')).toBe('https://api.example.com');
      expect(vars.get('api_key')).toBe('secret123');
    });

    it('should skip disabled (~-prefixed) variables in a .bru environment', async () => {
      const envDir = join(tempDir, 'environments');
      await fs.mkdir(envDir, { recursive: true });
      await fs.writeFile(
        join(envDir, 'dev.bru'),
        `vars {\n  base_url: https://api.example.com\n  ~disabled_var: old_value\n}\n`,
      );

      const vars = await loadEnvironment(tempDir, 'dev');
      expect(vars.size).toBe(1);
      expect(vars.has('base_url')).toBe(true);
      expect(vars.has('disabled_var')).toBe(false);
    });

    it('should keep secret variables (preserving the secret flag) rather than dropping them', async () => {
      // Bruno stores a secret variable's NAME in the `.bru` file but not its
      // plaintext value, so `parseBruEnvironmentRaw` carries secret:true with an
      // empty value. The loader must still include the variable, not drop it.
      const envDir = join(tempDir, 'environments');
      await fs.mkdir(envDir, { recursive: true });
      const content = generateBruEnvironmentFull([
        { name: 'apiKey', value: 's3cret', secret: true },
        { name: 'plain', value: 'visible' },
      ]);
      await fs.writeFile(join(envDir, 'prod.bru'), content);

      const vars = await loadEnvironment(tempDir, 'prod');
      expect(vars.size).toBe(2);
      expect(vars.has('apiKey')).toBe(true);
      expect(vars.get('apiKey')).toBe('');
      expect(vars.get('plain')).toBe('visible');
    });

    it('should prefer the .yml file when both .yml and .bru exist', async () => {
      const envDir = join(tempDir, 'environments');
      await fs.mkdir(envDir, { recursive: true });
      await fs.writeFile(
        join(envDir, 'dev.yml'),
        `name: dev\nvariables:\n  - name: source\n    value: yml\n`,
      );
      await fs.writeFile(
        join(envDir, 'dev.bru'),
        `vars {\n  source: bru\n  bru_only: present\n}\n`,
      );

      const vars = await loadEnvironment(tempDir, 'dev');
      expect(vars.size).toBe(1);
      expect(vars.get('source')).toBe('yml');
      expect(vars.has('bru_only')).toBe(false);
    });

    it('should return an empty map when a .bru environment is malformed', async () => {
      const envDir = join(tempDir, 'environments');
      await fs.mkdir(envDir, { recursive: true });
      await fs.writeFile(join(envDir, 'broken.bru'), 'vars {{{{ invalid');

      const vars = await loadEnvironment(tempDir, 'broken');
      expect(vars).toBeInstanceOf(Map);
      expect(vars.size).toBe(0);
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

  describe('findUnresolvedPlaceholders', () => {
    it('returns an empty array for an empty template', () => {
      expect(findUnresolvedPlaceholders('', new Map())).toEqual([]);
    });

    it('returns an empty array when there are no placeholders', () => {
      expect(findUnresolvedPlaceholders('https://api.test/x', new Map())).toEqual([]);
    });

    it('reports a placeholder that vars cannot resolve', () => {
      expect(findUnresolvedPlaceholders('Bearer {{token}}', new Map())).toEqual(['token']);
    });

    it('does not report a placeholder that vars resolves', () => {
      const vars = new Map([['token', 'abc']]);
      expect(findUnresolvedPlaceholders('Bearer {{token}}', vars)).toEqual([]);
    });

    it('reports only the unresolved names, mixed with resolved ones', () => {
      const vars = new Map([['a', '1']]);
      expect(findUnresolvedPlaceholders('{{a}}/{{b}}/{{c}}', vars)).toEqual(['b', 'c']);
    });

    it('de-duplicates repeated placeholders, preserving first-seen order', () => {
      expect(findUnresolvedPlaceholders('{{b}} {{a}} {{b}} {{a}}', new Map())).toEqual(['b', 'a']);
    });

    it('does not re-flag a resolved value that itself contains a placeholder (single-pass mitigation)', () => {
      // `outer` resolves to a literal that looks like `{{inner}}`. Because
      // detection runs on the ORIGINAL template — not the substituted output —
      // and substitution is single-pass, `inner` is NOT reported as unresolved.
      const vars = new Map([['outer', '{{inner}}']]);
      expect(findUnresolvedPlaceholders('hello {{outer}}', vars)).toEqual([]);
    });
  });
});
