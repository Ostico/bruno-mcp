import {
  parseBruRequest,
  generateBruRequest,
  parseBruEnvironment,
  generateBruEnvironment,
  parseBruEnvironmentRaw,
  generateBruEnvironmentFull,
  injectBruScript,
} from '../../../src/bruno/bru-parser.js';
import { BrunoError, type EnvVariable } from '../../../src/bruno/types.js';

const SAMPLE_BRU = `meta {
  name: Get Users
  type: http
  seq: 3
}

get {
  url: https://api.example.com/users
  body: none
  auth: none
}

headers {
  Content-Type: application/json
  Authorization: Bearer {{token}}
}
`;

const SAMPLE_BRU_FULL = `meta {
  name: Create User
  type: http
  seq: 1
}

post {
  url: https://api.example.com/users
  body: json
  auth: bearer
}

headers {
  Content-Type: application/json
}

auth:bearer {
  token: abc123
}

body:json {
  {"name": "John"}
}

script:pre-request {
  console.log('before');
}

script:post-response {
  console.log('after');
}

tests {
  test("status", function() {
    expect(res.status).to.equal(200);
  });
}
`;

const SAMPLE_ENV_BRU = `vars {
  base_url: https://api.example.com
  api_key: secret123
  ~disabled_var: old_value
}
`;

