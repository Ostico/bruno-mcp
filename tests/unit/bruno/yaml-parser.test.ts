import { parseYamlRequest, parseYamlFolder, parseYamlCollection } from '../../../src/bruno/yaml-parser.js';
import { BrunoError } from '../../../src/bruno/types.js';

const GET_REQUEST_YAML = `
info:
  name: Schema
  type: http
  seq: 1

http:
  method: GET
  url: "{{url}}/api/v3/context-url/schema"
  headers:
    - name: x-matecat-key
      value: "{{api-key}}"
  auth: inherit

runtime:
  scripts:
    - type: after-response
      code: |-
        test("status is 200", function () {
            expect(res.getStatus()).to.equal(200);
        });

        test("response is valid JSON schema", function () {
            const body = res.getBody();
            expect(body).to.have.property("type", "object");
        });

settings:
  encodeUrl: true
  timeout: 0
  followRedirects: true
  maxRedirects: 5

docs: Returns the JSON validation schema for context-url payloads
`;

const POST_REQUEST_YAML = `
info:
  name: Set for Project
  type: http
  seq: 2

http:
  method: POST
  url: "{{url}}/api/v3/context-url/1590/f2e814e9fbc8/project"
  headers:
    - name: Content-Type
      value: application/json
    - name: x-matecat-key
      value: "{{api-key}}"
  body:
    type: json
    data: |-
      {
          "context_url": "https://example.com/project-context"
      }
  auth: inherit

runtime:
  scripts:
    - type: after-response
      code: |-
        test("status is 200", function () {
            expect(res.getStatus()).to.equal(200);
        });

        test("response confirms project level", function () {
            const body = res.getBody();
            expect(body).to.have.property("level", "project");
        });

settings:
  encodeUrl: true
  timeout: 0
  followRedirects: true
  maxRedirects: 5

docs: Set context URL at project level
`;

const BEARER_AUTH_REQUEST_YAML = `
info:
  name: Export_file_auto.srt
  type: http
  seq: 6

http:
  method: GET
  url: https://api.matesub.com/v1/export/srt/6a1b5b78-0108-41c3-839d-ea1ba77c7dac
  auth:
    type: bearer
    token: "{{token}}"

runtime:
  scripts:
    - type: after-response
      code: |-
        test("Proxy the srt file content", function () {
            expect(res.getStatus()).to.equal(200);
        });

settings:
  encodeUrl: true
  timeout: 0
  followRedirects: true
  maxRedirects: 5
`;

const MINIMAL_REQUEST_YAML = `
info:
  name: Simple
  type: http
  seq: 1

http:
  method: GET
  url: https://example.com/api
`;

const FOLDER_YAML = `
info:
  name: Context-Url
  type: folder
  seq: 19

request:
  auth: inherit
`;

const OPENCOLLECTION_YAML = `
opencollection: 1.0.0

info:
  name: MateCat
bundled: false
extensions:
  bruno:
    ignore:
      - node_modules
      - .git
`;

const MULTIPART_REQUEST_YAML = `
info:
  name: Multipart
  type: http
http:
  method: POST
  url: https://example.com/upload
  body:
    type: multipart-form
    data:
      - name: caption
        value: hello
        type: text
        contentType: text/plain
      - name: files
        value:
          - /path/a
          - /path/b
        type: file
      - null
`;

const DEFAULTS_REQUEST_YAML = `
info: {}
http:
  headers:
    - {}
  auth: 42
runtime:
  scripts:
    - {}
`;

