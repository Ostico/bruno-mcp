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

/**
 * Apply a request's auth to the outgoing headers.
 *
 * Header-based schemes (bearer, basic, header api-key) mutate `headers` in
 * place. A query api-key is returned so the caller can append it to the URL.
 * Schemes we cannot honour automatically — oauth2 and digest need a flow,
 * `inherit` needs collection/folder resolution we do not model — are pushed to
 * `warnings` and produce no header, so a run never silently sends an
 * unauthenticated request while claiming the auth was configured.
 */
export function applyAuth(
  auth: YamlAuth | undefined,
  headers: Record<string, string>,
  subst: (value: string) => string,
  warnings: string[],
  authHeaderNames: string[],
  inheritedAuth?: YamlAuth,
  token?: string,
): { key: string; value: string } | undefined {
  if (!auth) {
    return undefined;
  }
  if (auth === 'inherit') {
    // Resolved from the nearest collection/folder root that defines auth. Still
    // warns when no root does: `inherit` from nothing sends no credential, and
    // that has to be said rather than looking like a request without auth.
    if (!inheritedAuth || inheritedAuth === 'inherit') {
      warnings.push(
        'auth is set to "inherit", but no collection or folder root defines auth; no credential was sent',
      );
      return undefined;
    }
    return applyAuth(inheritedAuth, headers, subst, warnings, authHeaderNames, undefined, token);
  }

  switch (auth.type) {
    case undefined:
    case 'none':
      return undefined;

    case 'bearer': {
      const token = subst(String(auth.token ?? ''));
      if (token.length === 0) {
        warnings.push('bearer auth has no token; no Authorization header was sent');
        return undefined;
      }
      headers['Authorization'] = `Bearer ${token}`;
      authHeaderNames.push('Authorization');
      return undefined;
    }

    case 'basic': {
      const username = subst(String(auth.username ?? ''));
      const password = subst(String(auth.password ?? ''));
      headers['Authorization'] =
        'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
      authHeaderNames.push('Authorization');
      return undefined;
    }

    case 'api-key':
    case 'apikey': {
      const key = subst(String(auth.key ?? ''));
      const value = subst(String(auth.value ?? ''));
      if (key.length === 0) {
        warnings.push('api-key auth has no key name; no credential was sent');
        return undefined;
      }
      if (isQueryPlacement(auth)) {
        return { key, value };
      }
      headers[key] = value;
      authHeaderNames.push(key);
      return undefined;
    }

    case 'digest': {
      // Nothing to send yet, and nothing to warn about: the credential is a
      // hash over a nonce the server has not issued. `executeSingleRequest`
      // answers the 401 challenge and re-sends.
      return undefined;
    }

    case 'oauth2': {
      const grant = String((auth as { grantType?: unknown }).grantType ?? '');
      if (!isAutomatableGrant(grant)) {
        warnings.push(
          `auth type "oauth2" with grant "${grant || 'unset'}" is not applied: it is defined around redirecting a browser to the provider and catching the redirect back, which this server has no way to do. Fetch the token out of band and set the header in a pre-request script, or use the client_credentials or password grant.`,
        );
        return undefined;
      }
      if (token === undefined) {
        // The fetch failed; the reason is already a warning from the caller.
        return undefined;
      }
      headers.Authorization = `Bearer ${token}`;
      authHeaderNames.push('Authorization');
      return undefined;
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
      return undefined;
    }
  }
}
