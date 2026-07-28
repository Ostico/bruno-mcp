import type { Config } from 'jest';

// Shared by both lanes. Kept in one place so the unit and integration projects
// can never drift into resolving modules differently.
const shared: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // `roots` bounds the haste map, and collectCoverageFrom can only report on
  // files inside it. With only tests/ here the coverage gate silently skipped
  // every src file no test imports — including 455 lines of dead code — while
  // still reporting 100% (finding Q3).
  roots: ['<rootDir>/src', '<rootDir>/tests'],
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
  // from the report rather than shown at 0% (finding Q3).
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
  // Two explicitly separated lanes (finding Q4). Previously a single
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
    },
  ],
};

export default config;
