/**
 * Editing a WebSocket or gRPC request: the fields that do move, and what has to
 * survive them.
 *
 * The requests here are authored by `createRequest` rather than hand-written, so
 * an edit is checked against bytes this server itself produces — the shape a
 * caller will actually have on disk. The central claim is narrow and mechanical:
 * changing one field changes one field. Everything else in the file, including the
 * blocks written from a different branch of the generator (metadata, credentials,
 * messages, settings), must come back byte-identical, because a rewrite regenerates
 * the whole file from a parsed model and anything the model dropped is gone
 * silently.
 *
 * Credentials are asserted against the create path rather than against a literal:
 * an authored credential and an edited one must produce the same bytes, and the
 * `.yml` edit path used to write `type: api-key` where Bruno writes `apikey` — a
 * mode its reader does not match, on a request that had just been told to
 * authenticate.
 */
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestBuilder } from '../../../src/bruno/request';
import { parseBruRequest } from '../../../src/bruno/bru-parser';
import { parseYamlRequest } from '../../../src/bruno/yaml-parser';
import type { CreateRequestInput } from '../../../src/bruno/types';

const PROTO = `syntax = "proto3";
package greet;
service Greeter { rpc SayHello (HelloRequest) returns (HelloReply); }
message HelloRequest { string name = 1; }
message HelloReply { string message = 1; }
`;

type Format = 'bru' | 'yaml';

async function collection(label: string, format: Format): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `transport-edit-${label}-${format}-`));
  await writeFile(
    // `opencollection.yml` is the name that declares a yaml collection, both here
    // and in `bru run`. A differently named file declares nothing, and the writer
    // then falls back to yaml — which passes for the wrong reason.
    join(root, format === 'yaml' ? 'opencollection.yml' : 'bruno.json'),
    format === 'yaml'
      ? 'opencollection: "1.0"\ninfo:\n  name: Edited\n'
      : JSON.stringify({ version: '1', name: 'Edited', type: 'collection' }),
  );
  await mkdir(join(root, 'protos'));
  await writeFile(join(root, 'protos', 'greet.proto'), PROTO);
  return root;
}

/** A WebSocket request with something in every block an edit could lose. */
const wsInput = (root: string, overrides: Partial<CreateRequestInput> = {}): CreateRequestInput => ({
  collectionPath: root,
  name: 'Socket',
  kind: 'ws',
  url: 'ws://127.0.0.1:8080/feed',
  sequence: 1,
  headers: { 'X-Trace': 'abc' },
  auth: { type: 'bearer', config: { token: '{{token}}' } },
  websocket: {
    messages: [
      { title: 'hello', content: '{"op":"hello"}' },
      { title: 'ping', content: '{"op":"ping"}' },
    ],
  },
  ...overrides,
});

/** A gRPC request, whose credentials live in metadata rather than headers. */
const grpcInput = (root: string, overrides: Partial<CreateRequestInput> = {}): CreateRequestInput => ({
  collectionPath: root,
  name: 'Greet',
  kind: 'grpc',
  url: 'grpc://127.0.0.1:50051',
  sequence: 1,
  headers: { 'X-Trace': 'abc' },
  auth: { type: 'bearer', config: { token: '{{token}}' } },
  grpc: {
    method: '/greet.Greeter/SayHello',
    protoPath: 'protos/greet.proto',
    methodType: 'unary',
    messages: [{ title: 'first', content: '{"name":"world"}' }],
  },
  ...overrides,
});

async function author(input: CreateRequestInput): Promise<{ path: string; bytes: string }> {
  const created = await createRequestBuilder().createRequest(input);
  expect(created.success).toBe(true);
  const path = created.path as string;
  return { path, bytes: await readFile(path, 'utf-8') };
}

async function edit(path: string, updates: Partial<CreateRequestInput>): Promise<string> {
  const result = await createRequestBuilder().updateRequest(path, updates);
  expect(result.error).toBeUndefined();
  expect(result.success).toBe(true);
  return readFile(path, 'utf-8');
}

/**
 * The lines an edit added and removed.
 *
 * Line-level rather than a real diff because the question is only ever "did
 * anything else move" — an unchanged block contributes nothing to either list, and
 * naming both sides makes a reordering visible instead of cancelling out.
 */
function lineDelta(before: string, after: string): { removed: string[]; added: string[] } {
  const b = before.split('\n');
  const a = after.split('\n');
  return {
    removed: b.filter((line) => !a.includes(line)),
    added: a.filter((line) => !b.includes(line)),
  };
}

