/**
 * Writing the two non-HTTP kinds: the message builders both authoring paths use,
 * and the edits `modify_request` applies to a request that has no `http` block.
 *
 * Separate from `request.ts` because that file is within a few lines of the
 * 1300-line `max-lines` ceiling, and because these are pure functions of their
 * arguments — the builder class they were methods of gave them nothing.
 *
 * The point of the edit half is that a request which can be created can be
 * changed. Until this existed, only `name` and `sequence` could move on a gRPC or
 * WebSocket request, so changing a URL meant deleting the file and writing a new
 * one, losing every field the tool does not model. What is still refused is the
 * set that genuinely has no home: an HTTP method, a body, query parameters and
 * path params. Refused by name, not written — grafting an `http` block onto a
 * request that has none produces a file Bruno cannot open and changes which host
 * it contacts.
 */

import {
  BrunoError,
  type AuthType,
  type BruAuth,
  type BruFile,
  type CreateGrpcMessageInput,
  type CreateRequestInput,
  type CreateWebsocketMessageInput,
  type YamlAuth,
  type YamlRequest,
} from './types.js';
import type { BruTransportMessage, YamlRequestMessage } from './transport-requests.js';
import {
  assertionsToBru,
  mergeBruHeaderList,
  mergeRequestSettings,
  mergeYamlHeaderList,
  toBruApiKeyPlacement,
  toBrunoAuthMode,
  toYamlApiKeyPlacement,
  varsToBruVarSets,
} from './request-inputs.js';

/** The on-disk kinds that have their own target block in place of `http`. */
export type TransportKind = 'ws' | 'grpc';

/**
 * The title an authored gRPC or WebSocket message is written under.
 *
 * Defaulted rather than left empty because upstream's `.yml` WebSocket writer
 * switches shape on it: one message with no title and some content is written as
 * a flat `message: {type, data}`, anything else as a titled variant list.
 * `message N` is upstream's own default for the variant form, so naming every
 * authored message keeps both dialects on the one shape both writers agree about,
 * instead of making the file's structure depend on how many messages there are.
 */
export function transportMessageTitle(title: string | undefined, index: number): string {
  const trimmed = title?.trim();
  return trimmed && trimmed.length > 0 ? title as string : `message ${index + 1}`;
}

/**
 * Build the gRPC messages both dialects write, from an authoring input.
 *
 * One builder for both, unlike WebSocket, because the two gRPC writers agree:
 * neither carries a type or a selection flag, and upstream's `.yml` writer emits
 * a titled variant list unconditionally rather than switching shape on a lone
 * untitled message. `message N` is still the default title, which is upstream's
 * own in both places.
 *
 * Empty content becomes `{}`. That is what upstream's `.bru` writer substitutes
 * (`jsonToBru` writes `content: '''{}'''` for a falsy content), so writing the
 * empty string would put a byte upstream would not.
 */
export function buildGrpcMessages(
  messages: CreateGrpcMessageInput[] | undefined,
): BruTransportMessage[] | undefined {
  if (!messages || messages.length === 0) return undefined;
  return messages.map((message, index) => ({
    name: transportMessageTitle(message.title, index),
    content: message.content.length > 0 ? message.content : '{}',
  }));
}

/**
 * Build the `.bru` `body:ws` messages from an authoring input.
 *
 * A deselected message is written as a message with no `selected` line, which is
 * what upstream's own writer emits for one. `.bru` expresses only the true half of
 * the flag, so the file cannot distinguish "deselected" from "not stated" — but
 * both are read as not sent, by Bruno and by this runner alike, so the behaviour
 * the caller asked for is the behaviour the file produces. What is lost is only
 * the report: reading the request back finds the flag absent rather than false.
 * `.yml` carries the false explicitly and loses nothing.
 */
export function buildBruWebsocketMessages(
  messages: CreateWebsocketMessageInput[] | undefined,
): BruTransportMessage[] | undefined {
  if (!messages || messages.length === 0) return undefined;

  return messages.map((message, index) => {
    const out: BruTransportMessage = {
      name: transportMessageTitle(message.title, index),
      content: message.content,
    };
    // `.bru` says "send this" only by carrying the line, since Bruno's reader
    // treats its absence as deselected: a message authored without it would open
    // in Bruno with nothing to send. So the line is written for every message the
    // caller wants sent, and omitted for a deselected one — the only way this
    // dialect has of recording that, and the same thing upstream's writer emits.
    if (message.selected !== false) out.selected = true;
    if (message.type !== undefined) out.type = message.type;
    return out;
  });
}

/**
 * Build the `.yml` `websocket.message` variants from an authoring input.
 *
 * `selected` is always written, including the false: this dialect records it,
 * and for a streaming request the difference between "not selected" and "not
 * stated" decides what gets sent.
 */
export function buildYamlWebsocketMessages(
  messages: CreateWebsocketMessageInput[] | undefined,
): YamlRequestMessage[] | undefined {
  if (!messages || messages.length === 0) return undefined;

  return messages.map((message, index) => {
    const out: YamlRequestMessage = {
      name: transportMessageTitle(message.title, index),
      content: message.content,
      selected: message.selected ?? true,
    };
    if (message.type !== undefined) out.type = message.type;
    return out;
  });
}

