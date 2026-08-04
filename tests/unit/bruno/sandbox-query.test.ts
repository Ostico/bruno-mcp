import vm from 'node:vm';
import { join } from 'node:path';
import {
  buildLibFromSource,
  buildQueryLib,
  buildUnavailableQueryLib,
  defaultAnchors,
  readQuerySource,
  sandboxQueryLib,
} from '../../../src/bruno/sandbox-query';
import { runTestJob } from '../../../src/bruno/sandbox-worker';
import { MockResponseData } from '../../../src/bruno/types';

const BODY = {
  data: {
    pets: [
      { name: 'ada', age: 3 },
      { name: 'bob', age: 9 },
    ],
  },
};

function response(overrides: Partial<MockResponseData> = {}): MockResponseData {
  return {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    body: BODY,
    responseTime: 12,
    ...overrides,
  };
}

/**
 * Run source in a context shaped like the sandbox's: no prototype chain to this
 * realm, and no code generation from strings. The query implementation has to
 * work under both, so the test must not relax either.
 */
function runInSandboxLike(source: string): unknown {
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  return new vm.Script(source).runInContext(context, { timeout: 5000 });
}

describe('resolving the query implementation', () => {
  it('reads the installed package as text', () => {
    const source = readQuerySource();

    // The published bundle assigns its single export; without that assignment
    // the shim in buildQueryLib has nothing to pick up.
    expect(source).toContain('exports.get');
  });

  it('tries every anchor before giving up', () => {
    // The first anchor cannot resolve anything, so a working result proves the
    // loop moved on rather than failing at the first attempt. Production relies
    // on this: process.argv[1] is absent under `node -e`.
    const source = readQuerySource(['/nonexistent/anchor/x.js', process.cwd() + '/index.js']);

    expect(source).toContain('exports.get');
  });

  it('throws when no anchor resolves the package, naming the last failure', () => {
    expect(() => readQuerySource(['/nonexistent/anchor/x.js'])).toThrow(
      /could not load @usebruno\/query: Cannot find module/,
    );
  });

  it('names the package when there was no anchor to fail at', () => {
    // No anchors means no attempt was made, so there is no underlying error to
    // report. The message still has to say what could not be loaded.
    expect(() => readQuerySource([])).toThrow(
      'could not load @usebruno/query: no anchor to resolve from',
    );
  });

  it('stays self-contained: the bundle neither requires nor generates code', () => {
    // The whole approach depends on this. Compiling the package's source inside
    // the sandbox is only safe while the source needs nothing from outside it: a
    // require() would fail in a context that has no require, and a Function or
    // eval call would be blocked by codeGeneration.strings. A release that adds
    // either has to be handled deliberately, so it must fail here first.
    const source = readQuerySource();

    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\beval\s*\(/);
    expect(source).not.toMatch(/\bnew\s+Function\b/);
  });
});

describe('the query library, compiled inside a sandbox-like context', () => {
  const lib = buildQueryLib(readQuerySource());
  const data = JSON.stringify(BODY);

  it('resolves a plain path', () => {
    expect(runInSandboxLike(`${lib}\n__bruno_query_get(${data}, 'data.pets[0].name')`)).toBe(
      'ada',
    );
  });

  it('resolves a deep descent, which is not valid JavaScript on its own', () => {
    expect(runInSandboxLike(`${lib}\n__bruno_query_get(${data}, 'data.pets..name')`)).toEqual([
      'ada',
      'bob',
    ]);
  });

  it('applies a filter callback', () => {
    expect(
      runInSandboxLike(
        `${lib}\n__bruno_query_get(${data}, 'data.pets[?].name', function (p) { return p.age > 5; })`,
      ),
    ).toEqual(['bob']);
  });

  it('survives a user script declaring the bundle helpers as globals', () => {
    // The minified bundle names its helpers r, t and e at its own top level. The
    // wrapper is an IIFE for exactly this reason: without it, a global of the
    // same name written afterwards would overwrite a helper the exported
    // function still closes over, and every later query would break.
    expect(
      runInSandboxLike(
        `${lib}\nvar r = 1; var t = 2; var e = 3;\n__bruno_query_get(${data}, 'data.pets..name')`,
      ),
    ).toEqual(['ada', 'bob']);
  });

  it('reports the loss on use when the bundle exports no get', () => {
    const broken = buildQueryLib('exports.somethingElse = 1;');

    expect(() => runInSandboxLike(`${broken}\n__bruno_query_get({}, 'a')`)).toThrow(
      /exports no get/,
    );
  });
});

