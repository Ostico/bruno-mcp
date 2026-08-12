/**
 * What a data-driven run does on the wire.
 *
 * The claim under test is that an iteration is a group: it gets its own variable
 * store, its own cookie jar and its own OAuth2 token cache, because it *is* a
 * group. The tests here are written against the traffic rather than against the
 * plan, since the plan agreeing with itself would prove none of it.
 *
 * `fetch` is mocked rather than answered by a loopback server: a real socket
 * passes here and fails in CI on undici state another test file owns.
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RequestExecutor } from '../../../src/bruno/request-executor';
import { TestRunner } from '../../../src/bruno/test-runner';

const mockFetch = jest.fn();
(global as unknown as { fetch: unknown }).fetch = mockFetch;

jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockResolvedValue({ valid: true }),
  ssrfRemediation: jest.fn().mockReturnValue(''),
}));

const ok = (body: unknown = { ok: true }): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockResolvedValue(ok());
});

async function collection(layout: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'iteration-run-'));
  for (const [name, content] of Object.entries(layout)) {
    const full = join(root, name);
    await fs.mkdir(join(full, '..'), { recursive: true });
    await fs.writeFile(full, content);
  }
  return root;
}

const BRUNO_JSON = JSON.stringify({ version: '1', name: 'Iterations', type: 'collection' });

/** Every url `fetch` was called with, in call order. */
const urls = (): string[] =>
  mockFetch.mock.calls.map((call) => String((call[0] as { url?: string })?.url ?? call[0]));

