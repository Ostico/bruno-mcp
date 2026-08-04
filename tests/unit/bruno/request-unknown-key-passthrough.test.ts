/**
 * What survives a read-modify-write of a request this server did not author.
 *
 * Both generators rebuild the file from the typed model instead of editing the
 * bytes, so a key the model has no field for was not ignored on a write — it was
 * deleted. `examples`, `info.description`, a `description` on a header: all
 * present in Bruno's grammar, all gone the first time `modify_request` touched
 * the file.
 * That makes an incomplete model a data-loss bug rather than a fidelity gap,
 * which is why the checks here are about keys nothing in this repo models.
 *
 * The assertions read the emitted text, not a model round-trip: writer and
 * parser share this repo's idea of the format, so a round-trip oracle would
 * agree with itself while the file on disk lost half its blocks.
 *
 * The two dialects are bounded differently, and the last group pins the bounds
 * rather than papering over them. On `.bru`, an unknown key inside a `settings`
 * block cannot be kept because upstream's reader discards it before this code
 * runs, and a single-line `tags: smoke` must not be kept because it is not a
 * tags list — upstream reads any non-list as no tags, and its writer would spell
 * the string one character per line. Both are asserted, so a grammar upgrade that
 * fixes either one fails a test here instead of going unnoticed.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseYamlRequest } from '../../../src/bruno/yaml-parser.js';
import { generateYamlRequest } from '../../../src/bruno/yaml-generator.js';
import { parseBruRequest, generateBruRequest } from '../../../src/bruno/bru-parser.js';
import { createRequestBuilder, RequestBuilder } from '../../../src/bruno/request.js';

let builder: RequestBuilder;

beforeEach(() => {
  builder = createRequestBuilder();
});

/** A .yml request as Bruno writes one, carrying blocks this server does not model. */
const YML_AUTHORED_BY_BRUNO = `info:
  name: Probe
  type: http
  seq: 1
  tags:
    - smoke

http:
  method: get
  url: https://example.com
  auth: none
  headers:
    - name: Accept
      value: application/json
      description: negotiated by the caller
  params:
    - name: q
      value: "1"
      type: query
      description: free-text search

runtime:
  scripts:
    - type: before-request
      code: bru.setVar('x', 1)
  hooks:
    - name: audit

settings:
  encodeUrl: true
  customSetting: 42

examples:
  - name: happy path
    status: 200

docs: what this request is for
`;

/** Re-emit a document without changing anything the model does hold. */
function rewrite(source: string): string {
  return generateYamlRequest(parseYamlRequest(source));
}

async function collectionDir(label: string): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), `bruno-extra-${label}-`));
  await fs.writeFile(
    join(dir, 'bruno.json'),
    JSON.stringify({ version: '1', name: 'c', type: 'collection' }),
  );
  return dir;
}

/** Hand-write a request file, as Bruno itself would, and return its path. */
async function seed(label: string, fileName: string, source: string): Promise<string> {
  const dir = await collectionDir(label);
  const filePath = join(dir, fileName);
  await fs.writeFile(filePath, source);
  return filePath;
}

