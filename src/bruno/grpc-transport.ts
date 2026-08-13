/**
 * Executing a unary gRPC call.
 *
 * `@grpc/grpc-js` and `@grpc/proto-loader` are loaded with a dynamic import
 * inside this module's one entry point, so an HTTP-only run never pays for them.
 * The import is not wrapped in a catch: the dependency is declared, so a missing
 * module is unreachable, and an unreachable catch is dead code the coverage gate
 * would rightly refuse.
 *
 * Three channel options are security decisions rather than tuning:
 *
 *   - `grpc.enable_http_proxy: 0`, unconditionally. grpc-js honours the ambient
 *     `http_proxy` environment variable while undici's `fetch` does not, so
 *     leaving it enabled would route a validated, address-pinned call through
 *     whatever that variable named — silently voiding the SSRF check. Upstream
 *     sets this only alongside an explicit proxy config; the divergence is
 *     deliberate, and this server does not support proxying these transports.
 *   - `grpc.default_authority`, set whenever a validated address is dialled in
 *     place of the hostname. Without it the `:authority` header becomes the IP
 *     and virtual-host routing breaks — the server answers for the wrong service
 *     or not at all.
 *   - `grpc.ssl_target_name_override`, set ONLY when an address was actually
 *     pinned. It fixes TLS name verification, not routing, and on the
 *     allowlisted-hostname path validation returns no addresses at all — there is
 *     nothing being substituted, so overriding the name would weaken
 *     verification for no reason.
 *
 * TLS is never downgraded. A `grpcs://` target whose credentials cannot be built
 * fails; it does not fall back to an insecure channel, which is what upstream's
 * own client does on a credential error.
 */
import { realpath } from 'node:fs/promises';
import { validateUrl, ssrfRemediation } from './url-validator.js';
import { gateTls, pinnedLookup } from './transport-trust.js';
import { assertProtoImportsConfined, confineProtoPath, ProtoPathError } from './proto-path.js';
import { redactMetadata } from './transport-redaction.js';
import { applyAuth } from './auth-apply.js';
import { substitute } from './env-loader.js';
import { redactUrl } from './request-redaction.js';
import { grpcResponse, type TransportOutcome } from './transport-verification.js';
import type { RootChain } from './collection-roots.js';
import type { GrpcResultDetail } from './transport-results.js';
import type { YamlRequest } from './types.js';

/** Schemes a gRPC target may carry. `grpc`/`grpcs` are Bruno's spelling. */
const GRPC_SCHEMES = ['grpc', 'grpcs', 'http', 'https'] as const;

/** Schemes that mean "negotiate TLS". */
const TLS_SCHEMES = new Set(['grpcs:', 'https:']);

export interface GrpcExecutionInput {
  /** The request. Its `grpc` block is what this reads; `http` is absent by definition. */
  request: YamlRequest;
  /** Effective variables, already merged in the caller's precedence order. */
  vars: Map<string, string>;
  collectionRoot?: string;
  /** For `auth: inherit`, resolved from the nearest root that defines auth. */
  rootChain?: RootChain;
  /**
   * The deadline, in milliseconds, already resolved from `settings.timeout` by
   * the caller so both transports share one implementation of that rule. `0`
   * means no deadline — grpc-js has none of its own, so a server that accepts and
   * never answers would otherwise block the request, its group and the whole
   * tool call.
   */
  timeoutMs: number;
  /** An oauth2 access token the caller already fetched, if any. */
  oauth2Token?: string;
  /**
   * A target a pre-request script set with `req.setUrl`, replacing the block's
   * own. Applied instead of substituting the template, not over the substituted
   * result: the script was handed the substituted target and what it gives back
   * is a finished target, so expanding it again would treat response data as a
   * template.
   */
  urlOverride?: string;
  /**
   * Metadata a pre-request script set with `req.setHeader`, applied over the
   * request's own block and over auth's — last writer wins, as on the HTTP path.
   * Metadata is this transport's header surface: grpc-js puts it on the wire as
   * HTTP/2 headers, which is why auth's headers are merged into it below.
   */
  metadataOverrides?: Record<string, string>;
}

/** Everything a refusal needs: no channel was built and nothing was sent. */
function refuse(
  request: YamlRequest,
  url: string,
  error: string,
  warnings: string[],
): TransportOutcome {
  // No `response`: a call that was never placed has nothing to assert about, and
  // it already carries its own error. See `TransportOutcome`.
  return {
    result: {
      name: request.info.name,
      method: 'GRPC',
      url: redactUrl(url),
      status: 0,
      duration_ms: 0,
      tests: [],
      ...(warnings.length > 0 ? { warnings } : {}),
      error,
    },
  };
}

