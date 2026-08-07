/**
 * An empty target is the one shape that cannot be written without losing data,
 * so it is refused rather than written.
 *
 * `jsonToBruV2` gates each transport block on a truthy `url` (`jsonToBru.js:62`,
 * `:97`) while writing the sibling `metadata` block unconditionally. A request
 * whose URL has not been filled in yet — the most common authoring state — would
 * therefore be saved with its credentials and no target: a file that looks
 * authored and goes nowhere.
 *
 * The two boundaries are deliberately different, and both are named here. The
 * generator throwing is the internal contract; a tool call returning a named
 * refusal is the external one. No tool call may throw, so `updateRequest` has to
 * turn the throw into a result — and the bytes on disk have to be untouched,
 * which is asserted by hash rather than by reading the file back through our own
 * parser.
 */
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseBruRequest, generateBruRequest } from '../../../src/bruno/bru-parser.js';
import { createRequestBuilder, RequestBuilder } from '../../../src/bruno/request.js';

let builder: RequestBuilder;

beforeEach(() => {
  builder = createRequestBuilder();
});

const BRU_EMPTY_GRPC_TARGET = `meta {
  name: Streamer
  type: grpc
  seq: 1
}

grpc {
  url:
  auth: bearer
}

auth:bearer {
  token: live-token
}

metadata {
  authorization: Bearer live
}
`;

const BRU_EMPTY_WS_TARGET = `meta {
  name: Socket
  type: ws
  seq: 1
}

ws {
  url:
  auth: none
}

headers {
  authorization: Bearer live
}
`;

async function seed(label: string, fileName: string, source: string): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), `bruno-refusal-${label}-`));
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

describe('generateBruRequest refuses an empty target — the internal contract', () => {
  it('throws for a grpc request whose url is empty', () => {
    expect(() => generateBruRequest(parseBruRequest(BRU_EMPTY_GRPC_TARGET)))
      .toThrow(/empty url/i);
  });

  it('names the loss rather than reporting a generic failure', () => {
    // The message is the whole point: silently dropping the block is the bug, so
    // the refusal has to say what would have been dropped and what would have
    // been kept.
    expect(() => generateBruRequest(parseBruRequest(BRU_EMPTY_GRPC_TARGET)))
      .toThrow(/dropped.*credentials kept/is);
  });

  it('throws for a websocket request whose url is empty', () => {
    expect(() => generateBruRequest(parseBruRequest(BRU_EMPTY_WS_TARGET)))
      .toThrow(/empty url/i);
  });

  it('writes the block when the target is present', () => {
    const filled = BRU_EMPTY_GRPC_TARGET.replace('url:\n', 'url: grpc://localhost:50051\n');
    expect(generateBruRequest(parseBruRequest(filled))).toContain('grpc://localhost:50051');
  });
});

describe('updateRequest returns a refusal — the external contract', () => {
  it('does not throw, and reports the empty target as the reason', async () => {
    const filePath = await seed('grpc', 'streamer.bru', BRU_EMPTY_GRPC_TARGET);
    // `name` is one of the two kind-agnostic updates a request with no http block
    // accepts, so this reaches the generator rather than being refused earlier for
    // the wrong reason.
    const result = await builder.updateRequest(filePath, { name: 'Renamed' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/empty url/i);
  });

  it('leaves the file byte-unchanged', async () => {
    const filePath = await seed('bytes', 'streamer.bru', BRU_EMPTY_GRPC_TARGET);
    const before = await sha256(filePath);
    await builder.updateRequest(filePath, { name: 'Renamed' });
    expect(await sha256(filePath)).toBe(before);
  });

  it('refuses a websocket request the same way', async () => {
    const filePath = await seed('ws', 'socket.bru', BRU_EMPTY_WS_TARGET);
    const result = await builder.updateRequest(filePath, { name: 'Renamed' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/empty url/i);
  });
});
