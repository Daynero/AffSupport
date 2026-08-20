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
    exclude: ['**/node_modules/**', '**/dist/**', 'release/**']
  }
});