/**
 * Split `/pkg.Svc/Method` into the service path and the method name.
 *
 * Returned rather than thrown so the caller can refuse with the request's own
 * name attached, and because a malformed method is an authoring mistake rather
 * than an exceptional condition.
 */
function splitMethodPath(path: string): { service: string; method: string } | undefined {
  const match = /^\/?([\w.]+)\/(\w+)$/.exec(path.trim());
  if (!match) return undefined;
  return { service: match[1], method: match[2] };
}

/**
 * Flatten gRPC metadata to the string map the result shape carries.
 *
 * A `-bin` key holds a Buffer rather than a string, and base64 is the honest
 * rendering of one: coercing it with String() would produce the useless
 * `[object Object]`.
 */
function flatten(metadata: { getMap(): Record<string, unknown> }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata.getMap())) {
    out[key] = typeof value === 'string'
      ? value
      : Buffer.isBuffer(value) ? value.toString('base64') : String(value);
  }
  return out;
}

/**
 * The metadata this call sends: the request's own block plus applied auth.
 *
 * Exported so the pre-request phase can seed `req.getHeaders()` from the same
 * implementation, rather than from a second copy of this loop that could drift
 * from what is actually sent.
 */
export function buildMetadata(
  request: YamlRequest,
  subst: (value: string) => string,
): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const entry of request.grpc?.metadata ?? []) {
    // The switched-off flag is honoured here rather than at parse time, so the
    // file keeps recording what the author disabled.
    if (entry.disabled) continue;
    metadata[subst(entry.name)] = subst(entry.value);
  }
  return metadata;
}

/**
 * Execute a unary gRPC request.
 *
 * Always resolves. Every failure — a refusal, a transport error, a non-OK status
 * — comes back as a `RequestExecutionResult`, because one unsupported or failing
 * request must not stop the rest of its group.
 */
