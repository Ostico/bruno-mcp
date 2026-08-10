/**
 * Tests for describeParseFailure — how a request file that will not parse is
 * reported. The cap and the empty-message fallback are tested here rather than
 * through the executor because what the parsers throw is not under a caller's
 * control, so no fixture can reach either branch.
 */

import { describeParseFailure } from '../../../src/bruno/parse-failure';
import { parseBruRequest } from '../../../src/bruno/bru-parser';

/** The error a real `.bru` grammar rejection throws, for the block name given. */
function bruRejection(blockName: string): unknown {
  try {
    parseBruRequest(
      `meta {\n  name: Echo\n  type: http\n}\n\n${blockName} {\n  url: wss://echo.example/socket\n}\n`,
    );
  } catch (error) {
    return error;
  }
  throw new Error(`expected ${blockName} to be rejected`);
}

describe('describeParseFailure', () => {
  it('keeps the first line and drops the code frame under it', () => {
    const failure = describeParseFailure(
      '/c/broken.yml',
      new Error('Nested mappings are not allowed at line 2, column 9:\n\n  name: a\n        ^\n'),
    );

    expect(failure).toEqual({
      file: '/c/broken.yml',
      message: 'Nested mappings are not allowed at line 2, column 9:',
    });
  });

  it('carries the .bru grammar’s expected-block list, which is on its last line', () => {
    const { message } = describeParseFailure('/c/echo.bru', bruRejection('websocket'));
    const families = message.slice(message.indexOf('Expected ') + 'Expected '.length).split(', ');

    expect(message.startsWith('Failed to parse .bru file: Line 6, col 1: Expected ')).toBe(true);
    // The block the author meant. Reporting the position alone is what made a
    // misspelled block name look like a format that cannot express the request.
    expect(families).toContain('ws');
    expect(families).toContain('meta');
  });

  it('collapses the expected-block families so the whole list fits the cap', () => {
    const { message } = describeParseFailure('/c/echo.bru', bruRejection('websocket'));
    const families = message.slice(message.indexOf('Expected ') + 'Expected '.length).split(', ');

    // Over fifty block names uncollapsed, and `ws` sits near the end of them.
    expect(families).toContain('auth:*');
    expect(families).not.toContain('auth:bearer');
    expect(families).toEqual([...new Set(families)]);
    expect(message.length).toBeLessThanOrEqual(300);
    expect(message.endsWith('…')).toBe(false);
  });

  it('does not echo the rejected source back', () => {
    // The frame ohm prints around the offending line quotes the file, which a
    // request body makes a bad place to copy from.
    expect(describeParseFailure('/c/echo.bru', bruRejection('websocket')).message)
      .not.toContain('websocket');
  });

  it('marks a truncated message instead of cutting it silently', () => {
    const long = `Failed to parse: ${'x'.repeat(400)}`;
    const failure = describeParseFailure('/c/broken.yml', new Error(long));

    expect(failure.message).toHaveLength(301);
    expect(failure.message.endsWith('…')).toBe(true);
    expect(failure.message.slice(0, 30)).toBe(long.slice(0, 30));
  });

  it('reports a reason even when the error carries none', () => {
    expect(describeParseFailure('/c/broken.yml', new Error('')).message)
      .toBe('Unknown parse error');
    // Whitespace-only is the same case: a named file and a blank reason is the
    // half of this worth fixing least.
    expect(describeParseFailure('/c/broken.yml', new Error('   \n  ')).message)
      .toBe('Unknown parse error');
  });

  it('handles a thrown non-Error', () => {
    expect(describeParseFailure('/c/broken.yml', 'plain string throw').message)
      .toBe('plain string throw');
  });
});
