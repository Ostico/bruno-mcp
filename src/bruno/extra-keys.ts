/**
 * Carry keys this server does not model through a read-modify-write.
 *
 * Both generators rebuild the file from the typed model rather than editing the
 * bytes in place, so a key the model has no field for is not ignored on a write
 * — it is **deleted**. A request authored in Bruno using a feature we do not
 * model therefore loses it the first time `modify_request` touches it, which
 * makes a partial model a data-loss bug rather than a fidelity gap.
 *
 * The fix is the shape the environment side already uses: the parser puts every
 * unmodelled key in an `extra` bag on the same level it was found, and the
 * generator writes the bag back out. Keeping it per-level rather than one bag
 * for the whole file matters because the position of a key is part of its
 * meaning — a `description` on a header is not a top-level `description`.
 *
 * The skip list passed to `applyExtraKeys` is load-bearing, not defensive. A
 * carried key must never win over the typed model, or a stale value read off the
 * file being replaced would overwrite the update the caller just asked for.
 *
 * **This can only preserve what the format's own reader and writer carry.** The
 * two dialects differ, and the difference is upstream's rather than ours — Bruno
 * goes through the same `@usebruno/lang` grammar, so what it cannot keep here it
 * cannot keep in Bruno either. Measured against the installed grammar:
 *
 * - `.yml` — everything, at every level. The document is handed to a YAML
 *   serializer whole, so an unknown top-level block round-trips like any other.
 * - `.bru` — unmodelled keys inside a *dictionary* block only, `meta` being the
 *   one that matters. `jsonToBruV2` walks such a block key by key, so a carried
 *   key is emitted; but it drops an unrecognised **top-level block** outright,
 *   and `bruToJsonV2` drops an unrecognised key inside a block whose fields the
 *   grammar names explicitly — `settings`, where it also injects `timeout: 0`.
 *   Neither is reachable from this side: one key never survives the write, the
 *   other never survives the read.
 */

/**
 * Collect the keys of `source` that the typed model does not name.
 *
 * @returns the unmodelled keys, or `undefined` when there are none — so the
 *   caller can leave the field off the model entirely rather than attaching an
 *   empty object to every request ever parsed.
 */
export function collectExtraKeys(
  source: unknown,
  modelled: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return undefined;

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (modelled.has(key)) continue;
    extra[key] = value;
  }

  return Object.keys(extra).length > 0 ? extra : undefined;
}

/**
 * Write carried keys onto a document being generated, skipping any key the
 * caller writes from the typed model.
 */
export function applyExtraKeys(
  target: Record<string, unknown>,
  extra: Record<string, unknown> | undefined,
  modelled: ReadonlySet<string>,
): void {
  if (!extra) return;
  for (const [key, value] of Object.entries(extra)) {
    if (modelled.has(key)) continue;
    target[key] = value;
  }
}

/** Fields of `YamlRequest` that generateYamlRequest writes itself. */
export const YAML_REQUEST_KEYS: ReadonlySet<string> = new Set([
  'info',
  'http',
  // Modelled as the request block for a graphql request. Omitting it here would
  // carry the block in `extra` as well, emitting it twice.
  'graphql',
  // Same reason, and they were deliberately absent for exactly as long as the
  // generator could not write them: while the blocks were parsed but unwritable,
  // the carried bag was the only thing keeping a `.yml` gRPC or WebSocket request
  // intact through a read-modify-write. They join the list in the same commit
  // that teaches the generator to emit them.
  'grpc',
  'websocket',
  'runtime',
  'settings',
  'docs',
  // Read from the file but written back inside `runtime`, so leaving them out
  // of this list would emit them twice — once where Bruno reads them and once
  // under the legacy top-level key H4 moved them off.
  'vars',
  'assert',
  'extra',
]);

/** Fields of `YamlInfo` that generateYamlRequest writes itself. */
export const YAML_INFO_KEYS: ReadonlySet<string> = new Set(['name', 'type', 'seq', 'tags', 'extra']);

/** Fields of `YamlHttp` that generateYamlRequest writes itself. */
export const YAML_HTTP_KEYS: ReadonlySet<string> = new Set([
  'method',
  'url',
  'headers',
  'body',
  'params',
  'auth',
  'extra',
]);

/**
 * Fields of `YamlGrpc` the generator writes itself.
 *
 * `protoFilePath` is listed because it is the on-disk name of a key the model
 * carries as `protoPath`. Leaving it out would put the path in `extra` as well
 * and emit it twice.
 */
export const YAML_GRPC_KEYS: ReadonlySet<string> = new Set([
  'url',
  'method',
  'protoFilePath',
  'methodType',
  'auth',
  'metadata',
  'message',
  'extra',
]);

/**
 * Fields of `YamlWebsocket` the generator writes itself.
 *
 * No `method`, `protoFilePath` or `methodType`: a WebSocket request has one
 * target and no service definition, and credentials arrive as `headers` rather
 * than gRPC's `metadata`.
 */
export const YAML_WEBSOCKET_KEYS: ReadonlySet<string> = new Set([
  'url',
  'auth',
  'headers',
  'message',
  'extra',
]);

/** Keys of a `.yml` `runtime` block that generateYamlRequest writes itself. */
export const YAML_RUNTIME_KEYS: ReadonlySet<string> = new Set([
  'variables',
  'scripts',
  'assertions',
  'actions',
  'extra',
]);

/** Fields of `YamlSettings` that generateYamlRequest writes itself. */
export const YAML_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  'encodeUrl',
  'timeout',
  'followRedirects',
  'maxRedirects',
  'keepAliveInterval',
  'tls',
  'proxy',
  'extra',
]);

/**
 * Fields of `TlsSettings` that generateYamlRequest writes itself.
 *
 * The `tls` block needs its own list because it is nested inside a modelled
 * settings key: an unrecognised field inside it is invisible to
 * `YAML_SETTINGS_KEYS`, which only ever sees `tls` as a whole.
 */
export const YAML_TLS_KEYS: ReadonlySet<string> = new Set([
  'rejectUnauthorized',
  'ca',
  'cert',
  'key',
  'extra',
]);

/** Fields of `YamlHeader` that generateYamlRequest writes itself. */
export const YAML_HEADER_KEYS: ReadonlySet<string> = new Set([
  'name',
  'value',
  'disabled',
  'extra',
]);

/** Fields of `YamlParam` that generateYamlRequest writes itself. */
export const YAML_PARAM_KEYS: ReadonlySet<string> = new Set([
  'name',
  'value',
  'type',
  'disabled',
  'extra',
]);

/**
 * Keys of a `.bru` `meta` block that must not go in the bag: the four
 * `generateBruRequest` writes from the model.
 *
 * `tags` is one of them, and stays on this list for a second reason as well. The
 * grammar accepts a list value and a single-line value at the same key, and only
 * the list form is a tags list — see `meta-tags.ts`. Were `tags` absent from this
 * set, a single-line value would be carried as an unmodelled key and handed back
 * to a writer that iterates whatever it is given, arriving on disk one character
 * per line.
 */
export const BRU_META_KEYS: ReadonlySet<string> = new Set([
  'name',
  'type',
  'seq',
  'extra',
  'tags',
]);
