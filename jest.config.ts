import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // `roots` bounds the haste map, and collectCoverageFrom can only report on
  // files inside it. With only tests/ here the coverage gate silently skipped
  // every src file no test imports — including 455 lines of dead code — while
  // still reporting 100% (finding Q3).
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  // Explicit, so adding a root never widens what counts as a test.
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
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

export default config;
