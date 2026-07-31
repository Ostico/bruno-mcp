/**
 * Tests for describeParseFailure — how a request file that will not parse is
 * reported. The cap and the empty-message fallback are tested here rather than
 * through the executor because what the parsers throw is not under a caller's
 * control, so no fixture can reach either branch.
 */

import { describeParseFailure } from '../../../src/bruno/parse-failure';

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
