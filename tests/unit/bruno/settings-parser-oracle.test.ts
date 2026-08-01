/**
 * What `@usebruno/lang` actually does with a `settings` block.
 *
 * `shouldEncodeUrl` used to be two-valued — off with no block, **on** for a block
 * that did not name `encodeUrl` — justified in its own docblock by the claim that
 * the parser fills the key in as `true`. It fills it in as `false`. The claim was
 * never checked against the library, and nothing failed when it was wrong,
 * because every test that could have caught it asserted our own rule rather than
 * upstream's.
 *
 * So this file asserts the library directly. It is an oracle, not a unit test of
 * ours: if a future `@usebruno/lang` changes these defaults, this goes red and
 * whoever sees it knows that `shouldEncodeUrl` is the thing to revisit — rather
 * than discovering it from a user whose URLs are encoded differently by two tools
 * reading the same file.
 */
import { bruToJsonV2 } from '@usebruno/lang';

const request = (settings = ''): string => `meta {
  name: r
  type: http
  seq: 1
}

get {
  url: https://example.com/x
  auth: none
}
${settings}`;

describe('what the parser reports for a settings block', () => {
  it('reports no settings at all when the file has no block', () => {
    expect(bruToJsonV2(request()).settings).toBeUndefined();
  });

  it('fills encodeUrl in as false, not true, when the block omits it', () => {
    // The measurement the old rule got backwards.
    expect(bruToJsonV2(request('\nsettings {\n  timeout: 20000\n}\n')).settings).toEqual({
      encodeUrl: false,
      timeout: 20000,
    });
  });

  it('fills timeout in as 0 when the block omits it', () => {
    expect(bruToJsonV2(request('\nsettings {\n  encodeUrl: false\n}\n')).settings).toEqual({
      encodeUrl: false,
      timeout: 0,
    });
  });

  it('keeps an explicit encodeUrl: true', () => {
    expect(bruToJsonV2(request('\nsettings {\n  encodeUrl: true\n}\n')).settings).toEqual({
      encodeUrl: true,
      timeout: 0,
    });
  });
});
