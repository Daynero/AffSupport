/**
 * 062: how the products of a catalog Launch are shared between its creatives,
 * and how restitch variations are handed to its videos.
 *
 * Pure and deterministic: the editor, validation, edge planning and property
 * tests all use these, so a share the operator sees is the share generated.
 * Every creative keeps at least one product and the shares always add up to the
 * product count.
 */
import type { LaunchConfig, LaunchCreative } from '../launches.js';

/** ⌊n/k⌋ each; the remainder goes one by one to the first creatives. */
export function evenCopies(n: number, k: number): number[] {
  if (k <= 0) return [];
  const base = Math.floor(n / k);
  const extra = n - base * k;
  return Array.from({ length: k }, (_, index) => base + (index < extra ? 1 : 0));
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/** Whole shares of `amount` by weight; largest remainder, ties to the earlier index. */
function apportion(amount: number, weights: readonly number[]): number[] {
  const total = sum(weights);
  if (amount <= 0 || weights.length === 0) return weights.map(() => 0);
  if (total <= 0) return evenCopies(amount, weights.length);
  const exact = weights.map(weight => (amount * weight) / total);
  const shares = exact.map(Math.floor);
  let left = amount - sum(shares);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    shares[index]! += 1;
    left -= 1;
  }
  return shares;
}

/**
 * Moves `values` to total `target`, each staying ≥ 1. Growth is shared by the
 * current sizes; shrinking takes from what each holds above one, so a share
 * never has to go below one while another still could.
 */
function proportional(values: readonly number[], target: number): number[] {
  const current = sum(values);
  if (target === current) return [...values];
  if (target > current) {
    const add = apportion(target - current, values);
    return values.map((value, index) => value + add[index]!);
  }
  const excess = values.map(value => Math.max(0, value - 1));
  const take = apportion(Math.min(current - target, sum(excess)), excess);
  return values.map((value, index) => value - take[index]!);
}

/** The largest share one creative may hold while the others keep one each. */
export function maxCopiesFor(n: number, k: number): number {
  return Math.max(1, n - (k - 1));
}

function clampCopies(value: number, n: number, k: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(maxCopiesFor(n, k), Math.max(1, Math.round(value)));
}

function isEven(values: readonly number[]): boolean {
  const even = evenCopies(sum(values), values.length);
  return values.every((value, index) => value === even[index]);
}

/**
 * Brings the shares of `adjustable` creatives to `target` in total: the ones the
 * operator never typed move first, proportionally; when they are not enough,
 * typed ones give way oldest-typed first.
 */
function settle(list: LaunchCreative[], adjustable: readonly number[], target: number): void {
  const free = adjustable.filter(index => list[index]!.pinned === null);
  const typed = adjustable
    .filter(index => list[index]!.pinned !== null)
    .sort((a, b) => list[a]!.pinned! - list[b]!.pinned!);
  let delta = target - sum(adjustable.map(index => list[index]!.copies));
  if (delta === 0) return;
  const apply = (group: readonly number[], amount: number) => {
    const values = group.map(index => list[index]!.copies);
    const next = proportional(values, sum(values) + amount);
    group.forEach((index, at) => {
      list[index] = { ...list[index]!, copies: next[at]! };
    });
    return sum(next) - sum(values);
  };
  if (free.length > 0) delta -= apply(free, delta);
  for (const index of typed) {
    if (delta === 0) break;
    delta -= apply([index], delta);
  }
}

/**
 * Slider: the moved creative takes `value` and every other creative gives or
 * takes proportionally. A drag re-shares everyone, so no typed value survives it.
 */
export function dragCopies(
  list: readonly LaunchCreative[],
  index: number,
  value: number,
  n: number
): LaunchCreative[] {
  const k = list.length;
  if (k === 0 || index < 0 || index >= k) return list.map(c => ({ ...c }));
  if (k === 1) return [{ ...list[0]!, copies: n, pinned: null }];
  const own = clampCopies(value, n, k);
  const others = list.flatMap((creative, at) => (at === index ? [] : [creative.copies]));
  const next = proportional(others, n - own);
  let cursor = 0;
  return list.map((creative, at) =>
    at === index
      ? { ...creative, copies: own, pinned: null }
      : { ...creative, copies: next[cursor++]!, pinned: null }
  );
}

/**
 * Typed value: the creative keeps exactly `value` (within reach), the creatives
 * not typed yet compensate, and the typed creative is pinned as the newest.
 */
export function setCopies(
  list: readonly LaunchCreative[],
  index: number,
  value: number,
  n: number
): LaunchCreative[] {
  const k = list.length;
  const next = list.map(creative => ({ ...creative }));
  if (k === 0 || index < 0 || index >= k) return next;
  if (k === 1) return [{ ...next[0]!, copies: n }];
  const own = clampCopies(value, n, k);
  const newest = Math.max(0, ...next.map(creative => creative.pinned ?? 0)) + 1;
  next[index] = { ...next[index]!, copies: own, pinned: newest };
  settle(
    next,
    next.flatMap((_, at) => (at === index ? [] : [at])),
    n - own
  );
  return next;
}

/** A new product count: equal stays equal, otherwise the shares scale with it. */
export function rescaleCopies(list: readonly LaunchCreative[], n: number): LaunchCreative[] {
  const k = list.length;
  if (k === 0) return [];
  const target = Math.max(n, k);
  const values = list.map(creative => creative.copies);
  const next = isEven(values) ? evenCopies(target, k) : proportional(values, target);
  return list.map((creative, index) => ({ ...creative, copies: next[index]! }));
}

