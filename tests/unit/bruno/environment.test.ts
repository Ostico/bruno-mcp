import { EnvironmentManager, createEnvironmentManager } from '../../../src/bruno/environment';
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
    readdir: jest.fn(),
    mkdir: jest.fn(),
    access: jest.fn(),
    stat: jest.fn(),
    unlink: jest.fn(),
  },
}));

jest.mock('../../../src/bruno/format-detector.js', () => ({
  detectFormat: jest.fn(),
}));

jest.mock('../../../src/bruno/yaml-generator.js', () => ({
  generateYamlEnvironment: jest.fn(() => 'name: test\nvariables:\n  - name: key\n    value: val\n'),
}));

jest.mock('../../../src/bruno/bru-parser.js', () => ({
  parseBruEnvironment: jest.fn((content: string, name: string) => ({
    name,
    variables: { baseUrl: 'http://localhost:3000' },
  })),
  parseBruEnvironmentRaw: jest.fn(() => [{ name: 'existing', value: 'old' }]),
  generateBruEnvironmentFull: jest.fn(() => 'vars {\n  existing: old\n}\n'),
}));

jest.mock('yaml', () => ({
  parse: jest.fn(),
}));

const fs = require('fs').promises;
const { detectFormat } = require('../../../src/bruno/format-detector.js');
const { parse: parseYaml } = require('yaml');
const { generateYamlEnvironment } = require('../../../src/bruno/yaml-generator.js');

