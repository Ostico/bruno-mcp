/**
 * `modify_request` must refuse an edit naming a field a transport kind has no
 * place for — by name, without throwing, and without touching the file.
 *
 * This is the write half of the same rule the executor applies on the run path.
 * `updateRequestLocked` reshapes `yamlReq.http` field by field, so before the
 * guard an update naming an HTTP-shaped field reached `yamlReq.http.method` on a
 * request that has no http block — a TypeError out of a tool call.
 *
 * Only the fields that genuinely do not exist off the http block are refused.
 * `url`, `headers` and `auth` all exist on both transports, in a different block,
 * and are edited rather than refused: see `transport-edits.test.ts`. Refusing
 * them was the same data problem approached from the other side, since it left a
 * WebSocket request's target unchangeable for the life of the file.
 */
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequestBuilder, RequestBuilder } from '../../../src/bruno/request.js';
import { parseBruRequest } from '../../../src/bruno/bru-parser.js';
import { parseYamlRequest } from '../../../src/bruno/yaml-parser.js';
import { transportKindToEdit } from '../../../src/bruno/transport-writes.js';

let builder: RequestBuilder;

beforeEach(() => {
  builder = createRequestBuilder();
});

const BRU_GRPC = `meta {
  name: Streamer
  type: grpc
  seq: 1
}

grpc {
  url: grpc://localhost:50051
  method: /pkg.Svc/Method
}

metadata {
  authorization: Bearer live
}
`;

const BRU_WS = `meta {
  name: Socket
  type: ws
  seq: 1
}

ws {
  url: ws://localhost:8080
}
`;

const YML_GRPC = `info:
  name: Streamer
  type: grpc
  seq: 1
grpc:
  url: grpc://localhost:50051
  method: /pkg.Svc/Method
  metadata:
    - name: authorization
      value: Bearer live
`;

async function seed(label: string, fileName: string, source: string): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), `bruno-kind-edit-${label}-`));
  await fs.writeFile(
    join(dir, 'bruno.json'),
    JSON.stringify({ version: '1', name: 'c', type: 'collection' }),
  );
  const filePath = join(dir, fileName);
  await fs.writeFile(filePath, source);
  return filePath;
}

const sha256 = async (filePath: string) =>
  createHash('sha256').update(await fs.readFile(filePath)).digest('hex');

// One case per HTTP-only field, because the guard is a list and a list is
// exactly the kind of thing that gets extended on one side only.
const HTTP_ONLY = [
  ['method', { method: 'POST' as const }],
  ['body', { body: { type: 'json' as const, content: '{}' } }],
  ['query', { query: { page: '2' } }],
  ['pathParams', { pathParams: { id: '7' } }],
] as const;

describe.each([
  ['.bru', 'streamer.bru', BRU_GRPC],
  ['.yml', 'streamer.yml', YML_GRPC],
])('%s: an HTTP-only edit to a grpc request is refused', (dialect, fileName, source) => {
  it.each(HTTP_ONLY)('refuses %s by name', async (field, updates) => {
    const filePath = await seed(`${dialect}-${field}`, fileName, source);
    const result = await builder.updateRequest(filePath, updates);
    expect(result.success).toBe(false);
    expect(result.error).toContain(field);
    expect(result.error).toMatch(/"grpc" request/);
  });

  it('does not throw out of the tool boundary', async () => {
    const filePath = await seed(`${dialect}-throw`, fileName, source);
    await expect(builder.updateRequest(filePath, { method: 'POST' })).resolves.toBeDefined();
  });

  it('leaves the file byte-unchanged', async () => {
    const filePath = await seed(`${dialect}-bytes`, fileName, source);
    const before = await sha256(filePath);
    await builder.updateRequest(filePath, { body: { type: 'json', content: '{}' } });
    expect(await sha256(filePath)).toBe(before);
  });

  it('names where the payload does live instead of only what cannot move', async () => {
    const filePath = await seed(`${dialect}-hint`, fileName, source);
    const result = await builder.updateRequest(filePath, { method: 'POST' });
    expect(result.error).toMatch(/grpc\.messages/);
    expect(result.error).toMatch(/metadata/);
  });

  it('refuses the other kind\'s nested object', async () => {
    const filePath = await seed(`${dialect}-foreign`, fileName, source);
    const result = await builder.updateRequest(filePath, {
      websocket: { messages: [{ content: 'ping' }] },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/`websocket` object does not apply to kind `grpc`/);
    // The refusal has to happen before any write, not after a partial one.
    expect(await fs.readFile(filePath, 'utf-8')).toBe(source);
  });
});

describe('a WebSocket request is refused the same way', () => {
  it('refuses a method edit and names the kind', async () => {
    const filePath = await seed('ws', 'socket.bru', BRU_WS);
    const result = await builder.updateRequest(filePath, { method: 'POST' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/"ws" request/);
    // Its own credentials are headers, not metadata — the hint is per kind.
    expect(result.error).toMatch(/credentials are headers/);
  });

  it('refuses the grpc object on a ws request', async () => {
    const filePath = await seed('ws-foreign', 'socket.bru', BRU_WS);
    const result = await builder.updateRequest(filePath, { grpc: { method: '/pkg.Svc/M' } });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/`grpc` object does not apply to kind `ws`/);
  });
});

describe('a kind this server cannot write is refused wholesale', () => {
  // Called directly rather than through a file: both parsers reject a `type` they
  // do not know before the writer ever sees it, so there is no file on disk that
  // reaches this guard. It is still the guard that stops the writer from guessing
  // a kind and grafting the wrong transport block onto a request.
  it.each(['socketio', undefined])('names what is still editable on type %s', (type) => {
    expect(() => transportKindToEdit(type)).toThrow(/name and sequence/i);
    expect(() => transportKindToEdit(type)).toThrow(new RegExp(type ?? 'unknown'));
  });

  it.each(['ws', 'grpc'] as const)('returns %s for a kind it can write', (type) => {
    expect(transportKindToEdit(type)).toBe(type);
  });
});

describe('the kind-agnostic edits still apply', () => {
  it('renames a .bru grpc request and keeps its target', async () => {
    const filePath = await seed('rename-bru', 'streamer.bru', BRU_GRPC);
    const result = await builder.updateRequest(filePath, { name: 'Renamed' });
    expect(result.success).toBe(true);

    const reparsed = parseBruRequest(await fs.readFile(filePath, 'utf-8'));
    expect(reparsed.meta.name).toBe('Renamed');
    expect(reparsed.grpc?.url).toBe('grpc://localhost:50051');
    // The credential block is the part a rewrite is most likely to lose, since it
    // is written from a separate branch of the generator.
    expect(reparsed.metadata).toEqual([{ name: 'authorization', value: 'Bearer live' }]);
  });

  it('resequences a .yml grpc request and keeps its target', async () => {
    const filePath = await seed('reseq-yml', 'streamer.yml', YML_GRPC);
    const result = await builder.updateRequest(filePath, { sequence: 9 });
    expect(result.success).toBe(true);

    const reparsed = parseYamlRequest(await fs.readFile(filePath, 'utf-8'));
    expect(reparsed.info.seq).toBe(9);
    expect(reparsed.grpc?.url).toBe('grpc://localhost:50051');
    expect(reparsed.grpc?.metadata).toEqual([{ name: 'authorization', value: 'Bearer live' }]);
  });
});
