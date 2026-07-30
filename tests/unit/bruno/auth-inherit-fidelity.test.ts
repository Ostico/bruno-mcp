/**
 * `inherit` auth is a mode, not the absence of one.
 *
 * Bruno resolves `inherit` by walking up to the nearest folder or collection auth
 * block. This tool does not model that walk — but it still has to read, write and
 * report the mode, because `none` and `inherit` are different instructions to
 * Bruno: send nothing versus send whatever the collection declares.
 *
 * It was treated as absent at all three ends. Reading a `.yml` request reported
 * `none`. The tool surface could not express it at all, so a request that
 * inherited could not be authored or preserved. And executing a `.bru` request
 * set to inherit sent no credential AND no warning, because the mode lives in the
 * http block while the executor only read the auth block — the same request in
 * `.yml` form was warned about correctly.
 *
 * The authoring assertions read the bytes on disk. A round-trip through our own
 * parser proves nothing, because our parser tolerates our own malformed output.
 *
 * Verified against Bruno at bruno-filestore/src/formats/yml/common/auth.ts: the
 * writer emits the bare token `inherit` for this mode and its reader matches that
 * bare token, so a `{ type: inherit }` mapping is not what Bruno reads.
 */

import { buildFetchOptions, bruAuthToYamlAuth } from '../../../src/bruno/request-executor';
import { createRequestBuilder, RequestBuilder } from '../../../src/bruno/request.js';
import { createCollectionManager } from '../../../src/bruno/collection.js';
import type { BruAuth, YamlAuth, YamlRequest } from '../../../src/bruno/types';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

jest.mock('../../../src/bruno/url-validator', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
}));

const noVars = new Map<string, string>();

function req(auth: YamlAuth | undefined): YamlRequest {
  return {
    info: { name: 'R', type: 'http' },
    http: { method: 'GET', url: 'https://api.test/resource', headers: [], auth },
  } as YamlRequest;
}

let builder: RequestBuilder;

beforeEach(() => {
  builder = createRequestBuilder();
});

async function makeCollection(label: string, format: 'bru' | 'yml'): Promise<string> {
  const tmpDir = await fs.mkdtemp(join(tmpdir(), `bruno-inherit-${label}-`));
  const result = await createCollectionManager().createCollection({
    name: 'InheritAPI',
    outputPath: tmpDir,
    format,
  });
  if (!result.success) throw new Error(`collection setup failed: ${result.error}`);
  return join(tmpDir, 'InheritAPI');
}

/** Author a request and hand back its bytes plus the collection it lives in. */
async function write(
  label: string,
  format: 'bru' | 'yml',
  auth: { type: 'inherit' | 'bearer'; config: Record<string, string> },
): Promise<{ source: string; filePath: string; collectionPath: string }> {
  const collectionPath = await makeCollection(label, format);
  const created = await builder.createRequest({
    collectionPath,
    name: 'Deferred',
    method: 'GET',
    url: 'https://api.example.com/x',
    auth,
  });
  if (!created.success) throw new Error(`create failed: ${created.error}`);
  // Read back the path the writer reports: it lowercases the request name, so a
  // rebuilt `Deferred.bru` resolves on a case-insensitive filesystem and fails on
  // a case-sensitive one.
  const filePath = created.path;
  if (!filePath) throw new Error('create reported success but returned no path');
  return { source: await fs.readFile(filePath, 'utf-8'), filePath, collectionPath };
}

