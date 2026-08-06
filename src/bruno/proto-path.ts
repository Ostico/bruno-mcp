/**
 * Confinement for `.proto` files a collection names, and for everything they
 * import.
 *
 * Deliberately NOT `confineUploadPath`. That boundary allows
 * `[collectionRoot, homedir(), tmpdir(), '/tmp', ...operatorUploadDirs()]`, which
 * would let a collection file — untrusted input — name any non-hidden file under
 * the operator's entire home directory, where tokens and kubeconfigs live. A proto
 * path has no reason to leave the collection, so the boundary is the collection
 * and nothing else.
 *
 * Containment is checked on the REAL path, not the lexical one. `resolve()`
 * normalises `..` away but knows nothing about symlinks, so a link inside the
 * collection pointing outside it passes a lexical check and reads the target
 * anyway. `fs.realpathSync` is what closes that, and it runs on the entry file and
 * on every resolved import.
 */

import { realpathSync } from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';

export class ProtoPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtoPathError';
  }
}

/**
 * True when `target` is the same file as `root` or sits underneath it.
 *
 * Both arguments must already be real paths; comparing a real path against a
 * lexical one reintroduces the hole this function exists to close.
 */
function isWithinReal(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Resolve to a real path, turning a missing file into a named refusal. */
function realOrRefuse(candidate: string, what: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    throw new ProtoPathError(`Cannot read ${what}: "${candidate}" does not exist or is unreadable`);
  }
}

/**
 * Resolve the proto file a collection named, confined to the collection.
 *
 * Returns the real path, which is what any loader must then open — opening the
 * pre-realpath path would mean the file that was checked and the file that is read
 * are not the same file.
 */
export function confineProtoPath(
  protoPath: string,
  collectionRoot: string | undefined,
): string {
  if (!collectionRoot) {
    throw new ProtoPathError(
      `Refusing to read proto file "${protoPath}": no collection root to confine it to`,
    );
  }
  if (protoPath.trim() === '') {
    throw new ProtoPathError('Refusing to read proto file: the path is empty');
  }

  const realRoot = realOrRefuse(resolve(collectionRoot), 'the collection root');
  const realTarget = realOrRefuse(resolve(realRoot, protoPath), `proto file "${protoPath}"`);

  if (!isWithinReal(realRoot, realTarget)) {
    throw new ProtoPathError(
      `Refusing to read proto file outside the collection: "${protoPath}" resolves to `
        + `"${realTarget}", which is not under "${realRoot}"`,
    );
  }
  return realTarget;
}

/**
 * Build the import resolver a proto parser must use, confined to the same root.
 *
 * Needed because delegating to `@grpc/proto-loader`'s `includeDirs` is not
 * confinement: its resolver returns an absolute target verbatim and `path.join`s a
 * relative one, normalising `..` away before it checks existence. So an
 * `import "/etc/hosts";` inside an otherwise-confined `.proto` bypasses the
 * include list entirely. Driving the parser with this resolver instead means every
 * import is checked the same way the entry file was.
 *
 * Returns the real path to open, and throws rather than returning null on a
 * refusal, so a blocked import is a named error instead of a confusing
 * "type not found" further along.
 */
export function makeProtoImportResolver(realRoot: string) {
  return (origin: string, target: string): string => {
    if (isAbsolute(target)) {
      throw new ProtoPathError(
        `Refusing to follow an absolute proto import: "${target}". `
          + 'Imports must be relative to the importing file.',
      );
    }

    const base = origin ? dirname(origin) : realRoot;
    const realTarget = realOrRefuse(resolve(base, target), `proto import "${target}"`);

    if (!isWithinReal(realRoot, realTarget)) {
      throw new ProtoPathError(
        `Refusing to follow a proto import outside the collection: "${target}" resolves to `
          + `"${realTarget}", which is not under "${realRoot}"`,
      );
    }
    return realTarget;
  };
}
