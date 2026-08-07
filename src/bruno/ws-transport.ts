/**
 * Recording a bounded WebSocket session.
 *
 * A socket has no natural end, so every session here ends on a bound the caller
 * can name: a message count, a wall-clock deadline, a cumulative byte ceiling, or
 * the peer closing. The bound that bit is reported, because "50 messages" and
 * "5 seconds" mean different things to whoever reads the transcript, and a
 * truncated recording that does not say it was truncated is worse than no
 * recording at all.
 *
 * Nothing is held open across tool calls and no handle is returned. A tool call is
 * the unit of work; a socket that outlived it would have nothing responsible for
 * closing it. Every exit path — bound reached, peer closed, error, throw — goes
 * through the same teardown, and the integration test has the server assert it saw
 * the close.
 *
 * `followRedirects` is deliberately left off (it is `ws`'s default). Enabling it
 * would move a credentialed handshake to a host that never passed `validateUrl`,
 * with none of the cross-origin credential stripping the HTTP path performs.
 */
import { validateUrl, ssrfRemediation } from './url-validator.js';
import { gateTls, pinnedLookup } from './transport-trust.js';
import { applyAuth } from './auth-apply.js';
import { substitute } from './env-loader.js';
import { redactUrl, appendQueryCredential } from './request-redaction.js';
import {
  toTranscriptEntry,
  transcriptCapReached,
  toWebsocketDetail,
  type TranscriptOptions,
} from './transport-redaction.js';
import type { RootChain } from './collection-roots.js';
import type { RequestExecutionResult } from './run-results.js';
import type { WebsocketResultDetail, WebsocketTranscriptEntry } from './transport-results.js';
import type { YamlRequest } from './types.js';

const WS_SCHEMES = ['ws', 'wss', 'http', 'https'] as const;
const TLS_SCHEMES = new Set(['wss:', 'https:']);

/** How many inbound frames a session records before stopping. */
const DEFAULT_MAX_MESSAGES = 50;
/** How long a session records before stopping, in milliseconds. */
const DEFAULT_MAX_DURATION_MS = 5000;
/** How long to wait for a close handshake before pulling the socket down. */
const CLOSE_GRACE_MS = 250;

/**
 * engine.io's OPEN and PING frames, and the PONG this may answer with.
 *
 * socket.io rides on a plain WebSocket, so it is reachable without a block of its
 * own — but its server disconnects a client that does not answer PING within
 * `pingTimeout`. Answering is opt-in and only ever after an OPEN frame has
 * actually been seen, so a non-socket.io server that happens to send the single
 * character `2` is never answered with a `3` it did not ask for.
 */
const ENGINE_IO_OPEN = '0';
const ENGINE_IO_PING = '2';
const ENGINE_IO_PONG = '3';

export interface WebsocketRunOptions extends TranscriptOptions {
  /** Inbound frames to record before stopping. Defaults to 50. */
  maxMessages?: number;
  /** Wall-clock ceiling for the whole session, in ms. Defaults to 5000. */
  maxDurationMs?: number;
  /**
   * Answer an engine.io PING with a PONG, so a socket.io session survives past
   * its `pingTimeout`. Off unless asked for: it puts a frame on the wire the
   * request did not author.
   */
  engineIoKeepalive?: boolean;
}

export interface WebsocketExecutionInput {
  request: YamlRequest;
  vars: Map<string, string>;
  rootChain?: RootChain;
  oauth2Token?: string;
  options?: WebsocketRunOptions;
}

function refuse(
  request: YamlRequest,
  url: string,
  error: string,
  warnings: string[],
): RequestExecutionResult {
  return {
    name: request.info.name,
    method: 'WS',
    url: url ? redactUrl(url) : '',
    status: 0,
    duration_ms: 0,
    tests: [],
    ...(warnings.length > 0 ? { warnings } : {}),
    error,
  };
}

/**
 * The frames this session sends, in order.
 *
 * `selected: false` is honoured and only `.yml` websocket variants can express it;
 * a `.bru` message has no such flag, so every message in that dialect is sent.
 * Filtering on `!== false` rather than on `=== true` is what keeps the two
 * dialects sending the same frames from equivalent files.
 */
function framesToSend(request: YamlRequest, subst: (value: string) => string): string[] {
  return (request.websocket?.messages ?? [])
    .filter((message) => message.selected !== false)
    .map((message) => subst(message.content ?? ''));
}

/** The handshake headers: the request's own, plus whatever auth placed. */
function handshakeHeaders(
  request: YamlRequest,
  subst: (value: string) => string,
  authHeaders: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const header of request.websocket?.headers ?? []) {
    if (header.disabled) continue;
    headers[subst(header.name)] = subst(header.value);
  }
  return { ...headers, ...authHeaders };
}

/**
 * Record a bounded WebSocket session.
 *
 * Always resolves. A refusal, a failed handshake and a completed recording are all
 * `RequestExecutionResult`s, because one WebSocket request must not stop the rest
 * of its group.
 */