describe('bru-parser', () => {
  describe('parseBruRequest', () => {
    it('parses meta section', () => {
      const result = parseBruRequest(SAMPLE_BRU);
      expect(result.meta.name).toBe('Get Users');
      expect(result.meta.type).toBe('http');
      expect(result.meta.seq).toBe(3);
    });

    it('parses http section', () => {
      const result = parseBruRequest(SAMPLE_BRU);
      expect(result.http.method).toBe('GET');
      expect(result.http.url).toBe('https://api.example.com/users');
      expect(result.http.body).toBe('none');
      expect(result.http.auth).toBe('none');
    });

    it('parses headers', () => {
      const result = parseBruRequest(SAMPLE_BRU);
      expect(result.headers).toBeDefined();
      expect(result.headers!['Content-Type']).toBe('application/json');
      expect(result.headers!['Authorization']).toBe('Bearer {{token}}');
    });

    it('parses full request with auth, body, scripts, tests', () => {
      const result = parseBruRequest(SAMPLE_BRU_FULL);
      expect(result.http.method).toBe('POST');
      expect(result.http.body).toBe('json');
      expect(result.http.auth).toBe('bearer');
      expect(result.auth).toBeDefined();
      expect(result.body).toBeDefined();
      expect(result.body!.type).toBe('json');
      expect(result.body!.content).toBe('{"name": "John"}');
      expect(result.script).toBeDefined();
      expect(result.script!['pre-request']!.exec.join('\n')).toBe("console.log('before');");
      expect(result.script!['post-response']!.exec.join('\n')).toBe("console.log('after');");
      expect(result.tests).toBeDefined();
      expect(result.tests!.exec.join('\n')).toContain('expect(res.status)');
    });

    it('converts seq from string to number', () => {
      const result = parseBruRequest(SAMPLE_BRU);
      expect(typeof result.meta.seq).toBe('number');
      expect(result.meta.seq).toBe(3);
    });

    it('handles minimal .bru file', () => {
      const minimal = `meta {
  name: Minimal
  type: http
}

get {
  url: https://example.com
  body: none
  auth: none
}
`;
      const result = parseBruRequest(minimal);
      expect(result.meta.name).toBe('Minimal');
      expect(result.http.url).toBe('https://example.com');
      expect(result.headers).toBeUndefined();
      expect(result.script).toBeUndefined();
      expect(result.tests).toBeUndefined();
    });

    it('throws BrunoError on malformed content', () => {
      expect(() => parseBruRequest('{{{{invalid bru content')).toThrow(BrunoError);
      try {
        parseBruRequest('{{{{invalid');
      } catch (e) {
        expect((e as BrunoError).code).toBe('PARSE_ERROR');
      }
    });

    it('handles empty string gracefully', () => {
      const result = parseBruRequest('');
      expect(result.meta.name).toBe('Untitled');
      expect(result.http.method).toBe('GET');
    });
  });

  describe('generateBruRequest', () => {
    it('generates valid .bru content', () => {
      const bruFile = parseBruRequest(SAMPLE_BRU);
      const generated = generateBruRequest(bruFile);
      expect(generated).toContain('meta {');
      expect(generated).toContain('name: Get Users');
      expect(generated).toContain('get {');
      expect(generated).toContain('url: https://api.example.com/users');
    });

    it('generates full request with all sections', () => {
      const bruFile = parseBruRequest(SAMPLE_BRU_FULL);
      const generated = generateBruRequest(bruFile);
      expect(generated).toContain('post {');
      expect(generated).toContain('headers {');
      expect(generated).toContain('auth:bearer {');
      expect(generated).toContain('body:json {');
      expect(generated).toContain('script:pre-request {');
      expect(generated).toContain('script:post-response {');
      expect(generated).toContain('tests {');
    });

    it('roundtrip preserves fields', () => {
      const original = parseBruRequest(SAMPLE_BRU_FULL);
      const generated = generateBruRequest(original);
      const reparsed = parseBruRequest(generated);

      expect(reparsed.meta.name).toBe(original.meta.name);
      expect(reparsed.http.method).toBe(original.http.method);
      expect(reparsed.http.url).toBe(original.http.url);
      expect(reparsed.http.body).toBe(original.http.body);
      expect(reparsed.http.auth).toBe(original.http.auth);
      expect(reparsed.body?.content).toBe(original.body?.content);
      expect(reparsed.script?.['pre-request']?.exec).toEqual(original.script?.['pre-request']?.exec);
      expect(reparsed.script?.['post-response']?.exec).toEqual(original.script?.['post-response']?.exec);
      expect(reparsed.tests?.exec).toEqual(original.tests?.exec);
    });

    it('roundtrip preserves simple request', () => {
      const original = parseBruRequest(SAMPLE_BRU);
      const generated = generateBruRequest(original);
      const reparsed = parseBruRequest(generated);

      expect(reparsed.meta.name).toBe(original.meta.name);
      expect(reparsed.meta.seq).toBe(original.meta.seq);
      expect(reparsed.http.method).toBe(original.http.method);
      expect(reparsed.http.url).toBe(original.http.url);
    });

    it('round-trips a multipart/form-data body and docs', () => {
      const bruFile: any = {
        meta: { name: 'MP', type: 'http' },
        http: { method: 'POST', url: 'https://example.com/upload', body: 'multipart-form', auth: 'none' },
        body: {
          type: 'form-data',
          formData: [
            { name: 'caption', value: 'hello', type: 'text', enabled: true, contentType: 'text/plain' },
            { name: 'files', value: ['/a', '/b'], type: 'file', enabled: true },
            { name: 'single', value: '/one', type: 'file', enabled: true },
            { name: 'arrtext', value: ['first'], type: 'text', enabled: false },
            { name: 'novalue', value: [] as string[], enabled: true },
          ],
        },
        docs: '# Docs\nsome notes',
      };
      const generated = generateBruRequest(bruFile);
      const reparsed = parseBruRequest(generated);
      expect(reparsed.http.body).toBe('form-data');
      expect(reparsed.body?.type).toBe('form-data');
      const byName = Object.fromEntries((reparsed.body?.formData ?? []).map((f) => [f.name, f]));
      expect(byName['caption'].contentType).toBe('text/plain');
      expect(byName['files'].type).toBe('file');
      expect(byName['files'].value).toEqual(['/a', '/b']);
      expect(reparsed.docs).toContain('Docs');
    });

    it('applies defaults when seq, body, and auth are absent', () => {
      const bruFile: any = {
        meta: { name: 'Defaults' },
        http: { method: 'GET', url: 'https://example.com' },
      };
      const generated = generateBruRequest(bruFile);
      const reparsed = parseBruRequest(generated);
      expect(reparsed.http.body).toBe('none');
      expect(reparsed.http.auth).toBe('none');
      expect(reparsed.meta.seq).toBeUndefined();
    });

    it('throws GENERATE_ERROR when the underlying generator fails', () => {
      const bad: any = {
        meta: { name: 'X', type: 'http' },
        http: { method: 'GET', url: {}, body: 'none', auth: 'none' },
      };
      expect(() => generateBruRequest(bad)).toThrow(BrunoError);
      try {
        generateBruRequest(bad);
      } catch (e) {
        expect((e as BrunoError).code).toBe('GENERATE_ERROR');
      }
    });
  });

  describe('parseBruEnvironment', () => {
    it('parses environment variables', () => {
      const result = parseBruEnvironment(SAMPLE_ENV_BRU, 'dev');
      expect(result.name).toBe('dev');
      expect(result.variables['base_url']).toBe('https://api.example.com');
      expect(result.variables['api_key']).toBe('secret123');
    });

    it('excludes disabled variables', () => {
      const result = parseBruEnvironment(SAMPLE_ENV_BRU, 'dev');
      expect(result.variables['disabled_var']).toBeUndefined();
    });

    it('uses provided name', () => {
      const result = parseBruEnvironment(SAMPLE_ENV_BRU, 'production');
      expect(result.name).toBe('production');
    });

    it('handles empty env', () => {
      const result = parseBruEnvironment('', 'empty');
      expect(result.name).toBe('empty');
      expect(Object.keys(result.variables)).toHaveLength(0);
    });

    it('throws BrunoError on malformed content', () => {
      expect(() => parseBruEnvironment('{{{{invalid', 'test')).toThrow(BrunoError);
    });
  });

  describe('generateBruEnvironment', () => {
    it('generates environment .bru content', () => {
      const env = { name: 'dev', variables: { base_url: 'https://api.example.com', count: '42' } };
      const generated = generateBruEnvironment(env);
      expect(generated).toContain('vars {');
      expect(generated).toContain('base_url: https://api.example.com');
    });

    it('roundtrip preserves enabled variables', () => {
      const original = { name: 'staging', variables: { host: 'localhost', port: '8080' } as Record<string, string | number | boolean> };
      const generated = generateBruEnvironment(original);
      const reparsed = parseBruEnvironment(generated, 'staging');
      expect(reparsed.variables['host']).toBe('localhost');
      expect(reparsed.variables['port']).toBe('8080');
    });
  });

  describe('injectBruScript', () => {
    const BASE_BRU = `meta {
  name: Test
  type: http
}

get {
  url: https://example.com
  body: none
  auth: none
}
`;

    const BRU_WITH_SCRIPT = `meta {
  name: Test
  type: http
}

get {
  url: https://example.com
  body: none
  auth: none
}

script:post-response {
  console.log('existing');
}
`;

    it('appends post-response script', () => {
      const result = injectBruScript(BASE_BRU, 'post-response', 'console.log("new")', 'append');
      expect(result).toContain('script:post-response {');
      expect(result).toContain('console.log("new")');
    });

    it('appends to existing script', () => {
      const result = injectBruScript(BRU_WITH_SCRIPT, 'post-response', 'console.log("added")', 'append');
      const parsed = parseBruRequest(result);
      const postScript = parsed.script?.['post-response']?.exec.join('\n') ?? '';
      expect(postScript).toContain('existing');
      expect(postScript).toContain('added');
    });

    it('replaces existing script', () => {
      const result = injectBruScript(BRU_WITH_SCRIPT, 'post-response', 'console.log("replaced")', 'replace');
      const parsed = parseBruRequest(result);
      const postScript = parsed.script?.['post-response']?.exec.join('\n') ?? '';
      expect(postScript).toBe('console.log("replaced")');
      expect(postScript).not.toContain('existing');
    });

    it('injects pre-request script', () => {
      const result = injectBruScript(BASE_BRU, 'pre-request', 'console.log("before")', 'append');
      expect(result).toContain('script:pre-request {');
      expect(result).toContain('console.log("before")');
    });

    it('injects tests script into tests block (not post-response)', () => {
      const result = injectBruScript(BASE_BRU, 'tests', 'test("ok", () => {})', 'append');
      const parsed = parseBruRequest(result);
      expect(parsed.tests?.exec.join('\n')).toContain('test("ok"');
      expect(parsed.script?.['post-response']).toBeUndefined();
    });

    it('rejects invalid script type', () => {
      expect(() =>
        injectBruScript(BASE_BRU, 'invalid' as any, 'code', 'append'),
      ).toThrow(BrunoError);
    });

    it('replaces the tests block in replace mode', () => {
      const result = injectBruScript(BASE_BRU, 'tests', 'test("only", () => {})', 'replace');
      const parsed = parseBruRequest(result);
      expect(parsed.tests?.exec.join('\n')).toContain('test("only"');
    });

    it('throws PARSE_ERROR when the .bru content cannot be parsed', () => {
      expect(() =>
        injectBruScript('{{{{invalid bru', 'tests', 'code', 'append'),
      ).toThrow(BrunoError);
      try {
        injectBruScript('{{{{invalid bru', 'tests', 'code', 'append');
      } catch (e) {
        expect((e as BrunoError).code).toBe('PARSE_ERROR');
      }
    });

    it('rejects null bytes in script', () => {
      expect(() =>
        injectBruScript(BASE_BRU, 'post-response', 'code\x00evil', 'append'),
      ).toThrow(BrunoError);
      try {
        injectBruScript(BASE_BRU, 'post-response', 'code\x00evil', 'append');
      } catch (e) {
        expect((e as BrunoError).code).toBe('VALIDATION_ERROR');
        expect((e as BrunoError).message).toContain('null bytes');
      }
    });

    it('rejects oversized scripts', () => {
      const bigScript = 'x'.repeat(50_001);
      expect(() =>
        injectBruScript(BASE_BRU, 'post-response', bigScript, 'append'),
      ).toThrow(BrunoError);
      try {
        injectBruScript(BASE_BRU, 'post-response', bigScript, 'append');
      } catch (e) {
        expect((e as BrunoError).message).toContain('maximum size');
      }
    });

    it('accepts script at exactly 50KB', () => {
      const exactScript = 'x'.repeat(50_000);
      expect(() =>
        injectBruScript(BASE_BRU, 'post-response', exactScript, 'append'),
      ).not.toThrow();
    });
  });

  describe('parseBruEnvironmentRaw()', () => {
    it('throws PARSE_ERROR on malformed environment content', () => {
      expect(() => parseBruEnvironmentRaw('{{{{invalid')).toThrow(BrunoError);
    });

    it('preserves disabled variables (unlike parseBruEnvironment) with their flag', () => {
      const vars = parseBruEnvironmentRaw(SAMPLE_ENV_BRU);
      const byName = Object.fromEntries(vars.map(v => [v.name, v]));

      expect(byName['base_url']).toEqual({ name: 'base_url', value: 'https://api.example.com' });
      expect(byName['api_key']).toEqual({ name: 'api_key', value: 'secret123' });
      // The disabled var survives and keeps disabled: true.
      expect(byName['disabled_var']).toEqual({ name: 'disabled_var', value: 'old_value', disabled: true });
    });
  });

  describe('generateBruEnvironmentFull()', () => {
    it('defaults a missing value to an empty string', () => {
      const bru = generateBruEnvironmentFull([{ name: 'novalue' } as any]);
      const reparsed = parseBruEnvironmentRaw(bru);
      const byName = Object.fromEntries(reparsed.map((v) => [v.name, v]));
      expect(byName['novalue']).toEqual({ name: 'novalue', value: '' });
    });

    it('round-trips the disabled flag', () => {
      const bru = generateBruEnvironmentFull([
        { name: 'host', value: 'localhost' },
        { name: 'debug_url', value: 'http://debug', disabled: true },
      ]);

      const reparsed = parseBruEnvironmentRaw(bru);
      const byName = Object.fromEntries(reparsed.map(v => [v.name, v]));

      expect(byName['host']).toEqual({ name: 'host', value: 'localhost' });
      expect(byName['debug_url']).toEqual({ name: 'debug_url', value: 'http://debug', disabled: true });
    });
  });

  describe('.bru environment secret flag round-trip (D7)', () => {
    it('preserves secret:true across generate + parse', () => {
      const vars: EnvVariable[] = [
        { name: 'apiKey', value: 's3cret', secret: true },
        { name: 'host', value: 'example.com' },
      ];
      const bru = generateBruEnvironmentFull(vars);
      const parsed = parseBruEnvironmentRaw(bru);
      const byName = Object.fromEntries(parsed.map((v) => [v.name, v]));
      expect(byName['apiKey'].secret).toBe(true);
      // A non-secret var must not gain a secret flag.
      expect(byName['host'].secret).toBeUndefined();
    });

    it('does not downgrade a secret var when the file is re-saved', () => {
      // A secret var's value is intentionally not persisted to the .bru env
      // file (only its name lands in the vars:secret block); the regression is
      // that the secret FLAG was being rewritten as false. Re-saving must keep
      // the flag so the var stays secret.
      const original = generateBruEnvironmentFull([{ name: 'token', value: 'old', secret: true }]);
      const parsed = parseBruEnvironmentRaw(original);
      const regenerated = generateBruEnvironmentFull(parsed);
      const reparsed = parseBruEnvironmentRaw(regenerated);
      expect(reparsed.find((v) => v.name === 'token')!.secret).toBe(true);
    });
  });
});