/** Equal shares again; nothing stays typed. */
export function balanceCopies(list: readonly LaunchCreative[], n: number): LaunchCreative[] {
  const next = evenCopies(Math.max(n, list.length), list.length);
  return list.map((creative, index) => ({ ...creative, copies: next[index]!, pinned: null }));
}

export interface CreativeDistribution {
  creatives: LaunchCreative[];
  productCount: number;
}

/**
 * Adds creatives at the end. The product count rises to the number of creatives
 * when there are more creatives than products. An equal split stays equal; a
 * custom one gives each newcomer an even share taken from the others.
 */
export function addCreatives(
  list: readonly LaunchCreative[],
  added: ReadonlyArray<Pick<LaunchCreative, 'materialId' | 'alias'>>,
  n: number
): CreativeDistribution {
  const known = new Set(list.map(creative => creative.materialId));
  const fresh = added.filter(
    (creative, index) =>
      !known.has(creative.materialId) &&
      added.findIndex(other => other.materialId === creative.materialId) === index
  );
  const k = list.length + fresh.length;
  const productCount = Math.max(n, k);
  if (k === 0) return { creatives: [], productCount };
  const even = list.length === 0 || isEven(list.map(creative => creative.copies));
  if (even) {
    const shares = evenCopies(productCount, k);
    const creatives = [
      ...list.map(creative => ({ ...creative })),
      ...fresh.map(creative => ({ ...creative, copies: 1, pinned: null }))
    ].map((creative, index) => ({ ...creative, copies: shares[index]! }));
    return { creatives, productCount };
  }
  const share = Math.max(1, Math.floor(productCount / k));
  const room = productCount - list.length;
  const each = Math.max(1, Math.min(share, Math.floor(room / Math.max(1, fresh.length))));
  const creatives: LaunchCreative[] = [
    ...list.map(creative => ({ ...creative })),
    ...fresh.map(creative => ({ ...creative, copies: each, pinned: null }))
  ];
  settle(
    creatives,
    list.map((_, index) => index),
    productCount - each * fresh.length
  );
  return { creatives, productCount };
}

/** Removes one creative; its products go back to the others. */
export function removeCreative(
  list: readonly LaunchCreative[],
  index: number,
  n: number
): LaunchCreative[] {
  if (index < 0 || index >= list.length) return list.map(creative => ({ ...creative }));
  const rest = list.flatMap((creative, at) => (at === index ? [] : [{ ...creative }]));
  if (rest.length === 0) return [];
  const wasEven = isEven(list.map(creative => creative.copies));
  if (wasEven) {
    const shares = evenCopies(n, rest.length);
    return rest.map((creative, at) => ({ ...creative, copies: shares[at]! }));
  }
  settle(
    rest,
    rest.map((_, at) => at),
    n
  );
  return rest;
}

/** Shares add up to `n`, everyone has one or more, and there are no more creatives than products. */
export function isValidDistribution(copies: readonly number[], n: number): boolean {
  return (
    copies.length > 0 &&
    copies.length <= n &&
    copies.every(value => Number.isInteger(value) && value >= 1) &&
    sum(copies) === n
  );
}

/**
 * Restitch variations handed to videos round-robin: one each first, then in
 * turn, skipping a video that already has one variation per product.
 * Precondition: copies.length ≤ total ≤ Σ copies.
 */
export function distributeVariations(copies: readonly number[], total: number): number[] {
  const k = copies.length;
  if (k === 0) return [];
  const target = Math.min(Math.max(total, k), sum(copies));
  const variants = copies.map(() => 1);
  let left = target - k;
  while (left > 0) {
    let moved = false;
    for (let index = 0; index < k && left > 0; index += 1) {
      if (variants[index]! >= copies[index]!) continue;
      variants[index]! += 1;
      left -= 1;
      moved = true;
    }
    if (!moved) break;
  }
  return variants;
}

/** The creatives a config names; an older single-creative config reads as one. */
export function launchCreativesOf(
  config: Pick<LaunchConfig, 'materialId' | 'creativeAlias' | 'creatives' | 'catalog'>
): LaunchCreative[] {
  if (Array.isArray(config.creatives) && config.creatives.length > 0)
    return config.creatives.map(creative => ({ ...creative }));
  if (!config.materialId) return [];
  return [
    {
      materialId: config.materialId,
      alias: config.creativeAlias,
      copies: config.catalog?.productCount ?? 1,
      pinned: null
    }
  ];
}

/**
 * 062 (R21): settings applied from a profile must fit the creatives already
 * chosen — no restitch for images, and at least one variation per video.
 */
export function fitCatalogToCreatives<
  T extends Partial<Pick<LaunchConfig, 'catalog' | 'creatives' | 'creativeKind'>>
>(draft: T): T {
  const catalog = draft.catalog;
  const k = draft.creatives?.length ?? 0;
  if (!catalog || k === 0) return draft;
  if (draft.creativeKind === 'image' && catalog.restitchEnabled)
    return {
      ...draft,
      catalog: {
        ...catalog,
        restitchEnabled: false,
        ...(catalog.catalogVideoProtocolVersion === 1 ? { videoVariationCount: 1 } : {})
      }
    };
  if (
    draft.creativeKind !== 'image' &&
    k > 1 &&
    catalog.restitchEnabled &&
    catalog.catalogVideoProtocolVersion === 1 &&
    (catalog.videoVariationCount ?? 1) < k
  )
    return {
      ...draft,
      catalog: { ...catalog, videoVariationCount: Math.min(k, catalog.productCount) }
    };
  return draft;
}
