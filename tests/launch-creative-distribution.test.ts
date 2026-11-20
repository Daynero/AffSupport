import { describe, expect, it } from 'vitest';
import {
  addCreatives,
  balanceCopies,
  distributeVariations,
  dragCopies,
  evenCopies,
  isValidDistribution,
  launchCreativesOf,
  maxCopiesFor,
  removeCreative,
  rescaleCopies,
  setCopies
} from '../packages/shared/src/team/launches/creative-distribution';
import type { LaunchCreative } from '../packages/shared/src/team/launches';

const id = (n: number) => `c0620000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const creatives = (copies: number[]): LaunchCreative[] =>
  copies.map((value, index) => ({
    materialId: id(index + 1),
    alias: `creo-${index + 1}`,
    copies: value,
    pinned: null
  }));
const copiesOf = (list: readonly LaunchCreative[]) => list.map(c => c.copies);

/** xorshift so a failing sequence can be replayed from its seed. */
function rng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

describe('even split', () => {
  it('gives the remainder to the first creatives', () => {
    expect(evenCopies(100, 4)).toEqual([25, 25, 25, 25]);
    expect(evenCopies(100, 3)).toEqual([34, 33, 33]);
    expect(evenCopies(5, 5)).toEqual([1, 1, 1, 1, 1]);
  });
});

describe('slider', () => {
  it('raising one lowers all the others', () => {
    expect(copiesOf(dragCopies(creatives([25, 25, 25, 25]), 0, 40, 100))).toEqual([40, 20, 20, 20]);
  });
  it('clears typed marks, since a drag re-shares everyone', () => {
    const typed = setCopies(creatives([25, 25, 25, 25]), 1, 30, 100);
    expect(dragCopies(typed, 0, 10, 100).every(c => c.pinned === null)).toBe(true);
  });
  it('cannot take the last product from another creative', () => {
    expect(copiesOf(dragCopies(creatives([25, 25, 25, 25]), 2, 500, 100))).toEqual([1, 1, 97, 1]);
    expect(maxCopiesFor(100, 4)).toBe(97);
  });
});

describe('typed values', () => {
  it('lets the operator type every share in turn', () => {
    let list = creatives([25, 25, 25, 25]);
    list = setCopies(list, 0, 40, 100);
    expect(copiesOf(list)).toEqual([40, 20, 20, 20]);
    list = setCopies(list, 1, 30, 100);
    expect(copiesOf(list)).toEqual([40, 30, 15, 15]);
    list = setCopies(list, 2, 20, 100);
    expect(copiesOf(list)).toEqual([40, 30, 20, 10]);
  });
  it('takes from the oldest typed share when nothing untyped is left', () => {
    let list = creatives([25, 25, 25, 25]);
    list = setCopies(list, 0, 40, 100);
    list = setCopies(list, 1, 30, 100);
    list = setCopies(list, 2, 20, 100);
    list = setCopies(list, 3, 20, 100);
    // 3 rows typed earlier hold 40/30/20; the untyped one was the last; now
    // everyone is typed, so the oldest typed (first) gives way.
    expect(copiesOf(list)).toEqual([30, 30, 20, 20]);
  });
});

describe('product count', () => {
  it('keeps an equal split equal and scales a custom one', () => {
    expect(copiesOf(rescaleCopies(creatives([25, 25, 25, 25]), 200))).toEqual([50, 50, 50, 50]);
    expect(copiesOf(rescaleCopies(creatives([40, 30, 20, 10]), 200))).toEqual([80, 60, 40, 20]);
  });
  it('never goes below the number of creatives', () => {
    expect(copiesOf(rescaleCopies(creatives([2, 2, 1]), 2))).toEqual([1, 1, 1]);
  });
  it('rises to the number of creatives when more are added than products', () => {
    const added = Array.from({ length: 120 }, (_, index) => ({
      materialId: id(index + 1),
      alias: `c${index}`
    }));
    const result = addCreatives([], added, 100);
    expect(result.productCount).toBe(120);
    expect(copiesOf(result.creatives).every(value => value === 1)).toBe(true);
  });
  it('ignores a creative that is already there', () => {
    const list = creatives([50, 50]);
    const result = addCreatives(list, [{ materialId: id(1), alias: 'again' }], 100);
    expect(result.creatives).toHaveLength(2);
  });
  it('gives a newcomer an even share of a custom split', () => {
    const result = addCreatives(creatives([70, 30]), [{ materialId: id(9), alias: 'new' }], 100);
    expect(copiesOf(result.creatives)).toEqual([47, 20, 33]);
  });
});

describe('balance and removal', () => {
  it('balance resets shares and typed marks', () => {
    const typed = setCopies(creatives([25, 25, 25, 25]), 0, 70, 100);
    const balanced = balanceCopies(typed, 100);
    expect(copiesOf(balanced)).toEqual([25, 25, 25, 25]);
    expect(balanced.every(c => c.pinned === null)).toBe(true);
  });
  it('gives a removed share back to the others', () => {
    expect(copiesOf(removeCreative(creatives([25, 25, 25, 25]), 3, 100))).toEqual([34, 33, 33]);
    expect(copiesOf(removeCreative(creatives([40, 30, 20, 10]), 0, 100))).toEqual([50, 33, 17]);
  });
});

describe('variations', () => {
  it('are handed round-robin', () => {
    expect(distributeVariations([25, 25, 25, 25], 30)).toEqual([8, 8, 7, 7]);
    expect(distributeVariations([25, 25, 25, 25], 4)).toEqual([1, 1, 1, 1]);
  });
  it('skip a video that already has one per product', () => {
    expect(distributeVariations([40, 30, 20, 10], 100)).toEqual([40, 30, 20, 10]);
    expect(distributeVariations([1, 5], 4)).toEqual([1, 3]);
  });
});

describe('legacy configs', () => {
  it('read as one creative holding every product', () => {
    expect(
      launchCreativesOf({
        materialId: id(1),
        creativeAlias: 'old',
        catalog: {
          productCount: 100,
          restitchEnabled: false,
          finalDurationMode: 'random-30-40',
          customFinalDurationSeconds: null
        }
      })
    ).toEqual([{ materialId: id(1), alias: 'old', copies: 100, pinned: null }]);
  });
});

describe('properties (SC-006)', () => {
  it('every sequence keeps an exact sum, one or more each, and k ≤ n', () => {
    for (let seed = 1; seed <= 10_000; seed += 1) {
      const random = rng(seed);
      const k = 1 + Math.floor(random() * (seed % 10 === 0 ? 400 : 12));
      let n = Math.min(400, k + Math.floor(random() * 400));
      let list = balanceCopies(creatives(Array.from({ length: k }, () => 1)), n);
      for (let step = 0; step < 6; step += 1) {
        const op = Math.floor(random() * 6);
        const at = Math.floor(random() * list.length);
        const value = 1 + Math.floor(random() * n);
        if (op === 0) list = dragCopies(list, at, value, n);
        else if (op === 1) list = setCopies(list, at, value, n);
        else if (op === 2) {
          n = Math.min(400, Math.max(list.length, Math.floor(random() * 401)));
          list = rescaleCopies(list, n);
        } else if (op === 3 && list.length > 1) list = removeCreative(list, at, n);
        else if (op === 4 && list.length < 400) {
          const result = addCreatives(list, [{ materialId: id(1000 + step), alias: 'x' }], n);
          list = result.creatives;
          n = result.productCount;
        } else list = balanceCopies(list, n);
        const values = copiesOf(list);
        if (!isValidDistribution(values, n))
          throw new Error(`seed ${seed} step ${step} op ${op}: ${values.join(',')} ≠ ${n}`);
      }
    }
  });
  it('typed shares hold while untyped ones can still compensate', () => {
    for (let seed = 1; seed <= 2_000; seed += 1) {
      const random = rng(seed);
      const k = 3 + Math.floor(random() * 8);
      const n = 100 + Math.floor(random() * 300);
      let list = balanceCopies(creatives(Array.from({ length: k }, () => 1)), n);
      list = setCopies(list, 0, 1 + Math.floor(random() * (n / 3)), n);
      const held = list[0]!.copies;
      list = setCopies(list, 1, 1 + Math.floor(random() * (n / 3)), n);
      expect(list[0]!.copies).toBe(held);
    }
  });
  it('variations add up, stay within each video and stay even among unsaturated', () => {
    for (let seed = 1; seed <= 5_000; seed += 1) {
      const random = rng(seed);
      const k = 1 + Math.floor(random() * 20);
      const copies = Array.from({ length: k }, () => 1 + Math.floor(random() * 40));
      const total = k + Math.floor(random() * (copies.reduce((a, b) => a + b, 0) - k + 1));
      const variants = distributeVariations(copies, total);
      expect(variants.reduce((a, b) => a + b, 0)).toBe(total);
      variants.forEach((value, index) => {
        expect(value).toBeGreaterThanOrEqual(1);
        expect(value).toBeLessThanOrEqual(copies[index]!);
      });
      const open = variants.filter((value, index) => value < copies[index]!);
      if (open.length > 1) expect(Math.max(...open) - Math.min(...open)).toBeLessThanOrEqual(1);
    }
  });
});

import { fitCatalogToCreatives } from '../packages/shared/src/team/launches/creative-distribution';
describe('profile settings fit the chosen creatives (R21)', () => {
  const catalog = {
    productCount: 100,
    restitchEnabled: true,
    finalDurationMode: 'random-30-40' as const,
    customFinalDurationSeconds: null,
    catalogVideoProtocolVersion: 1 as const,
    videoVariationCount: 2
  };
  it('turns restitch off for images', () => {
    const fitted = fitCatalogToCreatives({
      catalog,
      creativeKind: 'image',
      creatives: creatives([50, 50])
    });
    expect(fitted.catalog?.restitchEnabled).toBe(false);
    expect(fitted.catalog?.videoVariationCount).toBe(1);
  });
  it('raises variations to one per video', () => {
    const fitted = fitCatalogToCreatives({
      catalog,
      creativeKind: 'video',
      creatives: creatives([25, 25, 25, 25])
    });
    expect(fitted.catalog?.videoVariationCount).toBe(4);
  });
});
