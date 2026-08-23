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
    include: ['tests/**/*.test.{ts,tsx}'],
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
