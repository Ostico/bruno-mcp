/**
 * What the WebSocket transport hands to `ws`, and what it refuses before it opens
 * anything.
 *
 * The integration test proves the session behaviour against a real server. These
 * assertions pin the handshake itself — the URL actually dialled, the headers, the
 * pinned lookup, the absence of redirect following — which a server-side test
 * cannot see.
 */
import { EventEmitter } from 'node:events';
import { executeWebsocketRequest } from '../../../src/bruno/ws-transport.js';
import { resetAllowlistCache } from '../../../src/bruno/url-validator.js';
import type { YamlRequest } from '../../../src/bruno/types.js';

const dials: Array<{ url: string; options: Record<string, unknown> }> = [];

class FakeSocket extends EventEmitter {
  constructor(url: string, options: Record<string, unknown>) {
    super();
    dials.push({ url, options });
    // Open, then close immediately: these tests are about the handshake, and a
    // session that never ends would just be the integration test again.
    setImmediate(() => {
      this.emit('open');
      setImmediate(() => this.emit('close'));
    });
  }
  send() {}
  close() {}
  terminate() {}
}

jest.mock('ws', () => ({ WebSocket: FakeSocket }));

let savedAllowlist: string | undefined;

beforeAll(() => {
  savedAllowlist = process.env.BRUNO_SSRF_ALLOWLIST;
  process.env.BRUNO_SSRF_ALLOWLIST = '127.0.0.1,vouched.test';
  resetAllowlistCache();
});

afterAll(() => {
  if (savedAllowlist === undefined) delete process.env.BRUNO_SSRF_ALLOWLIST;
  else process.env.BRUNO_SSRF_ALLOWLIST = savedAllowlist;
  resetAllowlistCache();
});

beforeEach(() => { dials.length = 0; });

function request(overrides: Partial<NonNullable<YamlRequest['websocket']>> = {}): YamlRequest {
  return {
    info: { name: 'Socket', type: 'ws' },
    websocket: { url: 'ws://127.0.0.1:8080', ...overrides },
  };
}

// The transport returns the result alongside what a post-response script may
// examine, and these tests are about the result. The script-facing half is
// asserted in transport-verification.test.ts, where its unredacted payloads are
// the point rather than an incidental extra field.
const call = async (
  overrides?: Partial<NonNullable<YamlRequest['websocket']>>,
  vars: Map<string, string> = new Map(),
) => (await executeWebsocketRequest({
  request: request(overrides),
  vars,
  options: { maxDurationMs: 500 },
})).result;

describe('the handshake', () => {
  it('dials the validated target', async () => {
    await call();
    expect(dials[0].url).toBe('ws://127.0.0.1:8080/');
  });

  it('sends the request’s headers, minus the ones switched off', async () => {
    await call({
      headers: [
        { name: 'x-on', value: 'yes' },
        { name: 'x-off', value: 'no', disabled: true },
      ],
    });
    expect(dials[0].options.headers).toEqual({ 'x-on': 'yes' });
  });

  it('never enables redirect following', async () => {
    await call();
    // Enabling it would move a credentialed handshake to a host that never passed
    // validateUrl, with none of the cross-origin credential stripping the HTTP
    // path performs.
    expect(dials[0].options.followRedirects).toBeUndefined();
  });

  it('pins the validated address when validation produced one', async () => {
    await call();
    expect(dials[0].options.lookup).toBeDefined();
  });

  // `pinnedLookup([])` fails closed with ENOTFOUND by design, so the branch has to
  // be explicit: an allowlisted hostname is never resolved and pins nothing.
  it('omits the lookup entirely on the hostname path', async () => {
    await call({ url: 'ws://vouched.test:8080' });
    expect(dials[0].options.lookup).toBeUndefined();
  });

  it('substitutes variables into the target', async () => {
    await executeWebsocketRequest({
      request: request({ url: 'ws://{{host}}:8080' }),
      vars: new Map([['host', '127.0.0.1']]),
      options: { maxDurationMs: 500 },
    });
    expect(dials[0].url).toBe('ws://127.0.0.1:8080/');
  });
});

describe('auth on the handshake', () => {
  it('places a bearer token as a header', async () => {
    await call({ auth: { type: 'bearer', token: 'tok' } });
    expect((dials[0].options.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  // Unlike gRPC: a ws:// URL has a query string, and a token in it is a common way
  // to authenticate a socket. Refusing this would have been a refusal with a false
  // reason.
  it('appends a query-placed api-key to the target rather than refusing it', async () => {
    await call({ auth: { type: 'api-key', key: 'token', value: 'abc', in: 'query' } });
    expect(dials[0].url).toContain('token=abc');
  });

  it('refuses digest rather than opening a bare socket', async () => {
    const result = await call({ auth: { type: 'digest', username: 'u', password: 'p' } });
    expect(result.error).toMatch(/digest/);
    expect(dials).toHaveLength(0);
  });
});

describe('what is refused before anything is dialled', () => {
  it('refuses an empty target', async () => {
    const result = await call({ url: '' });
    expect(result.error).toMatch(/empty target/);
    expect(dials).toHaveLength(0);
  });

  it('refuses an SSRF-blocked target', async () => {
    const result = await call({ url: 'ws://169.254.169.254:8080' });
    expect(result.error).toMatch(/^Blocked:/);
    expect(dials).toHaveLength(0);
  });

  it('refuses a request with no websocket block', async () => {
    const outcome = await executeWebsocketRequest({
      request: { info: { name: 'Socket', type: 'ws' } },
      vars: new Map(),
    });
    expect(outcome.result.error).toMatch(/no websocket block/);
    // A request that never happened has nothing for assertions to examine, so it
    // carries no response — which is what stops the author's checks being
    // evaluated against a session that does not exist and reporting the same
    // single failure twice.
    expect(outcome.response).toBeUndefined();
    const result = outcome.result;
    expect(dials).toHaveLength(0);
  });
});

describe('the result shape', () => {
  it('keeps status at the refusal sentinel and puts the session in its own field', async () => {
    const result = await call();
    expect(result.status).toBe(0);
    expect(result.method).toBe('WS');
    expect(result.websocket?.stop_reason).toBe('closed');
    expect(result.websocket?.truncated).toBe(false);
  });
});
