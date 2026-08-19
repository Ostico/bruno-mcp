/**
 * The merged write path: one tool that creates a request or edits an existing
 * one, chosen by which locator the caller passed.
 *
 * Two tools for one job cost twice, because JSON Schema `$ref` is document-local:
 * the nine byte-identical sub-schemas the two write tools shared could not be
 * sent once between them, and the whole surface sits in the cached prefix of
 * every request a client makes. One tool sends them once.
 *
 * The mode is inferred rather than passed. A `mode` field would only restate
 * what the locator already says, and a caller who set it inconsistently with the
 * locator would have to be refused anyway.
 */

/** Fields whose presence is only meaningful in one of the two modes. */
const CREATE_ONLY_FIELDS = ['kind', 'folder', 'sequence'] as const;
const EDIT_ONLY_FIELDS = ['filename', 'scriptMode'] as const;

export interface WriteRequestLocators {
  collectionPath?: string;
  name?: string;
  filePath?: string;
  filename?: string;
  kind?: string;
  folder?: string;
  sequence?: number;
  scriptMode?: string;
}

/** Values a batch supplies once for the whole call rather than per item. */
export interface AmbientWriteContext {
  collectionPath?: string;
}

export type WriteTarget =
  | { mode: 'create'; collectionPath: string; name: string }
  | { mode: 'edit'; filePath: string }
  | { error: string };

/**
 * A key the caller wrote, as opposed to one that merely exists.
 *
 * The SDK hands a handler an object carrying every optional key as `undefined`,
 * so a presence test on the key alone would refuse every real call. A truthiness
 * test would be wrong in the other direction: `sequence: 0` and `filename: ''`
 * are values the caller passed, and silently ignoring them is how someone ends
 * up believing a field took effect.
 */
function wasPassed(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
}

function listed(fields: readonly string[]): string {
  return fields.join(', ');
}

/**
 * Decide what a write call is addressing, or why it cannot be addressed.
 *
 * `ambient` carries what a batch stated once for the whole call. It is
 * deliberately not treated as a locator the caller wrote in this item: an
 * ambient collection alongside an item's own `filePath` is the ordinary shape of
 * a batch that edits one request and creates another, and refusing that would
 * make batching useless for exactly the runs that need it most.
 */
export function resolveWriteTarget(
  input: WriteRequestLocators,
  ambient?: AmbientWriteContext,
): WriteTarget {
  const fields = input as Record<string, unknown>;
  const hasFilePath = wasPassed(fields, 'filePath');
  const hasOwnCollectionPath = wasPassed(fields, 'collectionPath');

  if (hasFilePath && hasOwnCollectionPath) {
    return {
      error: 'Pass filePath to edit an existing request, or collectionPath and name to'
        + ' create one. This call passes both filePath and collectionPath, and which one'
        + ' was meant is not something to guess at.',
    };
  }

  if (hasFilePath) {
    const misplaced = CREATE_ONLY_FIELDS.filter((field) => wasPassed(fields, field));
    if (misplaced.length > 0) {
      return {
        error: `${listed(misplaced)} can only be set when creating a request, and this call`
          + ` is an edit of ${String(input.filePath)}. Remove it, or address the request by`
          + ' collectionPath and name to create a new one.',
      };
    }
    return { mode: 'edit', filePath: String(input.filePath) };
  }

  const collectionPath = hasOwnCollectionPath ? input.collectionPath : ambient?.collectionPath;
  if (collectionPath === undefined) {
    return {
      error: 'Pass filePath to edit an existing request, or collectionPath and name to'
        + ' create one. This call passes neither.',
    };
  }

  if (!wasPassed(fields, 'name')) {
    return { error: `Creating a request in ${collectionPath} needs a name.` };
  }

  const misplaced = EDIT_ONLY_FIELDS.filter((field) => wasPassed(fields, field));
  if (misplaced.length > 0) {
    return {
      error: `${listed(misplaced)} can only be set when editing an existing request, and`
        + ` this call is a create in ${collectionPath}. Remove it, or address an existing`
        + ' request by filePath.',
    };
  }

  return { mode: 'create', collectionPath, name: String(input.name) };
}
