/**
 * The rest of a product row, made up per row (025).
 *
 * Meta's template ships one example product, and 022 wrote that example into every row: royal
 * blue, size M, cotton, "stripes", the same barcode, a sale that ended in 2020. A hundred rows of
 * it under a hundred different names is one product typed a hundred times, whatever the names say.
 *
 * Here each row gets its own. Where the name already decided something — "Navy Twill Wide Leg
 * Jeans Ludia" is navy, twill and trousers — the value follows the name, because a catalog that
 * contradicts itself is worse than one that repeats itself. Everything else is drawn.
 *
 * `random` is injectable so a test can hold the output still, and the vocabulary matches the pool
 * the space generates its names from (`apps/web/src/team/product-catalog/apparelTexts.ts`).
 */

export type GarmentKind = 'top' | 'bottom' | 'skirt' | 'dress' | 'outer';

interface Garment {
  name: string;
  kind: GarmentKind;
}

/** Longest first, so "Tank Top" is not read as "Top" and "Midi Dress" not as "Dress". */
const GARMENTS: readonly Garment[] = [
  { name: 'Wide Leg Jeans', kind: 'bottom' },
  { name: 'Pleated Skirt', kind: 'skirt' },
  { name: 'Bomber Jacket', kind: 'outer' },
  { name: 'Denim Jacket', kind: 'outer' },
  { name: 'Puffer Jacket', kind: 'outer' },
  { name: 'Oxford Shirt', kind: 'top' },
  { name: 'Sweatshirt', kind: 'top' },
  { name: 'Turtleneck', kind: 'top' },
  { name: 'Trench Coat', kind: 'outer' },
  { name: 'Cargo Pants', kind: 'bottom' },
  { name: 'Slim Jeans', kind: 'bottom' },
  { name: 'Mini Skirt', kind: 'skirt' },
  { name: 'Shirt Dress', kind: 'dress' },
  { name: 'Midi Dress', kind: 'dress' },
  { name: 'Maxi Dress', kind: 'dress' },
  { name: 'Wrap Dress', kind: 'dress' },
  { name: 'Slip Dress', kind: 'dress' },
  { name: 'Polo Shirt', kind: 'top' },
  { name: 'Overshirt', kind: 'outer' },
  { name: 'Tank Top', kind: 'top' },
  { name: 'Crop Top', kind: 'top' },
  { name: 'Jumpsuit', kind: 'dress' },
  { name: 'Cardigan', kind: 'top' },
  { name: 'T-Shirt', kind: 'top' },
  { name: 'Leggings', kind: 'bottom' },
  { name: 'Joggers', kind: 'bottom' },
  { name: 'Sweater', kind: 'top' },
  { name: 'Blouse', kind: 'top' },
  { name: 'Hoodie', kind: 'top' },
  { name: 'Blazer', kind: 'outer' },
  { name: 'Chinos', kind: 'bottom' },
  { name: 'Shorts', kind: 'bottom' },
  { name: 'Jacket', kind: 'outer' },
  { name: 'Skirt', kind: 'skirt' },
  { name: 'Jeans', kind: 'bottom' },
  { name: 'Dress', kind: 'dress' },
  { name: 'Shirt', kind: 'top' },
  { name: 'Coat', kind: 'outer' },
  { name: 'Pants', kind: 'bottom' }
];

const COLORS: readonly string[] = [
  'Forest Green',
  'Denim Blue',
  'Stone Grey',
  'Dusty Rose',
  'Sky Blue',
  'Terracotta',
  'Burgundy',
  'Charcoal',
  'Chocolate',
  'Lavender',
  'Mustard',
  'Black',
  'White',
  'Ivory',
  'Cream',
  'Navy',
  'Olive',
  'Sage',
  'Sand',
  'Camel',
  'Coral',
  'Mint',
  'Rust',
  'Plum'
];

const FABRICS: readonly string[] = [
  'Cashmere Blend',
  'Organic Cotton',
  'Wool Blend',
  'Corduroy',
  'Chambray',
  'Rib Knit',
  'Viscose',
  'Tencel',
  'Jersey',
  'Fleece',
  'Cotton',
  'Denim',
  'Linen',
  'Satin',
  'Twill',
  'Silk'
];

const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
const PATTERNS = ['solid', 'striped', 'plaid', 'printed', 'checked', 'colour block'];
const VIDEO_TAGS = ['Gym', 'Outdoor', 'Lifestyle', 'Studio', 'Street', 'Travel', 'Casual'];
/** Meta's `country:region:service:price`; an empty region means the whole country. */
const SHIPPING = [
  'US::Standard:0.00 USD',
  'US::Standard:3.99 USD',
  'US::Standard:4.99 USD',
  'US::Standard:5.99 USD',
  'US::Express:9.99 USD'
];
const SYLLABLES = [
  'au',
  're',
  'li',
  'no',
  'va',
  'ma',
  'ris',
  'ka',
  'lo',
  've',
  'ra',
  'lu',
  'mi',
  'ze',
  'ta',
  'or',
  'in',
  'el',
  'sa',
  'mo',
  'ne',
  'ty',
  'ce',
  'ly',
  'an',
  'so',
  'ri',
  'vi',
  'da'
];

const STYLES: Record<GarmentKind, readonly string[]> = {
  top: ['Casual', 'Relaxed', 'Classic', 'Streetwear', 'Minimal'],
  bottom: ['Straight', 'Wide Leg', 'Slim', 'High Waist', 'Casual'],
  skirt: ['A-Line', 'Pleated', 'Bodycon', 'High Waist'],
  dress: ['Bodycon', 'A-Line', 'Wrap', 'Slip', 'Shirt Dress'],
  outer: ['Oversized', 'Tailored', 'Utility', 'Classic', 'Cropped']
};

