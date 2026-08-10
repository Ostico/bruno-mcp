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
  transcriptBytes,
  transcriptCapReached,
  toWebsocketDetail,
  type TranscriptOptions,
} from './transport-redaction.js';
import { websocketResponse, type TransportOutcome } from './transport-verification.js';
import type { RootChain } from './collection-roots.js';
import type { WebsocketResultDetail, WebsocketTranscriptEntry } from './transport-results.js';
import type { IncomingMessage } from 'node:http';

import { collectIncomingHeaders, type ResponseHeaders } from './response-headers.js';
import type { YamlRequest } from './types.js';

const WS_SCHEMES = ['ws', 'wss', 'http', 'https'] as const;
const TLS_SCHEMES = new Set(['wss:', 'https:']);

/**
 * How many inbound frames a session records before stopping.
 *
 * Exported, like the byte ceilings in transport-redaction, so the tool schema's
 * documented default can be asserted equal to the one the transport actually
 * applies. A schema that says 50 while the transport uses something else is a lie
 * an agent has no way to detect.
 */
export const DEFAULT_MAX_MESSAGES = 50;
/** How long a session records before stopping, in milliseconds. */
export const DEFAULT_MAX_DURATION_MS = 5000;
/** How long to wait for a close handshake before pulling the socket down. */
const CLOSE_GRACE_MS = 250;

/**
 * Memory ceiling on the session a post-response script can examine.
 *
 * Not a display cap, and deliberately much larger than one: this exists so a
 * runaway socket cannot exhaust the process, which is the job `MAX_RESPONSE_BYTES`
 * does on the HTTP path. A caller's `maxTranscriptBytes` bounds what is *reported*
 * and must not silently bound what is *checked* — otherwise an assertion would
 * start passing because the frame that would have failed it was trimmed for
 * display, which is the worst way for a check to go green.
 */
const MAX_SCRIPT_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

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

/**
 * A request that never reached a socket.
 *
 * Returns the outcome wrapper with no `response`, which is what stops assertions
 * running against a session that did not happen: a refusal already carries its own
 * `error`, and evaluating checks about a request that was never sent would report
 * the same single failure twice, the second time in the vocabulary of the author's
 * assertions rather than of the refusal.
 */
function refuse(
  request: YamlRequest,
  url: string,
  error: string,
  warnings: string[],
): TransportOutcome {
  return {
    result: {
      name: request.info.name,
      method: 'WS',
      url: url ? redactUrl(url) : '',
      status: 0,
      duration_ms: 0,
      tests: [],
      ...(warnings.length > 0 ? { warnings } : {}),
      error,
    },
  };
}

/**
 * The frame types a WebSocket message can declare and have honoured.
 *
 * Upstream constrains the field to these three in its editor
 * (`bruno-app/src/components/RequestPane/WsBody/BodyMode`) but validates nothing
 * on disk, and every one of them ends up as a text frame: `normalizeMessageByFormat`
 * in `bruno-requests/src/ws/ws-client.js` returns a string on every path, and
 * nothing anywhere decodes base64 or reads a file. So a declared type changes how
 * a payload is *serialised*, never what kind of frame carries it.
 */
const HONOURED_MESSAGE_TYPES = new Set(['text', 'json', 'xml']);

/** What a session will put on the wire, and what it would not. */
interface PlannedFrames {
  payloads: string[];
  warnings: string[];
}

/**
 * The frames this session sends, in order, and the reasons some were not sent.
 *
 * `selected: false` is honoured and only `.yml` websocket variants can express it;
 * a `.bru` message has no such flag, so every message in that dialect is sent.
 * Filtering on `!== false` rather than on `=== true` is what keeps the two
 * dialects sending the same frames from equivalent files.
 *
 * Two things are refused here rather than sent badly. A type this transport cannot
 * honour is reported instead of being quietly downgraded to a text frame, because
 * a caller testing a binary protocol would otherwise get a green run having sent
 * the characters `AQIDBA==` where four bytes were meant. And a message carrying no
 * payload is dropped: an empty frame is a protocol event in its own right, and
 * inventing one from a message that authored none is worse than sending nothing.
 * Upstream's per-message send guards the same way — `if (message && message.content)`
 * in `bruno-electron/src/ipc/network/ws-event-handlers.js` — though its
 * queue-everything-on-connect path does not, so this follows the deliberate one.
 */