describe('EnvironmentManager', () => {
  let manager: EnvironmentManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = createEnvironmentManager();
    fs.access.mockRejectedValue(new Error('ENOENT'));
    fs.mkdir.mockResolvedValue(undefined);
    fs.writeFile.mockResolvedValue(undefined);
    fs.unlink.mockResolvedValue(undefined);
  });

  describe('createEnvironment()', () => {
    it('should create yaml environment', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });

      const result = await manager.createEnvironment({
        collectionPath: '/col',
        name: 'dev',
        variables: { baseUrl: 'http://localhost:3000' },
      });

      expect(result.success).toBe(true);
      expect(result.path).toMatch(/dev\.yml$/);
    });

    it('should create bru environment', async () => {
      detectFormat.mockResolvedValue({ format: 'bru' });

      const result = await manager.createEnvironment({
        collectionPath: '/col',
        name: 'prod',
        variables: { baseUrl: 'https://api.example.com', debug: false, timeout: 5000 },
      });

      expect(result.success).toBe(true);
      expect(result.path).toMatch(/prod\.bru$/);
      const writeCall = fs.writeFile.mock.calls[0];
      expect(writeCall[1]).toContain('vars {');
      expect(writeCall[1]).toContain("'https://api.example.com'");
      expect(writeCall[1]).toContain('false');
      expect(writeCall[1]).toContain('5000');
    });

    it('should create bru environment with empty variables', async () => {
      detectFormat.mockResolvedValue({ format: 'bru' });

      const result = await manager.createEnvironment({
        collectionPath: '/col',
        name: 'empty',
        variables: {},
      });

      expect(result.success).toBe(true);
      const writeCall = fs.writeFile.mock.calls[0];
      expect(writeCall[1]).toContain('# Add your environment variables here');
    });

    it('should escape single quotes in string values', async () => {
      detectFormat.mockResolvedValue({ format: 'bru' });

      await manager.createEnvironment({
        collectionPath: '/col',
        name: 'test',
        variables: { msg: "it's a test" },
      });

      const writeCall = fs.writeFile.mock.calls[0];
      expect(writeCall[1]).toContain("it\\'s a test");
    });

    it('should return error on empty name', async () => {
      const result = await manager.createEnvironment({
        collectionPath: '/col',
        name: '',
        variables: {},
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/name is required/i);
    });

    it('should return error on empty collectionPath', async () => {
      const result = await manager.createEnvironment({
        collectionPath: '',
        name: 'dev',
        variables: {},
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/collection path is required/i);
    });

    it('should return error on name with spaces', async () => {
      const result = await manager.createEnvironment({
        collectionPath: '/col',
        name: 'my env',
        variables: {},
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/invalid characters/i);
    });

    it('should return error on name with invalid chars', async () => {
      const result = await manager.createEnvironment({
        collectionPath: '/col',
        name: 'env<test>',
        variables: {},
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/invalid characters/i);
    });

    it('should return error when variables is not an object', async () => {
      const result = await manager.createEnvironment({
        collectionPath: '/col',
        name: 'dev',
        variables: null as any,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/variables must be an object/i);
    });
  });

  describe('loadEnvironment()', () => {
    it('should load yaml environment', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      fs.readFile.mockResolvedValue('yaml content');
      parseYaml.mockReturnValue({
        variables: [
          { name: 'baseUrl', value: 'http://localhost' },
          { name: 'disabled', value: 'skip', disabled: true },
          { name: 'empty', value: '' },
          { name: '', value: 'ignored' },
        ],
      });

      const env = await manager.loadEnvironment('/col', 'dev');
      expect(env.name).toBe('dev');
      expect(env.variables.baseUrl).toBe('http://localhost');
      expect(env.variables.disabled).toBeUndefined();
      expect(env.variables.empty).toBe('');
    });

    it('should load yaml environment with no variables array', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      fs.readFile.mockResolvedValue('yaml content');
      parseYaml.mockReturnValue({ name: 'dev' });

      const env = await manager.loadEnvironment('/col', 'dev');
      expect(env.variables).toEqual({});
    });

    it('should load bru environment', async () => {
      detectFormat.mockResolvedValue({ format: 'bru' });
      fs.readFile.mockResolvedValue('vars { baseUrl: http://localhost }');

      const env = await manager.loadEnvironment('/col', 'dev');
      expect(env.name).toBe('dev');
      expect(env.variables.baseUrl).toBe('http://localhost:3000');
    });

    it('should throw BruFileError on failure', async () => {
      detectFormat.mockRejectedValue(new Error('ENOENT'));
      await expect(manager.loadEnvironment('/col', 'dev')).rejects.toThrow(BruFileError);
    });
  });

  describe('updateEnvironment()', () => {
    it('should update yaml environment', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      fs.access.mockResolvedValue(undefined);

      const result = await manager.updateEnvironment('/col', 'dev', { baseUrl: 'https://new.com' });
      expect(result.success).toBe(true);
    });

    it('should update bru environment', async () => {
      detectFormat.mockResolvedValue({ format: 'bru' });
      fs.access.mockResolvedValue(undefined);

      const result = await manager.updateEnvironment('/col', 'dev', { key: 'val' });
      expect(result.success).toBe(true);
      const writeCall = fs.writeFile.mock.calls[0];
      expect(writeCall[1]).toContain('vars {');
    });

    it('should return error if env does not exist', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      fs.access.mockRejectedValue(new Error('ENOENT'));

      const result = await manager.updateEnvironment('/col', 'missing', { key: 'val' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/does not exist/i);
    });

    it('should return error on failure', async () => {
      detectFormat.mockRejectedValue(new Error('fail'));
      const result = await manager.updateEnvironment('/col', 'dev', {});
      expect(result.success).toBe(false);
    });
  });

  describe('deleteEnvironment()', () => {
    it('should delete existing environment', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      fs.access.mockResolvedValue(undefined);

      const result = await manager.deleteEnvironment('/col', 'dev');
      expect(result.success).toBe(true);
      expect(fs.unlink).toHaveBeenCalled();
    });

    it('should return error if env does not exist', async () => {
      detectFormat.mockResolvedValue({ format: 'bru' });
      fs.access.mockRejectedValue(new Error('ENOENT'));

      const result = await manager.deleteEnvironment('/col', 'missing');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/does not exist/i);
    });

    it('should return error on failure', async () => {
      detectFormat.mockRejectedValue(new Error('fail'));
      const result = await manager.deleteEnvironment('/col', 'dev');
      expect(result.success).toBe(false);
    });
  });

  describe('listEnvironments()', () => {
    it('should list environment files', async () => {
      fs.stat.mockResolvedValue({ isDirectory: () => true });
      fs.readdir.mockResolvedValue([
        { name: 'dev.yml', isFile: () => true, isDirectory: () => false },
        { name: 'prod.bru', isFile: () => true, isDirectory: () => false },
        { name: 'backup', isFile: () => false, isDirectory: () => true },
        { name: 'notes.txt', isFile: () => true, isDirectory: () => false },
      ]);

      const envs = await manager.listEnvironments('/col');
      expect(envs).toEqual(['dev', 'prod']);
    });

    it('should return empty array if environments dir missing', async () => {
      fs.stat.mockRejectedValue(new Error('ENOENT'));
      const envs = await manager.listEnvironments('/col');
      expect(envs).toEqual([]);
    });

    it('should throw BruFileError on other errors', async () => {
      fs.stat.mockResolvedValue({ isDirectory: () => true });
      fs.readdir.mockRejectedValue(new Error('EACCES'));
      await expect(manager.listEnvironments('/col')).rejects.toThrow(BruFileError);
    });
  });

  describe('copyEnvironment()', () => {
    it('should copy environment with overrides', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      fs.readFile.mockResolvedValue('');
      parseYaml.mockReturnValue({
        variables: [{ name: 'baseUrl', value: 'http://localhost' }],
      });

      const result = await manager.copyEnvironment('/col', 'dev', 'staging', {
        baseUrl: 'https://staging.com',
      });
      expect(result.success).toBe(true);
    });

    it('should copy environment without overrides', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      fs.readFile.mockResolvedValue('');
      parseYaml.mockReturnValue({
        variables: [{ name: 'key', value: 'val' }],
      });

      const result = await manager.copyEnvironment('/col', 'dev', 'dev-copy');
      expect(result.success).toBe(true);
    });

    it('should return error on failure', async () => {
      detectFormat.mockRejectedValue(new Error('fail'));
      const result = await manager.copyEnvironment('/col', 'dev', 'copy');
      expect(result.success).toBe(false);
    });
  });

  describe('getEnvironmentVariables()', () => {
    it('should return variables as record', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      fs.readFile.mockResolvedValue('');
      parseYaml.mockReturnValue({
        variables: [{ name: 'key', value: 'val' }],
      });

      const vars = await manager.getEnvironmentVariables('/col', 'dev');
      expect(vars.key).toBe('val');
    });
  });

  describe('setEnvironmentVariable()', () => {
    it('should set a variable', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      fs.readFile.mockResolvedValue('');
      fs.access.mockResolvedValue(undefined);
      parseYaml.mockReturnValue({
        variables: [{ name: 'existing', value: 'old' }],
      });

      const result = await manager.setEnvironmentVariable('/col', 'dev', 'newKey', 'newVal');
      expect(result.success).toBe(true);
    });

    it('preserves pre-existing variables when adding a new one (anti-clobber)', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      fs.readFile.mockResolvedValue('');
      fs.access.mockResolvedValue(undefined);
      parseYaml.mockReturnValue({
        variables: [{ name: 'existing', value: 'old' }],
      });

      await manager.setEnvironmentVariable('/col', 'dev', 'newKey', 'newVal');

      const envFile = generateYamlEnvironment.mock.calls.at(-1)[0];
      const byName = Object.fromEntries(envFile.variables.map((v: any) => [v.name, v.value]));
      expect(byName).toEqual({ existing: 'old', newKey: 'newVal' });
    });

    it('updates an existing variable value while keeping the rest', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      fs.readFile.mockResolvedValue('');
      fs.access.mockResolvedValue(undefined);
      parseYaml.mockReturnValue({
        variables: [
          { name: 'a', value: '1' },
          { name: 'b', value: '2' },
        ],
      });

      await manager.setEnvironmentVariable('/col', 'dev', 'b', '99');

      const envFile = generateYamlEnvironment.mock.calls.at(-1)[0];
      const byName = Object.fromEntries(envFile.variables.map((v: any) => [v.name, v.value]));
      expect(byName).toEqual({ a: '1', b: '99' });
    });

    it('preserves a pre-existing DISABLED variable (and its flag) when adding a new one', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      fs.readFile.mockResolvedValue('');
      fs.access.mockResolvedValue(undefined);
      parseYaml.mockReturnValue({
        variables: [
          { name: 'API_KEY', value: 'k' },
          { name: 'DEBUG_URL', value: 'http://debug', disabled: true },
        ],
      });

      await manager.setEnvironmentVariable('/col', 'dev', 'TIMEOUT', '30');

      const envFile = generateYamlEnvironment.mock.calls.at(-1)[0];
      const byName = Object.fromEntries(envFile.variables.map((v: any) => [v.name, v]));
      expect(byName['API_KEY']).toEqual({ name: 'API_KEY', value: 'k' });
      expect(byName['TIMEOUT']).toEqual({ name: 'TIMEOUT', value: '30' });
      // The disabled var survives with its flag intact.
      expect(byName['DEBUG_URL']).toEqual({ name: 'DEBUG_URL', value: 'http://debug', disabled: true });
    });

    it('persists enabled=false as a disabled variable (round-trip)', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      fs.readFile.mockResolvedValue('');
      fs.access.mockResolvedValue(undefined);
      parseYaml.mockReturnValue({ variables: [{ name: 'keep', value: 'v' }] });

      await manager.setEnvironmentVariable('/col', 'dev', 'FEATURE', 'off', false);

      const envFile = generateYamlEnvironment.mock.calls.at(-1)[0];
      const byName = Object.fromEntries(envFile.variables.map((v: any) => [v.name, v]));
      expect(byName['FEATURE']).toEqual({ name: 'FEATURE', value: 'off', disabled: true });
    });

    it('enables a previously disabled variable when enabled=true', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      fs.readFile.mockResolvedValue('');
      fs.access.mockResolvedValue(undefined);
      parseYaml.mockReturnValue({ variables: [{ name: 'FEATURE', value: 'v', disabled: true }] });

      await manager.setEnvironmentVariable('/col', 'dev', 'FEATURE', 'v', true);

      const envFile = generateYamlEnvironment.mock.calls.at(-1)[0];
      const feature = envFile.variables.find((v: any) => v.name === 'FEATURE');
      expect(feature.disabled).toBeUndefined();
    });

    it('should return error on failure', async () => {
      detectFormat.mockRejectedValue(new Error('fail'));
      const result = await manager.setEnvironmentVariable('/col', 'dev', 'k', 'v');
      expect(result.success).toBe(false);
    });
  });

  describe('removeEnvironmentVariable()', () => {
    it('should remove a variable', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      fs.readFile.mockResolvedValue('');
      fs.access.mockResolvedValue(undefined);
      parseYaml.mockReturnValue({
        variables: [
          { name: 'keep', value: 'yes' },
          { name: 'remove', value: 'no' },
        ],
      });

      const result = await manager.removeEnvironmentVariable('/col', 'dev', 'remove');
      expect(result.success).toBe(true);
    });

    it('removes only the target variable and preserves the others (anti-clobber)', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      fs.readFile.mockResolvedValue('');
      fs.access.mockResolvedValue(undefined);
      parseYaml.mockReturnValue({
        variables: [
          { name: 'keep', value: 'yes' },
          { name: 'remove', value: 'no' },
        ],
      });

      await manager.removeEnvironmentVariable('/col', 'dev', 'remove');

      const envFile = generateYamlEnvironment.mock.calls.at(-1)[0];
      const byName = Object.fromEntries(envFile.variables.map((v: any) => [v.name, v.value]));
      expect(byName).toEqual({ keep: 'yes' });
    });

    it('removing one variable keeps a pre-existing DISABLED variable (and its flag)', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      fs.readFile.mockResolvedValue('');
      fs.access.mockResolvedValue(undefined);
      parseYaml.mockReturnValue({
        variables: [
          { name: 'X', value: 'gone' },
          { name: 'Y', value: 'http://debug', disabled: true },
        ],
      });

      await manager.removeEnvironmentVariable('/col', 'dev', 'X');

      const envFile = generateYamlEnvironment.mock.calls.at(-1)[0];
      const byName = Object.fromEntries(envFile.variables.map((v: any) => [v.name, v]));
      expect(byName['X']).toBeUndefined();
      expect(byName['Y']).toEqual({ name: 'Y', value: 'http://debug', disabled: true });
    });

    it('should return error on failure', async () => {
      detectFormat.mockRejectedValue(new Error('fail'));
      const result = await manager.removeEnvironmentVariable('/col', 'dev', 'k');
      expect(result.success).toBe(false);
    });
  });

  describe('mergeEnvironment()', () => {
    it('adds a new variable while preserving a pre-existing DISABLED variable and its flag', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      fs.readFile.mockResolvedValue('');
      fs.access.mockResolvedValue(undefined);
      parseYaml.mockReturnValue({
        variables: [
          { name: 'API_KEY', value: 'k' },
          { name: 'DEBUG_URL', value: 'http://debug', disabled: true },
        ],
      });

      const result = await manager.mergeEnvironment('/col', 'dev', { TIMEOUT: '30' });
      expect(result.success).toBe(true);

      const envFile = generateYamlEnvironment.mock.calls.at(-1)[0];
      const byName = Object.fromEntries(envFile.variables.map((v: any) => [v.name, v]));
      expect(byName['API_KEY']).toEqual({ name: 'API_KEY', value: 'k' });
      expect(byName['TIMEOUT']).toEqual({ name: 'TIMEOUT', value: '30' });
      // The disabled var is NOT dropped and keeps its flag (the HIGH bug fix).
      expect(byName['DEBUG_URL']).toEqual({ name: 'DEBUG_URL', value: 'http://debug', disabled: true });
    });

    it('overriding a disabled variable keeps it disabled', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      fs.readFile.mockResolvedValue('');
      fs.access.mockResolvedValue(undefined);
      parseYaml.mockReturnValue({
        variables: [{ name: 'DEBUG_URL', value: 'old', disabled: true }],
      });

      await manager.mergeEnvironment('/col', 'dev', { DEBUG_URL: 'new' });

      const envFile = generateYamlEnvironment.mock.calls.at(-1)[0];
      const debug = envFile.variables.find((v: any) => v.name === 'DEBUG_URL');
      expect(debug).toEqual({ name: 'DEBUG_URL', value: 'new', disabled: true });
    });

    it('returns error when the environment does not exist', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      fs.readFile.mockRejectedValue(new Error('ENOENT'));

      const result = await manager.mergeEnvironment('/col', 'missing', { a: '1' });
      expect(result.success).toBe(false);
    });
  });

  describe('BRU-format environments', () => {
    it('sets a variable in a BRU environment (raw load + full BRU generate)', async () => {
      detectFormat.mockResolvedValue({ format: 'bru' });
      fs.readFile.mockResolvedValue('vars {\n  existing: old\n}\n');
      fs.access.mockResolvedValue(undefined);

      const result = await manager.setEnvironmentVariable('/col', 'dev', 'newKey', 'newVal');

      expect(result.success).toBe(true);
      // Wrote the .bru file (BRU branch of updateEnvironmentVariables).
      expect(fs.writeFile).toHaveBeenCalledWith('/col/environments/dev.bru', expect.any(String));
    });
  });

  describe('updateEnvironmentVariables()', () => {
    it('returns a NOT_FOUND error when the environment file does not exist', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      fs.access.mockRejectedValue(new Error('ENOENT')); // fileExists -> false

      const result = await manager.updateEnvironmentVariables('/col', 'ghost', [
        { name: 'a', value: '1' },
      ]);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/does not exist/i);
    });

    it('returns an error when the write fails', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      fs.access.mockResolvedValue(undefined); // exists
      fs.writeFile.mockRejectedValue(new Error('EACCES'));

      const result = await manager.updateEnvironmentVariables('/col', 'dev', [
        { name: 'a', value: '1' },
      ]);

      expect(result.success).toBe(false);
      expect(result.error).toBe('EACCES');
    });

    it('returns "Unknown error" when a non-Error value is thrown', async () => {
      detectFormat.mockRejectedValue('string failure');

      const result = await manager.updateEnvironmentVariables('/col', 'dev', []);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });
  });

  describe('variable filtering / defaulting branches', () => {
    it('loadEnvironment (yaml) skips nameless, empty-named and disabled vars and defaults null values', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      fs.readFile.mockResolvedValue('');
      parseYaml.mockReturnValue({
        variables: [
          { name: 'ok', value: 'v' },
          { value: 'noname' }, // name == null -> skipped
          { name: '', value: 'empty' }, // empty name -> skipped
          { name: 'dis', value: 'd', disabled: true }, // disabled -> skipped
          { name: 'nullVal', value: null }, // null value -> defaulted to ''
        ],
      });

      const env = await manager.loadEnvironment('/col', 'dev');

      expect(env.variables).toEqual({ ok: 'v', nullVal: '' });
    });

    it('loadEnvironmentRaw (via setEnvironmentVariable) skips nameless/empty vars and defaults null values', async () => {
      detectFormat.mockResolvedValue({ format: 'yaml' });
      fs.readFile.mockResolvedValue('');
      fs.access.mockResolvedValue(undefined);
      parseYaml.mockReturnValue({
        variables: [
          { name: 'keep', value: 'k' },
          { value: 'noname' }, // name == null -> skipped
          { name: '', value: 'x' }, // empty name -> skipped
          { name: 'nv', value: null }, // null value -> defaulted to ''
        ],
      });

      const result = await manager.setEnvironmentVariable('/col', 'dev', 'added', 'val');

      expect(result.success).toBe(true);
      const envFile = generateYamlEnvironment.mock.calls.at(-1)[0];
      const byName = Object.fromEntries(envFile.variables.map((v: any) => [v.name, v.value]));
      expect(byName).toEqual({ keep: 'k', nv: '', added: 'val' });
    });
  });

  describe('non-Error rejections fall back to "Unknown error"', () => {
    it('createEnvironment', async () => {
      detectFormat.mockRejectedValue('str');
      const result = await manager.createEnvironment({ collectionPath: '/col', name: 'dev', variables: {} });
      expect(result.error).toBe('Unknown error');
    });

    it('updateEnvironment', async () => {
      detectFormat.mockRejectedValue('str');
      const result = await manager.updateEnvironment('/col', 'dev', {});
      expect(result.error).toBe('Unknown error');
    });

    it('deleteEnvironment', async () => {
      detectFormat.mockRejectedValue('str');
      const result = await manager.deleteEnvironment('/col', 'dev');
      expect(result.error).toBe('Unknown error');
    });
  });
});
