import { CATALOG_IMAGE_COLORS, type CatalogImageGarment } from './catalog-images.js';

/** Versioned, shared catalog wording. No per-space pool or network generation. */
export const AUTOMATIC_CATALOG_CONTENT_VERSION = 1;
export const CATALOG_CONTENT_VARIANT_COUNT = 2000;

export interface CatalogPriceBand {
  readonly min: number;
  readonly max: number;
}
export interface CatalogContentFacts {
  garment: string | null;
  color: string | null;
}
export interface CatalogContentSelection {
  title: string;
  description: string;
  price: number;
  policyVersion: typeof AUTOMATIC_CATALOG_CONTENT_VERSION;
  variantId: number;
}

const PRICE_BANDS = {
  'T-Shirt': { min: 12, max: 24 },
  'Tank Top': { min: 12, max: 24 },
  'Polo Shirt': { min: 20, max: 36 },
  'Oxford Shirt': { min: 24, max: 44 },
  Blouse: { min: 24, max: 44 },
  Hoodie: { min: 28, max: 55 },
  Sweatshirt: { min: 28, max: 50 },
  Cardigan: { min: 30, max: 60 },
  Sweater: { min: 30, max: 60 },
  Turtleneck: { min: 30, max: 55 },
  'Crop Top': { min: 14, max: 28 },
  'Midi Dress': { min: 45, max: 85 },
  'Maxi Dress': { min: 55, max: 110 },
  'Wrap Dress': { min: 50, max: 95 },
  'Slip Dress': { min: 45, max: 80 },
  'Shirt Dress': { min: 45, max: 85 },
  Jumpsuit: { min: 50, max: 100 },
  'Pleated Skirt': { min: 32, max: 60 },
  'Mini Skirt': { min: 28, max: 50 },
  Chinos: { min: 32, max: 60 },
  'Cargo Pants': { min: 35, max: 65 },
  'Wide Leg Jeans': { min: 38, max: 75 },
  'Slim Jeans': { min: 38, max: 70 },
  Joggers: { min: 25, max: 48 },
  Shorts: { min: 18, max: 35 },
  Leggings: { min: 20, max: 38 },
  'Bomber Jacket': { min: 65, max: 125 },
  'Denim Jacket': { min: 65, max: 115 },
  'Puffer Jacket': { min: 85, max: 160 },
  'Trench Coat': { min: 90, max: 180 },
  Blazer: { min: 70, max: 140 },
  Overshirt: { min: 45, max: 85 }
} as const satisfies Record<CatalogImageGarment, CatalogPriceBand>;
const UNKNOWN_PRICE_BAND: CatalogPriceBand = { min: 20, max: 40 };
const knownGarment = (value: string | null): value is CatalogImageGarment =>
  value !== null && Object.hasOwn(PRICE_BANDS, value);

/** Return a copy so a consumer cannot mutate the shared policy. */
export function catalogPriceBand(garment: string | null): CatalogPriceBand {
  return { ...(knownGarment(garment) ? PRICE_BANDS[garment] : UNKNOWN_PRICE_BAND) };
}

// Forty × fifty fixed model words: exactly 2,000 unique identities, no rejection loop.
const MODEL_FIRST = [
  'Aster',
  'Alba',
  'Aria',
  'Aura',
  'Aven',
  'Briar',
  'Cora',
  'Dara',
  'Eden',
  'Elara',
  'Elio',
  'Ember',
  'Esme',
  'Faye',
  'Flora',
  'Isla',
  'Jade',
  'Juno',
  'Kaia',
  'Liora',
  'Luma',
  'Lyra',
  'Mara',
  'Mira',
  'Nala',
  'Nera',
  'Nova',
  'Odea',
  'Orla',
  'Rhea',
  'Riva',
  'Sera',
  'Sol',
  'Tara',
  'Thea',
  'Uma',
  'Vela',
  'Vera',
  'Wren',
  'Zara'
] as const;
const MODEL_LAST = [
  'Arc',
  'Bay',
  'Bloom',
  'Brook',
  'Coast',
  'Cove',
  'Crest',
  'Dale',
  'Dawn',
  'Dune',
  'Echo',
  'Elm',
  'Fern',
  'Field',
  'Finch',
  'Fjord',
  'Glen',
  'Grove',
  'Harbor',
  'Haven',
  'Hill',
  'Isle',
  'Lake',
  'Lane',
  'Leaf',
  'Linden',
  'Meadow',
  'Moon',
  'Moss',
  'North',
  'Oak',
  'Ocean',
  'Orchard',
  'Peak',
  'Pine',
  'Reed',
  'Ridge',
  'River',
  'Rowan',
  'Shore',
  'Sky',
  'Solstice',
  'Spring',
  'Stone',
  'Vale',
  'Valley',
  'Willow',
  'Wind',
  'Winter',
  'Wood'
] as const;
const models = MODEL_FIRST.flatMap(first => MODEL_LAST.map(last => `${first} ${last}`));
const endings = [
  'See the product image for its appearance.',
  'Explore the color and appearance in the product image.',
  'The product image shows the item in this selection.',
  'Use the product image to view the details of this item.',
  'Take a closer look at the item in the product image.'
] as const;
const colors = new Set<string>(CATALOG_IMAGE_COLORS.map(color => color.replace(/-/gu, ' ')));
const titleCase = (text: string) => text.replace(/\b[a-z]/gu, character => character.toUpperCase());
const unit = (random: () => number): number => {
  const value = random();
  return Number.isFinite(value) ? Math.max(0, Math.min(1 - Number.EPSILON, value)) : 0;
};

/**
 * One bounded draw stream per catalog/round. Exhaust a shuffled cycle before reusing a variant.
 * Callers persist final selections: a seed is not a substitute for a durable row recipe.
 */
export function createCatalogContentDraw(
  random: () => number = Math.random
): (facts: CatalogContentFacts) => CatalogContentSelection {
  let indices: number[] = [];
  let remaining = 0;
  return facts => {
    if (remaining === 0) {
      indices = Array.from({ length: CATALOG_CONTENT_VARIANT_COUNT }, (_, index) => index);
      remaining = indices.length;
    }
    const selected = Math.floor(unit(random) * remaining);
    const variantId = indices[selected]!;
    remaining -= 1;
    indices[selected] = indices[remaining]!;
    const model = models[variantId]!;
    const garment = knownGarment(facts.garment) ? facts.garment : null;
    const rawColor = facts.color?.trim().toLowerCase().replace(/-/gu, ' ') ?? '';
    const color = garment && colors.has(rawColor) ? rawColor : null;
    const item = garment ? `${color ? `${color} ` : ''}${garment.toLowerCase()}` : 'catalog item';
    const titleItem = garment ? `${color ? `${titleCase(color)} ` : ''}${garment}` : 'Catalog Item';
    const band = catalogPriceBand(garment);
    return {
      title: `${model} ${titleItem}`,
      description: `The ${model} ${item} is featured in this catalog. ${endings[variantId % endings.length]}`,
      price: band.min + Math.floor(unit(random) * (band.max - band.min + 1)),
      policyVersion: AUTOMATIC_CATALOG_CONTENT_VERSION,
      variantId
    };
  };
}