describe('.yml: keys this server does not model survive a rewrite', () => {
  it('keeps an unmodelled key in the info block', () => {
    const out = rewrite(YML_AUTHORED_BY_BRUNO);
    expect(out).toContain('tags:');
    expect(out).toContain('- smoke');
  });

  it('keeps an unmodelled key on a header entry', () => {
    const out = rewrite(YML_AUTHORED_BY_BRUNO);
    expect(out).toContain('description: negotiated by the caller');
  });

  it('keeps an unmodelled key on a query param entry', () => {
    const out = rewrite(YML_AUTHORED_BY_BRUNO);
    expect(out).toContain('description: free-text search');
  });

  it('keeps an unmodelled key in the settings block', () => {
    const out = rewrite(YML_AUTHORED_BY_BRUNO);
    expect(out).toContain('customSetting: 42');
  });

  it('keeps an unmodelled key in the runtime block alongside the scripts', () => {
    const out = rewrite(YML_AUTHORED_BY_BRUNO);
    expect(out).toContain('hooks:');
    expect(out).toContain('- name: audit');
  });

  it('keeps a whole top-level block it has no field for', () => {
    const out = rewrite(YML_AUTHORED_BY_BRUNO);
    expect(out).toContain('examples:');
    expect(out).toContain('name: happy path');
    expect(out).toContain('status: 200');
  });

  it('keeps an unmodelled top-level block that is not one of Bruno\'s either', () => {
    const out = rewrite(`info:
  name: R

http:
  method: get
  url: https://example.com

somethingNewInBruno:
  alpha: "1"
`);
    expect(out).toContain('somethingNewInBruno:');
    expect(out).toContain('alpha:');
  });

  it('keeps a runtime block whose only content is unmodelled', () => {
    // parseRuntime used to return undefined for a script-less runtime block, so
    // there was no object on the model to hang the carried keys off.
    const out = rewrite(`info:
  name: R

http:
  method: get
  url: https://example.com

runtime:
  hooks:
    - name: audit
`);
    expect(out).toContain('runtime:');
    expect(out).toContain('hooks:');
  });

  it('never writes the carrier itself into the file', () => {
    // The bag is an implementation detail of the model. An `extra:` key reaching
    // the file would be a new unmodelled key of our own invention.
    expect(rewrite(YML_AUTHORED_BY_BRUNO)).not.toContain('extra:');
  });

  it('adds nothing to a request that has no unmodelled keys', () => {
    const plain = `info:
  name: R
  type: http
  seq: 1

http:
  method: get
  url: https://example.com
`;
    const once = rewrite(plain);
    expect(once).not.toContain('extra');
    // Idempotent: a second pass must not accumulate anything either.
    expect(rewrite(once)).toBe(once);
  });

  it('puts a carried block where Bruno puts it, between settings and docs', () => {
    const out = rewrite(YML_AUTHORED_BY_BRUNO);
    expect(out.indexOf('settings:')).toBeLessThan(out.indexOf('examples:'));
    expect(out.indexOf('examples:')).toBeLessThan(out.indexOf('docs:'));
  });

  it('appends a carried block when the request has no docs to sit before', () => {
    const out = rewrite(`info:
  name: R

http:
  method: get
  url: https://example.com

examples:
  - name: only
`);
    expect(out).toContain('examples:');
    expect(out).toContain('- name: only');
  });
});

describe('.yml: a carried key never wins over the typed model', () => {
  it('does not let a carried top-level key overwrite a block the generator writes', () => {
    // The skip list is load-bearing, not defensive: a stale key read off the file
    // being replaced would otherwise clobber the update the caller just asked for.
    const out = generateYamlRequest({
      info: { name: 'real' },
      http: { method: 'get', url: 'https://example.com' },
      extra: {
        info: { name: 'stale' },
        http: { method: 'delete', url: 'https://attacker.example' },
        keepMe: true,
      },
    });
    expect(out).toContain('name: real');
    expect(out).not.toContain('stale');
    expect(out).not.toContain('attacker.example');
    expect(out).toContain('keepMe: true');
  });

  it('changes nothing when every carried top-level key turns out to be modelled', () => {
    // The bag filters down to empty, so the document must come back exactly as
    // the generator built it rather than gaining a reordered copy of itself.
    const request = {
      info: { name: 'R' },
      http: { method: 'get', url: 'https://example.com' },
      docs: 'notes',
    };
    const withStaleBag = generateYamlRequest({ ...request, extra: { info: { name: 'stale' } } });
    expect(withStaleBag).toBe(generateYamlRequest(request));
    expect(withStaleBag).not.toContain('stale');
  });

  it('does not let a carried header key overwrite the header value', () => {
    const out = generateYamlRequest({
      info: { name: 'R' },
      http: {
        method: 'get',
        url: 'https://example.com',
        headers: [
          { name: 'Accept', value: 'application/json', extra: { value: 'text/html', note: 'k' } },
        ],
      },
    });
    expect(out).toContain('value: application/json');
    expect(out).not.toContain('text/html');
    expect(out).toContain('note: k');
  });

  it('does not resurrect the legacy top-level vars and assert keys', () => {
    // H4 moved these into `runtime`. They are still read from the old position,
    // so leaving them out of the skip list would emit them in both places.
    const out = rewrite(`info:
  name: R

http:
  method: get
  url: https://example.com

vars:
  preRequest:
    - name: token
      value: abc

assert:
  - name: res.status
    value: eq 200
`);
    expect(out).toContain('runtime:');
    expect(out).toContain('variables:');
    expect(out).toContain('assertions:');
    // Not re-emitted at the top level, where Bruno would never look for them.
    expect(out).not.toMatch(/^vars:/m);
    expect(out).not.toMatch(/^assert:/m);
  });
});

