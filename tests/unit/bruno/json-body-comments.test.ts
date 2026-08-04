/**
 * Comments in a JSON payload, and whether what is left is JSON (register L17).
 *
 * Bruno's editor lets a JSON body carry `//` and slash-star comments the way
 * `tsconfig.json` does, and Bruno strips them before sending. Nothing here did,
 * so an annotated body reached the wire with the annotations in it and the
 * server answered 400 on a collection that runs clean under `bru run`.
 *
 * Two behaviours are pinned. The comments come out, in the same place upstream
 * takes them out — before variable substitution, so a variable whose value
 * contains `//` keeps it. And what is left is checked for being JSON at all,
 * because a body the server will reject deserves to say so before the round trip
 * rather than after it.
 */

import { parseYamlRequest } from '../../../src/bruno/yaml-parser';
import { buildFetchOptions } from '../../../src/bruno/request-executor';

/** Indent a payload to sit under a `data: |` block scalar. */
const block = (text: string, indent: string): string =>
  text
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n');

/** A `.yml` request whose body is `type` with the given payload. */
const bodyYml = (type: string, data: string): string =>
  [
    'info:',
    '  name: b',
    '  type: http',
    '  seq: 1',
    'http:',
    '  method: post',
    '  url: https://api.example.com/x',
    '  body:',
    `    type: ${type}`,
    '    data: |-',
    block(data, '      '),
    '',
  ].join('\n');

/** A `.yml` graphql request carrying a variables payload. */
const graphqlYml = (variables: string): string =>
  [
    'info:',
    '  name: g',
    '  type: graphql',
    '  seq: 1',
    'graphql:',
    '  url: https://api.example.com/gql',
    '  body:',
    '    query: |-',
    '      { user { id } }',
    '    variables: |-',
    block(variables, '      '),
    '',
  ].join('\n');

const send = async (yml: string, vars: Map<string, string> = new Map()) => {
  const { options, warnings } = await buildFetchOptions(parseYamlRequest(yml), vars, '/nowhere');
  return { body: String(options.body ?? ''), warnings: warnings ?? [] };
};

const malformedWarning = (warnings: string[]): string | undefined =>
  warnings.find((w) => w.includes('not valid json'));

describe('comments come out of a json body before it is sent', () => {
  it('removes a line comment', async () => {
    const { body } = await send(bodyYml('json', '{\n  // the id to look up\n  "id": 7\n}'));

    expect(body).not.toContain('//');
    expect(JSON.parse(body)).toEqual({ id: 7 });
  });

  it('removes a block comment, including one spanning several lines', async () => {
    const { body } = await send(
      bodyYml('json', '{\n  /* why this shape:\n     the server wants it */\n  "id": 7\n}'),
    );

    expect(body).not.toContain('/*');
    expect(JSON.parse(body)).toEqual({ id: 7 });
  });

  it('removes a comment sitting after a value on the same line', async () => {
    const { body } = await send(bodyYml('json', '{\n  "id": 7 // seven\n}'));

    expect(body).not.toContain('seven');
    expect(JSON.parse(body)).toEqual({ id: 7 });
  });

  it('keeps a `//` that is four characters inside a string', async () => {
    // The whole reason this reads the text as JSON rather than scanning for the
    // two characters: a URL in a value is not a comment.
    const { body } = await send(bodyYml('json', '{\n  "next": "https://api.example.com/p"\n}'));

    expect(JSON.parse(body)).toEqual({ next: 'https://api.example.com/p' });
  });

  it('leaves a body with no comments in it byte for byte', async () => {
    // Positive control. Removal replaces comment spans with spaces rather than
    // reflowing the text, so a payload with nothing to remove must come out
    // exactly as authored.
    const authored = '{\n  "id": 7,\n  "name": "seven"\n}';
    const { body } = await send(bodyYml('json', authored));

    expect(body).toBe(authored);
  });

  it('leaves a comment in a body that is not json', async () => {
    // A text body's `//` is content. Upstream strips only the json body and the
    // graphql variables block, and stripping more would corrupt a payload whose
    // syntax this has no business reading.
    const authored = 'plain text // not a comment here';
    const { body } = await send(bodyYml('text', authored));

    expect(body).toBe(authored);
  });

  it('strips before substituting, so a `//` inside a variable value survives', async () => {
    // Ordering, not an accident of ordering: upstream strips in prepare-request,
    // which runs before interpolate-vars. Were it the other way round, a
    // variable holding a URL would come back cut in half at the `//`.
    const { body } = await send(
      bodyYml('json', '{\n  // where to go next\n  "next": "{{base}}/p"\n}'),
      new Map([['base', 'https://api.example.com//x']]),
    );

    expect(JSON.parse(body)).toEqual({ next: 'https://api.example.com//x/p' });
  });
});