export async function executeWebsocketRequest(
  input: WebsocketExecutionInput,
): Promise<RequestExecutionResult> {
  const { request, vars, rootChain, oauth2Token, options = {} } = input;
  const block = request.websocket;
  const warnings: string[] = [];
  const subst = (value: string) => substitute(value, vars);

  if (!block) {
    return refuse(request, '', 'Cannot execute a WebSocket request with no websocket block', warnings);
  }

  const target = subst(block.url ?? '').trim();
  if (target.length === 0) {
    return refuse(request, '', 'Cannot execute a WebSocket request with an empty target', warnings);
  }

  const validation = await validateUrl(target, {
    allowedSchemes: WS_SCHEMES,
    defaultScheme: 'ws',
  });
  if (!validation.valid || !validation.normalisedUrl) {
    const remediation = validation.allowlistOverridable ? ` ${ssrfRemediation()}` : '';
    return refuse(request, target, `Blocked: ${validation.reason ?? 'invalid target'}${remediation}`, warnings);
  }

  const authHeaders: Record<string, string> = {};
  const disposition = applyAuth(
    block.auth,
    authHeaders,
    subst,
    warnings,
    [],
    rootChain?.auth,
    oauth2Token,
    'ws',
  );
  if (disposition.outcome === 'refused') {
    return refuse(request, target, disposition.reason, warnings);
  }

  // A `ws://` URL carries a query string exactly as an `http://` one does, which
  // is why the disposition table hands this back rather than refusing it — a
  // token in the query is a common way to authenticate a socket.
  const dialUrl = disposition.outcome === 'query'
    ? appendQueryCredential(validation.normalisedUrl, disposition.key, disposition.value)
    : validation.normalisedUrl;

  const checked = new URL(dialUrl);
  const addresses = validation.addresses ?? [];
  const tls = TLS_SCHEMES.has(checked.protocol)
    ? gateTls(request.settings?.tls, checked.hostname)
    : undefined;

  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;

  const { WebSocket } = await import('ws');

  const transcript: WebsocketTranscriptEntry[] = [];
  const startedAt = Date.now();
  const offset = () => Date.now() - startedAt;
  const record = (direction: 'sent' | 'received', payload: string) => {
    transcript.push(toTranscriptEntry({ direction, offset_ms: offset(), payload }, options));
  };

  const socket = new WebSocket(dialUrl, {
    headers: handshakeHeaders(request, subst, authHeaders),
    handshakeTimeout: maxDurationMs,
    // Both branches are load-bearing. `pinnedLookup([])` fails closed with
    // ENOTFOUND by design, and the allowlisted-hostname path returns no addresses
    // at all — so passing it unconditionally would make every such request fail
    // as if DNS were broken.
    ...(addresses.length > 0 ? { lookup: pinnedLookup(addresses) } : {}),
    ...(tls ?? {}),
  });

  let stopReason: WebsocketResultDetail['stop_reason'] = 'closed';
  let failure: string | undefined;
  let engineIoSeen = false;

  // Read by the message handler, not just by `finish`. A flood arrives as one
  // batch of already-queued events, so a bound that only stopped FUTURE frames
  // still recorded every frame in flight — 200 of them where the cap said 50.
  let stopped = false;

  await new Promise<void>((resolve) => {
    const finish = (reason: WebsocketResultDetail['stop_reason'], error?: string) => {
      if (stopped) return;
      stopped = true;
      stopReason = reason;
      failure = error;
      clearTimeout(deadline);
      // close(), not close(code): `ws` reads a second argument as a close code,
      // and upstream's own client takes exactly one argument here for the same
      // reason. The grace timer is what guarantees teardown if the peer never
      // answers the close handshake.
      try {
        socket.close();
      } catch {
        socket.terminate();
      }
      const grace = setTimeout(() => {
        socket.terminate();
        resolve();
      }, CLOSE_GRACE_MS);
      socket.once('close', () => {
        clearTimeout(grace);
        resolve();
      });
    };

    const deadline = setTimeout(() => finish('timeout'), maxDurationMs);

    socket.on('open', () => {
      for (const frame of framesToSend(request, subst)) {
        socket.send(frame);
        record('sent', frame);
      }
    });

    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      // Frames that were already queued when the bound was reached are dropped
      // rather than recorded: the transcript has to mean "this is what the bound
      // allowed", or the cap is not a cap.
      if (stopped) return;
      const payload = Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Buffer.from(data as ArrayBuffer).toString('utf8');
      record('received', payload);

      if (payload.startsWith(ENGINE_IO_OPEN)) {
        // Only an OPEN frame proves the peer speaks engine.io. Without this a
        // server that happens to send "2" would be answered with a "3" it never
        // asked for.
        engineIoSeen = true;
      } else if (options.engineIoKeepalive && engineIoSeen && payload === ENGINE_IO_PING) {
        socket.send(ENGINE_IO_PONG);
        record('sent', ENGINE_IO_PONG);
      }

      const received = transcript.filter((entry) => entry.direction === 'received').length;
      if (received >= maxMessages) {
        finish('count');
      } else if (transcriptCapReached(transcript, options)) {
        finish('bytes');
      }
    });

    socket.on('error', (error: Error) => finish('error', error.message));
    socket.on('close', () => finish('closed'));
  });

  // Belt and braces on every exit path, including one where the promise above
  // resolved through the grace timer: a socket left open outlives the tool call
  // that made it, and nothing else would ever close it.
  socket.terminate();

  return {
    name: request.info.name,
    method: 'WS',
    url: redactUrl(dialUrl),
    // The refusal sentinel, as for gRPC: the session's own outcome is in
    // `websocket`, and its presence is what says the socket was opened at all.
    status: 0,
    duration_ms: Date.now() - startedAt,
    tests: [],
    ...(warnings.length > 0 ? { warnings } : {}),
    websocket: toWebsocketDetail(transcript, stopReason),
    ...(failure ? { error: `WebSocket session failed: ${failure}` } : {}),
  };
}
