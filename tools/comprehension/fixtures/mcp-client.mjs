/**
 * A minimal stdio MCP client, used to build a trial's starting state.
 *
 * The fixture collection is written by the server under test rather than
 * committed as bytes: a committed fixture goes stale the moment the writer's
 * dialect or defaults change, and then every task grading a read or an edit is
 * measuring the fixture instead of the surface. Driving the real tools also
 * means the setup fails loudly if a tool is renamed.
 */

import { spawn } from 'node:child_process';

export function openServer(serverPath, env = {}) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  child.stderr.resume();

  let nextId = 1;
  let buffer = '';
  const pending = new Map();

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          message = null;
        }
        const settle = message && pending.get(message.id);
        if (settle) {
          pending.delete(message.id);
          settle(message);
        }
      }
      index = buffer.indexOf('\n');
    }
  });

  function request(method, params) {
    const id = nextId;
    nextId += 1;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
      });
    });
  }

  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  return {
    async start() {
      await request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'comprehension-fixture', version: '0' },
      });
      notify('notifications/initialized', {});
    },
    async call(name, args) {
      const result = await request('tools/call', { name, arguments: args });
      // A refused tool call comes back as a result with isError, not as a
      // JSON-RPC error, and a fixture built on a refusal is worse than no
      // fixture at all.
      if (result.isError) {
        throw new Error(`${name} refused: ${result.content?.map((c) => c.text).join(' ')}`);
      }
      return result;
    },
    async listTools() {
      return (await request('tools/list', {})).tools;
    },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}
