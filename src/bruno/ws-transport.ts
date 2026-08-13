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
  type TranscriptEntryInput,
  type TranscriptOptions,
} from './transport-redaction.js';
import { websocketResponse, type TransportOutcome } from './transport-verification.js';
import type { RootChain } from './collection-roots.js';
import type {
  WebsocketFrameType,
  WebsocketResultDetail,
  WebsocketTranscriptEntry,
} from './transport-results.js';
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
/**
 * How long a silence ends a session, in milliseconds.
 *
 * The wall-clock ceiling is a safety bound, not a schedule, and before this every
 * session spent all of it: eight WebSocket requests with a 2500 ms ceiling took
 * 22 seconds, almost all of it waiting on a peer that had already answered. Silence
 * after activity is the signal that nothing more is coming, so it ends the session
 * and reports `idle`.
 *
 * The clock only starts once a frame has been recorded, which is what keeps a
 * listen-only session — one that authors no messages and waits for the peer to
 * volunteer something — on the full wall-clock budget it asked for.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 1500;
/**
 * How long to wait between the session's own messages, in milliseconds.
 *
 * Zero, which is what every session did before the option existed: all of a
 * request's messages left in one tick, three sends all recorded at the same
 * millisecond. That is right for a fire-and-forget stream and useless for anything
 * that answers, so the default preserves it and a caller driving a send-wait-send
 * protocol asks for the gap it needs.
 */
export const DEFAULT_SEND_INTERVAL_MS = 0;
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
   * End the session after this much silence, in ms. Defaults to 1500; 0 waits for
   * the wall-clock ceiling instead, which is what a protocol with long gaps
   * between frames wants.
   */
  idleTimeoutMs?: number;
  /**
   * Wait this long between the session's own messages, in ms. Defaults to 0, which
   * sends them all in one tick, as every session did before this existed.
   */
  sendIntervalMs?: number;
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
  /**
   * A target a pre-request script set with `req.setUrl`, replacing the block's
   * own. Applied instead of substituting the template, not over the substituted
   * result: the script was handed the substituted target and what it gives back
   * is a finished URL, so expanding it again would treat response data as a
   * template.
   */
  urlOverride?: string;
  /**
   * Headers a pre-request script set with `req.setHeader`, applied over the
   * request's own and over auth's — last writer wins, as on the HTTP path.
   */
  headerOverrides?: Record<string, string>;
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
/**
 * A frame to record, as the session's handlers describe one.
 *
 * `type` is required here even though the entry builder defaults it, because every
 * handler in this file knows exactly which kind it caught and a default would only
 * be a way to forget.
 */
type RecordedFrame = Omit<TranscriptEntryInput, 'offset_ms' | 'type'> & {
  type: WebsocketFrameType;
};

/**
 * The frames that carry an application payload.
 *
 * `maxMessages` counts these and not control frames: a keepalive is not an answer,
 * and a peer that pings once a second would otherwise reach the message bound on
 * its own and report `count` for a session that received nothing.
 */
const DATA_FRAME_TYPES = new Set<WebsocketFrameType>(['text', 'binary']);

/** One frame this session will send, with the name the file gave it. */
interface PlannedFrame {
  payload: string;
  /** Absent when the message authored no name; an index is not a name. */
  title?: string;
  /**
   * How a warning refers to this message: its quoted name, or its position in the
   * file's message list. Carried rather than derived, so a message the session never
   * managed to send is named the same way as one that was refused before sending —
   * and by its authored position, not by its position among the frames that
   * survived selection.
   */
  label: string;
}

interface PlannedFrames {
  frames: PlannedFrame[];
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
  const frames: PlannedFrame[] = [];
  const warnings: string[] = [];

  (request.websocket?.messages ?? []).forEach((message, index) => {
    if (message.selected === false) return;

    const named = message.name !== undefined && message.name.length > 0;
    const label = named ? `"${message.name}"` : `at index ${index}`;

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

    frames.push({ payload, label, ...(named ? { title: message.name } : {}) });
  });

  return { frames, warnings };
}

/**
 * The handshake headers: the request's own, plus whatever auth placed.
 *
 * Exported so the pre-request phase can seed `req.getHeaders()` from the same
 * implementation that produces what is sent, rather than from a second copy of
 * this loop that could drift from it. That caller passes no auth headers: auth
 * is applied here, after the script has run.
 */
