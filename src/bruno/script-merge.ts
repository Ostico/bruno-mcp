/**
 * Joining a request's own scripts to the ones its collection and folders declare.
 *
 * `collection-roots.ts` has read root-level scripts and tests for a while and
 * reported them, per request, as "not applied to requests yet". This applies
 * them. A collection that put its authentication in `collection.bru`'s
 * `script:pre-request` — which is the normal way to write one — was running
 * every request without it.
 *
 * Ported from `bruno-cli/src/utils/collection.js` (`mergeScripts`), including
 * the two rules that are not guessable:
 *
 * ORDER. Pre-request always runs outermost-first: collection, then each folder
 * from the collection downwards, then the request. Post-response and tests
 * depend on a collection-level `scripts.flow` setting in `bruno.json`, which
 * upstream defaults to `sandwich`: under `sequential` they run in the same
 * outermost-first order as pre-request, and under `sandwich` in exactly the
 * reverse — the request first, then folders innermost-first, then the
 * collection. The name is the mnemonic: setup wraps the request going in and
 * unwraps it coming out.
 *
 * PHASES, NOT LAYERS. Every layer's post-response script runs before any
 * layer's tests. A folder post-response script that parks a value for a
 * request's test to read only works if the phases are kept apart, rather than
 * each layer being run start-to-finish in turn.
 *
 * WHERE THIS STOPS SHORT OF UPSTREAM, DELIBERATELY. Upstream wraps every
 * segment in `await (async () => { ... })();` so two sources can both declare
 * `const token`. This wraps only when there is more than one segment to
 * assemble. A single source — whether the request's own script or a lone
 * collection root — is emitted exactly as authored, because there is nothing
 * for it to collide with.
 *
 * That distinction is load-bearing, not cosmetic. This runner has a single
 * post-response phase, so a request's own post-response script and its own
 * tests have always been concatenated into one program sharing one scope, and
 * collections rely on it: a `const` declared in the post-response script and
 * read from a test is ordinary. Wrapping unconditionally would have taken that
 * scope away from every existing collection to buy isolation that only matters
 * once a second source exists. When one does, every segment is wrapped,
 * including the request's own.
 */
import type { YamlRequest } from './types.js';

/** Where post-response and tests sit relative to the request. */
export type ScriptFlow = 'sandwich' | 'sequential';

/** One source of root-level scripts: the collection root, or a folder root. */
export interface ScriptLayer {
  /** Path relative to the collection root, for attributing a failure. */
  source: string;
  preRequest?: string;
  postResponse?: string;
  tests?: string;
}

/** A request's own post-response phase, still in its two authored halves. */
export interface OwnPostScripts {
  postResponse: string | null;
  tests: string | null;
}

function isPresent(code: string | null | undefined): code is string {
  return typeof code === 'string' && code.trim().length > 0;
}

/**
 * `await` so a segment may use top-level await, and an async IIFE so its
 * declarations cannot collide with the next segment's. The newlines matter: a
 * segment ending in a `//` comment would otherwise swallow the closing brace.
 */
function isolate(code: string): string {
  return `await (async () => {\n${code}\n})();`;
}

/**
 * One source keeps its own text; two or more get a scope each.
 *
 * A lone segment is emitted exactly as authored whether it came from the
 * request or from a root — there is nothing for it to collide with, and leaving
 * it alone means this module cannot change the meaning of a collection that has
 * only ever had one source of scripts.
 */
function assemble(segments: string[]): string | null {
  if (segments.length === 0) {
    return null;
  }
  return segments.length === 1 ? segments[0]! : segments.map(isolate).join('\n\n');
}

/** The request's own pre-request code, or null. */
export function ownPreRequestScript(yaml: YamlRequest): string | null {
  const code = (yaml.runtime?.scripts ?? [])
    .filter((script) => script.type === 'before-request')
    .map((script) => script.code);
  return code.length > 0 ? code.join('\n') : null;
}

/**
 * The request's own post-response code, kept in its two halves.
 *
 * A `.yml` request keeps its tests in a slot of its own (`type: tests`) apart
 * from `type: after-response`; a `.bru` request keeps the same split between its
 * `script:post-response` and `tests` blocks. Reading only one of them would
 * store an authored test faithfully and never run it, reporting a run with zero
 * tests as green.
 */
export function ownPostScripts(yaml: YamlRequest): OwnPostScripts {
  const of = (type: 'after-response' | 'tests'): string | null => {
    const code = (yaml.runtime?.scripts ?? [])
      .filter((script) => script.type === type)
      .map((script) => script.code);
    return code.length > 0 ? code.join('\n') : null;
  };
  return { postResponse: of('after-response'), tests: of('tests') };
}

/**
 * The pre-request program: collection, folders top-down, then the request.
 *
 * No flow branch — upstream has none for this phase.
 */
export function mergePreRequest(
  layers: readonly ScriptLayer[],
  own: string | null,
): string | null {
  const roots = layers.map((layer) => layer.preRequest).filter(isPresent);
  return assemble(isPresent(own) ? [...roots, own] : roots);
}

/**
 * The post-response program: every layer's post-response script, then every
 * layer's tests, each group ordered by `flow`.
 */
export function mergePostResponse(
  layers: readonly ScriptLayer[],
  own: OwnPostScripts,
  flow: ScriptFlow,
): string | null {
  const ordered = flow === 'sequential' ? layers : [...layers].reverse();
  const rootPost = ordered.map((layer) => layer.postResponse).filter(isPresent);
  const rootTests = ordered.map((layer) => layer.tests).filter(isPresent);

  if (rootPost.length === 0 && rootTests.length === 0) {
    // Untouched: the one-scope concatenation a request has always been given.
    const mine = [own.postResponse, own.tests].filter(isPresent);
    return mine.length > 0 ? mine.join('\n') : null;
  }

  const place = (roots: string[], mine: string | null): string[] => {
    const own = isPresent(mine) ? [mine] : [];
    return flow === 'sequential' ? [...roots, ...own] : [...own, ...roots];
  };

  return assemble([
    ...place(rootPost, own.postResponse),
    ...place(rootTests, own.tests),
  ]);
}

/**
 * Read `scripts.flow` out of a parsed `bruno.json`.
 *
 * Upstream's default is `sandwich` (`prepare-request.js` reads
 * `brunoConfig?.scripts?.flow`), and a `.yml` collection has no `bruno.json` at
 * all, so the default is what most runs get. An unrecognised value falls back to
 * the default rather than being rejected: the field is Bruno's, not this
 * server's, and refusing to run a collection over a setting this server merely
 * reads would be worse than running it the usual way.
 */
export function scriptFlowFrom(brunoConfig: unknown): ScriptFlow {
  const flow = (brunoConfig as { scripts?: { flow?: unknown } } | null)?.scripts?.flow;
  return flow === 'sequential' ? 'sequential' : 'sandwich';
}
