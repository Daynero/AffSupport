import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The two type-check gates land with an exclusion list, because `tests/` and `scripts/`
 * were checked by nothing and turning them on wholesale would have meant a red gate on
 * day one — and a gate that starts red gets bypassed rather than fixed.
 *
 * So the list is a ratchet: it may shrink, never grow. A file removed from it is a file
 * that now type-checks; a file added to it is someone routing around the gate, which is
 * the failure this test exists to catch.
 *
 * When you fix a file, delete its line from the config **and** decrement the count here.
 * The counts are duplicated on purpose — if only the config changed, the intent was
 * probably to silence this test rather than to shrink the list.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Baselines recorded when the gates were introduced. Lower these, never raise them.
 *
 * Both reached zero. What that buys is not tidiness: emptying the test list turned up a
 * release-manifest fixture missing a tool the product shipped, a catalog response missing
 * three fields the scan reports, a task client missing the method its delete path calls,
 * and a manual test that could not have compiled. None of those were failing. They were
 * describing a product that no longer existed, and passing.
 */
const BASELINE = {
  'tsconfig.check.json': 0,
  'tsconfig.scripts.json': 0
} as const;

/** Reads a tsconfig that carries `//` comments, which JSON.parse rejects. */
function readExcludeList(configName: string): string[] {
  const raw = readFileSync(path.join(repoRoot, configName), 'utf8');
  const withoutComments = raw.replace(/^\s*\/\/.*$/gm, '');
  const parsed: unknown = JSON.parse(withoutComments);
  if (typeof parsed !== 'object' || parsed === null || !('exclude' in parsed)) {
    throw new Error(`${configName} has no exclude list`);
  }
  const exclude = (parsed as { exclude: unknown }).exclude;
  if (!Array.isArray(exclude) || !exclude.every(entry => typeof entry === 'string')) {
    throw new Error(`${configName} exclude is not a list of strings`);
  }
  return exclude;
}

describe('the type-check exclusion ratchet', () => {
  for (const [configName, baseline] of Object.entries(BASELINE)) {
    it(`${configName} excludes no more than ${baseline} files`, () => {
      const excluded = readExcludeList(configName);
      expect(
        excluded.length,
        `${configName} now excludes ${excluded.length} files, up from ${baseline}. ` +
          'The exclusion list is a ratchet — a new file that does not type-check must be ' +
          'fixed, not added here. If you genuinely fixed files, lower the baseline in ' +
          'tests/typecheck-ratchet.test.ts to match.'
      ).toBeLessThanOrEqual(baseline);
    });

    it(`${configName} lists every excluded path exactly once`, () => {
      const excluded = readExcludeList(configName);
      expect(new Set(excluded).size).toBe(excluded.length);
    });
  }

  it('excludes nothing outside tests/ and scripts/', () => {
    // A path outside those trees would mean the gate had been pointed somewhere it was
    // never meant to cover, which is a different kind of routing-around.
    for (const entry of readExcludeList('tsconfig.check.json')) {
      expect(entry.startsWith('tests/')).toBe(true);
    }
    for (const entry of readExcludeList('tsconfig.scripts.json')) {
      expect(entry.startsWith('scripts/')).toBe(true);
    }
  });
});
