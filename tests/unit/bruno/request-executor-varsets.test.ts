/**
 * `vars:pre-request` and `vars:post-response`, end to end through RequestExecutor.
 *
 * These were the last member of the "parsed, persisted, round-tripped, never
 * applied" class: both parsers read them, both generators wrote them back, and
 * nothing at execution time ever looked at them. bruFileToYamlRequest also
 * dropped them, so the .bru side stayed inert even once the executor applied
 * them — which is why both formats are covered here rather than one.
 *
 * The two halves are deliberately asymmetric, matching upstream:
 *   pre-request   -> RAW values folded into the interpolation map before the
 *                    request is built (precedence: env < request < runtime).
 *   post-response -> JS EXPRESSIONS evaluated against the response and stored
 *                    via bru.setVar.
 *
 * Distinct from request-executor-vars.test.ts, which covers the VariableStore
 * carrying a script's bru.setVar write from one request to the next.
 *
 * Mocking pattern follows request-executor-assertions.test.ts.
 */

import { RequestExecutor } from '../../../src/bruno/request-executor';
import {
  applyPreRequestVars,
  bruVarSetsToYamlVars,
} from '../../../src/bruno/request-vars';
import * as fs from 'node:fs/promises';

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

jest.mock('node:fs/promises');
const mockedFs = jest.mocked(fs);

jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
}));

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const YAML_PRE_REQUEST = `
info:
  name: Pre Request Vars
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/{{version}}/widgets"
vars:
  preRequest:
    - name: version
      value: v3
`;

const YAML_PRE_REQUEST_DISABLED = `
info:
  name: Pre Request Disabled
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/{{version}}/widgets"
vars:
  preRequest:
    - name: version
      value: v3
      disabled: true
`;

/** A pre-request var whose own value references another, declared earlier. */
const YAML_PRE_REQUEST_CHAINED = `
info:
  name: Pre Request Chained
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/{{path}}"
vars:
  preRequest:
    - name: version
      value: v9
    - name: path
      value: "{{version}}/widgets"
`;

const YAML_POST_RESPONSE = `
info:
  name: Post Response Vars
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/widgets/7"
vars:
  postResponse:
    - name: widgetId
      value: res.body.id
assert:
  - name: bru.getVar("widgetId")
    value: eq 7
`;

const YAML_POST_RESPONSE_DISABLED = `
info:
  name: Post Response Disabled
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/widgets/7"
vars:
  postResponse:
    - name: widgetId
      value: res.body.id
      disabled: true
assert:
  - name: bru.getVar("widgetId")
    value: isUndefined
`;

/**
 * .bru with both halves. `~name` is how the .bru format spells switched-off, the
 * opposite polarity from the .yml `disabled: true`, so the translation through
 * bruFileToYamlRequest is exercised rather than assumed.
 */
const BRU_BOTH = `meta {
  name: Bru Vars
  type: http
  seq: 1
}

get {
  url: https://api.example.com/{{version}}/widgets/7
}

vars:pre-request {
  version: v3
  ~unused: nope
}

vars:post-response {
  widgetId: res.body.id
  ~skipped: res.body.name
}

assert {
  bru.getVar("widgetId"): eq 7
  bru.getVar("skipped"): isUndefined
}
`;

const WIDGET_BODY = { id: 7, name: 'widget', items: [1, 2, 3] };

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function createMockResponse(body: unknown, status = 200): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  return {
    status,
    statusText: 'OK',
    headers,
    text: jest
      .fn()
      .mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
    ok: status >= 200 && status < 300,
  } as unknown as Response;
}

