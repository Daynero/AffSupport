import { describe, expect, it } from 'vitest';
import {
  createCatalogVideoAssignment,
  reuseCatalogVideoAssignment,
  parseCatalogVideoVariationCount
} from '../packages/shared/src/team/catalog-video-set';
const id = (n: number) => `b0470000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const recipe = (products = 17, variants = 5) => ({
  recipeRevision: 1,
  recipeRowIds: Array.from({ length: products }, (_, i) => id(i + 1)),
  variantCount: variants,
  seed: '0123456789abcdef'.repeat(4)
});
describe('catalog video variation count', () => {
  it('defaults legacy missing values to one and keeps one inert when restitch is off', () => {
    expect(parseCatalogVideoVariationCount(undefined, 17, false)).toBe(1);
    expect(parseCatalogVideoVariationCount(5, 17, true)).toBe(5);
  });
  it.each([null, 0, -1, 1.5, NaN, Infinity, '5', 18])(
    'rejects invalid count %s without clamping',
    count => {
      expect(() => parseCatalogVideoVariationCount(count, 17, true)).toThrow('INVALID_INPUT');
    }
  );
  it('requires restitch for additional physical variants', () => {
    expect(() => parseCatalogVideoVariationCount(5, 17, false)).toThrow('INVALID_INPUT');
  });
  it.each([0, -1, 1.5, NaN, Infinity, 401])('rejects invalid effective product count %s', count => {
    expect(() => parseCatalogVideoVariationCount(1, count, true)).toThrow('INVALID_INPUT');
  });
});
describe('persisted catalog row assignment', () => {
  it.each([1, 2, 5, 17, 400])('balances every variant for %s product rows', products => {
    for (const variants of new Set([1, Math.min(5, products), products])) {
      for (const seed of ['0'.repeat(64), 'f'.repeat(64), recipe().seed]) {
        const result = createCatalogVideoAssignment({ ...recipe(products, variants), seed });
        const counts = Array.from(
          { length: variants },
          (_, index) => result.assignments.filter(row => row.videoVariantIndex === index).length
        );
        expect(result.assignments).toHaveLength(products);
        expect(new Set(result.assignments.map(row => row.recipeRowId)).size).toBe(products);
        expect(Math.min(...counts)).toBeGreaterThan(0);
        expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
        expect(result).toEqual(
          createCatalogVideoAssignment({ ...recipe(products, variants), seed })
        );
      }
    }
  });
  it('keeps the persisted mapping across row reordering and caller mutation', () => {
    const input = recipe();
    const result = createCatalogVideoAssignment(input);
    const reordered = { ...input, recipeRowIds: [...input.recipeRowIds].reverse() };
    expect(createCatalogVideoAssignment(reordered)).toEqual(result);
    const reused = reuseCatalogVideoAssignment(result, reordered);
    expect(reused).toEqual(result);
    input.recipeRowIds[0] = id(999);
    expect(result.assignments.some(row => row.recipeRowId === id(999))).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.assignments[0])).toBe(true);
  });
  it('uses persisted balanced assignments on retry instead of drawing again', () => {
    const input = recipe();
    const stored = createCatalogVideoAssignment(input);
    const authoritative = {
      ...stored,
      assignments: stored.assignments.map(row => ({
        ...row,
        videoVariantIndex: (row.videoVariantIndex + 1) % input.variantCount
      }))
    };
    expect(reuseCatalogVideoAssignment(authoritative, input)).toEqual(authoritative);
  });
  it('rejects duplicate internal row identities including case variants and public IDs', () => {
    for (const rows of [
      [id(1), id(1)],
      [id(1), id(1).toUpperCase()],
      ['product-1', 'product-2']
    ])
      expect(() => createCatalogVideoAssignment({ ...recipe(2, 1), recipeRowIds: rows })).toThrow(
        'INVALID_INPUT'
      );
  });
  it('requires a new assignment after growth, shrink, count or revision changes', () => {
    const input = recipe(),
      stored = createCatalogVideoAssignment(input);
    for (const next of [
      recipe(18),
      recipe(16),
      { ...input, variantCount: 4 },
      { ...input, recipeRevision: 2 }
    ])
      expect(() => reuseCatalogVideoAssignment(stored, next)).toThrow('INVALID_INPUT');
    expect(createCatalogVideoAssignment({ ...recipe(18), recipeRevision: 2 }).productCount).toBe(
      18
    );
  });
  it('rejects malformed persisted assignments rather than inventing a replacement', () => {
    const input = recipe(),
      stored = createCatalogVideoAssignment(input);
    for (const invalid of [
      { ...stored, assignments: stored.assignments.slice(1) },
      { ...stored, assignments: stored.assignments.map(row => ({ ...row, videoVariantIndex: 0 })) },
      {
        ...stored,
        assignments: [
          { ...stored.assignments[0]!, videoVariantIndex: 5 },
          ...stored.assignments.slice(1)
        ]
      },
      { ...stored, algorithmVersion: 999 },
      { ...stored, seed: 'f'.repeat(64) }
    ])
      expect(() => reuseCatalogVideoAssignment(invalid, input)).toThrow('INVALID_INPUT');
  });
  it.each(['', '0'.repeat(63), 'g'.repeat(64)])('rejects a malformed seed', seed => {
    expect(() => createCatalogVideoAssignment({ ...recipe(), seed })).toThrow('INVALID_INPUT');
  });
});

it('pins assignment algorithm version one to its golden distribution', () => {
  const result = createCatalogVideoAssignment(recipe(10, 3));
  expect(result.algorithmVersion).toBe(1);
  expect(result.assignments.map(row => row.videoVariantIndex)).toEqual([
    0, 2, 0, 2, 0, 2, 1, 1, 0, 1
  ]);
});
it('uses the persisted seed and validates revision boundaries', () => {
  expect(
    createCatalogVideoAssignment({ ...recipe(), seed: 'f'.repeat(64) }).assignments
  ).not.toEqual(createCatalogVideoAssignment(recipe()).assignments);
  for (const revision of [0, -1, 1.5, NaN, Infinity])
    expect(() => createCatalogVideoAssignment({ ...recipe(), recipeRevision: revision })).toThrow(
      'INVALID_INPUT'
    );
  expect(() => parseCatalogVideoVariationCount(5, 17, 'true' as never)).toThrow('INVALID_INPUT');
});