describe('iterating a group over rows', () => {
  const GET_USER = `meta {
  name: Get
  type: http
}

get {
  url: https://api.test/users/{{user}}
  body: none
  auth: none
}
`;

  it('runs the request once per row, binding the row', async () => {
    const root = await collection({ 'bruno.json': BRUNO_JSON, 'get.bru': GET_USER });

    const result = await RequestExecutor.executeCollection(root, {
      data: [{ user: 'alice' }, { user: 'bob' }, { user: 'carol' }],
    });

    expect(urls()).toEqual([
      'https://api.test/users/alice',
      'https://api.test/users/bob',
      'https://api.test/users/carol',
    ]);
    expect(result.groups).toHaveLength(3);
    expect(result.groups!.map((g) => g.iterationIndex)).toEqual([0, 1, 2]);
  });

  it('reads the rows from a CSV inside the collection', async () => {
    const root = await collection({
      'bruno.json': BRUNO_JSON,
      'get.bru': GET_USER,
      'data/users.csv': 'user\nalice\nbob\n',
    });

    await RequestExecutor.executeCollection(root, {
      dataFile: 'data/users.csv',
    });

    expect(urls()).toEqual(['https://api.test/users/alice', 'https://api.test/users/bob']);
  });

  it('does not echo the rows back in the result', async () => {
    // A row read from a file is file content, and a column named `password`
    // must not turn up in a transcript because the run reported what it bound.
    const root = await collection({
      'bruno.json': BRUNO_JSON,
      'get.bru': GET_USER,
      'users.csv': 'user,password\nalice,hunter2\n',
    });

    const result = await RequestExecutor.executeCollection(root, {
      dataFile: 'users.csv',
    });

    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(result.groups![0]!.iterationIndex).toBe(0);
  });

  it('resolves a placeholder inside a row against the run variables', async () => {
    // Rows bind as authored variables, which is the tier that recurses. A row
    // holding `{{host}}` therefore behaves exactly as the same value typed into
    // `variables` would, and a caller does not have to know which is which.
    const root = await collection({
      'bruno.json': BRUNO_JSON,
      'get.bru': `meta {
  name: Get
  type: http
}

get {
  url: {{target}}/health
  body: none
  auth: none
}
`,
    });

    await RequestExecutor.executeCollection(root, {
      variables: { host: 'https://api.test' },
      data: [{ target: '{{host}}' }],
    });

    expect(urls()).toEqual(['https://api.test/health']);
  });

  it('keeps a failing row from stopping the rows after it', async () => {
    const root = await collection({ 'bruno.json': BRUNO_JSON, 'get.bru': GET_USER });
    mockFetch
      .mockResolvedValueOnce(ok())
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(ok());

    const result = await RequestExecutor.executeCollection(root, {
      data: [{ user: 'alice' }, { user: 'bob' }, { user: 'carol' }],
    });

    expect(urls()).toHaveLength(3);
    expect(result.groups!.map((g) => g.summary.failed)).toEqual([0, 1, 0]);
  });

  it('gives each iteration its own variable store', async () => {
    // Iteration 0 sets `seen`; iteration 1 must not see it. A store shared
    // across rows is how row 2 ends up sending row 1's captured token.
    const root = await collection({
      'bruno.json': BRUNO_JSON,
      'get.bru': `meta {
  name: Get
  type: http
}

get {
  url: https://api.test/users/{{user}}
  body: none
  auth: none
}

script:post-response {
  bru.setVar("seen", bru.getVar("seen") ? "again" : "first");
}
`,
    });

    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: TestRunner,
      data: [{ user: 'alice' }, { user: 'bob' }],
      captureVariables: ['seen'],
    });

    expect(result.groups!.map((g) => g.capturedVariables?.['seen'])).toEqual(['first', 'first']);
  });

  it('does not let one iteration mutate the request the next one sends', async () => {
    // Every iteration shares one parsed request object, so a pre-request script
    // that writes to `req` must be writing to per-run state. If it were not,
    // iteration 1 would inherit iteration 0's url and the rows would silently
    // stop being independent.
    const root = await collection({
      'bruno.json': BRUNO_JSON,
      'get.bru': `meta {
  name: Get
  type: http
}

get {
  url: https://api.test/users/{{user}}
  body: none
  auth: none
}

script:pre-request {
  req.setHeader("x-row", bru.getVar("user"));
  req.setUrl("https://api.test/rewritten/" + bru.getVar("user"));
}
`,
    });

    await RequestExecutor.executeCollection(root, {
      scriptRunner: TestRunner,
      data: [{ user: 'alice' }, { user: 'bob' }],
    });

    expect(urls()).toEqual([
      'https://api.test/rewritten/alice',
      'https://api.test/rewritten/bob',
    ]);
    const rowHeaders = mockFetch.mock.calls.map(
      (call) => (call[1] as { headers?: Record<string, string> })?.headers?.['x-row'],
    );
    expect(rowHeaders).toEqual(['alice', 'bob']);
  });
});

describe('iterating over identities', () => {
  it('fetches a separate token for two rows differing only in password', async () => {
    // The defect this design exists to prevent. When the token cache was per run
    // and its key omitted the password, row 2 reused row 1's token: it never
    // contacted the provider, and passed its assertions on a credential it had
    // never sent — in the rotation case, one that had just been revoked.
    const root = await collection({
      'bruno.json': BRUNO_JSON,
      'get.bru': `meta {
  name: Get
  type: http
}

get {
  url: https://api.test/me
  body: none
  auth: oauth2
}

auth:oauth2 {
  grant_type: password
  access_token_url: https://auth.test/token
  client_id: cli
  username: mufasa
  password: {{secret}}
}
`,
    });
    mockFetch.mockImplementation(async (input: unknown) => {
      const url = String((input as { url?: string })?.url ?? input);
      return url.includes('auth.test') ? ok({ access_token: 'granted' }) : ok();
    });

    await RequestExecutor.executeCollection(root, {
      data: [{ secret: 'first' }, { secret: 'second' }],
    });

    const tokenBodies = mockFetch.mock.calls
      .filter(([input]) => String((input as { url?: string })?.url ?? input).includes('auth.test'))
      .map(([, init]) => String((init as { body?: unknown })?.body ?? ''));

    expect(tokenBodies).toHaveLength(2);
    expect(tokenBodies[0]).toContain('password=first');
    expect(tokenBodies[1]).toContain('password=second');
  });
});
