/**
 * Turning an auth block into the header or query parameter it stands for.
 *
 * Split out of `request-executor.ts` when digest and oauth2 joined it (L3):
 * that file sits on the repo-wide `max-lines` ceiling, and this is the part of
 * it with one job and no I/O.
 *
 * Two of the modes here do not finish their work in this function, and cannot.
 * `digest` needs a nonce the server has not issued yet, so it contributes
 * nothing on the first request and is completed by the challenge retry in the
 * executor. `oauth2` needs a token fetched from another endpoint, so the token
 * arrives as an argument and this only decides where to put it. Everything else
 * is decidable from the request alone.
 */
import { isAutomatableGrant } from './auth-oauth2.js';
import type { YamlAuth } from './types.js';

/**
 * Placement values that put an api-key credential in the query string.
 *
 * Bruno writes `queryparams` (its schema allows only `'header' | 'queryparams'`)
 * while this tool's own surface says `query`, and the field is spelled `in` on
 * one path and `placement` on the other. Reading a single spelling and letting
 * everything else fall through to the header branch meant a request authored in
 * Bruno sent its credential as a HEADER NAMED AFTER THE QUERY PARAMETER — to a
 * server that was never going to look there, while the header went out anyway.
 */
const QUERY_PLACEMENTS = new Set(['query', 'queryparams']);

/** True when an api-key auth block asks for the credential in the query string. */
function isQueryPlacement(auth: Exclude<YamlAuth, 'inherit'>): boolean {
  const placement = auth.in ?? auth.placement;
  return typeof placement === 'string' && QUERY_PLACEMENTS.has(placement.toLowerCase());
}

/** Which transport the credential is being prepared for. */
export type AuthTransport = 'http' | 'grpc' | 'ws';

/**
 * What the caller must do after this function returns.
 *
 * `refused` is the outcome this module was missing. Two of its branches are
 * HTTP-shaped in a way that does not travel: a query-placed api-key is handed
 * back for the caller to append to a URL, and a gRPC target has no query string;
 * digest deliberately sends nothing on the first request because the HTTP path
 * answers the 401 challenge and retries, and a gRPC call never receives one.
 * Both used to end in "no credential and no complaint" for those transports,
 * which is the one outcome this module exists to prevent.
 *
 * A refusal is not a warning. A warning means the request goes out anyway; a
 * refusal means it must not.
 */
export type AuthDisposition =
  /** Nothing left to do: a header was placed, or there was nothing to send. */
  | { outcome: 'done' }
  /** The credential belongs in the target's query string; the caller appends it. */
  | { outcome: 'query'; key: string; value: string }
  /** This mode cannot be honoured on this transport. The request must not be sent. */
  | { outcome: 'refused'; reason: string };

const DONE: AuthDisposition = { outcome: 'done' };

/**
 * Modes that place an ordinary request header, and so work on every transport.
 *
 * gRPC carries them as metadata and a WebSocket carries them on the handshake,
 * but both are a name/value list built from the same `headers` record this
 * function writes into — which is why nothing here has to know the difference.
 */
const HEADER_MODES = new Set(['bearer', 'basic', 'api-key', 'apikey', 'oauth2']);

/**
 * Decide whether a mode is honourable on a non-HTTP transport, before any
 * credential is placed.
 *
 * Returning a reason rather than a boolean because the reason is the point: an
 * agent that gets "digest is not applied" can fix the file, and one that gets a
 * bare failure cannot. Only reached for `grpc` and `ws`; the HTTP dispositions
 * are left exactly as they were, warnings included.
 */
