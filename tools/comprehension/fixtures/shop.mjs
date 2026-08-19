/**
 * The starting state for every task that reads, edits, deletes or runs.
 *
 * Written through the server under test (see mcp-client.mjs). The base URL is
 * the fixture HTTP server's, so a run task's requests really answer; the
 * environment holds the token variables the two-identity task has to keep
 * apart.
 */

import { join } from 'node:path';
import { openServer } from './mcp-client.mjs';

/** Build a Shop collection inside `root`. Returns its path. */
export async function buildShop(serverPath, root, baseUrl, env = {}) {
  const server = openServer(serverPath, env);
  await server.start();
  try {
    const created = await server.call('create_collection', {
      name: 'Shop',
      outputPath: root,
      format: 'yaml',
    });
    const collectionPath = join(root, 'Shop');

    await server.call('write_request', {
      collectionPath,
      requests: [
        {
          name: 'Login',
          method: 'POST',
          url: `${baseUrl}/login`,
          body: { type: 'json', content: '{"user": "{{username}}"}' },
        },
        {
          name: 'Items',
          method: 'GET',
          url: `${baseUrl}/items`,
          auth: { type: 'bearer', config: { token: '{{token}}' } },
        },
        {
          name: 'Admin Reports',
          method: 'GET',
          url: `${baseUrl}/admin/reports`,
          auth: { type: 'bearer', config: { token: '{{token}}' } },
        },
        {
          name: 'Ping',
          method: 'GET',
          url: `${baseUrl}/ping`,
          // Ping starts with a script so that a task asking for one more can be
          // graded on whether the first one survived. Without it, appending and
          // overwriting leave the same file behind and the task proves nothing.
          scripts: { 'post-response': 'console.log("ping done");' },
        },
      ],
    });

    await server.call('create_environment', {
      collectionPath,
      name: 'local',
      variables: [
        { name: 'username', value: 'viewer' },
        { name: 'token', value: 'viewer-token' },
      ],
    });

    return { collectionPath, createdText: created.content?.[0]?.text ?? '' };
  } finally {
    server.close();
  }
}
