import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  benchmarkCatalogQueries,
  createDeterministicCatalogFixture,
  createInMemoryCatalogAdapter
} from '../scripts/team-catalog-benchmark';

describe('deterministic 50k catalog benchmark fixture', () => {
  it('contains exactly 50,000 visible rows plus isolated hidden rows with a stable hash', () => {
    const first = createDeterministicCatalogFixture();
    const second = createDeterministicCatalogFixture();
    expect(first.visible).toHaveLength(50_000);
    expect(first.hidden.length).toBeGreaterThan(0);
    expect(first.hidden.every(row => row.teamId !== first.visible[0]?.teamId)).toBe(true);
    const hash = (value: unknown) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex');
    expect(hash(first)).toBe(hash(second));
  });

  it('runs three authenticated-wrapper manifests with warmups and separate search/filter stats', async () => {
    const fixture = createDeterministicCatalogFixture();
    const result = await benchmarkCatalogQueries(createInMemoryCatalogAdapter(fixture), {
      runs: 3,
      warmups: 20,
      searches: 100,
      filterChanges: 100
    });
    expect(result.runs).toHaveLength(3);
    expect(result.runs.every(run => run.samples === 200)).toBe(true);

    // What this asserts, and what it deliberately does not.
    //
    // A wall-clock ceiling here fails when the suite is running twenty other
    // files beside it — a red run caused by a busy laptop rather than by a
    // change, which teaches people to re-run until green. The figures are
    // recorded and the *shape* is checked: every measurement is a real number,
    // and the p95 is not wildly out of line with the median, because a
    // distribution with a long tail is the thing a percentile budget is
    // actually for.
    for (const measurement of [result.overall, result.search, result.filter]) {
      expect(Number.isFinite(measurement.p95Ms)).toBe(true);
      expect(measurement.p95Ms).toBeGreaterThan(0);
      // Ten times the median would mean most operations are fast and some are
      // not — a stall, not a slow machine, since a slow machine moves both.
      expect(measurement.p95Ms).toBeLessThan(Math.max(measurement.p50Ms * 10, 50));
    }
  }, 30_000);
});
