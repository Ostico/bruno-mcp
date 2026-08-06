/**
 * HTTP Digest access authentication (RFC 7616, and the RFC 2617 shape still in
 * the wild).
 *
 * Digest could not be applied before because it is the one scheme that cannot
 * be decided from the request alone: the server issues a nonce in a 401, and
 * the credential is a hash over that nonce. So it is not a header this can
 * compute up front — it needs the challenge, which means sending the request,
 * being refused, and sending it again. `request-executor.ts` does that one
 * retry; everything about *what* to send lives here.
 *
 * What is supported: `qop=auth` and the no-qop RFC 2069 form, with MD5,
 * MD5-sess, SHA-256 and SHA-256-sess. What is not: `qop=auth-int`, which hashes
 * the request body and is essentially unused — an unsupported qop returns null
 * rather than a wrong header, so the caller reports the 401 it already has
 * instead of inventing a credential the server will reject anyway.
 */
import { createHash, randomBytes } from 'node:crypto';
import { substitute } from './env-loader.js';
import type { YamlRequest, YamlAuth } from './types.js';
import type { RootChain } from './collection-roots.js';

export interface DigestCredentials {
  username: string;
  password: string;
}

/**
 * The `Authorization` header to retry a refused request with, or null.
 *
 * Null covers every ordinary case: the request is not using digest, the server
 * did not refuse it, or it refused without a Digest challenge. Only a 401
 * carrying a challenge this can answer produces a header, so a request that is
 * not doing digest auth pays one status-code comparison.
 *
 * `{{placeholders}}` are resolved here rather than at build time because
 * nothing resolved them earlier — digest contributes no header to the first
 * request, so its credentials were never substituted on the way out.
 */
export function digestRetryHeader(
  yaml: YamlRequest,
  rootChain: RootChain | undefined,
  response: { status: number; headers: { get(name: string): string | null } },
  url: string,
  method: string,
  vars: Map<string, string>,
): string | null {
  if (response.status !== 401) {
    return null;
  }

  // Digest is answered by re-sending an http request, so a kind with no http
  // block cannot participate — and it never reaches here, because only the http
  // path produces a 401 to answer.
  const declared = yaml.http?.auth;
  const mode = typeof declared === 'string' ? declared : declared?.type;
  const effective: YamlAuth | undefined =
    mode === 'inherit' ? rootChain?.auth : (declared as YamlAuth | undefined);
  if (!effective || typeof effective !== 'object' || effective.type !== 'digest') {
    return null;
  }

  const challenge = parseDigestChallenge(response.headers.get('www-authenticate'));
  if (!challenge) {
    return null;
  }

  const credential = (key: 'username' | 'password'): string => {
    const raw = (effective as Record<string, unknown>)[key];
    return typeof raw === 'string' ? substitute(raw, vars) : '';
  };

  return buildDigestHeader(
    challenge,
    { username: credential('username'), password: credential('password') },
    method,
    url,
  );
}

/** The pieces of a `WWW-Authenticate: Digest ...` header that matter here. */
export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm?: string;
}

/**
 * Pull the Digest challenge out of a `WWW-Authenticate` header.
 *
 * A server may offer several schemes in one header (`Basic realm="x", Digest
 * realm="y"`), so this looks for the Digest one specifically rather than
 * assuming the header is all Digest. Returns null when there is no Digest
 * challenge to answer.
 */
export function parseDigestChallenge(header: string | null): DigestChallenge | null {
  if (!header) {
    return null;
  }
  const start = header.search(/(^|,)\s*Digest\s/i);
  if (start === -1) {
    return null;
  }

  const params: Record<string, string> = {};
  // Values are quoted strings or bare tokens; `algorithm` and `qop` are
  // commonly unquoted, `nonce` and `realm` commonly quoted.
  const pattern = /(\w+)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(header.slice(start))) !== null) {
    params[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? '';
  }

  if (!params.nonce) {
    // Without a nonce there is nothing to hash against; treat it as no
    // challenge rather than guessing an empty one.
    return null;
  }

  return {
    realm: params.realm ?? '',
    nonce: params.nonce,
    qop: params.qop,
    opaque: params.opaque,
    algorithm: params.algorithm,
  };
}

function hasher(algorithm: string | undefined): ((input: string) => string) | null {
  const base = (algorithm ?? 'MD5').replace(/-sess$/i, '').toUpperCase();
  const nodeName = base === 'MD5' ? 'md5' : base === 'SHA-256' ? 'sha256' : null;
  if (!nodeName) {
    return null;
  }
  return (input: string) => createHash(nodeName).update(input).digest('hex');
}

/**
 * Which qop to answer with.
 *
 * The header may offer a list (`qop="auth,auth-int"`); `auth` is picked
 * whenever it is on offer. An offer of only `auth-int` is unsupported.
 */
function chooseQop(offered: string | undefined): string | null | undefined {
  if (offered === undefined || offered.trim().length === 0) {
    return undefined; // RFC 2069: no qop in the response either.
  }
  const options = offered.split(',').map((value) => value.trim().toLowerCase());
  return options.includes('auth') ? 'auth' : null;
}

function quoted(value: string): string {
  // Escaping matters: a realm containing a quote would otherwise end the field
  // early and change which parameters the server reads.
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Build the `Authorization` header answering a challenge, or null when the
 * challenge asks for something unsupported.
 *
 * `nonceCount` starts at 1 for a given nonce. This sends one request per
 * challenge, so it is always 1 here; it is a parameter because the value is
 * part of the hash and a reader should see why it is not simply absent.
 */
export function buildDigestHeader(
  challenge: DigestChallenge,
  credentials: DigestCredentials,
  method: string,
  url: string,
  nonceCount = 1,
  cnonce: string = randomBytes(8).toString('hex'),
): string | null {
  const hash = hasher(challenge.algorithm);
  const qop = chooseQop(challenge.qop);
  if (!hash || qop === null) {
    return null;
  }

  // The digest URI is the request-target: path and query, not the whole URL.
  const target = (() => {
    try {
      const parsed = new URL(url);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return url;
    }
  })();

  const sess = /-sess$/i.test(challenge.algorithm ?? '');
  const ha1Base = hash(`${credentials.username}:${challenge.realm}:${credentials.password}`);
  const ha1 = sess ? hash(`${ha1Base}:${challenge.nonce}:${cnonce}`) : ha1Base;
  const ha2 = hash(`${method.toUpperCase()}:${target}`);

  const nc = nonceCount.toString(16).padStart(8, '0');
  const response = qop
    ? hash(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : hash(`${ha1}:${challenge.nonce}:${ha2}`);

  const fields = [
    `username=${quoted(credentials.username)}`,
    `realm=${quoted(challenge.realm)}`,
    `nonce=${quoted(challenge.nonce)}`,
    `uri=${quoted(target)}`,
    `response=${quoted(response)}`,
  ];
  if (challenge.algorithm) {
    fields.push(`algorithm=${challenge.algorithm}`);
  }
  if (qop) {
    fields.push(`qop=${qop}`, `nc=${nc}`, `cnonce=${quoted(cnonce)}`);
  }
  if (challenge.opaque !== undefined) {
    fields.push(`opaque=${quoted(challenge.opaque)}`);
  }

  return `Digest ${fields.join(', ')}`;
}
