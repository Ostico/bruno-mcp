import { extname } from 'path';

/**
 * Which extensions name a request file.
 *
 * `.bru` and `.yml` are the two Bruno writes. `.yaml` is the awkward third:
 * Bruno's own tree disagrees with itself about it.
 *
 * - The desktop app's collection watcher, the IPC request loader
 *   (`bruno-electron/src/ipc/collection.js`, `ext === '.bru' || ext === '.yml'`)
 *   and the `bru run` CLI (`bruno-cli/src/commands/run.js`, `ext === '.yml'`)
 *   all ignore `.yaml` outright.
 * - `bruno-electron/src/ipc/openapi-sync.js` walks a collection directory for
 *   requests — skipping `node_modules`, `.git`, `environments` and the
 *   `folder.` / `collection.` / `opencollection.` metadata prefixes, which is
 *   the same walk this project does — and accepts `.bru`, `.yml` AND `.yaml`.
 *
 * So a `.yaml` request is a real thing a Bruno-adjacent tool can leave behind,
 * and is at the same time invisible to Bruno's own runner. Reading it is
 * therefore right — a collection full of `.yaml` files previously enumerated as
 * empty, with no explanation, which is the worst way to be wrong. Reading it
 * *silently* would be wrong too: the run would pass here and the same request
 * would not exist as far as `bru run` is concerned. Hence
 * {@link unconventionalExtensionWarning}: read the file, and say that Bruno
 * will not.
 *
 * Matching is case-sensitive, as it is at every call site this replaced and as
 * it is in Bruno's watcher. Making it case-insensitive would newly enumerate
 * `Collection.YML` as a request, because the metadata-basename check next to it
 * is case-sensitive too — a behaviour change well outside this one.
 */
export const REQUEST_EXTENSIONS = ['.bru', '.yml', '.yaml'] as const;

/** The extension Bruno reads in only one place, and never runs. */
export const UNCONVENTIONAL_YAML_EXTENSION = '.yaml';

const YAML_REQUEST_EXTENSIONS = ['.yml', UNCONVENTIONAL_YAML_EXTENSION];

/**
 * The extension-taking forms, for callers that already have one in hand.
 *
 * They exist because a bare extension is not a path: `extname('.yml')` is `''`,
 * since `.yml` reads as a dotfile with no extension. Handing an extension to the
 * path-taking functions below therefore answers a confident, silent `false`.
 */
export function isRequestExtension(ext: string): boolean {
  return (REQUEST_EXTENSIONS as readonly string[]).includes(ext);
}

export function isYamlExtension(ext: string): boolean {
  return YAML_REQUEST_EXTENSIONS.includes(ext);
}

/** True when the path names a request file — metadata files are NOT excluded. */
export function isRequestFile(filePath: string): boolean {
  return isRequestExtension(extname(filePath));
}

/** True when the request file is in the YAML dialect rather than `.bru`. */
export function isYamlRequestFile(filePath: string): boolean {
  return isYamlExtension(extname(filePath));
}

/** True when the request file is in the native `.bru` dialect. */
export function isBruRequestFile(filePath: string): boolean {
  return extname(filePath) === '.bru';
}

/**
 * True for a request Bruno's own runner will not see because of its extension.
 *
 * Never true for a file this project writes: `write_request` writes `.yml` for
 * a YAML collection and `.bru` for a native one, so a `.yaml` file always came
 * from somewhere else.
 */
export function usesUnconventionalExtension(filePath: string): boolean {
  return extname(filePath) === UNCONVENTIONAL_YAML_EXTENSION;
}

/** How many `.yaml` names to list before summarising the rest. */
const MAX_NAMED_FILES = 5;

/**
 * A warning naming the `.yaml` requests in a set — empty when there are none.
 *
 * Returns a list rather than an optional string so every caller can assign it
 * straight into its own warnings array without restating the empty case.
 *
 * Names the files rather than counting them: "3 files use .yaml" leaves the
 * caller to find which, and the point of the warning is that they are the ones
 * missing from Bruno.
 */
