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
    expect(result.overall.p95Ms).toBeLessThan(2_000);
    expect(result.search.p95Ms).toBeLessThan(2_000);
    expect(result.filter.p95Ms).toBeLessThan(2_000);
  }, 30_000);
});
