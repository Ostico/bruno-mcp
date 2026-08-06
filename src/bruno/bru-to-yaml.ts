/**
 * Translating a parsed `.bru` file into the `YamlRequest` shape the executor
 * consumes.
 *
 * The two formats are near-isomorphic but disagree in three ways that this
 * module exists to reconcile:
 *
 *   - the switched-off flag has OPPOSITE POLARITY (`.bru` carries `enabled`,
 *     the executor's shape carries `disabled`), so forwarding a flag unchanged
 *     sends exactly what the author turned off;
 *   - auth is NESTED BY SCHEME in `.bru` (`auth.bearer.token`) and FLAT in the
 *     executor's shape (`{type, token}`);
 *   - the api-key mode is spelled `apikey` on disk and `api-key` on the tool
 *     surface, and its placement is spelled `queryparams` on disk.
 *
 * Extracted from request-executor.ts, which crossed the repo-wide max-lines
 * ceiling.
 */

import { bruVarSetsToYamlVars } from './request-vars.js';
import type {
  BruFile,
  YamlRequest,
  YamlAuth,
  MultipartFormPart,
} from './types.js';

/**
 * Translate a parsed .bru file into the YamlRequest the executor works in.
 * Exported for tests, matching bruAuthToYamlAuth alongside it; the executor is
 * still the only production caller.
 */
export function bruFileToYamlRequest(bru: BruFile): YamlRequest {
  const scripts: YamlRequest['runtime'] = { scripts: [] };
  if (bru.script?.['pre-request']?.exec) {
    scripts.scripts.push({ type: 'before-request', code: bru.script['pre-request'].exec.join('\n') });
  }
  if (bru.script?.['post-response']?.exec) {
    scripts.scripts.push({ type: 'after-response', code: bru.script['post-response'].exec.join('\n') });
  }
  if (bru.tests?.exec) {
    scripts.scripts.push({ type: 'after-response', code: bru.tests.exec.join('\n') });
  }

  // Prefer headersList: it is the parser's order-preserving record of every
  // authored header, duplicates and disabled flags included. `bru.headers` is
  // the flat Record kept for lookups, so building from it collapsed repeated
  // names before the model even existed and dropped the disabled
  // flag that buildFetchOptions needs to honour. Fall back to the Record
  // only for a BruFile that carries no headersList.
  const headers = bru.headersList
    ? bru.headersList.map((h) => ({
        name: h.name,
        value: h.value,
        ...(h.enabled === false ? { disabled: true } : {}),
      }))
    : bru.headers
      ? Object.entries(bru.headers).map(([name, value]) => ({ name, value }))
      : undefined;

  // The two formats spell the switched-off flag with opposite polarity: a
  // BruParam carries `enabled`, a YamlParam carries `disabled`. Forwarding these
  // without inverting would send exactly the parameters the author turned off.
  const params = bru.params?.map((param) => ({
    name: param.name,
    value: param.value,
    type: param.type,
    ...(param.enabled === false ? { disabled: true } : {}),
  }));

  // Same opposite-polarity trap as params, and worse here: forwarding `enabled`
  // straight through would evaluate the assertions the author switched off and
  // report their failures as the request's.
  const assertions = bru.assertions?.map((assertion) => ({
    name: assertion.name,
    value: assertion.value,
    ...(assertion.enabled === false ? { disabled: true } : {}),
  }));

  // Third occurrence of the same inversion, and the .bru names differ too:
  // varSets.req/.res carry `enabled`, YamlVars.preRequest/.postResponse carry
  // `disabled`. Getting it wrong here means applying a variable the author
  // switched off — silently, since a variable leaves no trace in the report the
  // way a failed assertion does. `local` is carried through unchanged.
  const vars = bruVarSetsToYamlVars(bru.varSets);

  let body: NonNullable<YamlRequest['http']>['body'];
  if (bru.body?.formData && bru.body.formData.length > 0) {
    body = {
      type: 'multipart-form',
      data: bru.body.formData.map((part): MultipartFormPart => {
        const item: MultipartFormPart = {
          name: part.name,
          value: part.value,
          type: part.type ?? 'text',
        };
        if (part.contentType) item.contentType = part.contentType;
        // Carry the enabled flag through so a part disabled in the .bru file is
        // not silently re-enabled by the converter. Only an
        // explicit `false` is recorded; `undefined`/`true` stay enabled.
        if (part.enabled === false) item.enabled = false;
        return item;
      }),
    };
  } else if (bru.body?.content) {
    body = { type: bru.body.type, data: bru.body.content };
  } else if (bru.body?.formUrlEncoded && bru.body.formUrlEncoded.length > 0) {
    // Carried as pairs, not as a pre-encoded string: buildFetchOptions
    // substitutes variables and only then encodes, so a value containing `&` or
    // `=` cannot forge extra fields.
    body = { type: 'form-urlencoded', data: bru.body.formUrlEncoded };
  } else if (bru.body?.graphql) {
    body = { type: 'graphql', data: bru.body.graphql };
  } else if (bru.body && bru.body.type !== 'none') {
    // A type the http block declared with no content block behind it — `body:
    // graphql` and no `body:graphql`. Last in the chain so it can never claim a
    // body one of the branches above knows how to fill. Carried because upstream
    // carries it: the mode comes off the http block whatever the content blocks
    // hold, and a graphql request with nothing stored still sends an envelope.
    body = { type: bru.body.type };
  }
  // `file` bodies are deliberately not handled. @usebruno/lang 0.36.0 has no
  // `body:file` block, so such a block parses as generic name/value pairs and
  // the filePath the parser looks for is never present — sending one would mean
  // resolving an empty path against the collection root and reading a
  // directory. Supporting it needs the block to exist upstream first.

  return {
    info: { name: bru.meta.name, type: bru.meta.type, seq: bru.meta.seq, tags: bru.meta.tags },
    // Omitted for a non-http kind, whose target lives in its own block. Every
    // executor path reads the request through this function, so a fabricated
    // empty http block here would be indistinguishable downstream from a real
    // one — which is how a grpc request came to run as a GET to an empty URL.
    http: bru.http
      ? {
        method: bru.http.method,
        url: bru.http.url,
        headers,
        params,
        body,
        auth: bruAuthToYamlAuth(bru.auth, bru.http.auth),
      }
      : undefined,
    runtime: scripts.scripts.length > 0 ? scripts : undefined,
    // buildFetchOptions reads the timeout, redirect policy, TLS options and proxy
    // off `settings`. Without forwarding it, every one of those was unreachable
    // from a .bru request: the .bru format declares `timeout`, the parser read it
    // and the writer preserved it, and it then had no effect whatsoever.
    settings: bru.settings,
    assert: assertions,
    // Without this the .bru side stayed inert whatever the executor did: the
    // format declares vars, the parser read them and the writer preserved them,
    // and they stopped here.
    vars,
    docs: bru.docs,
  };
}

