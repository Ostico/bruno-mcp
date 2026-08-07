/**
 * Turning a parsed request into the arguments `fetch` actually receives.
 *
 * Split out of `request-executor.ts` because that file sits against the 1300-line
 * `max-lines` ceiling and the two new transports have to land in it. This is a
 * clean seam rather than a convenient one: shaping an HTTP request is a single
 * decision with one caller, so moving it does not split a decision across two
 * files.
 */

import { applyAuth } from './auth-apply.js';
import { confineUploadPath } from './upload-path.js';
import { appendQueryCredential } from './request-redaction.js';
import {
  SINGLE_VALUE_HEADERS,
  appendHeader,
  BODY_TYPE_CONTENT_TYPES,
  setDefaultContentType,
  replaceContentType,
} from './request-headers.js';
import { stripJsonComments, describeJsonSyntaxError } from './json-body.js';
import { substitute, findUnresolvedPlaceholders } from './env-loader.js';
import { applyParams } from './request-params.js';
import { buildGraphqlBody, buildFileBody, buildFormUrlEncodedBody } from './request-body.js';
import { BrunoError } from './types.js';
import { readFile } from 'fs/promises';
import { basename } from 'path';
import type { RootChain } from './collection-roots.js';
import type {
  YamlRequest,
  MultipartFormPart,
  FormUrlEncodedPart,
  BruFilePart,
  BruGraphql,
} from './types.js';

type HttpBody = NonNullable<YamlRequest['http']>['body'];

/**
 * Takes a present body, so the caller narrows before asking rather than after.
 *
 * It used to accept `HttpBody | undefined` and return a plain `boolean`, which
 * left the one caller writing `body!.data`: a non-null assertion whose
 * correctness rested on a guard the compiler could not see, and which would have
 * gone on compiling if that guard ever stopped checking for absence. Neither a
 * predicate nor a cast is needed once absence is handled where it is known.
 */
function isMultipartBody(body: NonNullable<HttpBody>): boolean {
  return (
    (body.type === 'multipart-form' || body.type === 'form-data') &&
    Array.isArray(body.data)
  );
}