export async function executeGrpcRequest(
  input: GrpcExecutionInput,
): Promise<TransportOutcome> {
  const {
    request, vars, collectionRoot, rootChain, timeoutMs, oauth2Token, urlOverride, metadataOverrides,
  } = input;
  const block = request.grpc;
  const warnings: string[] = [];
  const subst = (value: string) => substitute(value, vars);

  if (!block) {
    return refuse(request, '', 'Cannot execute a gRPC request with no grpc block', warnings);
  }

  const target = (urlOverride ?? subst(block.url ?? '')).trim();
  if (target.length === 0) {
    return refuse(request, '', 'Cannot execute a gRPC request with an empty target', warnings);
  }

  // Unary only. An absent methodType is unary — that is Bruno's own default — but
  // a declared streaming kind is refused by name rather than attempted, because a
  // stream needs a session and a transcript this result shape cannot hold.
  const methodType = (block.methodType ?? 'unary').trim();
  if (methodType !== 'unary') {
    return refuse(
      request,
      target,
      `Cannot execute a "${methodType}" gRPC method: this server executes unary calls only`,
      warnings,
    );
  }

  const messages = block.messages ?? [];
  if (messages.length > 1) {
    // Count, not selection: neither dialect gives a gRPC message a `selected`
    // flag, so there is no way to say which of several was meant.
    return refuse(
      request,
      target,
      `Cannot execute a gRPC request carrying more than one message (${messages.length} found): `
        + 'a unary call sends exactly one, and neither file format marks which one is selected',
      warnings,
    );
  }

  const method = splitMethodPath(block.method ?? '');
  if (!method) {
    return refuse(
      request,
      target,
      `Cannot execute a gRPC request whose method "${block.method ?? ''}" is not of the form `
        + '/package.Service/Method',
      warnings,
    );
  }

  const validation = await validateUrl(target, {
    allowedSchemes: GRPC_SCHEMES,
    // A gRPC target is commonly written as a bare `host:port`, which is not a URL
    // until it has a scheme. Assuming plaintext matches Bruno, and an author who
    // wants TLS says `grpcs://`.
    defaultScheme: 'grpc',
  });
  if (!validation.valid || !validation.normalisedUrl) {
    const remediation = validation.allowlistOverridable ? ` ${ssrfRemediation()}` : '';
    return refuse(request, target, `Blocked: ${validation.reason ?? 'invalid target'}${remediation}`, warnings);
  }

  // The URL that was checked, never the author's raw string: the two differ
  // whenever normalisation did anything, and dialling a different string than the
  // one validated is the whole DNS-rebinding window this closes.
  const checked = new URL(validation.normalisedUrl);
  const useTls = TLS_SCHEMES.has(checked.protocol);
  const authority = checked.host;
  const addresses = validation.addresses ?? [];

  // Auth before the channel: a mode this transport cannot honour must fail the
  // request rather than open a connection and send it bare.
  const headers: Record<string, string> = {};
  const disposition = applyAuth(
    request.grpc?.auth,
    headers,
    subst,
    warnings,
    [],
    rootChain?.auth,
    oauth2Token,
    'grpc',
  );
  if (disposition.outcome === 'refused') {
    return refuse(request, target, disposition.reason, warnings);
  }
  if (disposition.outcome === 'query') {
    // Unreachable from the disposition table — a query credential is refused for
    // grpc — but stated rather than ignored, so a later table change cannot make
    // this silently drop a credential.
    return refuse(
      request,
      target,
      'Cannot place an api-key in a gRPC target\'s query string: it has none',
      warnings,
    );
  }

  let protoFile: string;
  let protoRoot: string;
  try {
    protoFile = confineProtoPath(block.protoPath ?? '', collectionRoot);
    // The real path of the collection root, which is what the import resolver
    // compares against: a symlinked root would otherwise fail every comparison.
    protoRoot = await realpath(collectionRoot ?? '.');
  } catch (error) {
    if (error instanceof ProtoPathError) {
      return refuse(request, target, error.message, warnings);
    }
    throw error;
  }

  // The namespace, not its `default`. Both packages are CommonJS, so under the
  // test runner's CJS transform there is no `default` to destructure and reading
  // one gives `undefined.credentials`. The named properties are present either
  // way.
  const [grpc, protoLoader] = await Promise.all([
    import('@grpc/grpc-js'),
    import('@grpc/proto-loader'),
  ]);

  let packageDefinition: Awaited<ReturnType<typeof protoLoader.load>>;
  try {
    // Imports are confined before the loader is handed the file. The plan assumed
    // the resolver could be injected into the load; measured, `@grpc/proto-loader`
    // exposes no `resolvePath` option and does not hand back protobufjs's Root, so
    // there is nowhere to inject it. The pre-scan resolves each import through the
    // same confinement instead, which reaches the same decision on the same input.
    await assertProtoImportsConfined(protoFile, protoRoot);
    packageDefinition = await protoLoader.load(protoFile, {
      keepCase: true,
      defaults: true,
      includeDirs: [protoRoot],
    });
  } catch (error) {
    if (error instanceof ProtoPathError) {
      return refuse(request, target, error.message, warnings);
    }
    return refuse(
      request,
      target,
      `Failed to load proto file: ${error instanceof Error ? error.message : String(error)}`,
      warnings,
    );
  }

  const methodPath = `/${method.service}/${method.method}`;
  const definition = packageDefinition[method.service];
  const methodDefinition = definition
    ? (definition as Record<string, unknown>)[method.method]
    : undefined;
  if (!methodDefinition || typeof methodDefinition !== 'object') {
    return refuse(
      request,
      target,
      `The proto file defines no method "${methodPath}". Check the service and method names.`,
      warnings,
    );
  }
  const { requestSerialize, responseDeserialize } = methodDefinition as {
    requestSerialize?: (value: object) => Buffer;
    responseDeserialize?: (bytes: Buffer) => object;
  };
  if (!requestSerialize || !responseDeserialize) {
    return refuse(
      request,
      target,
      `"${methodPath}" is defined in the proto file but not as a callable method`,
      warnings,
    );
  }

  const rawMessage = subst(messages[0]?.content ?? '{}').trim();
  let payload: object;
  try {
    payload = rawMessage.length === 0 ? {} : (JSON.parse(rawMessage) as object);
  } catch (error) {
    return refuse(
      request,
      target,
      `The stored gRPC message is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      warnings,
    );
  }

  const tls = gateTls(request.settings?.tls, checked.hostname);
  let credentials;
  if (useTls) {
    try {
      credentials = grpc.credentials.createSsl(
        tls?.ca ? Buffer.from(tls.ca) : undefined,
        tls?.key ? Buffer.from(tls.key) : undefined,
        tls?.cert ? Buffer.from(tls.cert) : undefined,
        // Only reachable for a host the operator allowlisted for insecure TLS:
        // gateTls has already dropped the field otherwise.
        tls?.rejectUnauthorized === false
          ? { checkServerIdentity: () => undefined }
          : undefined,
      );
    } catch (error) {
      // Deliberately NOT a fallback to createInsecure(), which is what upstream's
      // client does here. A target that asked for TLS and cannot have it must
      // fail; downgrading it silently sends the credential in the clear.
      return refuse(
        request,
        target,
        'Refusing to dial a grpcs:// target without TLS: its credentials could not be built '
          + `(${error instanceof Error ? error.message : String(error)}), and falling back to an `
          + 'insecure channel would send the request in the clear',
        warnings,
      );
    }
  } else {
    credentials = grpc.credentials.createInsecure();
  }

  const options: Record<string, unknown> = {
    // Never proxied. See the module comment: grpc-js reads ambient http_proxy and
    // undici does not, so this is what keeps a validated call from being routed
    // somewhere else entirely.
    'grpc.enable_http_proxy': 0,
  };
  if (addresses.length > 0) {
    // An address is being dialled in place of the name, so the authority has to be
    // restored explicitly or virtual-host routing sees the IP.
    options['grpc.default_authority'] = authority;
    if (useTls) {
      options['grpc.ssl_target_name_override'] = checked.hostname;
    }
    options['grpc.dns_resolver'] = 'native';
  }

  const client = new grpc.Client(
    checked.host,
    credentials,
    // The pinned lookup closes the window between validation and connect. Omitted
    // when nothing was pinned: an empty list fails closed with ENOTFOUND, which
    // would read as a DNS failure on the allowlisted-hostname path.
    addresses.length > 0
      ? { ...options, 'grpc.node.lookup': pinnedLookup(addresses) }
      : options,
  );

  const metadataRecord = {
    ...buildMetadata(request, subst),
    ...headers,
    ...(metadataOverrides ?? {}),
  };
  const metadata = new grpc.Metadata();
  for (const [name, value] of Object.entries(metadataRecord)) {
    metadata.set(name, value);
  }

  const startedAt = Date.now();
  const outcome = await new Promise<{ detail: GrpcResultDetail; body?: string }>((resolve) => {
    // Both the callback and the `status` event are awaited, in whichever order
    // grpc-js delivers them. The callback carries the response or the error; only
    // the status event carries the TRAILING metadata, which on a successful call
    // is the sole place it appears. Resolving on the first of the two would drop
    // the trailers on success or the response on failure, depending on the order.
    let status: { code: number; details: string; metadata?: unknown } | undefined;
    let response: object | undefined;
    let failure: { code?: number; details?: string; message: string } | undefined;
    let called = false;
    let settled = false;

    const finish = () => {
      if (settled || !status || !called) return;
      settled = true;
      const trailers = status.metadata instanceof grpc.Metadata
        ? redactMetadata(flatten(status.metadata))
        : undefined;
      resolve({
        detail: {
          code: status.code,
          details: failure?.details || status.details || (status.code === grpc.status.OK ? 'OK' : ''),
          ...(trailers ? { trailers } : {}),
        },
        ...(failure ? {} : { body: JSON.stringify(response ?? {}) }),
      });
    };

    const call = client.makeUnaryRequest<object, object>(
      methodPath,
      (value) => requestSerialize(value),
      (bytes) => responseDeserialize(bytes),
      payload,
      metadata,
      // grpc-js has no implicit deadline. Without one, a server that accepts and
      // never answers blocks this request, its group and the whole tool call.
      timeoutMs > 0 ? { deadline: Date.now() + timeoutMs } : {},
      (error, value) => {
        called = true;
        if (error) failure = { code: error.code, details: error.details, message: error.message };
        else response = value;
        finish();
      },
    );
    call.on('status', (received: { code: number; details: string; metadata?: unknown }) => {
      status = received;
      finish();
    });
  });
  client.close();

  const durationMs = Date.now() - startedAt;

  return {
    result: {
      name: request.info.name,
      method: 'GRPC',
      url: redactUrl(validation.normalisedUrl),
      // Left at the refusal sentinel on purpose: gRPC's OK code is also 0, so the
      // code lives in `grpc.code` and the presence of `grpc` is what says the call
      // happened at all.
      status: 0,
      duration_ms: durationMs,
      tests: [],
      ...(warnings.length > 0 ? { warnings } : {}),
      grpc: outcome.detail,
      ...(outcome.body !== undefined
        ? { response_body: outcome.body, response_content_type: 'application/json' }
        : {}),
    },
    // A call that reached the server is verifiable whatever its status: asserting
    // that a request is correctly REFUSED — PERMISSION_DENIED, UNAUTHENTICATED —
    // is the whole point of an authorization test, so a non-OK code must still
    // reach the author's assertions.
    response: grpcResponse(outcome.detail, outcome.body ?? '', durationMs),
  };
}