describe.each<[string, Format]>([['.bru', 'bru'], ['.yml', 'yaml']])(
  '%s: one field changes and nothing else does',
  (_dialect, format) => {
    it('moves a WebSocket url and leaves every other line in place', async () => {
      const root = await collection('ws-url', format);
      const { path, bytes } = await author(wsInput(root));

      const after = await edit(path, { url: 'wss://example.test/live' });

      expect(lineDelta(bytes, after)).toEqual({
        removed: [expect.stringContaining('ws://127.0.0.1:8080/feed')],
        added: [expect.stringContaining('wss://example.test/live')],
      });
    });

    it('moves a gRPC method and leaves every other line in place', async () => {
      const root = await collection('grpc-method', format);
      const { path, bytes } = await author(grpcInput(root));

      const after = await edit(path, { grpc: { method: '/greet.Greeter/SayGoodbye' } });

      expect(lineDelta(bytes, after)).toEqual({
        removed: [expect.stringContaining('/greet.Greeter/SayHello')],
        added: [expect.stringContaining('/greet.Greeter/SayGoodbye')],
      });
    });

    it('adds a WebSocket header without disturbing the one already there', async () => {
      const root = await collection('ws-headers', format);
      const { path, bytes } = await author(wsInput(root));

      const after = await edit(path, { headers: { 'X-Added': 'yes' } });

      expect(lineDelta(bytes, after).removed).toEqual([]);
      expect(after).toContain('X-Trace');
      expect(after).toContain('X-Added');
    });

    it('adds gRPC metadata rather than headers', async () => {
      const root = await collection('grpc-metadata', format);
      const { path } = await author(grpcInput(root));

      const after = await edit(path, { headers: { 'X-Added': 'yes' } });

      if (format === 'bru') {
        const reparsed = parseBruRequest(after);
        expect(reparsed.metadata).toEqual([
          { name: 'X-Trace', value: 'abc' },
          { name: 'X-Added', value: 'yes' },
        ]);
        expect(reparsed.headers).toBeUndefined();
      } else {
        const reparsed = parseYamlRequest(after);
        expect(reparsed.grpc?.metadata).toEqual([
          { name: 'X-Trace', value: 'abc' },
          { name: 'X-Added', value: 'yes' },
        ]);
        expect(after).not.toContain('headers:');
      }
    });

    it('replaces the WebSocket messages and keeps url, headers and auth', async () => {
      const root = await collection('ws-messages', format);
      const { path } = await author(wsInput(root));

      const after = await edit(path, {
        websocket: { messages: [{ title: 'only', content: '{"op":"bye"}' }] },
      });

      expect(after).toContain('{"op":"bye"}');
      expect(after).not.toContain('{"op":"hello"}');
      expect(after).not.toContain('{"op":"ping"}');
      expect(after).toContain('ws://127.0.0.1:8080/feed');
      expect(after).toContain('X-Trace');
      expect(after).toContain('{{token}}');
    });

    it('replaces the gRPC messages and keeps the proto path and method type', async () => {
      const root = await collection('grpc-messages', format);
      const { path } = await author(grpcInput(root));

      const after = await edit(path, {
        grpc: { messages: [{ title: 'second', content: '{"name":"moon"}' }] },
      });

      expect(after).toContain('{"name":"moon"}');
      expect(after).not.toContain('{"name":"world"}');
      expect(after).toContain('protos/greet.proto');
      expect(after).toContain('unary');
    });

    it('writes an edited credential exactly as an authored one', async () => {
      const root = await collection('auth-parity', format);
      const bearer = await author(wsInput(root));
      const authored = await author(wsInput(root, {
        name: 'Twin',
        sequence: 2,
        auth: { type: 'api-key', config: { key: 'X-Key', value: '{{apiKey}}', placement: 'header' } },
      }));

      const after = await edit(bearer.path, {
        auth: { type: 'api-key', config: { key: 'X-Key', value: '{{apiKey}}', placement: 'header' } },
      });

      // Compare the credential region only: the two files differ in name and seq.
      const credential = (bytes: string) =>
        bytes.split('\n').filter((line) => /\bauth|key:|value:|placement:/i.test(line));
      expect(credential(after)).toEqual(credential(authored.bytes));
      expect(after).not.toContain('{{token}}');
      // Bruno's own mode spelling, which its reader matches on.
      if (format === 'yaml') expect(after).toContain('apikey');
    });

    it.each(['inherit', 'none'] as const)('drops the credential when auth becomes %s', async (mode) => {
      const root = await collection(`auth-${mode}`, format);
      const { path } = await author(grpcInput(root));

      const after = await edit(path, { auth: { type: mode, config: {} } });

      // The credential block goes with the mode; a leftover one would keep
      // sending the token the caller just asked to drop.
      expect(after).not.toContain('{{token}}');
      if (format === 'bru') {
        // `.bru` names the mode in the transport block either way.
        expect(parseBruRequest(after).grpc?.auth).toBe(mode);
        expect(parseBruRequest(after).auth).toBeUndefined();
      } else {
        // `.yml` spells `none` as the absence of the key, which is what its
        // create path writes, so the edit has to remove it rather than blank it.
        expect(parseYamlRequest(after).grpc?.auth).toBe(mode === 'inherit' ? 'inherit' : undefined);
      }
    });
  },
);

describe('the kind-agnostic edits reach a request with no http block', () => {
  // These were applied on the http path only, so a WebSocket request took them
  // without complaint and wrote none of them.
  it.each<[string, Format]>([['.bru', 'bru'], ['.yml', 'yaml']])(
    '%s: writes an assertion, a variable and a setting onto a ws request',
    async (_dialect, format) => {
      const root = await collection('agnostic', format);
      const { path } = await author(wsInput(root));

      const after = await edit(path, {
        assert: [{ name: 'res.status', value: 'eq 101' }],
        vars: { postResponse: [{ name: 'sessionId', value: 'res.body.id' }] },
        settings: { timeout: 5000 },
      });

      expect(after).toContain('res.status');
      expect(after).toContain('sessionId');
      expect(after).toContain('5000');
      // And the transport itself is untouched by them.
      expect(after).toContain('ws://127.0.0.1:8080/feed');
    },
  );
});
