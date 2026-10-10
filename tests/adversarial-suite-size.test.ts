import { access, readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { runAttempt, type AdversarialSuite } from './support/adversarial.js';
import { admissionSuite } from './support/adversarial/admission.js';
import { hostileFilenameSuite } from './support/adversarial/hostile-filenames.js';
import { pathGrantSuite } from './support/adversarial/path-grants.js';
import {
  closeTransferGrantDatabase,
  transferGrantSuite
} from './support/adversarial/transfer-grants.js';
import { uploadBudgetSuite } from './support/adversarial/upload-budgets.js';

/**
 * SC-008, as a count rather than a sentence: at least thirty attack attempts — hostile
 * origins, spoofed hosts, missing headers, forged and replayed tokens, traversal-shaped
 * paths, oversized and malformed uploads, unauthorised backend paths — refused in 100% of
 * cases.
 *
 * Every attempt is executed here, not tallied from source text: each area's table is run in
 * full against its real target, and the number asserted is the number that ran. The tables
 * are the same objects the area test files run one `it` per attempt, so an attempt added
 * there is counted here the moment it exists, and an attempt that stops being refused fails
 * both files.
 */

/** By the name each test file imports, so the second test can find it there. */
const SUITES = {
  admissionSuite,
  pathGrantSuite,
  uploadBudgetSuite,
  hostileFilenameSuite,
  transferGrantSuite
} as unknown as Record<string, AdversarialSuite<unknown>>;

const MINIMUM_ATTEMPTS = 30;

afterAll(async () => {
  await closeTransferGrantDatabase();
});

describe('the adversarial suite', () => {
  it(`makes at least ${MINIMUM_ATTEMPTS} attempts and refuses every one`, async () => {
    const tally: { file: string; attempts: number; refused: number; let_through: string[] }[] = [];
    for (const suite of Object.values(SUITES)) {
      const row = { file: suite.testFile, attempts: 0, refused: 0, let_through: [] as string[] };
      for (const attempt of suite.attempts) {
        const result = await runAttempt(suite, attempt);
        row.attempts += 1;
        if (result.refused) row.refused += 1;
        else row.let_through.push(`${attempt.name}: ${result.evidence}`);
      }
      tally.push(row);
    }

    const attempts = tally.reduce((sum, row) => sum + row.attempts, 0);
    const refused = tally.reduce((sum, row) => sum + row.refused, 0);
    const report = tally
      .map(
        row =>
          `${row.file}: ${row.refused}/${row.attempts}${row.let_through.length ? ` — let through: ${row.let_through.join('; ')}` : ''}`
      )
      .join('\n');

    expect(attempts, report).toBeGreaterThanOrEqual(MINIMUM_ATTEMPTS);
    expect(refused / attempts, report).toBe(1);
    // No area may carry the count alone: each one contributes attempts of its own.
    for (const row of tally)
      expect(row.attempts, `${row.file} contributes nothing`).toBeGreaterThan(0);
  }, 120_000);

  it('counts only tables that their own test files actually run', async () => {
    // A table nobody runs one-by-one would be counted here and reported nowhere else.
    for (const [table, suite] of Object.entries(SUITES)) {
      await expect(access(suite.testFile), `${suite.testFile} is missing`).resolves.toBeUndefined();
      const source = await readFile(suite.testFile, 'utf8');
      expect(source, `${suite.testFile} does not run ${table}`).toContain(`${table}.attempts`);
    }
  });
});