function refuseOnTransport(
  auth: Exclude<YamlAuth, 'inherit'>,
  transport: AuthTransport,
): AuthDisposition | undefined {
  if (transport === 'http') return undefined;
  const mode = String(auth.type ?? 'none');
  if (mode === 'none') return undefined;

  if (mode === 'digest') {
    return {
      outcome: 'refused',
      reason: `auth mode "digest" cannot be applied to a ${transport} request: the credential is a `
        + 'hash over a nonce the server issues in a 401 challenge, and this transport has no such '
        + 'challenge to answer. Use bearer, basic or a header api-key.',
    };
  }

  // A `ws://` URL carries a query string exactly as an `http://` one does, and a
  // token in the query is a common way to authenticate a socket — so this refusal
  // is gRPC's alone. Refusing it for WebSocket would have been a refusal whose
  // stated reason was false.
  if ((mode === 'api-key' || mode === 'apikey') && isQueryPlacement(auth) && transport === 'grpc') {
    return {
      outcome: 'refused',
      reason: 'auth mode "api-key" with query placement cannot be applied to a grpc request: a grpc '
        + 'target has no query string to append it to. Move the credential to header placement.',
    };
  }

  if (mode === 'oauth2') {
    const grant = String((auth as { grantType?: unknown }).grantType ?? '');
    if (!isAutomatableGrant(grant)) {
      return {
        outcome: 'refused',
        reason: `auth mode "oauth2" with grant "${grant || 'unset'}" cannot be applied to a `
          + `${transport} request: the grant is defined around redirecting a browser to the provider `
          + 'and catching the redirect back, which this server has no way to do. Use the '
          + 'client_credentials or password grant, or fetch the token out of band.',
      };
    }
    return undefined;
  }

  if (!HEADER_MODES.has(mode)) {
    // awsv4, wsse, ntlm and anything the parser accepted that this does not
    // model. On HTTP these warn and the request still goes out; for a transport
    // being taught from scratch there is no reason to inherit that.
    return {
      outcome: 'refused',
      reason: `auth mode "${mode}" is not applied to a ${transport} request: this server has no `
        + 'implementation for it. Send the credential as a header, or set it from a pre-request '
        + 'script.',
    };
  }

  return undefined;
}

/**
 * Apply a request's auth to the outgoing headers, and say what is left to do.
 *
 * Header-based schemes (bearer, basic, header api-key) mutate `headers` in
 * place. A query api-key comes back as `{outcome: 'query'}` so the caller can
 * append it to the target. Schemes that cannot be honoured automatically on the
 * HTTP path — a browser-redirect oauth2 grant, `inherit` from a tree that defines
 * no auth — are pushed to `warnings` and produce no header, so a run never
 * silently sends an unauthenticated request while claiming the auth was
 * configured.
 *
 * On a non-HTTP transport the same principle needs a stronger outcome, because
 * some of those "no header, plus a warning" cases are HTTP-shaped: digest is
 * finished by the 401 retry that gRPC never receives, and a query credential
 * needs a query string a gRPC target does not have. Those come back as
 * `{outcome: 'refused'}` with the reason, and the caller must not send the
 * request. See `refuseOnTransport` for the table.
 */