/**
 * The `.bru` auth block for an authored or edited credential.
 *
 * `type` alone for the modes this dialect stores nothing else for: `oauth2` and
 * `digest` carry their configuration in blocks this writer does not yet author,
 * and writing a half-filled one would look like a credential that is there.
 */
export function buildBruAuthBlock(type: AuthType, config: Record<string, string>): BruAuth {
  const auth: BruAuth = { type };
  switch (type) {
    case 'bearer':
      auth.bearer = { token: config.token || '{{token}}' };
      break;
    case 'basic':
      auth.basic = {
        username: config.username || '{{username}}',
        password: config.password || '{{password}}',
      };
      break;
    case 'api-key':
      auth.apikey = {
        key: config.key || 'X-API-Key',
        value: config.value || '{{apiKey}}',
        placement: toBruApiKeyPlacement(config),
      };
      break;
  }
  return auth;
}

/**
 * The `.yml` auth mapping for an authored or edited credential.
 *
 * Only for the modes that carry one: `inherit` is the bare token and `none` is the
 * absence of the key, both of which the callers handle before reaching here.
 *
 * Each field is written only when the caller supplied it, rather than copying the
 * whole config across, because Bruno omits what was not expressed — `placement`
 * especially, whose presence changes where an API key is sent. A create and an
 * edit of the same credential must produce the same bytes, so both go through
 * this.
 */
export function buildYamlAuthValue(type: AuthType, config: Record<string, string>): YamlAuth {
  const auth: Record<string, unknown> = { type: toBrunoAuthMode(type) };
  if (type === 'bearer' && config.token) {
    auth.token = config.token;
  } else if (type === 'basic') {
    if (config.username) auth.username = config.username;
    if (config.password) auth.password = config.password;
  } else if (type === 'api-key') {
    if (config.key) auth.key = config.key;
    if (config.value) auth.value = config.value;
    if (config.placement ?? config.in) auth.placement = toYamlApiKeyPlacement(config);
  }
  return auth as YamlAuth;
}

/**
 * The fields that cannot move on a request with no `http` block, in the order
 * they are reported.
 *
 * `url`, `headers` and `auth` are deliberately absent: all three exist on both
 * transports, just in a different block, and refusing them was the reason a
 * WebSocket request's target could not be changed at all.
 */
const HTTP_ONLY_UPDATE_FIELDS = ['method', 'body', 'query', 'pathParams'] as const;

/** The nested transport object that does not belong to `kind`. */
const FOREIGN_OBJECT: Record<TransportKind, 'websocket' | 'grpc'> = {
  ws: 'grpc',
  grpc: 'websocket',
};

/**
 * Refuse an edit naming a field the kind has no place for.
 *
 * Throws rather than returning a message so the two dialect paths report it
 * identically, and so a new field added to one of them cannot quietly skip the
 * check.
 */
export function assertTransportUpdatable(
  kind: TransportKind,
  updates: Partial<CreateRequestInput>,
): void {
  const refused = HTTP_ONLY_UPDATE_FIELDS.filter((field) => updates[field] !== undefined);
  if (refused.length > 0) {
    throw new BrunoError(
      `Cannot set ${refused.join(', ')} on a "${kind}" request: the kind has no http block. `
        + `Its target is url, its credentials are ${kind === 'grpc' ? 'metadata' : 'headers'}, and `
        + `its payload is ${kind}.messages.`,
      'VALIDATION_ERROR',
    );
  }

  const foreign = FOREIGN_OBJECT[kind];
  if (updates[foreign] !== undefined) {
    throw new BrunoError(
      `The \`${foreign}\` object does not apply to kind \`${kind}\``,
      'VALIDATION_ERROR',
    );
  }
}

/**
 * The transport kind a parsed `meta.type` names, or undefined for anything else.
 *
 * `http` and `graphql` both have an http block and are not transports here;
 * anything else is a kind this server cannot write and must refuse rather than
 * guess at.
 */
export function transportKindOf(metaType: string | undefined): TransportKind | undefined {
  if (metaType === 'ws') return 'ws';
  if (metaType === 'grpc') return 'grpc';
  return undefined;
}

/**
 * The transport kind to edit on a request with no http block, or a refusal.
 *
 * Both parsers reject a `type` they do not know, so no file on disk reaches here
 * with an unwritable one today. The check stays because the alternative is
 * guessing: writing a `ws` block onto a request that is not one is silent
 * corruption, and the set of types the parsers accept is not this module's to
 * assume. It is called through directly rather than through a file for the same
 * reason.
 */
export function transportKindToEdit(metaType: string | undefined): TransportKind {
  const kind = transportKindOf(metaType);
  if (!kind) {
    throw new BrunoError(
      `Cannot edit a "${metaType ?? 'unknown'}" request: it has no http block and no transport `
        + 'block this server can write. Only name and sequence can be changed.',
      'VALIDATION_ERROR',
    );
  }
  return kind;
}

