import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { getCollectionStats } from '../../../src/bruno/collection-stats.js';

// The stats loop swallows per-file errors with `catch { continue; }`, so a request
// kind it does not understand does not fail loudly — it disappears from the
// totals. That makes "does it throw?" the wrong question and "is it counted?" the
// right one.
describe('getCollectionStats counts every request kind', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bruno-stats-kinds-'));
    await writeFile(join(root, 'bruno.json'), JSON.stringify({ version: '1', name: 'Kinds', type: 'collection' }));

    await writeFile(
      join(root, 'plain.bru'),
      'meta {\n  name: Plain\n  type: http\n  seq: 1\n}\n\nget {\n  url: http://example.test\n}\n',
    );
    await writeFile(
      join(root, 'streamer.bru'),
      'meta {\n  name: Streamer\n  type: grpc\n  seq: 2\n}\n\ngrpc {\n  url: grpc://localhost:50051\n  method: /pkg.Svc/Method\n}\n',
    );
    await writeFile(
      join(root, 'socket.bru'),
      'meta {\n  name: Socket\n  type: ws\n  seq: 3\n}\n\nws {\n  url: ws://localhost:8080\n}\n',
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('counts a grpc and a ws request instead of silently dropping them', async () => {
    const stats = await getCollectionStats(root);
    expect(stats.totalRequests).toBe(3);
  });

  it('reports the new kinds under their own label rather than as an http method', async () => {
    const stats = await getCollectionStats(root);
    const labels = Object.keys(stats.requestsByMethod);
    expect(labels).toContain('GRPC');
    expect(labels).toContain('WS');
    expect(stats.requestsByMethod.GET).toBe(1);
  });

  it('still counts a collection that holds only http requests exactly as before', async () => {
    const httpOnly = await mkdtemp(join(tmpdir(), 'bruno-stats-http-'));
    try {
      await mkdir(join(httpOnly, 'sub'), { recursive: true });
      await writeFile(join(httpOnly, 'bruno.json'), JSON.stringify({ version: '1', name: 'H', type: 'collection' }));
      await writeFile(
        join(httpOnly, 'one.bru'),
        'meta {\n  name: One\n  type: http\n  seq: 1\n}\n\npost {\n  url: http://example.test\n}\n',
      );
      const stats = await getCollectionStats(httpOnly);
      expect(stats.totalRequests).toBe(1);
      expect(stats.requestsByMethod).toEqual({ POST: 1 });
    } finally {
      await rm(httpOnly, { recursive: true, force: true });
    }
  });
});
