/**
 * The chai-compatible expect() the sandbox runs against, as pure ES5 source.
 *
 * Extracted from sandbox-worker.ts unchanged, because that file crossed the
 * repo-wide max-lines ceiling. It is a string rather than a module on purpose:
 * it must be evaluated INSIDE the vm context so no host-realm function is ever
 * reachable from sandboxed code, which is the same reason SANDBOX_ASSERT_LIB
 * lives as source too.
 *
 * Two consequences of being a template literal, both load-bearing:
 *   - a backtick anywhere in here, including inside a comment, ends the string
 *     and the errors surface far away and misleadingly. Use plain quotes.
 *   - ${...} must stay escaped.
 */
/**
 * Minimal expect() assertion library as a pure JS string.
 * This is prepended to user scripts and runs entirely inside the VM sandbox.
 * No references to the main Node.js realm — all functions are defined as source.
 */
export const SANDBOX_EXPECT_LIB = `
var expect = (function() {
  function AssertionError(message) {
    this.message = message;
    this.name = 'AssertionError';
  }
  AssertionError.prototype = Object.create(null);
  AssertionError.prototype.constructor = AssertionError;
  AssertionError.prototype.toString = function() { return 'AssertionError: ' + this.message; };

  function typeOf(val) {
    if (val === null) return 'null';
    if (Array.isArray(val)) return 'array';
    return typeof val;
  }

  function stringify(val) {
    if (val === null) return 'null';
    if (val === undefined) return 'undefined';
    if (typeof val === 'string') return '"' + val + '"';
    if (Array.isArray(val)) return 'Array(' + val.length + ')';
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  }

  // stringify() reduces an array to its length, which is useless when the array
  // IS the expectation — a failing .oneOf has to name the candidates it rejected.
  function stringifyList(list) {
    var parts = [];
    for (var i = 0; i < list.length; i++) { parts.push(stringify(list[i])); }
    return '[' + parts.join(', ') + ']';
  }

  function Assertion(val) {
    this._val = val;
  }

  var toProto = Object.create(null);
  var beProto = Object.create(null);
  var haveProto = Object.create(null);

  // --- .equal(expected) ---
  toProto.equal = function(expected) {
    if (this._val !== expected) {
      throw new AssertionError('expected ' + stringify(this._val) + ' to equal ' + stringify(expected));
    }
  };

  // An object target means chai's subset form. Arrays and strings are handled by
  // their own branches first, so this is "a plain object or any other object".
  function isSubsetTarget(v) {
    return v !== null && typeof v === 'object';
  }
  // chai rejects an object target with a primitive argument outright rather than
  // guessing what was meant, and the wording is its own. This is the branch the
  // declared contains operator lands in when its left-hand side is an object,
  // which is why an object target still fails there — as it does upstream.
  function requireSubsetArgument(actual, item) {
    if (item === null || typeof item !== 'object') {
      throw new AssertionError(
        'the given combination of arguments (object and ' + typeof item +
        ') is invalid for this assertion. You can use an array, a map, an object, ' +
        'a set, a string, or a weakset instead of a ' + typeof item
      );
    }
  }

  // --- .contain(item) / .include(item) ---
  function containCheck(actual, item) {
    if (Array.isArray(actual)) {
      var found = false;
      for (var i = 0; i < actual.length; i++) {
        if (actual[i] === item) { found = true; break; }
      }
      if (!found) {
        throw new AssertionError('expected ' + stringify(actual) + ' to contain ' + stringify(item));
      }
    } else if (typeof actual === 'string') {
      if (actual.indexOf(item) === -1) {
        throw new AssertionError('expected ' + stringify(actual) + ' to include ' + stringify(item));
      }
    } else if (isSubsetTarget(actual)) {
      // chai treats an object target as a SUBSET check, comparing the argument's
      // own keys against the target's. Not reachable from the declared contains
      // operator, whose operand is always a coerced primitive and so lands in
      // requireSubsetArgument below, but a hand-written script reaches it.
      requireSubsetArgument(actual, item);
      var keys = Object.keys(item);
      for (var k = 0; k < keys.length; k++) {
        if (!(keys[k] in Object(actual)) || actual[keys[k]] !== item[keys[k]]) {
          throw new AssertionError(
            'expected ' + stringify(actual) + " to have property '" + keys[k] +
            "' of " + stringify(item[keys[k]]) + ', but got ' + stringify(actual[keys[k]])
          );
        }
      }
    } else {
      throw new AssertionError('expected ' + stringify(actual) + ' to be an array or string for contain/include');
    }
  }
  toProto.contain = function(item) { containCheck(this._val, item); };
  toProto.include = function(item) { containCheck(this._val, item); };

  // --- .property(name [, value]) ---
  haveProto.property = function(name, value) {
    var obj = this._val;
    if (obj === null || obj === undefined || !(name in Object(obj))) {
      throw new AssertionError('expected ' + stringify(obj) + ' to have property "' + name + '"');
    }
    if (arguments.length > 1 && obj[name] !== value) {
      throw new AssertionError(
        'expected property "' + name + '" to equal ' + stringify(value) +
        ', but got ' + stringify(obj[name])
      );
    }
  };

  // --- .lengthOf(n) ---
  haveProto.lengthOf = function(n) {
    var actual = this._val;
    // actual != null, not a truthiness test: "" is falsy but does have a length,
    // and treating it as lengthless made a "length 0" assertion on an empty
    // string fail.
    var len =
      actual != null && typeof actual.length === 'number' ? actual.length : undefined;
    if (len === undefined || len !== n) {
      throw new AssertionError(
        'expected ' + stringify(actual) + ' to have length ' + n +
        (len !== undefined ? ', but got ' + len : '')
      );
    }
  };

  // --- .a(type) / .an(type) ---
  function typeCheck(actual, expectedType) {
    var t = typeOf(actual);
    if (t !== expectedType) {
      throw new AssertionError('expected ' + stringify(actual) + ' to be a(n) ' + expectedType + ', but got ' + t);
    }
  }
  beProto.a = function(type) { typeCheck(this._val, type); };
  beProto.an = function(type) { typeCheck(this._val, type); };

  // --- numeric comparisons: four checks, many spellings ---
  // Bruno's assert runtime emits greaterThan/greaterThanOrEqual/lessThan/
  // lessThanOrEqual; hand-written scripts reach for chai's above/below/at.least/
  // at.most or the short gt/gte/lt/lte. Aliasing every spelling onto one
  // implementation is what stops the spellings drifting apart.
  var numericChecks = {
    above: { holds: function(v, n) { return v > n; }, label: 'above', aliases: ['gt', 'greaterThan'] },
    below: { holds: function(v, n) { return v < n; }, label: 'below', aliases: ['lt', 'lessThan'] },
    least: { holds: function(v, n) { return v >= n; }, label: 'at least', aliases: ['gte', 'greaterThanOrEqual'] },
    most: { holds: function(v, n) { return v <= n; }, label: 'at most', aliases: ['lte', 'lessThanOrEqual'] }
  };
  // A non-number cannot be ordered, and JS answers false for every comparison
  // against one — including under negation, where false would read as a pass.
  function requireNumbers(vals, description) {
    for (var i = 0; i < vals.length; i++) {
      if (typeof vals[i] !== 'number') { throw new AssertionError(description + ', but ' + stringify(vals[i]) + ' is not a number'); }
    }
  }
  function numericAssert(key, val, n, negated) {
    var check = numericChecks[key];
    var description = 'expected ' + stringify(val) +
      (negated ? ' to not be ' : ' to be ') + check.label + ' ' + stringify(n);
    requireNumbers([val, n], description);
    var holds = check.holds(val, n);
    if (negated ? holds : !holds) { throw new AssertionError(description); }
  }

  // --- .oneOf(list) ---
  function oneOfAssert(val, list, negated) {
    if (!Array.isArray(list)) { throw new AssertionError('oneOf expects an array of candidates, but got ' + stringify(list)); }
    var found = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i] === val) { found = true; break; }
    }
    if (negated ? found : !found) {
      throw new AssertionError('expected ' + stringify(val) +
        (negated ? ' to not be one of ' : ' to be one of ') + stringifyList(list));
    }
  }

  // --- .within(min, max), inclusive of both bounds ---
  function withinAssert(val, min, max, negated) {
    var description = 'expected ' + stringify(val) +
      (negated ? ' to not be within ' : ' to be within ') + stringify(min) + '..' + stringify(max);
    requireNumbers([val, min, max], description);
    var holds = val >= min && val <= max;
    if (negated ? holds : !holds) { throw new AssertionError(description); }
  }

  // --- .match(regexp) ---
  // The target is coerced rather than required to be a string, matching chai:
  // Bruno's matches operator feeds in the raw left-hand side, often a status code
  // that scripts test against /^2/. .search, not .test, because a caller-supplied
  // /re/g carries lastIndex between calls, so one assertion would pass then fail.
  function matchAssert(val, re, negated) {
    if (!(re instanceof RegExp)) { throw new AssertionError('match expects a regular expression, but got ' + stringify(re)); }
    var holds = String(val).search(re) !== -1;
    if (negated ? holds : !holds) {
      throw new AssertionError('expected ' + stringify(val) +
        (negated ? ' to not match ' : ' to match ') + String(re));
    }
  }

  // --- .startWith(str) / .endWith(str) ---
  function affixAssert(val, affix, atEnd, negated) {
    var verb = atEnd ? 'end with' : 'start with';
    // Affixes are only defined on strings, and answering "no affix" for a
    // non-string would let the negated form report a pass.
    if (typeof val !== 'string' || typeof affix !== 'string') {
      throw new AssertionError('expected ' + stringify(val) + ' to ' + verb + ' ' + stringify(affix) +
        ', but both must be strings (got ' + typeOf(val) + ' and ' + typeOf(affix) + ')');
    }
    var holds = atEnd
      ? val.slice(val.length - affix.length) === affix
      : val.slice(0, affix.length) === affix;
    if (negated ? holds : !holds) {
      throw new AssertionError('expected ' + stringify(val) +
        (negated ? ' to not ' : ' to ') + verb + ' ' + stringify(affix));
    }
  }

  // --- property-style matchers: .true/.false/.null/.undefined/.ok/.empty ---
  // These are read as properties rather than called as methods, so they have to
  // assert from a getter. They used to be absent entirely, which meant
  // expect(false).to.be.true evaluated to undefined, threw nothing, and was
  // reported as a PASS.
  function isEmptyVal(v) {
    if (typeof v === 'string' || Array.isArray(v)) return v.length === 0;
    if (v !== null && typeof v === 'object') return Object.keys(v).length === 0;
    return false;
  }
  // Emptiness is undefined for a value with no length, size or own keys, so chai
  // THROWS for one instead of answering false, and a throw survives negation.
  // That distinction is the whole assertion here: answering false would make
  // .to.not.be.empty PASS on null, undefined or a number — reporting a missing
  // field as having content, on the one matcher whose purpose is the opposite.
  // Runs before the polarity branch for the same reason requireNumbers does.
  function requireEmptyable(v) {
    if (typeof v === 'string' || Array.isArray(v) || (v !== null && typeof v === 'object')) {
      return;
    }
    if (typeof v === 'function') {
      throw new AssertionError('.empty was passed a function');
    }
    throw new AssertionError('.empty was passed non-string primitive ' + stringify(v));
  }
  // Preconditions that must throw in BOTH polarities. Keyed by matcher name; a
  // matcher with no entry is total over its input and needs none.
  var propertyPreconditions = {
    'empty': requireEmptyable
  };
  // .to.be.json does NOT parse a string. Bruno's own isJson assertion checks the
  // value is already a plain object or an array — what res.getBody() yields for a
  // JSON response — so a JSON *string* is deliberately not json here. Mirrors
  // Bruno rather than the name's intuitive reading. Object.prototype.toString
  // rather than a constructor check because this vm realm has its own Object.
  function isJsonVal(v) {
    return typeof v === 'object' && v !== null &&
      (Array.isArray(v) || Object.prototype.toString.call(v) === '[object Object]');
  }
  var propertyMatchers = {
    'true': function(v) { return v === true; },
    'false': function(v) { return v === false; },
    'null': function(v) { return v === null; },
    'undefined': function(v) { return v === undefined; },
    'ok': function(v) { return !!v; },
    'empty': isEmptyVal,
    'json': isJsonVal
  };
  function definePropertyMatchers(target, getVal, negated) {
    Object.keys(propertyMatchers).forEach(function(name) {
      Object.defineProperty(target, name, {
        enumerable: true,
        get: function() {
          var v = getVal();
          if (propertyPreconditions[name]) { propertyPreconditions[name](v); }
          var holds = propertyMatchers[name](v);
          if (negated ? holds : !holds) {
            throw new AssertionError(
              'expected ' + stringify(v) + (negated ? ' to not be ' : ' to be ') + name
            );
          }
          return undefined;
        }
      });
    });
  }

  // Matchers reachable through .to.be / .to.not.be. Defined from one place for
  // both polarities so a matcher can never exist in the affirmative chain while
  // its negation falls through to the unknown-matcher guard.
  function defineBeMethods(target, getVal, negated) {
    Object.keys(numericChecks).forEach(function(key) {
      var spellings = [key].concat(numericChecks[key].aliases);
      spellings.forEach(function(name) {
        target[name] = function(n) { numericAssert(key, getVal(), n, negated); };
      });
    });
    target.oneOf = function(list) { oneOfAssert(getVal(), list, negated); };
    target.within = function(min, max) { withinAssert(getVal(), min, max, negated); };
    // chai's "at" carries no assertion of its own; it exists so .to.be.at.least(2)
    // reads as English. Guarded like every other chain object so a typo after it
    // still throws rather than reading as undefined.
    Object.defineProperty(target, 'at', {
      enumerable: true,
      get: function() {
        var at = Object.create(null);
        at.least = target.least;
        at.most = target.most;
        return guardChain(at, negated ? 'to.not.be.at' : 'to.be.at');
      }
    });
  }

  // String-shape matchers, which chai exposes on .to directly rather than under
  // .to.be. Both chai-string spellings are registered: Bruno's assert runtime
  // emits startWith/endWith, scripts written against chai-string's docs use
  // startsWith/endsWith.
  function defineStringMatchers(target, getVal, negated) {
    target.match = function(re) { matchAssert(getVal(), re, negated); };
    target.startWith = function(s) { affixAssert(getVal(), s, false, negated); };
    target.startsWith = target.startWith;
    target.endWith = function(s) { affixAssert(getVal(), s, true, negated); };
    target.endsWith = target.endWith;
  }

  // Any accessor we do not implement must fail loudly. Returning undefined for an
  // unrecognised matcher is what turned an entire class of typos and unsupported
  // matchers into silent passes, so guard the chain objects rather than only adding
  // the specific names that were missing.
  function guardChain(target, label) {
    return new Proxy(target, {
      get: function(obj, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'then' || prop === 'inspect' || prop === 'constructor') return undefined;
        if (prop in obj) return obj[prop];
        throw new AssertionError(
          'unknown matcher "' + label + '.' + String(prop) + '" is not supported; ' +
          'failing instead of passing silently'
        );
      }
    });
  }

  // Wire up the chain: expect(val).to.be.X / .to.have.X / .to.X
  // Each chain accessor creates a new context sharing _val
  Object.defineProperty(Assertion.prototype, 'to', {
    get: function() {
      var self = this;
      var chain = Object.create(null);
      // direct methods on .to
      chain.equal = function(e) { toProto.equal.call(self, e); };
      chain.contain = function(i) { toProto.contain.call(self, i); };
      chain.include = function(i) { toProto.include.call(self, i); };
      defineStringMatchers(chain, function() { return self._val; }, false);
      // .to.be
      Object.defineProperty(chain, 'be', {
        get: function() {
          var be = Object.create(null);
          be.a = function(t) { beProto.a.call(self, t); };
          be.an = function(t) { beProto.an.call(self, t); };
          defineBeMethods(be, function() { return self._val; }, false);
          definePropertyMatchers(be, function() { return self._val; }, false);
          return guardChain(be, 'to.be');
        }
      });
      // .to.exist / .to.not.exist
      Object.defineProperty(chain, 'exist', {
        get: function() {
          if (self._val === null || self._val === undefined) {
            throw new AssertionError('expected ' + stringify(self._val) + ' to exist');
          }
          return undefined;
        }
      });
      // .to.have
      Object.defineProperty(chain, 'have', {
        get: function() {
          var have = Object.create(null);
          have.property = function(n, v) {
            if (arguments.length > 1) haveProto.property.call(self, n, v);
            else haveProto.property.call(self, n);
          };
          have.lengthOf = function(n) { haveProto.lengthOf.call(self, n); };
          return guardChain(have, 'to.have');
        }
      });
      // .to.not — negating chain
      Object.defineProperty(chain, 'not', {
        get: function() {
          var not = Object.create(null);
          // .to.not.equal(expected)
          not.equal = function(expected) {
            if (self._val === expected) {
              throw new AssertionError('expected ' + stringify(self._val) + ' to not equal ' + stringify(expected));
            }
          };
          // .to.not.include(item) / .to.not.contain(item)
          function notContainCheck(actual, item) {
            if (Array.isArray(actual)) {
              var found = false;
              for (var i = 0; i < actual.length; i++) {
                if (actual[i] === item) { found = true; break; }
              }
              if (found) {
                throw new AssertionError('expected ' + stringify(actual) + ' to not contain ' + stringify(item));
              }
            } else if (typeof actual === 'string') {
              if (actual.indexOf(item) !== -1) {
                throw new AssertionError('expected ' + stringify(actual) + ' to not include ' + stringify(item));
              }
            } else if (isSubsetTarget(actual)) {
              // Mirror of the positive subset form: the negation fails when the
              // argument IS a subset. The argument check runs first in both
              // polarities, because an invalid combination is chai's error
              // regardless of negation.
              requireSubsetArgument(actual, item);
              var notKeys = Object.keys(item);
              for (var nk = 0; nk < notKeys.length; nk++) {
                if (notKeys[nk] in Object(actual) && actual[notKeys[nk]] === item[notKeys[nk]]) {
                  throw new AssertionError(
                    'expected ' + stringify(actual) + " to not have property '" +
                    notKeys[nk] + "' of " + stringify(item[notKeys[nk]])
                  );
                }
              }
            } else {
              throw new AssertionError('expected ' + stringify(actual) + ' to be an array or string for not.contain/include');
            }
          }
          not.include = function(item) { notContainCheck(self._val, item); };
          not.contain = function(item) { notContainCheck(self._val, item); };
          defineStringMatchers(not, function() { return self._val; }, true);
          // .to.not.have
          Object.defineProperty(not, 'have', {
            get: function() {
              var notHave = Object.create(null);
              notHave.property = function(name) {
                var obj = self._val;
                if (obj !== null && obj !== undefined && name in Object(obj)) {
                  throw new AssertionError('expected ' + stringify(obj) + ' to not have property "' + name + '"');
                }
              };
              // Guarded like every sibling chain object. It was the one that
              // was not, so an unknown matcher after to.not.have read undefined
              // and passed silently — no declared operator reaches it, but a
              // hand-written script can, and the guard's whole promise is that
              // an unknown matcher fails loudly rather than reporting green.
              return guardChain(notHave, 'to.not.have');
            }
          });
          // .to.not.be
          Object.defineProperty(not, 'be', {
            get: function() {
              var notBe = Object.create(null);
              notBe.a = function(type) {
                var t = typeOf(self._val);
                if (t === type) {
                  throw new AssertionError('expected ' + stringify(self._val) + ' to not be a(n) ' + type);
                }
              };
              notBe.an = notBe.a;
              defineBeMethods(notBe, function() { return self._val; }, true);
              definePropertyMatchers(notBe, function() { return self._val; }, true);
              return guardChain(notBe, 'to.not.be');
            }
          });
          // .to.not.exist
          Object.defineProperty(not, 'exist', {
            get: function() {
              if (self._val !== null && self._val !== undefined) {
                throw new AssertionError('expected ' + stringify(self._val) + ' to not exist');
              }
              return undefined;
            }
          });
          return guardChain(not, 'to.not');
        }
      });
      return guardChain(chain, 'to');
    }
  });

  return function expect(val) {
    return new Assertion(val);
  };
})();
`;
