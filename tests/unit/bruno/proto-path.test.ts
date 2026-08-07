import { mkdtemp, mkdir, writeFile, symlink, rm } from 'fs/promises';
import { realpathSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import {
  confineProtoPath,
  makeProtoImportResolver,
  ProtoPathError,
} from '../../../src/bruno/proto-path.js';

describe('confineProtoPath', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    // realpath both, because macOS puts the temp dir behind a /var -> /private/var
    // symlink and a test comparing a lexical path against a real one would pass or
    // fail for reasons unrelated to the code.
    root = realpathSync(await mkdtemp(join(tmpdir(), 'proto-root-')));
    outside = realpathSync(await mkdtemp(join(tmpdir(), 'proto-outside-')));
    await writeFile(join(root, 'svc.proto'), 'syntax = "proto3";\n');
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, 'nested', 'inner.proto'), 'syntax = "proto3";\n');
    await writeFile(join(outside, 'secret.proto'), 'syntax = "proto3";\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('accepts a proto inside the collection and returns its real path', () => {
    expect(confineProtoPath('svc.proto', root)).toBe(join(root, 'svc.proto'));
  });

  it('accepts one in a subdirectory', () => {
    expect(confineProtoPath('nested/inner.proto', root)).toBe(join(root, 'nested', 'inner.proto'));
  });

  it('refuses a traversal path', () => {
    expect(() => confineProtoPath('../../../etc/passwd', root)).toThrow(ProtoPathError);
  });

  // The escape a lexical check cannot catch: resolve() normalises `..` but knows
  // nothing about symlinks, so this path looks like it stays inside the collection.
  it('refuses a symlink inside the collection that points outside it', async () => {
    await symlink(join(outside, 'secret.proto'), join(root, 'link.proto'));
    let message = '';
    try {
      confineProtoPath('link.proto', root);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('outside the collection');
    // The refusal names the REAL target, so an operator can see where it pointed.
    expect(message).toContain(outside);
  });

  it('refuses an absolute path outside the collection', () => {
    expect(() => confineProtoPath(join(outside, 'secret.proto'), root)).toThrow(
      /outside the collection/,
    );
  });

  // The boundary is the collection, not the home directory. This is the specific
  // thing reusing confineUploadPath would have allowed.
  it('refuses a path under the home directory', () => {
    expect(() => confineProtoPath(join(homedir(), '.aws', 'credentials'), root)).toThrow(
      ProtoPathError,
    );
  });

  it('refuses when there is no collection root to confine against', () => {
    expect(() => confineProtoPath('svc.proto', undefined)).toThrow(/no collection root/);
  });

  it('refuses an empty path', () => {
    expect(() => confineProtoPath('   ', root)).toThrow(/path is empty/);
  });

  it('names a missing file rather than reporting it as an escape', () => {
    expect(() => confineProtoPath('absent.proto', root)).toThrow(/does not exist or is unreadable/);
  });
});

describe('makeProtoImportResolver', () => {
  let root: string;
  let outside: string;
  let resolver: (origin: string, target: string) => string;

  beforeEach(async () => {
    root = realpathSync(await mkdtemp(join(tmpdir(), 'proto-root-')));
    outside = realpathSync(await mkdtemp(join(tmpdir(), 'proto-outside-')));
    await writeFile(join(root, 'a.proto'), 'syntax = "proto3";\n');
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, 'nested', 'b.proto'), 'syntax = "proto3";\n');
    await writeFile(join(outside, 'evil.proto'), 'syntax = "proto3";\n');
    resolver = makeProtoImportResolver(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('resolves a relative import inside the collection', () => {
    expect(resolver(join(root, 'a.proto'), 'nested/b.proto')).toBe(join(root, 'nested', 'b.proto'));
  });

  it('resolves relative to the importing file, not to the root', () => {
    expect(resolver(join(root, 'nested', 'b.proto'), '../a.proto')).toBe(join(root, 'a.proto'));
  });

  // proto-loader's own resolver returns an absolute target verbatim, so
  // `import "/etc/hosts";` would bypass includeDirs entirely.
  it('refuses an absolute import', () => {
    expect(() => resolver(join(root, 'a.proto'), '/etc/hosts')).toThrow(
      /absolute proto import/,
    );
  });

  it('refuses a relative import that climbs out of the collection', () => {
    expect(() => resolver(join(root, 'a.proto'), '../../etc/passwd')).toThrow(
      ProtoPathError,
    );
  });

  it('refuses an import that reaches outside via a symlink', async () => {
    await symlink(join(outside, 'evil.proto'), join(root, 'link.proto'));
    expect(() => resolver(join(root, 'a.proto'), 'link.proto')).toThrow(
      /outside the collection/,
    );
  });

  it('names a missing import rather than silently returning nothing', () => {
    expect(() => resolver(join(root, 'a.proto'), 'absent.proto')).toThrow(
      /does not exist or is unreadable/,
    );
  });
});