export async function buildFetchOptions(
  yaml: YamlRequest,
  vars: Map<string, string>,
  collectionRoot?: string,
  rootChain?: RootChain,
  /** An oauth2 access token already fetched for this request, if any. */
  oauth2Token?: string,
): Promise<{
  url: string;
  options: RequestInit;
  warnings?: string[];
  authHeaderNames?: string[];
  /**
   * Query-parameter names a credential was placed under. Feeds redactUrl, whose
   * built-in list cannot know a collection-chosen parameter name.
   */
  authQueryNames?: string[];
}> {
  // Surface any {{var}} that substitution could not resolve so an
  // unsubstituted placeholder can no longer reach the wire silently. The
  // failure mode is starkest across groups — a variable set by a script in one
  // group is invisible to every other group's requests, by design — but an
  // unresolved placeholder is a latent bug within one serial group too. Detection
  // runs on the ORIGINAL templates below, not the substituted output, so a
  // resolved value that itself contains `{{...}}` is never mis-flagged
  // (substitution is deliberately single-pass). Names accumulate across every
  // substituted surface (url, headers, auth, body).
  const unresolvedNames = new Set<string>();
  const trackUnresolved = (template: string): void => {
    for (const name of findUnresolvedPlaceholders(template, vars)) {
      unresolvedNames.add(name);
    }
  };

  // HTTP-only by contract. A grpc or ws request has no http block and is refused
  // by the caller before it reaches here; narrowing once keeps the rest of this
  // function reading as it did when the field was mandatory, and turns a would-be
  // TypeError deep in the pipeline into a named error at the boundary.
  const http = yaml.http;
  if (!http) {
    throw new BrunoError(
      `Cannot build an HTTP request from a "${yaml.info.type ?? 'http'}" request: it has no http block`,
      'VALIDATION_ERROR',
    );
  }

  trackUnresolved(http.url);
  let url = substitute(http.url, vars);

  // Applied here, before validateUrl below, so the URL that is checked is the
  // one actually sent — a parameter must never be able to slip past the check.
  url = applyParams(url, http.params, (raw) => {
    trackUnresolved(raw);
    return substitute(raw, vars);
  });

  const headers: Record<string, string> = {};
  // Maps a lowercased header name to the key actually used in `headers`, so a
  // repeat under different casing lands on the first occurrence's casing
  // instead of creating a second entry.
  const headerKeys = new Map<string, string>();
  // Counted per lowercased name so a singleton header repeated N times warns
  // once, on the transition to the second occurrence, rather than N-1 times.
  const headerCounts = new Map<string, number>();
  const headerWarnings: string[] = [];

  // Collection/folder root headers go on FIRST, and any name the request sets
  // itself is left out of them entirely. Two reasons for dropping rather than
  // overwriting: appendHeader would otherwise comma-join the two values and send
  // a doubled credential, and upstream's own merge is a Map filled
  // root-then-request, where the later write simply replaces the earlier one.
  // Matched case-insensitively, which upstream does not do — it keys on the name
  // as written, so a collection's `authorization` and a request's
  // `Authorization` both go out. Header names are case-insensitive per HTTP, so
  // that pairing is exactly the doubled-credential case worth avoiding.
  if (rootChain && rootChain.headers.length > 0) {
    const ownNames = new Set(
      (http.headers ?? [])
        .filter(h => h.disabled !== true)
        .map(h => substitute(h.name, vars).toLowerCase()),
    );
    // Nearest root wins among the roots themselves: the chain arrives
    // collection-first, so a later set() replaces an outer folder's header.
    const nearest = new Map<string, { name: string; value: string }>();
    for (const h of rootChain.headers) {
      const headerName = substitute(h.name, vars);
      nearest.set(headerName.toLowerCase(), { name: headerName, value: h.value });
    }
    for (const [lower, h] of nearest) {
      if (ownNames.has(lower)) {
        continue;
      }
      trackUnresolved(h.name);
      trackUnresolved(h.value);
      appendHeader(headers, headerKeys, h.name, substitute(h.value, vars));
    }
  }

  if (http.headers) {
    for (const h of http.headers) {
      // A header explicitly disabled in the collection must not be sent.
      // Skip before substituting, so a disabled header's placeholders are not
      // reported as unresolved either.
      if (h.disabled === true) continue;
      trackUnresolved(h.value);
      // The NAME is substituted and tracked too. A header authored as
      // `{{tokenHeader}}: abc` otherwise went out with the literal
      // `{{tokenHeader}}` as its field name, and the unresolved-variable report
      // — the mechanism that stops an unsubstituted placeholder reaching the
      // wire silently — never mentioned it.
      trackUnresolved(h.name);
      const headerName = substitute(h.name, vars);
      // Keyed off the SUBSTITUTED name: the duplicate and single-value
      // bookkeeping is about the field actually sent, so two different templates
      // resolving to the same field have to collapse onto one entry.
      const lower = headerName.toLowerCase();
      const occurrence = (headerCounts.get(lower) ?? 0) + 1;
      headerCounts.set(lower, occurrence);
      if (occurrence === 2 && SINGLE_VALUE_HEADERS.has(lower)) {
        // Name only, never the value: a repeated Authorization or Cookie
        // carries a credential, and warnings surface to the caller.
        headerWarnings.push(
          `Header "${headerKeys.get(lower) ?? headerName}" is defined by HTTP as a single-value field but is set more than once; the values were combined into one and the server may reject the request. Remove the duplicate.`,
        );
      }
      appendHeader(headers, headerKeys, headerName, substitute(h.value, vars));
    }
  }

  // Apply the request's auth on the wire: it was authored and
  // parsed but never sent. Header-based schemes mutate `headers`; a query
  // api-key comes back to be appended to the URL; a scheme we cannot apply
  // automatically is surfaced as a warning rather than dropped in silence.
  const authWarnings: string[] = [];
  const authHeaderNames: string[] = [];
  const authQueryNames: string[] = [];
  const queryAuth = applyAuth(
    http.auth,
    headers,
    s => {
      trackUnresolved(s);
      return substitute(s, vars);
    },
    authWarnings,
    authHeaderNames,
    rootChain?.auth,
    oauth2Token,
  );
  // `refused` is unreachable from here: nothing refuses on the http transport,
  // which is this call's default. The non-HTTP transports name themselves when
  // they call applyAuth, and it is their business to fail the request by name.
  if (queryAuth.outcome === 'query') {
    url = appendQueryCredential(url, queryAuth.key, queryAuth.value);
    // Registered so the redactor can mask this value on the way back out. The
    // header path registers its names for the same reason; a query-placed
    // credential skipping registration meant it was the one credential that
    // reached the caller in the clear, because the reported URL contains it.
    authQueryNames.push(queryAuth.key);
  }

  const options: RequestInit = {
    method: http.method,
    headers,
  };

  const bodyWarnings: string[] = [];
  const body = http.body;
  if (body && isMultipartBody(body)) {
    const form = new FormData();
    const parts = body.data as MultipartFormPart[];

    for (const part of parts) {
      // A part explicitly disabled in the collection must not be sent.
      // Skip before tracking/substituting so a disabled part's
      // placeholders never reach the wire nor raise a warning.
      if (part.enabled === false) continue;
      if (part.contentType) trackUnresolved(part.contentType);
      const contentType = part.contentType
        ? substitute(part.contentType, vars)
        : undefined;

      if (part.type === 'file') {
        const paths = Array.isArray(part.value) ? part.value : [part.value];
        for (const rawPath of paths) {
          trackUnresolved(String(rawPath));
          const filePath = substitute(String(rawPath), vars);
          // A file-part path is collection-controlled; confine the read to the
          // collection root so a collection cannot exfiltrate arbitrary host
          // files.
          const resolvedPath = confineUploadPath(filePath, collectionRoot);
          const buf = await readFile(resolvedPath);
          form.append(
            part.name,
            new Blob([buf], { type: contentType || 'application/octet-stream' }),
            basename(resolvedPath),
          );
        }
      } else {
        const values = Array.isArray(part.value) ? part.value : [part.value];
        for (const rawValue of values) {
          trackUnresolved(String(rawValue));
          const value = substitute(String(rawValue), vars);
          if (contentType) {
            form.append(part.name, new Blob([value], { type: contentType }));
          } else {
            form.append(part.name, value);
          }
        }
      }
    }

    options.body = form;

    // undici sets the multipart boundary itself; a user-provided Content-Type
    // header would clobber the boundary, so strip it.
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-type') {
        delete headers[key];
      }
    }
  } else if (body?.type === 'graphql' && !Array.isArray(body.data)) {
    // Ahead of the plain-string branch on purpose: a graphql query this tool
    // wrote is stored as bare text, and the string branch would claim it and
    // send it with no JSON envelope around it.
    //
    // Entered even with nothing stored, because upstream sends an envelope
    // regardless: `prepare-request.js:443` builds one from a `body.graphql` that
    // may be absent, which is what a `.bru` file declaring `body: graphql` with
    // no `body:graphql` block parses to. Skipping the branch there would send no
    // body at all and no `application/json` either.
    options.body = buildGraphqlBody(
      body.data as BruGraphql | string | undefined,
      vars,
      trackUnresolved,
      (m) => bodyWarnings.push(m),
    );
    setDefaultContentType(headers, 'application/json');
  } else if (typeof body?.data === 'string') {
    trackUnresolved(body.data);
    // Comments come out before substitution, not after, so that a variable whose
    // value happens to contain `//` keeps it. Upstream strips at the same point,
    // in prepare-request, which runs before interpolate-vars.
    const source = body.type === 'json' ? stripJsonComments(body.data) : body.data;
    // A JSON body is a document, not free text: a generator that produces a
    // newline or a quote has to be escaped on the way in, or the body the author
    // wrote stops parsing. Other modes take the generated value as-is.
    options.body = substitute(source, vars, { escapeJSONStrings: body.type === 'json' });
    if (body.type === 'json') {
      // Checked after substitution, because that is the text the server sees, and
      // only when every placeholder resolved: an unresolved `{{id}}` is invalid
      // JSON by definition and already has a warning of its own to answer for it.
      const malformed = unresolvedNames.size === 0 ? describeJsonSyntaxError(options.body) : undefined;
      if (malformed !== undefined) {
        bodyWarnings.push(
          `this json body is not valid json (${malformed}), so the server will reject it. ` +
            'Sent rather than refused because Bruno sends an unparseable body too.',
        );
      }
    }
    const implied = BODY_TYPE_CONTENT_TYPES[body.type];
    if (implied !== undefined) setDefaultContentType(headers, implied);
  } else if (body?.type === 'file' && Array.isArray(body.data)) {
    // The octet-stream default goes on first and the selected entry's own type
    // replaces it, because that is upstream's order: `prepare-request.js:399`
    // defaults it, `:406` assigns over the top.
    setDefaultContentType(headers, 'application/octet-stream');
    const file = await buildFileBody(
      body.data as BruFilePart[],
      vars,
      trackUnresolved,
      collectionRoot,
      m => bodyWarnings.push(m),
    );
    if (file.contentType !== undefined) replaceContentType(headers, file.contentType);
    // Wrapped in a Blob rather than handed over as bytes: undici accepts either,
    // but the Blob type is the one this codebase already uses for a multipart
    // file part, and an untyped Blob adds no Content-Type of its own — so the
    // header decided above is the header sent.
    if (file.data !== undefined) options.body = new Blob([file.data]);
  } else if (body?.type === 'form-urlencoded' && Array.isArray(body.data)) {
    options.body = buildFormUrlEncodedBody(
      body.data as FormUrlEncodedPart[],
      vars,
      trackUnresolved,
    );
    setDefaultContentType(headers, 'application/x-www-form-urlencoded');
  } else if (body?.data != null) {
    // The branch that used not to exist. Every shape above is one this codebase
    // knows how to put on the wire; anything left is a body the file declares
    // and this build cannot encode. Sending nothing is the only honest option —
    // a guessed encoding is a body the author did not write — but it must not
    // be silent, because the request then returns a perfectly clean 2xx or 4xx
    // and any assertion on it passes for the wrong reason.
    bodyWarnings.push(
      `body of type "${body.type}" was not sent: its data is ${
        Array.isArray(body.data) ? 'a list' : typeof body.data
      }, which no encoder here accepts`,
    );
  }

  // Name the placeholder (e.g. `{{token}}`) but never a resolved value — the
  // value may be a secret. Ordered by the stage that produced them:
  // headerWarnings (the authored header list is read first), then authWarnings,
  // then bodyWarnings, then the unresolved-variable warnings in first-seen order.
  const unresolvedWarnings = [...unresolvedNames].map(
    name => `unresolved variable: {{${name}}}`,
  );
  const warnings = [
    // First: a root setting that exists and is NOT applied explains warnings
    // below it, such as an unresolved variable a root's vars block would define.
    ...(rootChain?.unapplied ?? []),
    ...headerWarnings,
    ...authWarnings,
    ...bodyWarnings,
    ...unresolvedWarnings,
  ];

  return {
    url,
    options,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(authHeaderNames.length > 0 ? { authHeaderNames } : {}),
    ...(authQueryNames.length > 0 ? { authQueryNames } : {}),
  };
}
