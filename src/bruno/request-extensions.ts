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
 * Never true for a file this project writes: `create_request` writes `.yml` for
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