function framesToSend(request: YamlRequest, subst: (value: string) => string): PlannedFrames {
  const payloads: string[] = [];
  const warnings: string[] = [];

  (request.websocket?.messages ?? []).forEach((message, index) => {
    if (message.selected === false) return;

    const label = message.name && message.name.length > 0
      ? `"${message.name}"`
      : `at index ${index}`;

    const declared = message.type ?? 'text';
    if (!HONOURED_MESSAGE_TYPES.has(declared)) {
      const binaryNote = declared === 'binary' || declared === 'base64'
        ? ' Bruno has no binary WebSocket path at all — nothing decodes base64 or reads a file '
          + 'before sending — so this is a gap in the format rather than a setting to correct.'
        : '';
      warnings.push(
        `Message ${label} declares type "${declared}", which is not one of ${
          [...HONOURED_MESSAGE_TYPES].join(', ')
        }. Its payload was sent as a text frame carrying those literal characters.${binaryNote}`,
      );
    }

    const payload = subst(message.content ?? '');
    if (payload.length === 0) {
      warnings.push(
        `Message ${label} carries no payload, so nothing was sent for it. An empty frame is a `
          + 'protocol event in its own right and is not fabricated from a message that authored '
          + 'none.',
      );
      return;
    }

    payloads.push(payload);
  });

  return { payloads, warnings };
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
 * Always resolves. A refusal, a failed handshake and a completed recording all come
 * back as a `TransportOutcome`, because one WebSocket request must not stop the
 * rest of its group.
 *
 * Only a completed session carries a `response`; that is what decides whether the
 * caller runs this request's assertions against it. See `TransportOutcome`.
 */
export async function executeWebsocketRequest(
  input: WebsocketExecutionInput,
): Promise<TransportOutcome> {
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

  // A session that sends nothing is almost never what the file meant, and it is
  // indistinguishable from a healthy one in the result: it connects, records
  // whatever the peer volunteers, and passes. The run already refuses to let
  // "zero requests" or "an empty group" pass silently; this is the same
  // principle one level down, at the message list.
  //
  // Five shapes reach here — no `message` key, an empty list, every entry
  // deselected, `selected` omitted, and `selected` as the STRING "false". The
  // last two are the dangerous ones, because they look selected to a human
  // reading the file. `.yml` parsing resolves `selected` to an explicit boolean,
  // so an omitted flag has already become `false` by the time the filter below
  // sees it.
  // Planned once, not per use: the plan reports what it would not send, and
  // computing it twice would say each of those things twice.
  const planned = framesToSend(request, subst);
  warnings.push(...planned.warnings);

  if (planned.payloads.length === 0) {
    warnings.push(
      'This WebSocket request sends no messages, so the session only records what the peer '
        + 'volunteers. Sending nothing is not a pass. The usual cause is selection: set '
        + '`selected: true` (a boolean, not the string "false") on the messages that should '
        + 'go out.',
    );
  }

  const { WebSocket } = await import('ws');

  const transcript: WebsocketTranscriptEntry[] = [];

  // The session as the author's own script sees it, kept apart from the one the
  // caller is shown.
  //
  // The surfaced transcript omits payloads unless `includePayloads` is set, and
  // clips what it does keep to the display caps, because outbound frames are
  // recorded AFTER interpolation and would otherwise write supplied secrets into a
  // result returned by default. A post-response script is not that: it is the
  // author's own code, and without the payloads it could not assert on the one
  // thing a session produces. The HTTP path already draws the line here — `res.body`
  // always carries the full body while `response_body` is gated — so this is the
  // existing contract rather than a new exception.
  //
  // Bounded by its own ceiling rather than by the display caps, for the same reason
  // HTTP buffers to MAX_RESPONSE_BYTES rather than to the caller's truncation
  // setting: the display caps protect the tool response, and this one protects the
  // process.
  const scriptFrames: WebsocketTranscriptEntry[] = [];
  let scriptBytes = 0;

  const startedAt = Date.now();
  const offset = () => Date.now() - startedAt;
  const record = (direction: 'sent' | 'received', payload: string) => {
    const offset_ms = offset();
    // The running total is what lets the entry clip itself to the cumulative
    // ceiling. Computed from the transcript rather than carried in a counter so
    // there is one source of truth for it.
    transcript.push(
      toTranscriptEntry(
        { direction, offset_ms, payload },
        options,
        transcriptBytes(transcript),
      ),
    );

    const bytes = Buffer.byteLength(payload, 'utf8');
    if (scriptBytes + bytes <= MAX_SCRIPT_TRANSCRIPT_BYTES) {
      scriptBytes += bytes;
      scriptFrames.push({ direction, offset_ms, bytes, payload });
    }
  };

  // Wrapped because the constructor validates the handshake headers and throws
  // SYNCHRONOUSLY on a bad one — an invalid character in a value, a name that is
  // not a token. Unwrapped, that escaped this function entirely and was reported
  // by a generic handler with no `url`, so a caller refusing several targets at
  // once could not tell which one was rejected. Everything else here reports the
  // target it refused; this now does too.
  let upgradeHeaders: ResponseHeaders | undefined;
  let socket: InstanceType<typeof WebSocket>;
  try {
    socket = new WebSocket(dialUrl, {
      headers: handshakeHeaders(request, subst, authHeaders),
      handshakeTimeout: maxDurationMs,
      // Both branches are load-bearing. `pinnedLookup([])` fails closed with
      // ENOTFOUND by design, and the allowlisted-hostname path returns no addresses
      // at all — so passing it unconditionally would make every such request fail
      // as if DNS were broken.
      ...(addresses.length > 0 ? { lookup: pinnedLookup(addresses) } : {}),
      ...(tls ?? {}),
    });
  } catch (err) {
    // Read off the object rather than through `instanceof Error`: the throw
    // comes from inside `ws`, and a cross-realm builtin fails that test while
    // still carrying a perfectly good message.
    const detail = String((err as { message?: unknown })?.message ?? err);
    return refuse(request, target, `WebSocket handshake was refused: ${detail}`, warnings);
  }

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

    // Fires on the 101 before `open`, and is the only place the server's own
    // headers are visible: a WebSocket has no per-message headers to fall back on.
    socket.on('upgrade', (response: IncomingMessage) => {
      upgradeHeaders = collectIncomingHeaders(response.headers);
    });

    socket.on('open', () => {
      for (const frame of planned.payloads) {
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

  const durationMs = Date.now() - startedAt;

  return {
    result: {
      name: request.info.name,
      method: 'WS',
      url: redactUrl(dialUrl),
      // The refusal sentinel, as for gRPC: the session's own outcome is in
      // `websocket`, and its presence is what says the socket was opened at all.
      status: 0,
      duration_ms: durationMs,
      tests: [],
      ...(warnings.length > 0 ? { warnings } : {}),
      websocket: toWebsocketDetail(transcript, stopReason),
      // The same field an HTTP result uses, carrying the same thing: what the
      // server answered with. Absent when the handshake never completed.
      ...(upgradeHeaders ? { response_headers: upgradeHeaders } : {}),
      ...(failure ? { error: `WebSocket session failed: ${failure}` } : {}),
    },
    // A session that opened is verifiable even when it ended badly: "the peer
    // closed before answering" is a thing an author should be able to assert on,
    // so the failure branch is not excluded here.
    response: websocketResponse(scriptFrames, stopReason, durationMs),
  };
}
