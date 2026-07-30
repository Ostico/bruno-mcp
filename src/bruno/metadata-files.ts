import { basename, dirname, relative } from 'path';

/**
 * Bruno's own metadata files. They live alongside request files, share the same
 * `.bru`/`.yml` extensions, and carry collection- or folder-level settings —
 * never a request. Anything that walks a collection looking for requests has to
 * skip them, or it reports phantom requests and tries to execute files that have
 * no method and no URL.
 *
 * The basenames and the depth rules below mirror how Bruno itself classifies a
 * path when it mounts a collection: collection roots only count at the top
 * level, folder roots count at any depth, and the match is case-sensitive.
 */
export const COLLECTION_ROOT_BASENAMES = new Set([
  'collection.bru',
  'collection.yml',
  'opencollection.yml',
]);

export const FOLDER_ROOT_BASENAMES = new Set([
  'folder.bru',
  'folder.yml',
]);

export const BRUNO_CONFIG_BASENAME = 'bruno.json';

/**
 * True when `filePath` is one of Bruno's metadata files rather than a request.
 *
 * `collectionPath` is the collection root, needed because the same basename can
 * be metadata at the root and an ordinary request deeper down.
 */
export function isMetadataFile(filePath: string, collectionPath: string): boolean {
  const name = basename(filePath);

  if (FOLDER_ROOT_BASENAMES.has(name)) {
    return true;
  }

  if (!COLLECTION_ROOT_BASENAMES.has(name) && name !== BRUNO_CONFIG_BASENAME) {
    return false;
  }

  // Collection roots and the config file only count at the collection root. A
  // file with one of those names inside a subfolder is a request, which is how
  // Bruno reads it too.
  return dirname(relative(collectionPath, filePath)) === '.';
}
