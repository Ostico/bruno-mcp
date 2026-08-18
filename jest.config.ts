import type { Config } from 'jest';

// Shared by both lanes. Kept in one place so the unit and integration projects
// can never drift into resolving modules differently.
const shared: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // `roots` bounds the haste map, and collectCoverageFrom can only report on
  // files inside it. With only tests/ here the coverage gate silently skipped
  // every src file no test imports — including 455 lines of dead code — while
  // still reporting 100%.
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  // Runs in every test file's own process, before the test framework loads, and
  // redirects the workspace registry to a throwaway file. It belongs on both
  // lanes and not in globalSetup: globalSetup runs once for the whole invocation
  // and integration suites run in parallel workers, so a single shared registry
  // would have several of them appending to one file at once. The file itself
  // documents what was leaking into the developer's real registry.
  setupFiles: ['<rootDir>/tests/setup-workspace-isolation.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      useESM: false,
      tsconfig: {
        module: 'commonjs',
        moduleResolution: 'node',
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        verbatimModuleSyntax: false,
      },
    }],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};

// Coverage is a root-level concern: it is collected across every project that
// runs, so a partial run produces a partial report. CI therefore generates the
// artifact from a full `jest --coverage` (both lanes), never from one lane.
const coverage = {
  // Widening `roots` alone is not enough: without this, coverage still reports
  // only the files some test happened to import, so an untested file is absent
  // from the report rather than shown at 0%.
  collectCoverageFrom: ['src/**/*.ts'],
  coveragePathIgnorePatterns: [
    // Type-only declarations carry no runtime code to cover.
    '\\.d\\.ts$',
    // src/index.ts is both the public barrel and the CLI entrypoint, and its
    // `import.meta.url === file://…` guard cannot be loaded by this CJS test
    // runtime at all. Splitting the entrypoint out of the barrel would make it
    // testable; until then, measuring it would only ever report 0%.
    '<rootDir>/src/index\\.ts$',
  ],
};

const config: Config = {
  ...coverage,
  // Two explicitly separated lanes. Previously a single
  // `testMatch: ['<rootDir>/tests/**/*.test.ts']` fused them, so there was no
  // way to run the fast lane on its own: integration tests use real sockets,
  // real child processes and real filesystem writes, and dragging that into
  // every unit run makes the fast lane slow and flaky.
  //
  // `npm run test:unit` / `npm run test:integration` select one lane;
  // `npm test` (bare `jest`) still runs BOTH, which is what keeps the coverage
  // artifact complete. CI runs the two lanes as separate, individually
  // attributable steps — see .github/workflows/ci.yml.
  projects: [
    {
      ...shared,
      ...coverage,
      displayName: 'unit',
      testMatch: ['<rootDir>/tests/unit/**/*.test.ts'],
    },
    {
      ...shared,
      ...coverage,
      displayName: 'integration',
      testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
      // Builds dist/ once, before any worker starts, replacing the per-suite
      // `beforeAll` builds that raced each other through `tsup --clean`
      // (tests/global-setup.ts documents the race).
      //
      // Runs exactly once per jest invocation whichever level it is declared
      // at: @jest/core's runGlobalHook gathers the root hook and every
      // project's hook into a Set of module paths, so a single path is a
      // single call no matter how many projects or workers are involved.
      //
      // It sits on this project rather than at the root because a root
      // globalSetup runs for every invocation, including `npm run test:unit`
      // and single-unit-file runs — measured at ~2.15s -> ~3.3s locally for a
      // lane whose whole point is being the fast one, and which never reads
      // dist/. Jest defines the project-scoped form as triggering only when at
      // least one test from that project runs, which is exactly the condition
      // that needs the artifact. Verified, not assumed: `jest --selectProjects
      // unit` performs 0 builds, `--selectProjects integration`, `jest
      // tests/integration` and a full `jest` each perform exactly 1.
      globalSetup: '<rootDir>/tests/global-setup.ts',
    },
  ],
};

export default config;