function setupFsReaddir(files: string[]): void {
  mockedFs.readdir.mockImplementation(async (dirPath: any) => {
    const p = typeof dirPath === 'string' ? dirPath : dirPath.toString();
    if (p === '/test-collection') {
      return files.map(f => ({
        name: f,
        isFile: () => true,
        isDirectory: () => false,
      })) as any;
    }
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
}

function setupFsReadFile(fileMap: Record<string, string>): void {
  mockedFs.readFile.mockImplementation(async (filePath: any) => {
    const p = typeof filePath === 'string' ? filePath : filePath.toString();
    for (const [key, value] of Object.entries(fileMap)) {
      if (p.endsWith(key) || p === key) return value;
    }
    const err = new Error(`ENOENT: no such file - ${p}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
}

function setupFsStat(existingPaths: string[]): void {
  mockedFs.stat.mockImplementation(async (filePath: any) => {
    const p = typeof filePath === 'string' ? filePath : filePath.toString();
    for (const existing of existingPaths) {
      if (p.endsWith(existing) || p === existing) {
        return { isDirectory: () => true, isFile: () => false } as any;
      }
    }
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
}

async function runOne(fileName: string, source: string, body: unknown = WIDGET_BODY) {
  setupFsReaddir([fileName]);
  setupFsReadFile({ [fileName]: source });
  setupFsStat(['/test-collection']);
  mockFetch.mockResolvedValue(createMockResponse(body));

  const result = await RequestExecutor.executeCollection('/test-collection', {});
  return result.results[0];
}

/** The URL the request actually went out with. */
function requestedUrl(): string {
  return String(mockFetch.mock.calls[0][0]);
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('RequestExecutor — vars:pre-request', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves a {{var}} in the URL from a pre-request var', async () => {
    await runOne('Pre Request Vars.yml', YAML_PRE_REQUEST);
    expect(requestedUrl()).toBe('https://api.example.com/v3/widgets');
  });

  it('leaves the placeholder alone when the var is switched off', async () => {
    // An unresolved placeholder is the visible symptom, which is what the author
    // needs to see. Applying a switched-off var would leave no trace at all.
    await runOne('Pre Request Disabled.yml', YAML_PRE_REQUEST_DISABLED);
    expect(requestedUrl()).toContain('{{version}}');
  });

  it('resolves a var that references one declared before it', async () => {
    await runOne('Pre Request Chained.yml', YAML_PRE_REQUEST_CHAINED);
    expect(requestedUrl()).toBe('https://api.example.com/v9/widgets');
  });
});

describe('RequestExecutor — vars:post-response', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('evaluates the expression so a declared assertion can read it', async () => {
    const request = await runOne('Post Response Vars.yml', YAML_POST_RESPONSE);
    expect(request.tests.map(t => [t.description, t.status])).toEqual([
      ['bru.getVar("widgetId") eq 7', 'pass'],
    ]);
  });

  it('does not set the variable when the var is switched off', async () => {
    const request = await runOne(
      'Post Response Disabled.yml',
      YAML_POST_RESPONSE_DISABLED,
    );
    expect(request.tests.map(t => [t.description, t.status])).toEqual([
      ['bru.getVar("widgetId") isUndefined', 'pass'],
    ]);
  });
});

describe('bruVarSetsToYamlVars — the polarity and rename', () => {
  it('returns undefined when there is nothing to carry', () => {
    // So a request without vars produces a byte-identical YamlRequest to before.
    expect(bruVarSetsToYamlVars(undefined)).toBeUndefined();
    expect(bruVarSetsToYamlVars({})).toBeUndefined();
    expect(bruVarSetsToYamlVars({ req: [], res: [] })).toBeUndefined();
  });

  it('inverts enabled to disabled and renames req/res', () => {
    expect(
      bruVarSetsToYamlVars({
        req: [
          { name: 'on', value: '1', enabled: true },
          { name: 'off', value: '2', enabled: false },
        ],
        res: [{ name: 'r', value: 'res.body.id', enabled: true }],
      }),
    ).toEqual({
      preRequest: [
        { name: 'on', value: '1' },
        { name: 'off', value: '2', disabled: true },
      ],
      postResponse: [{ name: 'r', value: 'res.body.id' }],
    });
  });

  it('carries the local flag only when it is set', () => {
    expect(
      bruVarSetsToYamlVars({
        req: [
          { name: 'a', value: '1', enabled: true, local: true },
          { name: 'b', value: '2', enabled: true, local: false },
        ],
      }),
    ).toEqual({
      preRequest: [
        { name: 'a', value: '1', local: true },
        { name: 'b', value: '2' },
      ],
    });
  });

  it('carries only the half that has entries', () => {
    expect(bruVarSetsToYamlVars({ res: [{ name: 'r', value: 'x', enabled: true }] }))
      .toEqual({ postResponse: [{ name: 'r', value: 'x' }] });
  });
});

describe('applyPreRequestVars — precedence and skipping', () => {
  it('returns the same map when there is nothing to apply', () => {
    const vars = new Map([['a', '1']]);
    expect(applyPreRequestVars(vars, undefined)).toBe(vars);
    expect(applyPreRequestVars(vars, {})).toBe(vars);
    expect(applyPreRequestVars(vars, { preRequest: [] })).toBe(vars);
  });

  it('overrides an environment variable of the same name', () => {
    const out = applyPreRequestVars(
      new Map([['host', 'env.example.com']]),
      { preRequest: [{ name: 'host', value: 'request.example.com' }] },
    );
    expect(out.get('host')).toBe('request.example.com');
  });

  it('does not mutate the map it was given', () => {
    const vars = new Map([['host', 'env.example.com']]);
    applyPreRequestVars(vars, { preRequest: [{ name: 'host', value: 'other' }] });
    expect(vars.get('host')).toBe('env.example.com');
  });

  it('skips a disabled entry entirely', () => {
    const out = applyPreRequestVars(new Map(), {
      preRequest: [{ name: 'skipped', value: 'v', disabled: true }],
    });
    expect(out.has('skipped')).toBe(false);
  });

  it('leaves a forward reference literal, since entries resolve in order', () => {
    const out = applyPreRequestVars(new Map(), {
      preRequest: [
        { name: 'early', value: '{{late}}' },
        { name: 'late', value: 'resolved' },
      ],
    });
    expect(out.get('early')).toBe('{{late}}');
    expect(out.get('late')).toBe('resolved');
  });
});

describe('RequestExecutor — vars through a .bru file', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('applies both halves and honours the ~disabled polarity', async () => {
    const request = await runOne('Bru Vars.bru', BRU_BOTH);

    // The pre-request var reached the wire...
    expect(requestedUrl()).toBe('https://api.example.com/v3/widgets/7');
    // ...the post-response var was evaluated, and the ~disabled one was not.
    expect(request.tests.map(t => [t.description, t.status])).toEqual([
      ['bru.getVar("widgetId") eq 7', 'pass'],
      ['bru.getVar("skipped") isUndefined', 'pass'],
    ]);
  });
});