describe('yaml-parser', () => {
  describe('parseYamlRequest', () => {
    it('parses a GET request with headers', () => {
      const result = parseYamlRequest(GET_REQUEST_YAML);
      expect(result.info.name).toBe('Schema');
      expect(result.info.type).toBe('http');
      expect(result.info.seq).toBe(1);
      expect(result.http.method).toBe('GET');
      expect(result.http.url).toBe('{{url}}/api/v3/context-url/schema');
      expect(result.http.headers).toHaveLength(1);
      expect(result.http.headers![0]).toEqual({ name: 'x-matecat-key', value: '{{api-key}}' });
    });

    it('parses auth: inherit as a string', () => {
      const result = parseYamlRequest(GET_REQUEST_YAML);
      expect(result.http.auth).toBe('inherit');
    });

    it('parses a POST request with JSON body', () => {
      const result = parseYamlRequest(POST_REQUEST_YAML);
      expect(result.info.name).toBe('Set for Project');
      expect(result.info.seq).toBe(2);
      expect(result.http.method).toBe('POST');
      expect(result.http.headers).toHaveLength(2);
      expect(result.http.headers![0]).toEqual({ name: 'Content-Type', value: 'application/json' });
      expect(result.http.body).toBeDefined();
      expect(result.http.body!.type).toBe('json');
      expect(result.http.body!.data).toContain('"context_url"');
    });

    it('parses bearer auth object', () => {
      const result = parseYamlRequest(BEARER_AUTH_REQUEST_YAML);
      expect(result.http.auth).toEqual({ type: 'bearer', token: '{{token}}' });
    });

    it('parses runtime.scripts (after-response)', () => {
      const result = parseYamlRequest(GET_REQUEST_YAML);
      expect(result.runtime).toBeDefined();
      expect(result.runtime!.scripts).toHaveLength(1);
      expect(result.runtime!.scripts[0].type).toBe('after-response');
      expect(result.runtime!.scripts[0].code).toContain('test("status is 200"');
      expect(result.runtime!.scripts[0].code).toContain('expect(res.getStatus())');
    });

    it('parses multiple runtime scripts', () => {
      const result = parseYamlRequest(POST_REQUEST_YAML);
      expect(result.runtime!.scripts).toHaveLength(1);
      expect(result.runtime!.scripts[0].type).toBe('after-response');
      expect(result.runtime!.scripts[0].code).toContain('test("status is 200"');
      expect(result.runtime!.scripts[0].code).toContain('test("response confirms project level"');
    });

    it('parses settings', () => {
      const result = parseYamlRequest(GET_REQUEST_YAML);
      expect(result.settings).toBeDefined();
      expect(result.settings!.encodeUrl).toBe(true);
      expect(result.settings!.timeout).toBe(0);
      expect(result.settings!.followRedirects).toBe(true);
      expect(result.settings!.maxRedirects).toBe(5);
    });

    it('parses settings.tls and settings.proxy into YamlSettings', () => {
      const TLS_PROXY_REQUEST_YAML = `
info:
  name: TLS Proxy
  type: http
  seq: 1
http:
  method: GET
  url: "https://example.com/api"
settings:
  tls:
    rejectUnauthorized: false
    ca: ca-pem-data
    cert: cert-pem-data
    key: key-pem-data
  proxy: "http://proxy.example.com:8080"
`;
      const result = parseYamlRequest(TLS_PROXY_REQUEST_YAML);
      expect(result.settings).toBeDefined();
      // Exact shape consumed by buildDispatcher (fetch-dispatcher.ts)
      expect(result.settings!.tls).toEqual({
        rejectUnauthorized: false,
        ca: 'ca-pem-data',
        cert: 'cert-pem-data',
        key: 'key-pem-data',
      });
      expect(result.settings!.proxy).toBe('http://proxy.example.com:8080');
    });

    it('omits settings.tls when no recognized tls fields are present', () => {
      const NO_TLS_FIELDS_YAML = `
info:
  name: Empty TLS
  type: http
  seq: 1
http:
  method: GET
  url: "https://example.com/api"
settings:
  tls:
    unknownField: value
`;
      const result = parseYamlRequest(NO_TLS_FIELDS_YAML);
      expect(result.settings).toBeDefined();
      expect(result.settings!.tls).toBeUndefined();
      expect(result.settings!.proxy).toBeUndefined();
    });

    it('parses docs string', () => {
      const result = parseYamlRequest(GET_REQUEST_YAML);
      expect(result.docs).toBe('Returns the JSON validation schema for context-url payloads');
    });

    it('handles minimal request with no optional sections', () => {
      const result = parseYamlRequest(MINIMAL_REQUEST_YAML);
      expect(result.info.name).toBe('Simple');
      expect(result.http.method).toBe('GET');
      expect(result.http.url).toBe('https://example.com/api');
      expect(result.runtime).toBeUndefined();
      expect(result.settings).toBeUndefined();
      expect(result.docs).toBeUndefined();
      expect(result.http.headers).toBeUndefined();
      expect(result.http.body).toBeUndefined();
    });

    it('throws BrunoError on malformed YAML', () => {
      const badYaml = ':\n  - :\n    bad: [unclosed';
      expect(() => parseYamlRequest(badYaml)).toThrow(BrunoError);
    });

    it('throws BrunoError when info section is missing', () => {
      const noInfo = `\nhttp:\n  method: GET\n  url: https://example.com\n`;
      expect(() => parseYamlRequest(noInfo)).toThrow(BrunoError);
      expect(() => parseYamlRequest(noInfo)).toThrow(/info/i);
    });

    it('throws BrunoError when http section is missing', () => {
      const noHttp = `\ninfo:\n  name: Test\n  type: http\n  seq: 1\n`;
      expect(() => parseYamlRequest(noHttp)).toThrow(BrunoError);
      expect(() => parseYamlRequest(noHttp)).toThrow(/http/i);
    });

    it('throws BrunoError on empty input', () => {
      expect(() => parseYamlRequest('')).toThrow(BrunoError);
    });

    it('preserves the full code block in runtime scripts', () => {
      const result = parseYamlRequest(BEARER_AUTH_REQUEST_YAML);
      const code = result.runtime!.scripts[0].code;
      expect(code).toContain('test(');
      expect(code).toContain('expect(res.getStatus())');
    });

    it('parses request with no auth field', () => {
      const noAuth = `\ninfo:\n  name: NoAuth\n  type: http\n  seq: 1\n\nhttp:\n  method: GET\n  url: https://example.com\n`;
      const result = parseYamlRequest(noAuth);
      expect(result.http.auth).toBeUndefined();
    });
  });

  describe('parseYamlRequest — edge cases', () => {
    it('parses a multipart/form-data body with mixed part shapes', () => {
      const result = parseYamlRequest(MULTIPART_REQUEST_YAML);
      const data = result.http.body!.data as Array<Record<string, unknown>>;
      expect(Array.isArray(data)).toBe(true);
      expect(data).toHaveLength(3);
      expect(data[0]).toEqual({ name: 'caption', value: 'hello', type: 'text', contentType: 'text/plain' });
      expect(data[1].type).toBe('file');
      expect(data[1].value).toEqual(['/path/a', '/path/b']);
      // A null list entry is coerced to an empty text part.
      expect(data[2]).toEqual({ name: '', value: '', type: 'text' });
    });

    it('applies defaults for missing optional fields', () => {
      const result = parseYamlRequest(DEFAULTS_REQUEST_YAML);
      expect(result.info.name).toBe('');
      expect(result.http.method).toBe('');
      expect(result.http.url).toBe('');
      expect(result.http.headers).toEqual([{ name: '', value: '' }]);
      // auth given as a non-string/non-object (number) is ignored.
      expect(result.http.auth).toBeUndefined();
      expect(result.runtime!.scripts[0]).toEqual({ type: 'after-response', code: '' });
    });

    it('omits runtime when scripts is an empty array', () => {
      const yaml = `\ninfo:\n  name: X\n  type: http\nhttp:\n  method: GET\n  url: https://example.com\nruntime:\n  scripts: []\n`;
      const result = parseYamlRequest(yaml);
      expect(result.runtime).toBeUndefined();
    });

    it('throws BrunoError when the YAML does not produce an object', () => {
      expect(() => parseYamlRequest('42')).toThrow(BrunoError);
      expect(() => parseYamlRequest('42')).toThrow(/object/i);
    });
  });

  describe('parseYamlFolder', () => {
    it('parses folder.yml into folder metadata', () => {
      const result = parseYamlFolder(FOLDER_YAML);
      expect(result.info.name).toBe('Context-Url');
      expect(result.info.type).toBe('folder');
      expect(result.info.seq).toBe(19);
    });

    it('parses folder request defaults', () => {
      const result = parseYamlFolder(FOLDER_YAML);
      expect(result.request).toBeDefined();
      expect(result.request!.auth).toBe('inherit');
    });

    it('handles minimal folder with just info', () => {
      const minFolder = `\ninfo:\n  name: Simple Folder\n  type: folder\n`;
      const result = parseYamlFolder(minFolder);
      expect(result.info.name).toBe('Simple Folder');
      expect(result.info.type).toBe('folder');
      expect(result.request).toBeUndefined();
    });

    it('throws BrunoError when info section is missing', () => {
      expect(() => parseYamlFolder('request:\n  auth: inherit')).toThrow(BrunoError);
    });

    it('throws BrunoError on empty input', () => {
      expect(() => parseYamlFolder('')).toThrow(BrunoError);
    });
  });

  describe('parseYamlCollection', () => {
    it('parses opencollection.yml into collection metadata', () => {
      const result = parseYamlCollection(OPENCOLLECTION_YAML);
      expect(result.opencollection).toBe('1.0.0');
      expect(result.info.name).toBe('MateCat');
    });

    it('parses bundled flag', () => {
      const result = parseYamlCollection(OPENCOLLECTION_YAML);
      expect(result.bundled).toBe(false);
    });

    it('parses extensions with ignore list', () => {
      const result = parseYamlCollection(OPENCOLLECTION_YAML);
      expect(result.extensions).toBeDefined();
      expect(result.extensions!.bruno).toBeDefined();
      expect(result.extensions!.bruno!.ignore).toEqual(['node_modules', '.git']);
    });

    it('handles minimal opencollection with just version and name', () => {
      const minimal = `\nopencollection: 1.0.0\n\ninfo:\n  name: Minimal\n`;
      const result = parseYamlCollection(minimal);
      expect(result.opencollection).toBe('1.0.0');
      expect(result.info.name).toBe('Minimal');
      expect(result.bundled).toBeUndefined();
      expect(result.extensions).toBeUndefined();
    });

    it('throws BrunoError when opencollection version is missing', () => {
      const noVersion = `\ninfo:\n  name: Test\n`;
      expect(() => parseYamlCollection(noVersion)).toThrow(BrunoError);
      expect(() => parseYamlCollection(noVersion)).toThrow(/opencollection/i);
    });

    it('throws BrunoError when info section is missing', () => {
      const noInfo = `\nopencollection: 1.0.0\nbundled: false\n`;
      expect(() => parseYamlCollection(noInfo)).toThrow(BrunoError);
    });

    it('defaults info name to empty string when name is absent', () => {
      const result = parseYamlCollection('opencollection: 1.0.0\ninfo: {}\n');
      expect(result.info.name).toBe('');
    });

    it('throws BrunoError on empty input', () => {
      expect(() => parseYamlCollection('')).toThrow(BrunoError);
    });
  });
});