export function applyAuth(
  auth: YamlAuth | undefined,
  headers: Record<string, string>,
  subst: (value: string) => string,
  warnings: string[],
  authHeaderNames: string[],
  inheritedAuth?: YamlAuth,
  token?: string,
  // Defaults to http so the existing call site needs no change, and so a new
  // transport has to name itself to get the stricter dispositions rather than
  // acquiring them by accident.
  transport: AuthTransport = 'http',
): AuthDisposition {
  if (!auth) {
    return DONE;
  }
  if (auth === 'inherit') {
    // Resolved from the nearest collection/folder root that defines auth. Still
    // warns when no root does: `inherit` from nothing sends no credential, and
    // that has to be said rather than looking like a request without auth.
    if (!inheritedAuth || inheritedAuth === 'inherit') {
      warnings.push(
        'auth is set to "inherit", but no collection or folder root defines auth; no credential was sent',
      );
      return DONE;
    }
    // The transport travels with the recursion. Without it, inheriting digest on a
    // grpc request would resolve to the root credential and then be applied by the
    // HTTP rules — sending the request bare while the file claims a credential.
    return applyAuth(
      inheritedAuth, headers, subst, warnings, authHeaderNames, undefined, token, transport,
    );
  }

  // Before any credential is placed: a mode this transport cannot honour must
  // leave no header behind, or a later change to the order would leak one.
  const refusal = refuseOnTransport(auth, transport);
  if (refusal) return refusal;

  switch (auth.type) {
    case undefined: {
      // A block with no `type` is not the same as no block at all. `parseAuth`
      // is a passthrough, so a file that spells the mode any other way arrives
      // here intact and would otherwise be indistinguishable from `auth: none`
      // — the file claims a credential and the request goes out bare, which is
      // the exact failure the `default:` branch below exists to prevent. An
      // unrecognised VALUE was already loud; an unrecognised SHAPE was silent.
      //
      // `mode` is worth naming rather than lumping in with the rest, because it
      // is the one wrong guess a careful author makes: it is Bruno's in-memory
      // spelling, and collection and folder roots genuinely do use it on disk,
      // where `normalizeRootAuth` translates it. Requests are not translated.
      const keys = Object.keys(auth);
      if (keys.length > 0) {
        const named = keys.includes('mode')
          ? ' On disk a request spells its mode `type`, not `mode` — `mode` is the '
            + 'collection/folder root spelling.'
          : '';
        warnings.push(
          `auth block has no "type" key, so it could not be interpreted and no credential was `
            + `sent. Keys present: ${keys.join(', ')}.${named}`,
        );
      }
      return DONE;
    }

    case 'none':
      return DONE;

    case 'bearer': {
      const token = subst(String(auth.token ?? ''));
      if (token.length === 0) {
        warnings.push('bearer auth has no token; no Authorization header was sent');
        return DONE;
      }
      headers['Authorization'] = `Bearer ${token}`;
      authHeaderNames.push('Authorization');
      return DONE;
    }

    case 'basic': {
      const username = subst(String(auth.username ?? ''));
      const password = subst(String(auth.password ?? ''));
      headers['Authorization'] =
        'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
      authHeaderNames.push('Authorization');
      return DONE;
    }

    case 'api-key':
    case 'apikey': {
      const key = subst(String(auth.key ?? ''));
      const value = subst(String(auth.value ?? ''));
      if (key.length === 0) {
        warnings.push('api-key auth has no key name; no credential was sent');
        return DONE;
      }
      if (isQueryPlacement(auth)) {
        return { outcome: 'query', key, value };
      }
      headers[key] = value;
      authHeaderNames.push(key);
      return DONE;
    }

    case 'digest': {
      // Nothing to send yet, and nothing to warn about: the credential is a
      // hash over a nonce the server has not issued. `executeSingleRequest`
      // answers the 401 challenge and re-sends.
      return DONE;
    }

    case 'oauth2': {
      const grant = String((auth as { grantType?: unknown }).grantType ?? '');
      if (!isAutomatableGrant(grant)) {
        warnings.push(
          `auth type "oauth2" with grant "${grant || 'unset'}" is not applied: it is defined around redirecting a browser to the provider and catching the redirect back, which this server has no way to do. Fetch the token out of band and set the header in a pre-request script, or use the client_credentials or password grant.`,
        );
        return DONE;
      }
      if (token === undefined) {
        // The fetch failed; the reason is already a warning from the caller.
        return DONE;
      }
      headers.Authorization = `Bearer ${token}`;
      authHeaderNames.push('Authorization');
      return DONE;
    }

    default: {
      // Every mode this tool knows now has a branch above, so reaching here
      // means the file names something the parser accepted and this does not
      // model — a typo, or a Bruno feature not learned yet. Both are the
      // author's to fix, and both are worse as a silent unauthenticated
      // request than as a warning.
      warnings.push(
        `auth type "${String(auth.type)}" is not applied because it is not recognised; no credential was sent. Send the credential via a header or a pre-request script.`,
      );
      return DONE;
    }
  }
}