describe('.yml: modify_request no longer deletes what it did not model', () => {
  it('preserves examples and info.tags across an update to the url', async () => {
    const filePath = await seed('yml-update', 'probe.yml', YML_AUTHORED_BY_BRUNO);

    const result = await builder.updateRequest(filePath, { url: 'https://example.com/v2' });
    expect(result.success).toBe(true);

    const onDisk = await fs.readFile(filePath, 'utf-8');
    expect(onDisk).toContain('https://example.com/v2');
    expect(onDisk).toContain('examples:');
    expect(onDisk).toContain('name: happy path');
    expect(onDisk).toContain('tags:');
    expect(onDisk).toContain('customSetting: 42');
    expect(onDisk).toContain('description: negotiated by the caller');
  });
});

describe('.bru: what the grammar allows, and what it does not', () => {
  const BRU_AUTHORED_BY_BRUNO = `meta {
  name: Probe
  type: http
  seq: 1
  tags: smoke
  reviewedBy: qa
}

get {
  url: https://example.com
  body: none
  auth: none
}

settings {
  encodeUrl: true
  customSetting: 42
}
`;

  it('keeps an unmodelled key in the meta block', () => {
    // A dictionary block: upstream's serializer walks its keys, so a carried one
    // is emitted like any other.
    const out = generateBruRequest(parseBruRequest(BRU_AUTHORED_BY_BRUNO));
    expect(out).toContain('reviewedBy: qa');
  });

  it('does not carry a single-line tags value, which is not a tags list', () => {
    // `tags` is modelled now, as a list — see meta-tags.ts and its tests. This
    // fixture uses the single-line form on purpose: the grammar accepts it at the
    // same key, upstream's own reader hands back the string `'smoke'`, and
    // upstream's runner reads any non-list as no tags at all. So there is nothing
    // here to carry, and handing the string to a writer that iterates whatever it
    // gets would put `tags: [ s m o k e ]` on disk.
    const out = generateBruRequest(parseBruRequest(BRU_AUTHORED_BY_BRUNO));
    expect(out).not.toContain('tags:');
    expect(out).not.toMatch(/^\s+s$/m);
  });

  it('never writes the carrier itself into the file', () => {
    expect(generateBruRequest(parseBruRequest(BRU_AUTHORED_BY_BRUNO))).not.toContain('extra');
  });

  it('does not let a carried meta key overwrite the name', () => {
    const out = generateBruRequest({
      meta: { name: 'real', type: 'http', extra: { name: 'stale', reviewedBy: 'keep' } },
      http: { method: 'GET', url: 'https://example.com', body: 'none', auth: 'none' },
    });
    expect(out).toContain('name: real');
    expect(out).not.toContain('stale');
    expect(out).toContain('reviewedBy: keep');
  });

  it('cannot keep an unknown key inside a settings block, because the reader drops it', () => {
    // Upstream's `.bru` grammar names this block's fields explicitly and discards
    // anything else at parse time, so the key never reaches this repo. Asserted
    // rather than hidden: if a grammar upgrade starts surfacing it, this fails
    // and the passthrough can be extended to cover it.
    const out = generateBruRequest(parseBruRequest(BRU_AUTHORED_BY_BRUNO));
    expect(out).not.toContain('customSetting');
  });

  it('preserves a meta key across an update to the url', async () => {
    const filePath = await seed('bru-update', 'probe.bru', BRU_AUTHORED_BY_BRUNO);

    const result = await builder.updateRequest(filePath, { url: 'https://example.com/v2' });
    expect(result.success).toBe(true);

    const onDisk = await fs.readFile(filePath, 'utf-8');
    expect(onDisk).toContain('https://example.com/v2');
    expect(onDisk).toContain('reviewedBy: qa');
  });
});