/**
 * Apply the `.bru` edits that belong to no block in particular.
 *
 * Shared by the http and transport paths because they belong to every kind: an
 * assertion reads a response, a `vars` entry sets a variable and `settings` caps a
 * timeout, none of which is HTTP-specific. Before this they were applied on the
 * http path only, so passing `assert` for a WebSocket request neither wrote the
 * assertion nor said it had not been written.
 */
export function applyKindAgnosticUpdates(
  bru: BruFile,
  updates: Partial<CreateRequestInput>,
): void {
  if (updates.assert) bru.assertions = assertionsToBru(updates.assert);
  if (updates.vars) bru.varSets = varsToBruVarSets(updates.vars, bru.varSets);
  if (updates.settings) bru.settings = mergeRequestSettings(bru.settings, updates.settings);
}

/**
 * Apply an edit to a `.bru` request's transport block, in place.
 *
 * Credentials go to different places by kind, which is upstream's asymmetry and
 * not a simplification here: a WebSocket request carries them in the ordinary
 * top-level `headers` block, and only gRPC has `metadata`. Writing `headers` for
 * a gRPC request would produce a block Bruno's gRPC reader never looks at.
 */
export function applyBruTransportUpdates(
  bru: BruFile,
  kind: TransportKind,
  updates: Partial<CreateRequestInput>,
): void {
  assertTransportUpdatable(kind, updates);

  const block = kind === 'grpc' ? bru.grpc : bru.ws;
  if (!block) {
    throw new BrunoError(
      `This "${kind}" request has no ${kind} block to edit. Recreate it with create_request.`,
      'VALIDATION_ERROR',
    );
  }

  if (updates.url) block.url = updates.url;

  if (updates.headers) {
    if (kind === 'grpc') {
      bru.metadata = mergeBruHeaderList(bru.metadata, updates.headers);
    } else {
      bru.headers = { ...bru.headers, ...updates.headers };
      bru.headersList = mergeBruHeaderList(bru.headersList, updates.headers);
    }
  }

  if (updates.auth?.type === 'inherit' || updates.auth?.type === 'none') {
    // Neither mode leaves a local credential, so the credential block goes with
    // the mode: a file that says inherit or none must not carry one underneath.
    // The create path writes no block for either, and an edit has to agree.
    block.auth = toBrunoAuthMode(updates.auth.type);
    delete bru.auth;
  } else if (updates.auth) {
    block.auth = toBrunoAuthMode(updates.auth.type);
    bru.auth = buildBruAuthBlock(updates.auth.type, updates.auth.config || {});
  }

  if (kind === 'grpc') {
    if (updates.grpc?.method !== undefined) bru.grpc!.method = updates.grpc.method;
    if (updates.grpc?.protoPath !== undefined) bru.grpc!.protoPath = updates.grpc.protoPath;
    if (updates.grpc?.methodType !== undefined) bru.grpc!.methodType = updates.grpc.methodType;
    if (updates.grpc?.messages) bru.grpc!.messages = buildGrpcMessages(updates.grpc.messages);
  } else if (updates.websocket?.messages) {
    bru.ws!.messages = buildBruWebsocketMessages(updates.websocket.messages);
  }
}

/** Apply an edit to a `.yml` request's transport block, in place. */
export function applyYamlTransportUpdates(
  req: YamlRequest,
  kind: TransportKind,
  updates: Partial<CreateRequestInput>,
): void {
  assertTransportUpdatable(kind, updates);

  const block = kind === 'grpc' ? req.grpc : req.websocket;
  if (!block) {
    throw new BrunoError(
      `This "${kind}" request has no ${kind} block to edit. Recreate it with create_request.`,
      'VALIDATION_ERROR',
    );
  }

  if (updates.url) block.url = updates.url;

  if (updates.headers) {
    if (kind === 'grpc') {
      req.grpc!.metadata = mergeYamlHeaderList(req.grpc!.metadata, updates.headers);
    } else {
      req.websocket!.headers = mergeYamlHeaderList(req.websocket!.headers, updates.headers);
    }
  }

  if (updates.auth?.type === 'inherit') {
    // The bare token, not a mapping: the same form the create path writes.
    block.auth = 'inherit';
  } else if (updates.auth?.type === 'none') {
    // `none` is the absence of the key here, so removing the credential means
    // removing the key. Leaving the previous mapping in place would have kept
    // sending the credential the caller just asked to drop.
    delete block.auth;
  } else if (updates.auth) {
    block.auth = buildYamlAuthValue(updates.auth.type, updates.auth.config || {});
  }

  if (kind === 'grpc') {
    if (updates.grpc?.method !== undefined) req.grpc!.method = updates.grpc.method;
    if (updates.grpc?.protoPath !== undefined) req.grpc!.protoPath = updates.grpc.protoPath;
    if (updates.grpc?.methodType !== undefined) req.grpc!.methodType = updates.grpc.methodType;
    if (updates.grpc?.messages) req.grpc!.messages = buildGrpcMessages(updates.grpc.messages);
  } else if (updates.websocket?.messages) {
    req.websocket!.messages = buildYamlWebsocketMessages(updates.websocket.messages);
  }
}