describe('a .bru request that inherits auth is executed as inheriting', () => {
  it('carries the mode from the http block, which has no auth block of its own', () => {
    // `auth: inherit` is a line in the http block. There is no `auth:inherit {}`
    // block to read, so reading only the block reported no auth at all.
    expect(bruAuthToYamlAuth(undefined, 'inherit')).toBe('inherit');
  });

  it('warns instead of sending an unauthenticated request in silence', async () => {
    const { warnings } = await buildFetchOptions(req(bruAuthToYamlAuth(undefined, 'inherit')), noVars);

    expect(warnings?.some(w => /inherit/i.test(w))).toBe(true);
  });

  it('lets the declared mode win over a leftover block', () => {
    // A file can carry both: the http block says inherit while a previously
    // authored bearer block is still sitting underneath it. Bruno goes by the
    // declared mode, so honouring the stale block would send a credential Bruno
    // itself would not send.
    const stale: BruAuth = { type: 'bearer', bearer: { token: 'stale-token' } };

    expect(bruAuthToYamlAuth(stale, 'inherit')).toBe('inherit');
  });

  it('still reads the auth block when the mode is not inherit', () => {
    const auth: BruAuth = { type: 'bearer', bearer: { token: 'live-token' } };

    expect(bruAuthToYamlAuth(auth, 'bearer')).toEqual({ type: 'bearer', token: 'live-token' });
  });
});

describe('authoring a request that inherits auth', () => {
  it('writes the bare token in a .yml file, not a type mapping', async () => {
    const { source } = await write('yml-create', 'yml', { type: 'inherit', config: {} });

    expect(source).toContain('auth: inherit');
    // `{ type: inherit }` matches neither of Bruno's branches, so the mode is
    // dropped and the request silently becomes unauthenticated.
    expect(source).not.toContain('type: inherit');
  });

  it('writes the mode in a .bru http block and no auth block', async () => {
    const { source } = await write('bru-create', 'bru', { type: 'inherit', config: {} });

    expect(source).toContain('auth: inherit');
    // There is no local credential to put in a block, and Bruno writes none.
    expect(source).not.toContain('auth:inherit');
  });

  it('drops the credential block when a .bru request is switched to inherit', async () => {
    const { filePath } = await write('bru-modify', 'bru', {
      type: 'bearer',
      config: { token: 'to-be-removed' },
    });

    const updated = await builder.updateRequest(filePath, {
      auth: { type: 'inherit', config: {} },
    });
    if (!updated.success) throw new Error(`modify failed: ${updated.error}`);
    const source = await fs.readFile(filePath, 'utf-8');

    expect(source).toContain('auth: inherit');
    // Leaving the block behind writes a file that says inherit and still carries
    // the old token underneath it.
    expect(source).not.toContain('auth:bearer');
    expect(source).not.toContain('to-be-removed');
  });

  it('writes the bare token when a .yml request is switched to inherit', async () => {
    const { filePath } = await write('yml-modify', 'yml', {
      type: 'bearer',
      config: { token: 'to-be-removed' },
    });

    const updated = await builder.updateRequest(filePath, {
      auth: { type: 'inherit', config: {} },
    });
    if (!updated.success) throw new Error(`modify failed: ${updated.error}`);
    const source = await fs.readFile(filePath, 'utf-8');

    expect(source).toContain('auth: inherit');
    expect(source).not.toContain('type: inherit');
    expect(source).not.toContain('to-be-removed');
  });

  it('reports the mode back when the request is read again', async () => {
    const { filePath } = await write('yml-read', 'yml', { type: 'inherit', config: {} });

    const loaded = await builder.loadRequest(filePath);

    expect(loaded.http.auth).toBe('inherit');
  });
});

describe('scaffolded auth requests', () => {
  it('does not invent a username and password for an inheriting request', async () => {
    // The scaffolding falls back to basic-style credentials for any mode it has no
    // specific shape for. inherit has nowhere to put them, so attaching them
    // describes the request as something it is not.
    const collectionPath = await makeCollection('scaffold', 'bru');

    const results = await builder.createAuthRequests(collectionPath, 'https://api.example.com', 'inherit');
    const withAuth = results.filter(r => r.success && r.path?.match(/profile|logout/));
    expect(withAuth.length).toBeGreaterThan(0);

    for (const result of withAuth) {
      const source = await fs.readFile(result.path as string, 'utf-8');
      expect(source).toContain('auth: inherit');
      expect(source).not.toContain('{{password}}');
    }
  });
});
