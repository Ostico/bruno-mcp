/**
 * A value a script captured can be read by the caller that asked for the run.
 *
 * `bru.setVar` writes into a store `executeCollection` creates and throws away,
 * so a token a login captured used to be reachable only as `{{token}}` inside
 * the same run. Getting it out meant adding a request that echoed it back, or
 * interpolating it into a test name — which is how it was reported: a
 * credential in a test title.
 *
 * These run the executor rather than the reducer (`captured-variables.test.ts`
 * covers that), because the part that can silently stop working is the wiring:
 * a store that is created per group, mutated by the sandbox, and read after
 * the results are merged.
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

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ token: 'tok-from-response', id: 42 }),
  });
});

/** A request whose after-response script parks values from the body. */
const capturing = (name: string, script: string): string => `info:
  name: ${name}
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/${name}"
runtime:
  scripts:
    - type: after-response
      code: |
        ${script}
`;

const plain = (name: string): string => `info:
  name: ${name}
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/${name}"
`;

async function collection(layout: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'captured-vars-'));
  for (const [relativePath, content] of Object.entries(layout)) {
    const full = join(root, relativePath);
    await fs.mkdir(join(full, '..'), { recursive: true });
    await fs.writeFile(full, content);
  }
  return root;
}

describe('reading back what a run captured', () => {
  it('lists the names a script set without being asked', async () => {
    const root = await collection({
      'login.yml': capturing('login', 'bru.setVar("token", res.body.token);'),
    });

    const result = await RequestExecutor.executeCollection(root, { scriptRunner: TestRunner });

    expect(result.groups[0]!.capturedVariableNames).toEqual(['token']);
    // Not asked for, so not returned — the whole point of the opt-in.
    expect(result.groups[0]!.capturedVariables).toBeUndefined();
  });

  it('returns the value of a name the caller asked for', async () => {
    const root = await collection({
      'login.yml': capturing('login', 'bru.setVar("token", res.body.token);'),
    });

    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: TestRunner,
      captureVariables: ['token'],
    });

    expect(result.groups[0]!.capturedVariables).toEqual({ token: 'tok-from-response' });
  });

  it('returns only the names asked for, not everything the run captured', async () => {
    const root = await collection({
      'login.yml': capturing(
        'login',
        'bru.setVar("token", res.body.token); bru.setVar("id", res.body.id);',
      ),
    });

    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: TestRunner,
      captureVariables: ['id'],
    });

    expect(result.groups[0]!.capturedVariableNames).toEqual(['id', 'token']);
    expect(result.groups[0]!.capturedVariables).toEqual({ id: '42' });
  });

  it('omits both fields entirely when no script set anything', async () => {
    const root = await collection({ 'get.yml': plain('get') });

    const result = await RequestExecutor.executeCollection(root, { scriptRunner: TestRunner });

    expect(result.groups[0]!.capturedVariableNames).toBeUndefined();
    expect(result.groups[0]!.capturedVariables).toBeUndefined();
  });

  it('warns on the run when a requested name was never set', async () => {
    const root = await collection({
      'login.yml': capturing('login', 'bru.setVar("token", res.body.token);'),
    });

    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: TestRunner,
      captureVariables: ['refresh_token'],
    });

    expect(result.groups[0]!.capturedVariables).toBeUndefined();
    // On the run, not the group: a group's store is isolated by design, so
    // whether a name was set anywhere is a question only the run can answer.
    expect(result.warnings?.join(' ')).toContain('refresh_token');
    expect(result.groups[0]!).not.toHaveProperty('warnings');
  });

  it('says nothing when each group captured what the other one did not', async () => {
    // The misreport this replaced: with two groups the run emitted two
    // warnings, each naming the variable the other group had just set.
    const root = await collection({
      'login.yml': capturing('login', 'bru.setVar("token", res.body.token);'),
      'order.yml': capturing('order', 'bru.setVar("orderId", res.body.id);'),
    });

    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: TestRunner,
      captureVariables: ['token', 'orderId'],
      groups: [
        { name: 'auth', requests: ['login.yml'] },
        { name: 'orders', requests: ['order.yml'] },
      ],
    });

    expect(result.groups[0]!.capturedVariables).toEqual({ token: 'tok-from-response' });
    expect(result.groups[1]!.capturedVariables).toEqual({ orderId: '42' });
    expect(result.warnings ?? []).toEqual([]);
  });

  it('names a vars:preRequest variable as scoped rather than as never set', async () => {
    // It IS set, and the old warning said no script had set it and that
    // supplied variables are not captured — neither of which is this case. A
    // pre-request vars block is applied for interpolation and scoped to its own
    // request, so it never reaches the store the values come from.
    const root = await collection({
      'seed.yml': `info:
  name: seed
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/seed"
runtime:
  variables:
    - name: host
      value: example.com
`,
    });

    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: TestRunner,
      captureVariables: ['host'],
    });

    const warnings = (result.warnings ?? []).join(' ');
    expect(warnings).toContain('host');
    expect(warnings).toContain('vars:preRequest');
    expect(warnings).not.toContain('no script set');
  });

  it('does not credit a disabled vars:preRequest entry with setting anything', async () => {
    // A disabled entry is not applied, so the name really is set nowhere and
    // the explanation that fits it is the other one.
    const root = await collection({
      'seed.yml': `info:
  name: seed
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/seed"
runtime:
  variables:
    - name: host
      value: example.com
      disabled: true
`,
    });

    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: TestRunner,
      captureVariables: ['host'],
    });

    const warnings = (result.warnings ?? []).join(' ');
    expect(warnings).toContain('no script set');
    expect(warnings).not.toContain('vars:preRequest');
  });

  it('does not capture the variables the caller supplied for the run', async () => {
    // Only what a script set. An injected value is already the caller's, and
    // echoing it back would make the names list a mirror of the request.
    const root = await collection({ 'get.yml': plain('get') });

    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: TestRunner,
      variables: { api_key: 'supplied-secret' },
      captureVariables: ['api_key'],
    });

    expect(result.groups[0]!.capturedVariables).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('supplied-secret');
  });

  it('collects from every request of a parallel group, not just the last', async () => {
    // With no groups given the whole collection is one group, so both scripts
    // write into the one store however the directories are laid out. Reporting
    // a subset would look exactly like a script that never ran.
    const root = await collection({
      'auth/login.yml': capturing('login', 'bru.setVar("authToken", res.body.token);'),
      'orders/create.yml': capturing('create', 'bru.setVar("orderId", res.body.id);'),
    });

    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: TestRunner,
      parallel: true,
      captureVariables: ['authToken', 'orderId'],
    });

    expect(result.summary.total).toBe(2);
    expect(result.groups[0]!.capturedVariables).toEqual({ authToken: 'tok-from-response', orderId: '42' });
  });

  it('reports the same captured values serially and in parallel', async () => {
    const layout = {
      'auth/login.yml': capturing('login', 'bru.setVar("authToken", res.body.token);'),
      'orders/create.yml': capturing('create', 'bru.setVar("orderId", res.body.id);'),
    };

    const run = async (parallel: boolean): Promise<unknown> => {
      const root = await collection(layout);
      const result = await RequestExecutor.executeCollection(root, {
        scriptRunner: TestRunner,
        parallel,
        captureVariables: ['authToken', 'orderId'],
      });
      return result.groups[0]!.capturedVariables;
    };

    expect(await run(true)).toEqual(await run(false));
  });

  it('keeps a value a pre-request script set, not only an after-response one', async () => {
    const root = await collection({
      'seed.yml': `info:
  name: seed
  type: http
  seq: 1
http:
  method: GET
  url: "https://api.example.com/seed"
runtime:
  scripts:
    - type: before-request
      code: |
        bru.setVar("nonce", "n-1");
`,
    });

    const result = await RequestExecutor.executeCollection(root, {
      scriptRunner: TestRunner,
      captureVariables: ['nonce'],
    });

    expect(result.groups[0]!.capturedVariables).toEqual({ nonce: 'n-1' });
  });
});
