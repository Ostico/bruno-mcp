/**
 * `atob` and `btoa` inside the sandbox.
 *
 * A fresh `vm` context has the ECMAScript intrinsics and nothing else. `atob`,
 * `btoa` and `Buffer` are Node globals, not intrinsics, so a script that decodes
 * a JWT payload — the ordinary way to read a `uid` out of a token a login just
 * returned — threw a ReferenceError. The workaround was an extra HTTP request
 * for a value the response already carried.
 *
 * Upstream's sandbox allows both names through
 * (`bruno-js/src/sandbox/node-vm/constants.js`), so these are the names a script
 * written for Bruno already uses. The alternative — a `bru.base64` of our own —
 * would be a spelling only this server understands.
 *
 * Written in JavaScript that runs INSIDE the realm rather than as host functions
 * placed on the context. A host function is a live reference out of the sandbox:
 * `hostFn.constructor('return globalThis')()` reaches the real global object from
 * the host realm, which is the escape the empty context exists to prevent. The
 * cost of that decision is this file: base64 by hand, in the realm, where the
 * worst a caller can reach is a string.
 *
 * `Buffer` is deliberately NOT provided. Reimplementing it faithfully would mean
 * a fake typed-array class whose `allocUnsafe` cannot do what its name promises
 * and whose absent `toString('hex')` paths would be discovered one at a time by
 * callers; a bare `Buffer` reference instead throws a ReferenceError, which is
 * reported as a script error and names itself.
 *
 * NOTE: no backticks anywhere below — the body is a template literal.
 */

/** Runs inside the sandbox; declares the two globals and nothing else. */
export const SANDBOX_BASE64_LIB = `
(function () {
  var ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  // Index by code point rather than by indexOf on every character: a JWT header
  // and payload together are a few hundred characters, and this runs under the
  // script timeout the caller set.
  var VALUES = Object.create(null);
  for (var i = 0; i < ALPHABET.length; i++) {
    VALUES[ALPHABET.charAt(i)] = i;
  }

  // The name the platform uses, so a script that catches by name behaves the
  // same here as in the Bruno app.
  //
  // It reaches the SCRIPT but not the reported result. An uncaught error is
  // rewrapped on the way out (sandbox-clock's toHostError) into a host Error
  // chosen from a table of the builtin names, so anything else collapses to
  // Error: the host never holds a sandbox object. That is why the message below
  // names the operation itself rather than leaning on the label.
  class InvalidCharacterError extends Error {
    constructor(message) {
      super(message);
      this.name = 'InvalidCharacterError';
    }
  }

  function invalidCharacter(fn) {
    return new InvalidCharacterError(
      'Failed to execute ' + fn + ': the string contains characters outside the '
      + (fn === 'atob' ? 'base64 alphabet' : 'Latin1 range')
    );
  }

  // A separate message because the two refusals are separate diagnoses. Sharing
  // one would also make the length check indistinguishable from the alphabet
  // check: padding a 4n+1 input up to a multiple of four leaves an '=' in the
  // middle of the value, which the alphabet check rejects anyway -- reporting a
  // stray character the caller never wrote.
  function invalidLength() {
    return new InvalidCharacterError(
      'Failed to execute atob: the string has a length no base64 value can have'
    );
  }

  function btoaImpl(input) {
    var text = String(input);
    var out = '';
    for (var i = 0; i < text.length; i += 3) {
      var a = text.charCodeAt(i);
      var b = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      var c = i + 2 < text.length ? text.charCodeAt(i + 2) : 0;
      // btoa encodes bytes. A character above 0xff is not one, and silently
      // truncating it would produce base64 that decodes to different text.
      if (a > 255 || b > 255 || c > 255) {
        throw invalidCharacter('btoa');
      }
      var word = (a << 16) | (b << 8) | c;
      out += ALPHABET.charAt((word >> 18) & 63);
      out += ALPHABET.charAt((word >> 12) & 63);
      out += i + 1 < text.length ? ALPHABET.charAt((word >> 6) & 63) : '=';
      out += i + 2 < text.length ? ALPHABET.charAt(word & 63) : '=';
    }
    return out;
  }

  function atobImpl(input) {
    // Whitespace is ignored by the platform, and a base64 value that arrived in
    // a header or a JSON body has often been wrapped.
    var text = String(input).replace(/[\\t\\n\\f\\r ]/g, '');

    // Padding is optional on the way in but must not be contradictory: a length
    // of 4n+1 cannot come from any input. Checked before padding, since padding
    // is what would otherwise hide it.
    if (text.length % 4 === 1) {
      throw invalidLength();
    }

    var padded = text;
    while (padded.length % 4 !== 0) {
      padded += '=';
    }

    var stripped = padded.replace(/={1,2}$/, '');
    var out = '';
    var word = 0;
    var bits = 0;
    for (var i = 0; i < stripped.length; i++) {
      var value = VALUES[stripped.charAt(i)];
      if (value === undefined) {
        throw invalidCharacter('atob');
      }
      word = (word << 6) | value;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((word >> bits) & 255);
      }
    }
    return out;
  }

  // Non-enumerable, like the platform's own: a script that walks globalThis to
  // report what it was given should not find these listed as user state.
  Object.defineProperty(globalThis, 'btoa', {
    value: btoaImpl, writable: true, enumerable: false, configurable: true,
  });
  Object.defineProperty(globalThis, 'atob', {
    value: atobImpl, writable: true, enumerable: false, configurable: true,
  });
})();
`;
