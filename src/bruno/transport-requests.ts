/**
 * The request-side model for the two non-HTTP kinds: gRPC and WebSocket.
 *
 * These live here rather than in `types.ts` because that file is 38 lines short
 * of the 1300-line `max-lines` ceiling, which counts comments — and because the
 * two kinds are one subject, read by one parser pair and written by one
 * generator pair.
 *
 * The two kinds are **not symmetric**, and the asymmetry is upstream's rather
 * than a simplification here. Measured against `@usebruno/filestore`'s own
 * readers:
 *
 * - WebSocket carries its credentials in the ordinary `headers` block. Only gRPC
 *   has a `metadata` block. They are the same shape but not the same key, so a
 *   shared field would have to be written under two names anyway.
 * - Only WebSocket messages carry a `type` (`text` / `binary`) and a `selected`
 *   flag. gRPC has neither, in either dialect. `.bru` expresses `selected` only
 *   in its true form — see `BruTransportMessage.selected`.
 * - A `.yml` gRPC message variant holds its payload as a bare string under
 *   `message`; a WebSocket variant nests it one level deeper as
 *   `message: { type, data }`.
 *
 * Both dialects spell the message list singular on disk (`grpc.message`,
 * `websocket.message`) and accept either a variant list or one bare message. The
 * model normalises both to a list, because a caller asking for "the messages"
 * should not have to know which form the file happened to use.
 */

import type { YamlAuth, YamlHeader } from './types.js';

/**
 * One message of a `.bru` gRPC or WebSocket request.
 *
 * `type` is WebSocket-only and absent on a gRPC message, because this dialect
 * has no type for one.
 *
 * `name` and `content` are required rather than optional because the grammar
 * always produces them: a `body:grpc` block written in the bare-text form parses
 * to `{name: '', content: ''}` with the content destroyed and no error raised, so
 * the keys are present even when the data is gone.
 */
export interface BruTransportMessage {
  name: string;
  /** WebSocket only: `text` or `binary`. */
  type?: string;
  content: string;
  /**
   * WebSocket only, and **only ever `true`**.
   *
   * `.bru` does carry the flag — `jsonToBru` writes `selected: true` for a
   * selected message and writes nothing for a deselected one, and `bruToJson`
   * reads it back. What it cannot carry is the false case: its parser resolves a
   * missing pair to `false`, so an absent line and a deliberate `selected: false`
   * arrive here as the same value and cannot be told apart.
   *
   * So this field is populated only when the file said `selected: true`, and is
   * left absent otherwise. Absent means not selected, the same reading Bruno
   * itself takes, and `bruFileToYamlRequest` resolves it to `false` when it builds
   * the runtime view — so a hand-written `.bru` message is sent only if it says
   * `selected: true`, and the transport warns by name about each one it skips.
   * The authoring path refuses to author a deselected message in this dialect
   * rather than write a file that cannot state what it was asked to state.
   */
  selected?: boolean;
}

/**
 * A `.bru` gRPC request's own block, in place of `http`.
 *
 * Every value is a string: the `.bru` grammar is untyped, so `methodType` and
 * `body` arrive as they were written.
 */
export interface BruGrpc {
  url: string;
  method?: string;
  /**
   * The body-mode string the block declares. A real field in this dialect, not
   * something derived from the content blocks — dropping it would rewrite the
   * file without its `body:` line and orphan the messages.
   */
  body?: string;
  protoPath?: string;
  /** A bare mode string here, unlike `.yml` where auth is an object. */
  auth?: string;
  methodType?: string;
  messages?: BruTransportMessage[];
  /** Unmodelled keys of this block, which is a dictionary block and carries them. */
  extra?: Record<string, unknown>;
}

/**
 * A `.bru` WebSocket request's own block, in place of `http`.
 *
 * No `headers`: WebSocket credentials arrive in the ordinary top-level `headers`
 * block and land on `BruFile.headersList`. A field here would be a second path to
 * the same data and would write it twice.
 */
export interface BruWs {
  url: string;
  /** See `BruGrpc.body`. */
  body?: string;
  auth?: string;
  messages?: BruTransportMessage[];
  /** Unmodelled keys of this block, which is a dictionary block and carries them. */
  extra?: Record<string, unknown>;
}

/**
 * One message in a gRPC or WebSocket request.
 *
 * `type` and `selected` are WebSocket-only; a gRPC message never carries them,
 * so they are absent rather than defaulted. `selected` is kept as an explicit
 * `false` when the file says so, because for a streaming request the difference
 * between "not selected" and "not stated" decides what actually gets sent.
 */
export interface YamlRequestMessage {
  /** The variant's title on disk. Empty for a file that used one bare message. */
  name?: string;
  /**
   * WebSocket only. A missing value means text upstream.
   *
   * Upstream offers `json`, `xml` and `text` in its editor and validates nothing
   * on disk, so any string can appear here. It has no binary path at all — every
   * payload is sent as a string — which is why this is kept as the free string it
   * is on disk rather than narrowed to a union the format does not enforce. The
   * transport reports a value it cannot honour instead of silently downgrading it.
   */
  type?: string;
  content?: string;
  /** WebSocket only. */
  selected?: boolean;
}

/**
 * A gRPC request's own target block.
 *
 * `protoPath` is this model's name for it in both dialects. `.yml` spells the
 * key `protoFilePath` on disk and the parser normalises it, exactly as
 * `@usebruno/filestore/src/formats/yml/items/parseGrpcRequest.ts` does; `.bru`
 * already spells it `protoPath`.
 */
export interface YamlGrpc {
  url: string;
  method?: string;
  protoPath?: string;
  /** `unary`, `client-streaming`, `server-streaming` or `bidi-streaming`. */
  methodType?: string;
  /**
   * A bare mode string in `.bru`, an object carrying the credential in `.yml`.
   * Both forms are kept as they were read: reducing the `.yml` object to its
   * mode would drop the credential on the next write, which is the same class of
   * data loss this model exists to close.
   */
  auth?: YamlAuth;
  /** gRPC's own credential block. The WebSocket equivalent is `headers`. */
  metadata?: YamlHeader[];
  messages?: YamlRequestMessage[];
  /** Keys of the block this model does not name, carried through a write. */
  extra?: Record<string, unknown>;
}

/**
 * A WebSocket request's own target block.
 *
 * No `method`, `protoPath` or `methodType`: a WebSocket request has one target
 * and no service definition. Credentials are ordinary `headers`, which is why
 * this is not the gRPC interface with a renamed field.
 */
export interface YamlWebsocket {
  url: string;
  /** See `YamlGrpc.auth` — the same two on-disk forms. */
  auth?: YamlAuth;
  /**
   * WebSocket's credential block. Named `headers` because that is the key both
   * dialects use for it, and because the handshake really does send them as HTTP
   * headers.
   */
  headers?: YamlHeader[];
  messages?: YamlRequestMessage[];
  /** Keys of the block this model does not name, carried through a write. */
  extra?: Record<string, unknown>;
}