describe('the anchors resolution starts from', () => {
  it('leads with the running entry point', () => {
    // Production forks the sandbox worker, so argv[1] is a file inside the
    // installed package — the one place from which walking up reaches both a
    // hoisted install of the dependency and a nested one.
    expect(defaultAnchors()[0]).toBe(process.argv[1]);
  });

  it('falls back to the working directory when there is no entry point', () => {
    // True of `node -e`, which has no argv[1] at all.
    const entry = process.argv[1];
    try {
      delete process.argv[1];
      expect(defaultAnchors()).toEqual([join(process.cwd(), 'index.js')]);
    } finally {
      process.argv[1] = entry;
    }
  });
});

describe('the fallback when the implementation cannot be loaded', () => {
  it('keeps the accessor callable and names the cause', () => {
    const lib = buildUnavailableQueryLib('ENOENT: no such file');

    expect(() => runInSandboxLike(`${lib}\n__bruno_query_get({}, 'a')`)).toThrow(
      /unavailable: ENOENT: no such file/,
    );
  });

  it('degrades to the stub when the source cannot be read', () => {
    // The cost of an unreadable package is this one accessor. A collection whose
    // scripts never call res(...) has to keep running.
    const lib = buildLibFromSource(() => {
      throw new Error('ENOENT: open dist/cjs/index.js');
    });

    expect(() => runInSandboxLike(`${lib}\n__bruno_query_get({}, 'a')`)).toThrow(
      /unavailable: ENOENT: open/,
    );
  });

  it('names a thrown non-Error too', () => {
    const lib = buildLibFromSource(() => {
      throw 'resolution refused';
    });

    expect(() => runInSandboxLike(`${lib}\n__bruno_query_get({}, 'a')`)).toThrow(
      /unavailable: resolution refused/,
    );
  });

  it('builds the real library when the source reads', () => {
    const lib = buildLibFromSource(() => readQuerySource());

    expect(runInSandboxLike(`${lib}\n__bruno_query_get({ a: 1 }, 'a')`)).toBe(1);
  });
});

describe('the cached prelude', () => {
  it('reads the source once per process', () => {
    // Every request carrying a script or a declared assertion builds a prelude.
    // Re-reading the file each time would be per-request I/O for a constant.
    expect(sandboxQueryLib()).toBe(sandboxQueryLib());
  });

  it('is a working library, not the unavailable stub', () => {
    expect(sandboxQueryLib()).toContain('exports.get');
  });
});

describe('the response is callable in the sandbox', () => {
  it('answers a query path from a script', () => {
    const { results } = runTestJob(
      "test('deep', function () { if (res('data.pets..name').length !== 2) { throw new Error('no'); } });",
      response(),
      5000,
    );

    expect(results).toEqual([{ description: 'deep', status: 'pass' }]);
  });

  it('answers a query path used as an assertion left-hand side', () => {
    // The reason this feature exists: a declared assertion is one expression, so
    // a deep descent can only reach it as a string argument to a callable res.
    const { results } = runTestJob('', response(), 5000, undefined, [
      { name: "res('data.pets[1].name')", value: 'eq bob' },
    ]);

    expect(results[0].status).toBe('pass');
  });

  it('applies a filter callback from an assertion', () => {
    const { results } = runTestJob('', response(), 5000, undefined, [
      { name: "res('data.pets[?].name', function (p) { return p.age > 5; })[0]", value: 'eq bob' },
    ]);

    expect(results[0].status).toBe('pass');
  });

  it('keeps the accessors and properties it had before it was callable', () => {
    // Making res a function must not cost the object it replaced: Bruno scripts
    // read both res.getBody() and res.status, and a declared assertion reaches
    // for the properties.
    const { results } = runTestJob(
      "test('shape', function () {" +
        " if (res.getStatus() !== 200) { throw new Error('getStatus'); }" +
        " if (res.status !== 200) { throw new Error('status'); }" +
        " if (res.getBody().data.pets.length !== 2) { throw new Error('getBody'); }" +
        " if (res.getHeader('Content-Type') !== 'application/json') { throw new Error('getHeader'); }" +
        ' });',
      response(),
      5000,
    );

    expect(results).toEqual([{ description: 'shape', status: 'pass' }]);
  });
});
