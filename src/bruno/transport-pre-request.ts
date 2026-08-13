/**
 * The pre-request phase for a request that reaches the wire through a transport
 * of its own rather than through fetch.
 *
 * gRPC and WebSocket requests are executed by a branch that returns before the
 * HTTP path's pre-request block is reached, so for both of them a pre-request
 * script simply did not run: `bru.setVar` wrote nothing, `req.setUrl` changed
 * nothing, and a script that threw did not stop the request. Post-response and
 * test scripts always did run, which is why this stayed invisible — the phase
 * that was missing is the one whose whole job is to happen *before*
 * substitution.
 *
 * What a script can and cannot reach here is decided once, in this module,
 * rather than twice in the two transport branches:
 *
 * - `bru.setVar` is honoured, and the transport's variables are re-derived from
 *   the store afterwards so the value reaches this request's own
 *   `{{placeholders}}` — the same re-substitution the HTTP path performs.
 * - `req.setUrl` replaces the transport's target.
 * - `req.setHeader` writes the transport's own header surface: a WebSocket's
 *   handshake headers, or a gRPC call's metadata. Metadata is not a second-class
 *   analogue here — `grpc-transport` already merges auth-produced HTTP headers
 *   into the metadata it sends, and grpc-js puts metadata on the wire as HTTP/2
 *   headers.
 * - `req.setBody` is NOT honoured, and says so in a warning. Neither transport
 *   sends "a body": a WebSocket session sends a list of messages and a unary
 *   gRPC call sends one typed message, so there is no single value a body could
 *   replace. Guessing one would send bytes the file never authored.
 */
import type { MockRequestData, YamlRequest } from './types.js';
import type { RootChain } from './collection-roots.js';
import type { ScriptRunner } from './sandbox-host.js';
import type { VariableStore } from './variable-store.js';
import { mergePreRequest, ownPreRequestScript } from './script-merge.js';
import { scriptTimeoutMs } from './script-timeout.js';

/** How the transport is named in results, and what `req.getMethod()` reports. */
export type TransportLabel = 'GRPC' | 'WS';

export interface TransportPreRequestInput {
  yaml: YamlRequest;
  rootChain?: RootChain;
  scriptRunner: ScriptRunner;
  variableStore?: VariableStore;
  /**
   * The authored variables — environment plus `vars:pre-request` — before the
   * runtime store is merged over them. Re-deriving from these rather than from
   * the environment alone is what keeps a `vars:pre-request` entry from being
   * dropped the moment a script writes a variable, which is exactly when the
   * re-derivation runs.
   */
  baseVars: Map<string, string>;
  /** The effective variables the transport substitutes with. */
  vars: Map<string, string>;
  label: TransportLabel;
  /** The target, already substituted, as the script should see it. */
  url: string;
  /**
   * The transport's own header surface, already substituted: a WebSocket's
   * authored handshake headers, or a gRPC call's metadata.
   *
   * Credentials the transport computes for itself are absent: auth is applied
   * inside the transport, after this phase, so a script reads what the file
   * authored rather than what will finally be sent.
   */
  headers: Record<string, string>;
}

export interface TransportPreRequestResult {
  /** The variables to execute with — re-derived if the script wrote any. */
  vars: Map<string, string>;
  /** From `req.setUrl`. Absent when the script did not call it. */
  urlOverride?: string;
  /** From `req.setHeader`, applied over the transport's own header surface. */
  headerOverrides?: Record<string, string>;
  warnings: string[];
  /** The script threw. The caller must not enter the transport. */
  error?: string;
}

/**
 * Run the merged pre-request script for a transport request.
 *
 * Returns the variables to execute with even when there is no script, so the
 * caller has one value to pass on either way.
 */
export async function runTransportPreRequest(
  input: TransportPreRequestInput,
): Promise<TransportPreRequestResult> {
  const { yaml, rootChain, scriptRunner, variableStore, baseVars, vars, label, url, headers } = input;

  const preScript = mergePreRequest(rootChain?.scripts ?? [], ownPreRequestScript(yaml));
  if (!preScript) return { vars, warnings: [] };

  const mockReqData: MockRequestData = {
    url,
    method: label,
    headers: { ...headers },
    // Not the message list: `req.getBody()` is a single value, and handing it one
    // of several messages would make a script that read it and wrote it back
    // silently drop the rest.
    body: null,
  };

  const result = await scriptRunner.runPreRequestScript(preScript, mockReqData, {
    timeout: scriptTimeoutMs(yaml.settings),
    // The same set the transport substitutes with, so `bru.getVar` and
    // `{{placeholder}}` see one consistent view. Object.fromEntries defines every
    // entry as an own data property, so a variable named `__proto__` is a plain
    // key rather than a prototype write.
    variables: Object.fromEntries(vars),
  });

  const warnings: string[] = [];

  // Into the store first, so the value is visible both to later requests and —
  // via the re-derivation below — to this request's own placeholders.
  if (variableStore) {
    for (const [name, value] of Object.entries(result.variables)) {
      variableStore.set(name, value as string | number | boolean);
    }
  }

  // Substitution happens inside the transport, after this returns, so handing
  // back the merged set is the whole of the re-substitution: there is no built
  // request to rebuild.
  const executionVars = variableStore && Object.keys(result.variables).length > 0
    ? variableStore.merge(baseVars)
    : vars;

  if (result.mutations.body !== undefined) {
    warnings.push(
      `A pre-request script called req.setBody() on a ${label} request, which sends no single `
        + 'body: a WebSocket session sends a list of messages and a unary gRPC call sends one '
        + 'typed message. The value was not applied — edit the request\'s messages instead.',
    );
  }

  return {
    vars: executionVars,
    ...(result.mutations.url !== undefined ? { urlOverride: result.mutations.url } : {}),
    ...(result.mutations.headers !== undefined ? { headerOverrides: result.mutations.headers } : {}),
    warnings,
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}