export function handshakeHeaders(
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
 * Every value authored for one header name, whatever case it was written in.
 *
 * Header names are case-insensitive on the wire, and a request that wrote
 * `Sec-Websocket-Protocol` means the same thing as one that wrote
 * `Sec-WebSocket-Protocol`. Upstream reads exactly two spellings of each name; this
 * reads all of them, because the failure for a third spelling is not a header that
 * quietly does nothing — see `handshakeTerms` — and no file that works upstream
 * negotiates differently here.
 */
function headerValues(headers: Record<string, string>, name: string): string[] {
  const wanted = name.toLowerCase();
  return Object.entries(headers)
    .filter(([key]) => key.toLowerCase() === wanted)
    .map(([, value]) => value);
}

/** What the handshake must be told at the constructor, not merely in a header. */
interface HandshakeTerms {
  protocols: string[];
  protocolVersion?: number;
}

/**
 * The two handshake terms a header alone cannot express.
 *
 * A subprotocol is authored as a `Sec-WebSocket-Protocol` header — that is
 * upstream's only surface for it either — but `ws` validates the server's answer
 * against the list given to its CONSTRUCTOR rather than against whatever went out in
 * the headers. So a request that wrote only the header, talking to a server that
 * dutifully echoed it, had its handshake aborted with `Server sent a subprotocol but
 * none was requested`: writing the header was worse than leaving it out. Extracting
 * it here is what makes the header mean what it reads as.
 *
 * Comma-split and trimmed, as `bruno-requests/src/ws/ws-client.js` does it, so one
 * file negotiates the same protocols in Bruno and here. `ws` then writes the
 * outgoing header from this list, so the wire and the validation cannot disagree.
 * An empty entry — the trailing comma in `chat,` — is left in on purpose: `ws`
 * refuses it as an invalid subprotocol, which is what the same file does upstream,
 * and silently dropping it would negotiate something Bruno would not.
 *
 * `Sec-WebSocket-Version` is the same shape of problem. `ws` overwrites the header
 * with whatever its own `protocolVersion` option says, so an authored version was
 * ignored outright. It accepts 8 and 13 and throws on anything else, which the
 * caller sees as a refusal naming the version it asked for; a value that is not a
 * number at all is reported as a warning instead, since passing `NaN` on would
 * refuse the request without saying why.
 */
function handshakeTerms(headers: Record<string, string>, warnings: string[]): HandshakeTerms {
  const protocols = headerValues(headers, 'Sec-WebSocket-Protocol')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim());

  const [version] = headerValues(headers, 'Sec-WebSocket-Version');
  if (version === undefined) return { protocols };

  const asNumber = Number(version);
  if (!Number.isFinite(asNumber)) {
    warnings.push(
      `Header Sec-WebSocket-Version carries "${version}", which is not a number, so it was `
        + 'ignored and the session negotiated version 13. The header cannot set the version on '
        + 'its own: the library writes that header itself from the version it was given.',
    );
    return { protocols };
  }

  return { protocols, protocolVersion: asNumber };
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
  const { request, vars, rootChain, oauth2Token, options = {}, urlOverride, headerOverrides } = input;
  const block = request.websocket;
  const warnings: string[] = [];
  const subst = (value: string) => substitute(value, vars);

  if (!block) {
    return refuse(request, '', 'Cannot execute a WebSocket request with no websocket block', warnings);
  }

  const target = (urlOverride ?? subst(block.url ?? '')).trim();
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
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const sendIntervalMs = options.sendIntervalMs ?? DEFAULT_SEND_INTERVAL_MS;

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

  if (planned.frames.length === 0) {
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

  // Assigned once the promise below has a `finish` to restart the clock against.
  // Held out here so `record` is the single place a frame touches the idle bound:
  // a handler that recorded a frame without restarting it would let the session
  // end while the peer was still talking.
  let touchIdle: () => void = () => {};

  const record = (frame: RecordedFrame) => {
    const offset_ms = offset();
    // The running total is what lets the entry clip itself to the cumulative
    // ceiling. Computed from the transcript rather than carried in a counter so
    // there is one source of truth for it.
    transcript.push(
      toTranscriptEntry({ ...frame, offset_ms }, options, transcriptBytes(transcript)),
    );

    const bytes = frame.bytes ?? Buffer.byteLength(frame.payload, 'utf8');
    if (scriptBytes + bytes <= MAX_SCRIPT_TRANSCRIPT_BYTES) {
      scriptBytes += bytes;
      scriptFrames.push({
        direction: frame.direction,
        offset_ms,
        bytes,
        type: frame.type,
        ...(frame.title !== undefined ? { title: frame.title } : {}),
        ...(frame.closeCode !== undefined ? { close_code: frame.closeCode } : {}),
        payload: frame.payload,
      });
    }

    touchIdle();
  };

  // Wrapped because the constructor validates the handshake headers and throws
  // SYNCHRONOUSLY on a bad one — an invalid character in a value, a name that is
  // not a token. Unwrapped, that escaped this function entirely and was reported
  // by a generic handler with no `url`, so a caller refusing several targets at
  // once could not tell which one was rejected. Everything else here reports the
  // target it refused; this now does too.
  let upgradeHeaders: ResponseHeaders | undefined;
  let socket: InstanceType<typeof WebSocket>;
  // The script's headers last, and before the terms are read, so a script that
  // set Sec-WebSocket-Protocol is extracted to the constructor like any other
  // author of that header rather than aborting the handshake as a bare header.
  const headers = { ...handshakeHeaders(request, subst, authHeaders), ...(headerOverrides ?? {}) };
  const terms = handshakeTerms(headers, warnings);
  try {
    socket = new WebSocket(dialUrl, terms.protocols, {
      headers,
      handshakeTimeout: maxDurationMs,
      ...(terms.protocolVersion !== undefined ? { protocolVersion: terms.protocolVersion } : {}),
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

  // True from the first send until the last one, so the idle bound cannot mistake
  // the gap this session is deliberately leaving between its own messages for a peer
  // that has stopped talking. Without it any `sendIntervalMs` above the idle timeout
  // would end the session after its first message, every time.
  let sending = planned.frames.length > 0;

  // How far the sequence actually got. Read after the session rather than reported
  // from inside the loop: the loop learns it was stopped one microtask after the
  // bound fired, and the teardown it is racing against is what builds the result.
  let sent = 0;

  await new Promise<void>((resolve) => {
    const finish = (reason: WebsocketResultDetail['stop_reason'], error?: string) => {
      if (stopped) return;
      stopped = true;
      stopReason = reason;
      failure = error;
      clearTimeout(deadline);
      clearTimeout(idle);
      // Woken rather than left to expire. A pending pause holds the process open for
      // the rest of the interval, and the send it would resume is a write to a socket
      // this call has already closed.
      for (const wake of waiting) wake();
      waiting.clear();
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

    // Armed by the first recorded frame rather than at open, so a session that
    // authors no messages keeps the whole wall-clock budget to wait for a peer that
    // may yet speak. `0` turns the bound off, for a protocol whose gaps are longer
    // than its answers.
    let idle: NodeJS.Timeout | undefined;
    touchIdle = () => {
      if (stopped || sending || idleTimeoutMs <= 0) return;
      clearTimeout(idle);
      idle = setTimeout(() => finish('idle'), idleTimeoutMs);
    };

    // Every pause a paced send is currently sitting in, so `finish` can cut it short.
    const waiting = new Set<() => void>();
    const pause = (ms: number) => new Promise<void>((resume) => {
      const timer = setTimeout(() => {
        waiting.delete(wake);
        resume();
      }, ms);
      const wake = () => {
        clearTimeout(timer);
        resume();
      };
      waiting.add(wake);
    });

    // Fires on the 101 before `open`, and is the only place the server's own
    // headers are visible: a WebSocket has no per-message headers to fall back on.
    socket.on('upgrade', (response: IncomingMessage) => {
      upgradeHeaders = collectIncomingHeaders(response.headers);
    });

    // Paced, and unawaited on purpose: the session's bounds run against the socket,
    // not against this loop, so a sequence that outlasts `maxDurationMs` is stopped
    // where it stands rather than allowed to finish sending first.
    const sendPlanned = async () => {
      // A session with nothing to send leaves the idle clock unarmed, since arming it
      // is what the last send does and there is no send. A listen-only request keeps
      // the whole wall-clock budget to wait for a peer that may yet speak.
      if (planned.frames.length === 0) return;

      for (const [index, frame] of planned.frames.entries()) {
        // A bound can bite between two paced sends, and it can already have bitten
        // before the first one — the handshake and the wall-clock ceiling share a
        // deadline. Either way the rest of the sequence stays unsent, and what was
        // left is reported once the session is over.
        if (stopped) break;

        socket.send(frame.payload);
        record({
          direction: 'sent',
          payload: frame.payload,
          type: 'text',
          title: frame.title,
        });
        sent += 1;

        // No trailing pause: waiting after the last message would spend the interval
        // on nothing, and with a one-message request the whole option would be a delay
        // before the session could end.
        if (sendIntervalMs > 0 && index < planned.frames.length - 1) {
          await pause(sendIntervalMs);
        }
      }

      // The idle bound starts here, from the last thing this session said, rather
      // than from the first — which is where it would have started had every send
      // touched it while the sequence was still going out.
      sending = false;
      touchIdle();
    };

    socket.on('open', () => {
      void sendPlanned();
    });

    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary?: boolean) => {
      // Frames that were already queued when the bound was reached are dropped
      // rather than recorded: the transcript has to mean "this is what the bound
      // allowed", or the cap is not a cap.
      if (stopped) return;
      const raw = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      // Base64 for a binary frame. Decoding those bytes as UTF-8 replaces every
      // invalid sequence, so the payload could not be read back and its length no
      // longer matched what arrived — `bytes` is the wire size in both cases.
      const payload = isBinary === true ? raw.toString('base64') : raw.toString('utf8');
      record({
        direction: 'received',
        payload,
        type: isBinary === true ? 'binary' : 'text',
        bytes: raw.length,
      });

      // Only against a text frame: engine.io is a text protocol, and base64 of
      // arbitrary bytes can begin with "0" without meaning anything by it.
      if (isBinary !== true) {
        if (payload.startsWith(ENGINE_IO_OPEN)) {
          // Only an OPEN frame proves the peer speaks engine.io. Without this a
          // server that happens to send "2" would be answered with a "3" it never
          // asked for.
          engineIoSeen = true;
        } else if (options.engineIoKeepalive && engineIoSeen && payload === ENGINE_IO_PING) {
          socket.send(ENGINE_IO_PONG);
          record({ direction: 'sent', payload: ENGINE_IO_PONG, type: 'text' });
        }
      }

      const received = transcript.filter(
        (entry) => entry.direction === 'received' && DATA_FRAME_TYPES.has(entry.type),
      ).length;
      if (received >= maxMessages) {
        finish('count');
      } else if (transcriptCapReached(transcript, options)) {
        finish('bytes');
      }
    });

    // Control frames, recorded so a silent-looking session can be told apart from
    // one the peer was keeping alive all along. `ws` answers a ping with a pong
    // itself, below this code, so that reply is not in the transcript.
    // A control frame's own payload is opaque application data and is almost always
    // empty; it is recorded as text, and `bytes` is what actually arrived.
    socket.on('ping', (data: Buffer) => {
      if (stopped) return;
      record({
        direction: 'received',
        payload: data.toString('utf8'),
        type: 'ping',
        bytes: data.length,
      });
    });

    socket.on('pong', (data: Buffer) => {
      if (stopped) return;
      record({
        direction: 'received',
        payload: data.toString('utf8'),
        type: 'pong',
        bytes: data.length,
      });
    });

    socket.on('error', (error: Error) => finish('error', error.message));

    socket.on('close', (code: number, reason: Buffer) => {
      // The close frame is the session's last word, and until now it was thrown
      // away: `stop_reason: "closed"` said the peer hung up without saying whether
      // it was an ordinary goodbye (1000), a policy refusal (1008) or a server
      // error (1011). Not recorded when a bound already stopped us, because then
      // this is the peer answering our own close rather than ending the session.
      if (!stopped) {
        record({
          direction: 'received',
          payload: reason === undefined ? '' : reason.toString('utf8'),
          type: 'close',
          bytes: reason === undefined ? 0 : reason.length,
          closeCode: code,
        });
      }
      finish('closed');
    });
  });

  // Belt and braces on every exit path, including one where the promise above
  // resolved through the grace timer: a socket left open outlives the tool call
  // that made it, and nothing else would ever close it.
  socket.terminate();

  // A half-driven request/response protocol looks exactly like a peer that stopped
  // answering, so the messages that never went out are named rather than left to be
  // inferred from a transcript that is one send short.
  if (sent < planned.frames.length) {
    const unsent = planned.frames.slice(sent);
    warnings.push(
      `The session ended (stop_reason "${stopReason}") with ${unsent.length} of `
        + `${planned.frames.length} messages unsent: ${
          unsent.map((pending) => pending.label).join(', ')
        }. A paced sequence spends wall-clock time between sends, so maxDurationMs has to cover `
        + 'the whole of it.',
    );
  }

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