describe('a json body that is not json is named in a warning', () => {
  it('names a trailing comma, which a strict server rejects', async () => {
    const { warnings } = await send(bodyYml('json', '{\n  "id": 7,\n}'));

    expect(malformedWarning(warnings)).toContain('not valid json');
  });

  it('names the parse error rather than saying only that something is wrong', async () => {
    const { warnings } = await send(bodyYml('json', '{\n  "id" 7\n}'));

    // The error code distinguishes the two plausible mistakes at that offset,
    // which a thrown SyntaxError's "unexpected token" does not.
    expect(malformedWarning(warnings)).toMatch(/Expected|offset \d+/);
  });

  it('still sends the body, because Bruno sends an unparseable body too', async () => {
    const { body } = await send(bodyYml('json', '{\n  "id": 7,\n}'));

    expect(body).toBe('{\n  "id": 7,\n}');
  });

  it('says nothing when the body is valid json', async () => {
    const { warnings } = await send(bodyYml('json', '{\n  "id": 7\n}'));

    expect(malformedWarning(warnings)).toBeUndefined();
  });

  it('says nothing about json when a comment was the only thing wrong', async () => {
    // Checked after removal, so an annotated body that is otherwise fine is not
    // reported as broken.
    const { warnings } = await send(bodyYml('json', '{\n  // a note\n  "id": 7\n}'));

    expect(malformedWarning(warnings)).toBeUndefined();
  });

  it('says nothing about an empty body, which is a choice rather than a mistake', async () => {
    // Empty is not valid JSON, but a request authored with no body text is a
    // request deliberately sending nothing, and upstream sends it. Warning here
    // would fire on every one of them.
    const { body, warnings } = await send(bodyYml('json', ''));

    expect(body).toBe('');
    expect(malformedWarning(warnings)).toBeUndefined();
  });

  it('says nothing about a body that is only whitespace', async () => {
    const { warnings } = await send(bodyYml('json', '  \n  '));

    expect(malformedWarning(warnings)).toBeUndefined();
  });

  it('stays quiet when a variable did not resolve', async () => {
    // An unresolved `{{id}}` makes the text invalid JSON by definition, and the
    // unresolved variable already has a warning of its own. Two warnings for one
    // cause point the caller at the wrong one.
    const { warnings } = await send(bodyYml('json', '{\n  "id": {{id}}\n}'));

    expect(malformedWarning(warnings)).toBeUndefined();
    expect(warnings.some((w) => w.includes('id'))).toBe(true);
  });
});

describe('comments come out of a graphql variables block', () => {
  it('removes a comment and parses what is left', async () => {
    const { body } = await send(graphqlYml('{\n  // which user\n  "id": 7\n}'));

    expect(JSON.parse(body)).toEqual({ query: '{ user { id } }', variables: { id: 7 } });
  });

  it('keeps a `//` inside a variables string value', async () => {
    const { body } = await send(graphqlYml('{\n  "next": "https://api.example.com/p"\n}'));

    expect(JSON.parse(body).variables).toEqual({ next: 'https://api.example.com/p' });
  });

  it('fails the request by name when removal leaves something unparseable', async () => {
    // The envelope has to be one JSON document, so an unparseable variables
    // block cannot be passed through the way a whole json body can. Upstream
    // fails the request here too.
    await expect(send(graphqlYml('{\n  // a note\n  "id" 7\n}'))).rejects.toThrow(
      /Failed to parse GraphQL variables/,
    );
  });
});
