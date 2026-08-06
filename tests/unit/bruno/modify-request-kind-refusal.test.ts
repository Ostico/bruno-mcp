/**
 * `modify_request` must refuse an HTTP-shaped edit to a kind that has no http
 * block — by name, without throwing, and without touching the file.
 *
 * This is the write half of the same rule the executor applies on the run path.
 * `updateRequestLocked` reshapes `yamlReq.http` field by field, so before the
 * guard an update naming any of method, url, headers, body, auth, query or
 * pathParams reached `yamlReq.http.method` on a request that has no http block —
 * a TypeError out of a tool call.
 *
 * The other half is just as load-bearing: name and sequence still apply. Refusing
 * every edit would make a gRPC or WebSocket request permanently uneditable, which
 * is the same data problem approached from the other side.
 */
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequestBuilder, RequestBuilder } from '../../../src/bruno/request.js';
import { parseBruRequest } from '../../../src/bruno/bru-parser.js';
import { parseYamlRequest } from '../../../src/bruno/yaml-parser.js';

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

// One case per HTTP-shaped field, because the guard is a list and a list is
// exactly the kind of thing that gets extended on one side only.
const HTTP_SHAPED = [
  ['method', { method: 'POST' as const }],
  ['url', { url: 'http://evil.example' }],
  ['headers', { headers: { 'x-injected': 'yes' } }],
  ['body', { body: { type: 'json' as const, content: '{}' } }],
  ['auth', { auth: { type: 'bearer' as const, config: { token: 'stolen' } } }],
  ['query', { query: { page: '2' } }],
  ['pathParams', { pathParams: { id: '7' } }],
] as const;

describe.each([
  ['.bru', 'streamer.bru', BRU_GRPC],
  ['.yml', 'streamer.yml', YML_GRPC],
])('%s: an HTTP-shaped edit to a grpc request is refused', (dialect, fileName, source) => {
  it.each(HTTP_SHAPED)('refuses %s by name', async (field, updates) => {
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
    await builder.updateRequest(filePath, { url: 'http://evil.example' });
    expect(await sha256(filePath)).toBe(before);
  });

  it('names what can be changed instead of only what cannot', async () => {
    const filePath = await seed(`${dialect}-hint`, fileName, source);
    const result = await builder.updateRequest(filePath, { method: 'POST' });
    expect(result.error).toMatch(/name and sequence/i);
  });
});

describe('a WebSocket request is refused the same way', () => {
  it('refuses a url edit and names the kind', async () => {
    const filePath = await seed('ws', 'socket.bru', BRU_WS);
    const result = await builder.updateRequest(filePath, { url: 'http://evil.example' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/"ws" request/);
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