export function unconventionalExtensionWarning(filePaths: string[]): string[] {
  const offenders = filePaths.filter(usesUnconventionalExtension);
  if (offenders.length === 0) {
    return [];
  }

  const named = offenders.slice(0, MAX_NAMED_FILES).join(', ');
  const rest = offenders.length > MAX_NAMED_FILES
    ? ` and ${offenders.length - MAX_NAMED_FILES} more`
    : '';

  return [
    `${offenders.length} ${offenders.length === 1 ? 'request uses' : 'requests use'} the `
      + `"${UNCONVENTIONAL_YAML_EXTENSION}" extension, which was read here but which Bruno's own app `
      + `and "bru run" do not recognise — rename to ".yml" or they will not exist as requests in `
      + `Bruno: ${named}${rest}`,
  ];
}

/** The extension Bruno reads for each collection dialect. */
export function dialectExtension(format: 'yaml' | 'bru'): string {
  return format === 'yaml' ? '.yml' : '.bru';
}

/**
 * True when a request's own extension disagrees with its collection's dialect.
 *
 * Bruno picks request files by the dialect its root marker declares, not by
 * trying both: `bruno-cli/src/utils/collection.js:28` skips any entry whose
 * `path.extname` differs from `FORMAT_CONFIG[format].ext`. So a `.yml` request
 * in a `bruno.json` collection is not a request as far as Bruno is concerned —
 * it is a file sitting in a directory.
 */
export function mismatchesCollectionDialect(
  filePath: string,
  format: 'yaml' | 'bru',
): boolean {
  const ext = extname(filePath).toLowerCase();
  if (!isRequestExtension(ext)) return false;
  return isYamlExtension(ext) !== (format === 'yaml');
}

/**
 * A warning naming the requests whose extension disagrees with the collection.
 *
 * Separate from {@link unconventionalExtensionWarning} because the cause is
 * different — that one is about an extension Bruno's runner never reads
 * anywhere, this one about an extension it reads only in the other kind of
 * collection — but the decision behind both is the same: operate on the file,
 * and say that Bruno will not see it. Refusing instead would leave the caller
 * no way to repair the very file the warning is about.
 */
function dialectMismatchWarning(filePaths: string[], format: 'yaml' | 'bru'): string[] {
  if (filePaths.length === 0) {
    return [];
  }

  const named = filePaths.slice(0, MAX_NAMED_FILES).join(', ');
  const rest = filePaths.length > MAX_NAMED_FILES
    ? ` and ${filePaths.length - MAX_NAMED_FILES} more`
    : '';

  return [
    `${filePaths.length} ${filePaths.length === 1 ? 'request uses' : 'requests use'} an extension `
      + `this collection's dialect does not read: it is a "${format}" collection, so Bruno's own app `
      + `and "bru run" see only "${dialectExtension(format)}" files. They were read and written here, `
      + `but rename them to "${dialectExtension(format)}" — or convert the collection — or they will `
      + `not exist as requests in Bruno: ${named}${rest}`,
  ];
}

/**
 * Every way the files in one collection can be invisible to Bruno.
 *
 * The two warnings are chosen per file rather than both being emitted, because
 * in a `.bru` collection they would otherwise contradict each other: a `.yaml`
 * request there mismatches the dialect AND uses the extension Bruno never
 * reads, and telling the caller to rename it to `.yml` — which is what the
 * `.yaml` warning says — would leave it just as invisible. The dialect is the
 * stronger claim, so it takes the file.
 *
 * A `null` format means nothing declared a dialect — no marker file was found
 * above these paths — and then there is no collection for a file to disagree
 * with, so only the `.yaml` warning can apply.
 */
export function collectionDialectWarnings(
  filePaths: string[],
  format: 'yaml' | 'bru' | null,
): string[] {
  const mismatched: string[] = [];
  const rest: string[] = [];
  for (const filePath of filePaths) {
    const isMismatch = format !== null && mismatchesCollectionDialect(filePath, format);
    (isMismatch ? mismatched : rest).push(filePath);
  }

  return [
    ...(format === null ? [] : dialectMismatchWarning(mismatched, format)),
    ...unconventionalExtensionWarning(rest),
  ];
}
