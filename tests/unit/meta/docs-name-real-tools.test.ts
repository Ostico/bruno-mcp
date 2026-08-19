/**
 * A shipped document may not tell a reader to call a tool this server does not
 * register.
 *
 * `tool-cross-references.test.ts` closes the same hole inside the surface, where
 * one description points at another tool. This closes it in the documents a
 * human reads before ever connecting: a rename leaves the tool list correct and
 * every example in the README wrong, and an example is what gets copied.
 *
 * Two kinds of passage legitimately name a tool that is not registered, and both
 * are fenced by an HTML comment so this test can skip them by position rather
 * than by exempting a name — an exemption list would grow to cover the very
 * names a rename must not leave behind:
 *
 *   - the migration table, whose whole job is to name what was removed;
 *   - prose about another project's tools, which is a true statement about
 *     someone else's server and must not be rewritten to match ours.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { BrunoMcpServer } from '../../../src/server';

/* eslint-disable @typescript-eslint/no-explicit-any */

const REPO_ROOT = join(__dirname, '..', '..', '..');

/** The documents npm ships, and the two a caller is pointed at first. */
const SHIPPED_DOCS = ['README.md', 'INTEGRATION.md'];

/**
 * Tool names this server has registered and no longer does.
 *
 * The check below is `LOOKS_LIKE_A_TOOL minus what is registered now`, so this
 * list is what gives it teeth: a retired name left in a document is only
 * detectable if something still remembers the name was ever real. Append to it
 * whenever a tool is removed or renamed; never remove from it.
 */
const RETIRED_TOOL_NAMES = [
  'create_request',
  'modify_request',
  'create_test_suite',
  'create_crud_requests',
];

const FENCES: [string, string][] = [
  ['<!-- migration-table:start -->', '<!-- migration-table:end -->'],
  ['<!-- foreign-tool-names:start -->', '<!-- foreign-tool-names:end -->'],
];

/**
 * The document with every fenced passage removed.
 *
 * An unclosed fence would otherwise silently swallow the rest of the file, so it
 * throws instead: a fence that opens and never closes exempts far more than
 * whoever opened it intended.
 */
function stripFenced(body: string): string {
  let stripped = body;

  for (const [start, end] of FENCES) {
    for (;;) {
      const opensAt = stripped.indexOf(start);
      if (opensAt === -1) break;

      const closesAt = stripped.indexOf(end, opensAt);
      if (closesAt === -1) throw new Error(`${start} is never closed by ${end}`);

      stripped = stripped.slice(0, opensAt) + stripped.slice(closesAt + end.length);
    }
  }

  return stripped;
}

/** Every snake_case word in a document, tool-shaped or not. */
function snakeCaseWords(text: string): string[] {
  return [...text.matchAll(/\b[a-z]+(?:_[a-z0-9]+)+\b/g)].map((match) => match[0]);
}

describe('shipped documents name only registered tools', () => {
  let registered: Set<string>;
  let looksLikeATool: Set<string>;

  beforeAll(async () => {
    const server = new BrunoMcpServer();
    const client = new Client({ name: 'docs-name-real-tools', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    // Reaches the private McpServer because the public entry point binds stdio.
    await (server as any).server.connect(serverTransport);
    await client.connect(clientTransport);
    registered = new Set((await client.listTools()).tools.map((tool) => tool.name));
    await client.close();

    looksLikeATool = new Set([...registered, ...RETIRED_TOOL_NAMES]);
  });

  it.each(SHIPPED_DOCS)('%s names only registered tools', (doc) => {
    const body = stripFenced(readFileSync(join(REPO_ROOT, doc), 'utf8'));

    const stale = [...new Set(snakeCaseWords(body))]
      .filter((word) => looksLikeATool.has(word) && !registered.has(word));

    expect(stale).toEqual([]);
  });

  // Three ways the check above passes while looking at nothing: the pattern
  // matches no words, the fences swallow the document, or the retired list is
  // empty so no name can ever be stale.
  it('is looking at real tool names in the README', () => {
    const body = stripFenced(readFileSync(join(REPO_ROOT, 'README.md'), 'utf8'));
    const found = new Set(snakeCaseWords(body).filter((word) => registered.has(word)));

    expect(found.has('write_request')).toBe(true);
    expect(found.has('run_collection')).toBe(true);
    expect(found.size).toBeGreaterThan(8);
  });

  it('remembers names that are no longer registered', () => {
    expect(RETIRED_TOOL_NAMES.length).toBeGreaterThan(0);
    expect(RETIRED_TOOL_NAMES.filter((name) => registered.has(name))).toEqual([]);
  });
});

describe('stripFenced', () => {
  it('removes a fenced passage and keeps the rest', () => {
    const body = [
      'Call write_request.',
      '<!-- migration-table:start -->',
      '`create_request` is gone.',
      '<!-- migration-table:end -->',
      'Then run_collection.',
    ].join('\n');

    const stripped = stripFenced(body);

    expect(stripped).toContain('write_request');
    expect(stripped).toContain('run_collection');
    expect(stripped).not.toContain('create_request');
  });

  it('removes every fenced passage, not just the first', () => {
    const fence = (inner: string): string =>
      `<!-- foreign-tool-names:start -->${inner}<!-- foreign-tool-names:end -->`;

    expect(stripFenced(`${fence('create_request')} and ${fence('modify_request')}`))
      .toBe(' and ');
  });

  it('refuses a fence that is never closed', () => {
    expect(() => stripFenced('<!-- migration-table:start --> create_request'))
      .toThrow('is never closed');
  });
});