const GOOGLE_CATEGORY: Record<GarmentKind, string> = {
  top: 'Apparel & Accessories > Clothing > Shirts & Tops',
  bottom: 'Apparel & Accessories > Clothing > Pants',
  skirt: 'Apparel & Accessories > Clothing > Skirts',
  dress: 'Apparel & Accessories > Clothing > Dresses',
  outer: 'Apparel & Accessories > Clothing > Outerwear'
};

const FB_CATEGORY: Record<GarmentKind, string> = {
  top: 'Clothing & Accessories > Clothing > Shirts & Tops',
  bottom: 'Clothing & Accessories > Clothing > Pants',
  skirt: 'Clothing & Accessories > Clothing > Skirts',
  dress: 'Clothing & Accessories > Clothing > Dresses',
  outer: 'Clothing & Accessories > Clothing > Outerwear'
};

/** What only a woman's section sells: the rest is drawn. */
const WOMENS: ReadonlySet<GarmentKind> = new Set<GarmentKind>(['dress', 'skirt']);

export const pickFrom = <T>(items: readonly T[], random: () => number): T =>
  items[Math.floor(random() * items.length)]!;

const found = (title: string, values: readonly string[]): string | null =>
  values.find(value => title.toLowerCase().includes(value.toLowerCase())) ?? null;

/** The garment the name is for, longest match first; null when the name names none. */
export function garmentOf(title: string): Garment | null {
  return GARMENTS.find(garment => title.toLowerCase().includes(garment.name.toLowerCase())) ?? null;
}

/** A made-up label a whole catalog sells under — two or three syllables, capitalized. */
export function inventedBrand(random: () => number = Math.random): string {
  const length = random() < 0.6 ? 2 : 3;
  let name = '';
  for (let index = 0; index < length; index += 1) name += pickFrom(SYLLABLES, random);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * A content ID no catalog has used before.
 *
 * Row numbers came back: a re-created catalog started at 1 again, and Meta remembered the
 * rejections those IDs carried. The time it was written and a drawn tail make one that cannot,
 * and it is a string, which is what Meta's ID column takes (up to 100 characters).
 */
export function contentId(now: number = Date.now(), random: () => number = Math.random): string {
  const stamp = Math.max(0, Math.floor(now)).toString(36).toUpperCase();
  let tail = '';
  for (let index = 0; index < 7; index += 1) {
    tail += Math.floor(random() * 36)
      .toString(36)
      .toUpperCase();
  }
  return `${stamp}-${tail}`;
}

/** A whole-dollar price under `price`, at least a dollar: 15% to 40% off. */
export function salePriceFor(price: number, random: () => number = Math.random): number {
  const cut = 0.6 + random() * 0.25;
  return Math.max(1, Math.min(price - 1, Math.round(price * cut)));
}

/** Meta's sale window, from yesterday to a month out, so the sale is running when it is read. */
export function saleWindowFrom(now: number = Date.now()): string {
  const day = 86_400_000;
  const start = new Date(now - day).toISOString().slice(0, 10);
  const end = new Date(now + 30 * day).toISOString().slice(0, 10);
  return `${start}T00:00+00:00/${end}T23:59+00:00`;
}

export interface DrawnProductDetails {
  salePrice: number;
  saleWindow: string;
  color: string;
  size: string;
  material: string;
  pattern: string;
  gender: string;
  style: string;
  googleCategory: string;
  fbCategory: string;
  brand: string;
  quantity: number;
  shippingWeight: string;
  shipping: string;
  videoTag: string;
  videoParam: string;
  tags: readonly [string, string];
}

/** Everything one row says beside its name, text, price and picture. */
export function drawProductDetails(input: {
  title: string;
  price: number;
  brand: string;
  now?: number;
  random?: () => number;
}): DrawnProductDetails {
  const random = input.random ?? Math.random;
  const now = input.now ?? Date.now();
  const garment = garmentOf(input.title);
  const kind: GarmentKind = garment?.kind ?? 'top';
  const color = (found(input.title, COLORS) ?? pickFrom(COLORS, random)).toLowerCase();
  const material = (found(input.title, FABRICS) ?? pickFrom(FABRICS, random)).toLowerCase();
  const weight = (0.2 + Math.floor(random() * 14) / 10).toFixed(1);
  let tail = '';
  for (let index = 0; index < 4; index += 1) {
    tail += Math.floor(random() * 36).toString(36);
  }
  return {
    salePrice: salePriceFor(input.price, random),
    saleWindow: saleWindowFrom(now),
    color,
    size: pickFrom(SIZES, random),
    material,
    pattern: pickFrom(PATTERNS, random),
    gender: WOMENS.has(kind) ? 'female' : pickFrom(['female', 'male', 'unisex'], random),
    style: pickFrom(STYLES[kind], random),
    googleCategory: GOOGLE_CATEGORY[kind],
    fbCategory: FB_CATEGORY[kind],
    brand: input.brand,
    quantity: 20 + Math.floor(random() * 281),
    shippingWeight: `${weight} kg`,
    shipping: pickFrom(SHIPPING, random),
    videoTag: pickFrom(VIDEO_TAGS, random),
    videoParam: tail,
    tags: [(garment?.name ?? 'clothing').toLowerCase().replace(/\s+/gu, '-'), color]
  };
}