/**
 * Flatten a parsed .bru auth block into the shape the executor applies.
 *
 * .bru stores auth nested by scheme (auth.bearer.token, auth.basic.username);
 * the executor and the .yml path both consume the flat form ({type, token} /
 * {type, username, password} / {type, key, value, in}). Without this, auth
 * authored in a .bru file was dropped here — before the request even reached
 * buildFetchOptions.
 */
export function bruAuthToYamlAuth(
  auth: BruFile['auth'],
  mode?: NonNullable<BruFile['http']>['auth']
): YamlAuth | undefined {
  // `inherit` is declared in the http block and has no auth block of its own —
  // there is no local credential to carry, only the instruction to look up the
  // tree. Reading the block alone therefore made it indistinguishable from no
  // auth at all, so a .bru request set to inherit was sent with no credential and
  // none of the warning the .yml path emits for exactly the same request.
  if (mode === 'inherit') {
    return 'inherit';
  }
  if (!auth || auth.type === 'none') {
    return undefined;
  }
  switch (auth.type) {
    case 'bearer':
      return { type: 'bearer', token: auth.bearer?.token ?? '' };
    case 'basic':
      return {
        type: 'basic',
        username: auth.basic?.username ?? '',
        password: auth.basic?.password ?? '',
      };
    // `apikey` is how Bruno itself spells the mode, so a file authored in Bruno
    // arrives under that name. Matching only the hyphenated one dropped the key
    // and value here and the request went out with no credential at all.
    case 'api-key':
    case 'apikey':
      return {
        type: 'api-key',
        key: auth.apikey?.key ?? '',
        value: auth.apikey?.value ?? '',
        in: auth.apikey?.placement === 'queryparams' ? 'query' : 'header',
      };
    case 'digest':
      return {
        type: 'digest',
        username: auth.digest?.username ?? '',
        password: auth.digest?.password ?? '',
      };
    case 'oauth2':
      // Spread rather than named fields: Bruno's oauth2 block differs by grant
      // type and gains parameters between releases, and the executor only reads
      // the handful it understands. Listing them here would silently drop the
      // rest on the way to a model that can hold them (`YamlAuth` is indexed).
      return { type: 'oauth2', ...(auth.oauth2 ?? {}) };
    default:
      // Anything this does not model yet is carried by type alone, so the
      // scheme is reported as unapplied rather than vanishing silently.
      return { type: auth.type };
  }
}
