import { defineConfig } from 'vitest/config';

/**
 * Tests live in the central `tests/` directory and nowhere else — never
 * co-located, never `*.spec`. Stating that here, rather than relying on
 * Vitest's default glob, keeps the suite from collecting files that merely
 * happen to sit under this path.
 *
 * That is not hypothetical: `release/` is a gitignored staging directory for
 * packaged builds, and a third-party app bundled into a DMG stage shipped its
 * own template test suite. `vitest run` picked it up and reported a failure
 * that had nothing to do with this codebase, which is exactly the kind of noise
 * that trains people to ignore a red run.
 */
export default defineConfig({
  test: {
    // Deliberately no `include` here. Both projects inherit this block, and an
    // `include` at this level is merged into each of them rather than replaced
    // — which had the end-to-end project collecting all 260 test files instead
    // of its 3, running the whole suite twice against one shared jsdom origin.
    exclude: ['**/node_modules/**', '**/dist/**', 'release/**'],

    /**
     * Unmount every rendered tree after each test. Fourteen component files never called
     * cleanup themselves, so their renders accumulated within a file and later assertions
     * could match elements an earlier test had created. Doing it here makes it impossible
     * to forget; it is inert in the node environment.
     */
    setupFiles: ['tests/support/setup-dom.ts'],

    /**
     * The end-to-end suites boot a real Agent process that binds a port and owns temporary
     * state directories. Two of them running concurrently in separate forks would race on
     * both. They are confined to a single fork with a longer deadline; everything else
     * keeps the default parallel pool, which is what holds the whole suite near 30s.
     */
    poolOptions: {
      forks: { singleFork: false }
    },

    /**
     * Coverage is measured, never enforced here.
     *
     * `all: true` is the load-bearing setting: without it the modules no test
     * imports simply do not appear, and a baseline computed from only the files
     * someone remembered to test is a number that can rise while coverage falls.
     *
     * The verdict belongs to `scripts/verify-all.mjs` rather than to a
     * threshold, because the rule is not one floor — the global must not fall,
     * no single file may fall beyond a tolerance, and a named set of run-state
     * modules has an absolute floor whatever the global did. One place owns
     * that decision; a runner threshold here could only disagree with it.
     */
    coverage: {
      provider: 'v8',
      all: true,
      reporter: ['json-summary', 'json', 'text-summary'],
      reportsDirectory: 'coverage',
      include: [
        'apps/agent/src/**/*.ts',
        'apps/web/src/**/*.{ts,tsx}',
        'packages/shared/src/**/*.ts'
      ],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.d.ts',
        // Generated, vendored, or entry shims with no branch of their own.
        'apps/web/src/main.tsx',
        'apps/web/src/vite-env.d.ts',
        'packages/shared/src/index.ts'
      ]
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/**/*.test.{ts,tsx}'],
          exclude: ['**/node_modules/**', '**/dist/**', 'release/**', 'tests/**/*-e2e.test.ts']
        }
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['tests/**/*-e2e.test.ts'],
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 120_000,
          hookTimeout: 120_000
        }
      }
    ]
  }
});
