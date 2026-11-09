import { isRecord } from './contract.js';

export const CATALOG_PRODUCT_COUNT_MAX = 400;
export const CATALOG_VIDEO_ASSIGNMENT_VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SEED = /^[0-9a-f]{64}$/iu;

export class CatalogVideoSetValidationError extends Error {
  readonly code = 'INVALID_INPUT';
  constructor(
    readonly reason:
      | 'invalid_product_count'
      | 'invalid_count'
      | 'count_exceeds_products'
      | 'restitch_required'
      | 'invalid_recipe'
      | 'recipe_mismatch'
      | 'invalid_assignment'
  ) {
    super('INVALID_INPUT');
  }
}
const invalid = (reason: CatalogVideoSetValidationError['reason']): never => {
  throw new CatalogVideoSetValidationError(reason);
};

/** Read/create default only. A PATCH must preserve an absent field rather than call this. */
export function parseCatalogVideoVariationCount(
  raw: unknown,
  effectiveProductCount: number,
  restitchEnabled: boolean
): number {
  if (
    !Number.isSafeInteger(effectiveProductCount) ||
    effectiveProductCount < 1 ||
    effectiveProductCount > CATALOG_PRODUCT_COUNT_MAX
  )
    return invalid('invalid_product_count');
  const count = raw === undefined ? 1 : raw;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1)
    return invalid('invalid_count');
  if (count > effectiveProductCount) return invalid('count_exceeds_products');
  if (count > 1 && restitchEnabled !== true) return invalid('restitch_required');
  return count;
}

export interface CatalogVideoAssignmentRecipe {
  recipeRevision: number;
  /** Persisted internal row UUIDs, independent of public product IDs or row order. */
  recipeRowIds: readonly string[];
  variantCount: number;
  /** Randomness is sampled by the owner once and stored with the generation. */
  seed: string;
}
export interface CatalogVideoAssignment {
  readonly algorithmVersion: 1;
  readonly recipeRevision: number;
  readonly variantCount: number;
  readonly productCount: number;
  readonly seed: string;
  readonly assignments: readonly Readonly<{
    recipeRowId: string;
    videoVariantIndex: number;
  }>[];
}
function capture(input: CatalogVideoAssignmentRecipe) {
  if (
    !isRecord(input) ||
    !Number.isSafeInteger(input.recipeRevision) ||
    input.recipeRevision < 1 ||
    typeof input.seed !== 'string' ||
    !SEED.test(input.seed) ||
    !Array.isArray(input.recipeRowIds) ||
    input.variantCount === undefined
  )
    return invalid('invalid_recipe');
  const count = parseCatalogVideoVariationCount(
    input.variantCount,
    input.recipeRowIds.length,
    true
  );
  const rows = input.recipeRowIds.map(row => {
    if (typeof row !== 'string' || !UUID.test(row)) return invalid('invalid_recipe');
    return row.toLowerCase();
  });
  if (new Set(rows).size !== rows.length) return invalid('invalid_recipe');
  return {
    recipeRevision: input.recipeRevision,
    rows: rows.sort(),
    variantCount: count,
    seed: input.seed.toLowerCase()
  };
}
function snapshot(
  recipe: ReturnType<typeof capture>,
  assignments: Array<{ recipeRowId: string; videoVariantIndex: number }>
): CatalogVideoAssignment {
  return Object.freeze({
    algorithmVersion: CATALOG_VIDEO_ASSIGNMENT_VERSION,
    recipeRevision: recipe.recipeRevision,
    variantCount: recipe.variantCount,
    productCount: recipe.rows.length,
    seed: recipe.seed,
    assignments: Object.freeze(assignments.map(row => Object.freeze({ ...row })))
  });
}

/** Versioned, platform-independent shuffle. It does not sample time or fresh randomness. */
export function createCatalogVideoAssignment(
  input: CatalogVideoAssignmentRecipe
): CatalogVideoAssignment {
  const recipe = capture(input);
  let state = 2166136261;
  for (let i = 0; i < recipe.seed.length; i += 8)
    state = Math.imul(state ^ Number.parseInt(recipe.seed.slice(i, i + 8), 16), 16777619) >>> 0;
  if (state === 0) state = 2654435769;
  const indices = recipe.rows.map((_, index) => index % recipe.variantCount);
  for (let i = indices.length - 1; i > 0; i--) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const pick = Math.floor(((state >>> 0) / 4294967296) * (i + 1));
    [indices[i], indices[pick]] = [indices[pick]!, indices[i]!];
  }
  return snapshot(
    recipe,
    recipe.rows.map((recipeRowId, index) => ({ recipeRowId, videoVariantIndex: indices[index]! }))
  );
}

/** A retry reads its original mapping. Changed membership/count/revision requires a new recipe. */
export function reuseCatalogVideoAssignment(
  stored: unknown,
  input: CatalogVideoAssignmentRecipe
): CatalogVideoAssignment {
  const recipe = capture(input);
  if (
    !isRecord(stored) ||
    stored.algorithmVersion !== CATALOG_VIDEO_ASSIGNMENT_VERSION ||
    stored.recipeRevision !== recipe.recipeRevision ||
    stored.variantCount !== recipe.variantCount ||
    stored.productCount !== recipe.rows.length ||
    stored.seed !== recipe.seed
  )
    return invalid('recipe_mismatch');
  if (!Array.isArray(stored.assignments) || stored.assignments.length !== recipe.rows.length)
    return invalid('invalid_assignment');
  const counts = Array.from({ length: recipe.variantCount }, () => 0);
  const members = new Set(recipe.rows);
  const assignments = stored.assignments.map(row => {
    if (
      !isRecord(row) ||
      typeof row.recipeRowId !== 'string' ||
      !members.delete(row.recipeRowId) ||
      typeof row.videoVariantIndex !== 'number' ||
      !Number.isSafeInteger(row.videoVariantIndex) ||
      row.videoVariantIndex < 0 ||
      row.videoVariantIndex >= recipe.variantCount
    )
      return invalid('invalid_assignment');
    counts[row.videoVariantIndex]!++;
    return { recipeRowId: row.recipeRowId, videoVariantIndex: row.videoVariantIndex };
  });
  if (members.size || Math.min(...counts) < 1 || Math.max(...counts) - Math.min(...counts) > 1)
    return invalid('invalid_assignment');
  assignments.sort((a, b) =>
    a.recipeRowId < b.recipeRowId ? -1 : a.recipeRowId > b.recipeRowId ? 1 : 0
  );
  return snapshot(recipe, assignments);
}
