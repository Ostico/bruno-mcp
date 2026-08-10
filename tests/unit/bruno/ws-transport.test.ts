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

const dials: Array<{
  url: string;
  /** The constructor's second argument, which is where a subprotocol is requested. */
  protocols: string[];
  options: Record<string, unknown>;
}> = [];

/** Headers the next handshake answers with, or none for a socket that never upgrades. */
let upgradeResponse: Record<string, string | string[] | undefined> | undefined;

/**
 * What the next socket does after opening, for the tests that are about the
 * session rather than the handshake. Left unset, the socket closes immediately.
 */
let drive: ((socket: FakeSocket) => void) | undefined;

class FakeSocket extends EventEmitter {
  constructor(url: string, protocols: string[], options: Record<string, unknown>) {
    super();
    dials.push({ url, protocols, options });
    // Open, then close immediately: these tests are about the handshake, and a
    // session that never ends would just be the integration test again.
    setImmediate(() => {
      // Real order: `ws` emits upgrade on the 101, before open.
      if (upgradeResponse) this.emit('upgrade', { headers: upgradeResponse });
      this.emit('open');
      if (drive) {
        drive(this);
        return;
      }
      setImmediate(() => this.emit('close'));
    });
  }
  send() {}
  // Answers the close handshake, as a real peer does. Without this every bound
  // that ends a session waited out the grace timer before the call returned.
  close() { setImmediate(() => this.emit('close')); }
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

beforeEach(() => { dials.length = 0; upgradeResponse = undefined; drive = undefined; });

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
  options: Record<string, unknown> = {},
) => (await executeWebsocketRequest({
  request: request(overrides),
  vars,
  options: { maxDurationMs: 500, ...options },
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

  it('reports the handshake response headers, in the field an HTTP result uses', async () => {
    upgradeResponse = {
      'sec-websocket-protocol': 'chat',
      'set-cookie': ['session=s3cret; HttpOnly; Secure'],
    };

    const result = await call();

    // A WebSocket has no per-message headers, so the 101 is the only place a
    // session cookie or an agreed subprotocol is visible at all.
    expect(result.response_headers).toEqual({
      'sec-websocket-protocol': 'chat',
      'set-cookie': ['session=[redacted]; HttpOnly; Secure'],
    });
  });

  it('omits the field when no handshake completed', async () => {
    const result = await call();
    expect(result.response_headers).toBeUndefined();
  });
});

describe('what a transcript entry says about its frame', () => {
  it('carries the title the file gave each message it sent', async () => {
    const result = await call(
      {
        messages: [
          { name: 'greeting', content: 'hello', selected: true },
          { content: 'anonymous', selected: true },
        ],
      },
      new Map(),
      { includePayloads: true },
    );

    const sent = result.websocket!.transcript.filter((entry) => entry.direction === 'sent');
    expect(sent.map((entry) => entry.type)).toEqual(['text', 'text']);
    expect(sent[0].title).toBe('greeting');
    // An index is not a name, so an untitled message carries no title at all
    // rather than a fabricated one.
    expect('title' in sent[1]).toBe(false);
  });

  it('records a binary frame as base64, and its true size rather than a decoded one', async () => {
    drive = (socket) => {
      socket.emit('message', Buffer.from([0x00, 0xff, 0x10]), true);
      socket.emit('close');
    };

    const result = await call(undefined, new Map(), { includePayloads: true });

    // Decoded as UTF-8 those three bytes become two characters and five bytes,
    // which is both unreadable and a size that never went over the wire.
    expect(result.websocket!.transcript[0]).toMatchObject({
      type: 'binary',
      bytes: 3,
      payload: 'AP8Q',
    });
  });

  it('records control frames without spending the inbound message budget', async () => {
    drive = (socket) => {
      socket.emit('ping', Buffer.alloc(0));
      socket.emit('pong', Buffer.alloc(0));
      socket.emit('message', Buffer.from('the first answer'));
      socket.emit('message', Buffer.from('the second answer'));
    };

    const result = await call(undefined, new Map(), { maxMessages: 2 });

    // Counted as messages, the two keepalives would have spent the budget of two
    // and ended the session on the first real answer.
    expect(result.websocket!.transcript.map((entry) => entry.type)).toEqual([
      'ping',
      'pong',
      'text',
      'text',
    ]);
    expect(result.websocket!.stop_reason).toBe('count');
  });

  it('reads a frame that arrived as an ArrayBuffer rather than a Buffer', async () => {
    drive = (socket) => {
      socket.emit('message', new Uint8Array([0x68, 0x69]).buffer);
      socket.emit('close');
    };

    const result = await call(undefined, new Map(), { includePayloads: true });

    expect(result.websocket!.transcript[0]).toMatchObject({ payload: 'hi', bytes: 2 });
  });

  it('drops control frames that arrive after a bound has already stopped it', async () => {
    drive = (socket) => {
      socket.emit('message', Buffer.from('the answer'));
      socket.emit('ping', Buffer.alloc(0));
      socket.emit('pong', Buffer.alloc(0));
    };

    const result = await call(undefined, new Map(), { maxMessages: 1 });

    // Same rule as a data frame: the transcript has to mean "this is what the
    // bound allowed", and a keepalive recorded past the bound is not that.
    expect(result.websocket!.transcript.map((entry) => entry.type)).toEqual(['text']);
  });

  it('reports the close code and the reason the peer gave with it', async () => {
    drive = (socket) => socket.emit('close', 1008, Buffer.from('policy'));

    const result = await call(undefined, new Map(), { includePayloads: true });

    expect(result.websocket!.transcript.at(-1)).toMatchObject({
      direction: 'received',
      type: 'close',
      close_code: 1008,
      bytes: 6,
      payload: 'policy',
    });
    expect(result.websocket!.stop_reason).toBe('closed');
  });

  it('invents no code for a close that carried none', async () => {
    const result = await call();

    const last = result.websocket!.transcript.at(-1)!;
    expect(last.type).toBe('close');
    expect('close_code' in last).toBe(false);
    expect(last.bytes).toBe(0);
  });

  it('gives a post-response script the same kinds, with the payloads it must assert on', async () => {
    drive = (socket) => socket.emit('close', 1011, Buffer.from('boom'));

    const outcome = await executeWebsocketRequest({
      request: request({ messages: [{ name: 'greeting', content: 'hello', selected: true }] }),
      vars: new Map(),
      options: { maxDurationMs: 500 },
    });

    const frames = outcome.response?.body as Array<Record<string, unknown>>;
    expect(frames[0]).toMatchObject({ type: 'text', title: 'greeting', payload: 'hello' });
    expect(frames[1]).toMatchObject({ type: 'close', close_code: 1011, payload: 'boom' });
  });
});

describe('a session the socket itself fails', () => {
  it('names the failure in the result and stops on it', async () => {
    drive = (socket) => socket.emit('error', new Error('econnreset'));

    const result = await call();

    expect(result.websocket?.stop_reason).toBe('error');
    expect(result.error).toContain('econnreset');
    // A failure is not a bound cutting a recording short, so it says nothing
    // about truncation.
    expect(result.websocket?.truncated).toBe(false);
  });
});

describe('the idle bound', () => {
  it('ends a session that has gone quiet, without calling it truncated', async () => {
    drive = (socket) => socket.emit('message', Buffer.from('one'));

    const result = await call(undefined, new Map(), { maxDurationMs: 5000, idleTimeoutMs: 60 });

    expect(result.websocket?.stop_reason).toBe('idle');
    // No cap bit: the wall-clock budget was not spent, and flagging that as
    // truncated would put the warning on nearly every healthy session.
    expect(result.websocket?.truncated).toBe(false);
    expect(result.duration_ms).toBeLessThan(2000);
  });

  it('restarts on every frame, so a chatty session runs to its own end', async () => {
    drive = (socket) => {
      let sent = 0;
      const tick = setInterval(() => {
        sent += 1;
        socket.emit('message', Buffer.from(`frame ${sent}`));
        if (sent === 4) clearInterval(tick);
      }, 20);
    };

    const result = await call(undefined, new Map(), { maxDurationMs: 5000, idleTimeoutMs: 200 });

    expect(result.websocket!.transcript.filter((e) => e.type === 'text')).toHaveLength(4);
    expect(result.websocket?.stop_reason).toBe('idle');
  });

  it('is not armed before the first frame, so a listening session keeps its budget', async () => {
    drive = () => {};

    const result = await call({ messages: [] }, new Map(), {
      maxDurationMs: 300,
      idleTimeoutMs: 40,
    });

    // A request that authors nothing and waits for the peer to volunteer something
    // is silent by design; ending it after 40 ms would report an empty session as
    // if the peer had been asked.
    expect(result.websocket?.stop_reason).toBe('timeout');
    expect(result.duration_ms).toBeGreaterThanOrEqual(250);
  });

  it('waits for the wall-clock ceiling when switched off', async () => {
    drive = (socket) => socket.emit('message', Buffer.from('one'));

    const result = await call(undefined, new Map(), { maxDurationMs: 200, idleTimeoutMs: 0 });

    expect(result.websocket?.stop_reason).toBe('timeout');
  });
});

describe('the subprotocol a header asks for', () => {
  // `ws` validates the server's answer against the list it was given at the
  // CONSTRUCTOR, not against the headers. A request that wrote only the header, to a
  // server that echoed it, had its handshake aborted with "Server sent a subprotocol
  // but none was requested" — so these assertions are about the second argument.
  it('requests what the header names', async () => {
    await call({ headers: [{ name: 'Sec-WebSocket-Protocol', value: 'chat' }] });
    expect(dials[0].protocols).toEqual(['chat']);
  });

  it('splits a list and trims it', async () => {
    await call({ headers: [{ name: 'Sec-WebSocket-Protocol', value: 'chat, superchat' }] });
    expect(dials[0].protocols).toEqual(['chat', 'superchat']);
  });

  it('reads the header in any case it was written in', async () => {
    // Header names are case-insensitive on the wire, and the failure for a spelling
    // that goes unread is an aborted handshake rather than a header that does nothing.
    await call({ headers: [{ name: 'sec-websocket-protocol', value: 'chat' }] });
    expect(dials[0].protocols).toEqual(['chat']);
  });

  it('still sends the header, so the wire says what was requested', async () => {
    await call({ headers: [{ name: 'Sec-WebSocket-Protocol', value: 'chat' }] });
    expect(dials[0].options.headers).toEqual({ 'Sec-WebSocket-Protocol': 'chat' });
  });

  it('requests none when the request authored none', async () => {
    await call();
    expect(dials[0].protocols).toEqual([]);
  });

  it('honours an authored protocol version, as a number', async () => {
    // The library writes the Sec-WebSocket-Version header itself from this option, so
    // an authored header alone was overwritten and ignored.
    const result = await call({ headers: [{ name: 'Sec-WebSocket-Version', value: '8' }] });
    expect(dials[0].options.protocolVersion).toBe(8);
    expect(result.warnings ?? []).not.toContainEqual(
      expect.stringContaining('Sec-WebSocket-Version'),
    );
  });

  it('omits the version when the request authored none', async () => {
    await call();
    expect(dials[0].options.protocolVersion).toBeUndefined();
  });

  it('reports a version that is not a number instead of passing it on', async () => {
    const result = await call({
      headers: [{ name: 'Sec-WebSocket-Version', value: 'thirteen' }],
    });
    expect(dials[0].options.protocolVersion).toBeUndefined();
    expect(result.warnings).toContainEqual(
      expect.stringContaining('Sec-WebSocket-Version carries "thirteen"'),
    );
  });
});

describe('pacing the messages a session sends', () => {
  const three = [
    { name: 'first', content: 'a' },
    { name: 'second', content: 'b' },
    { name: 'third', content: 'c' },
  ];
  const sentOffsets = (result: Awaited<ReturnType<typeof call>>) =>
    result.websocket!.transcript.filter((e) => e.direction === 'sent').map((e) => e.offset_ms);

  it('sends everything in one tick by default', async () => {
    const result = await call({ messages: three });

    const offsets = sentOffsets(result);
    expect(offsets).toHaveLength(3);
    // The behaviour every session had before the option existed, kept as the default:
    // three sends at the same millisecond.
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThan(20);
  });

  it('leaves the asked-for gap between sends', async () => {
    drive = (socket) => { setTimeout(() => socket.emit('close'), 400); };

    const result = await call({ messages: three }, new Map(), {
      maxDurationMs: 2000,
      sendIntervalMs: 60,
    });

    const offsets = sentOffsets(result);
    expect(offsets).toHaveLength(3);
    // Two gaps of 60 ms before the third message, which is what makes a
    // send-wait-send exchange drivable at all.
    expect(offsets[2]).toBeGreaterThanOrEqual(110);
  });

  it('waits after the last message for nothing', async () => {
    drive = () => {};

    const result = await call({ messages: [{ name: 'only', content: 'a' }] }, new Map(), {
      maxDurationMs: 2000,
      sendIntervalMs: 400,
      idleTimeoutMs: 50,
    });

    // A trailing pause would spend the interval on nothing, and with one message the
    // whole option would be a delay before the session could end.
    expect(result.websocket?.stop_reason).toBe('idle');
    expect(result.duration_ms).toBeLessThan(300);
  });

  it('names the messages a bound stopped it from sending', async () => {
    drive = () => {};

    const result = await call({ messages: three }, new Map(), {
      maxDurationMs: 250,
      sendIntervalMs: 200,
    });

    expect(result.websocket?.stop_reason).toBe('timeout');
    expect(sentOffsets(result)).toHaveLength(2);
    // Named, not counted: a request/response protocol driven half way through looks
    // exactly like a peer that stopped answering.
    expect(result.warnings).toContainEqual(expect.stringContaining('1 of 3 messages unsent'));
    expect(result.warnings).toContainEqual(expect.stringContaining('"third"'));
  });

  it('does not let the idle bound end a sequence that is still going out', async () => {
    drive = () => {};

    const result = await call({ messages: three }, new Map(), {
      maxDurationMs: 2000,
      sendIntervalMs: 60,
      // Shorter than the gap this session is deliberately leaving between its own
      // messages. Armed per send, the first one would end the session 20 ms in with
      // two messages unsent — the gap this session leaves is not the peer's silence.
      idleTimeoutMs: 20,
    });

    expect(sentOffsets(result)).toHaveLength(3);
    expect(result.duration_ms).toBeGreaterThanOrEqual(110);
    expect(result.warnings).toBeUndefined();
  });

  it('arms the idle bound from the last send', async () => {
    drive = () => {};

    const result = await call({ messages: three }, new Map(), {
      maxDurationMs: 3000,
      sendIntervalMs: 40,
      idleTimeoutMs: 60,
    });

    expect(sentOffsets(result)).toHaveLength(3);
    expect(result.websocket?.stop_reason).toBe('idle');
    // Two gaps of 40 ms, then 60 ms of silence — not the whole 3000 ms ceiling.
    expect(result.duration_ms).toBeLessThan(1000);
  });
});
