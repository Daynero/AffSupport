/**
 * Product names and descriptions for clothing, made up in the browser (024).
 *
 * A catalog whose every row is the same product reads to Meta as one item a hundred times. The
 * space keeps a pool of distinct ones instead, and this is where a pool comes from: a garment,
 * a colour, a fabric, a fit and an invented model name put together in a sensible order, and a
 * few sentences about it. Clothing only, English only — the pictures a space pairs with these
 * should be clothing too, which the settings say where the pool is made.
 *
 * `random` is injectable so a test can hold the output still.
 */

export interface ApparelText {
  title: string;
  description: string;
}

export const APPAREL_POOL_MAX = 1000;
export const APPAREL_POOL_DEFAULT = 200;

const GARMENTS: ReadonlyArray<{ name: string; kind: 'top' | 'bottom' | 'dress' | 'outer' }> = [
  { name: 'T-Shirt', kind: 'top' },
  { name: 'Tank Top', kind: 'top' },
  { name: 'Polo Shirt', kind: 'top' },
  { name: 'Oxford Shirt', kind: 'top' },
  { name: 'Blouse', kind: 'top' },
  { name: 'Hoodie', kind: 'top' },
  { name: 'Sweatshirt', kind: 'top' },
  { name: 'Cardigan', kind: 'top' },
  { name: 'Sweater', kind: 'top' },
  { name: 'Turtleneck', kind: 'top' },
  { name: 'Crop Top', kind: 'top' },
  { name: 'Midi Dress', kind: 'dress' },
  { name: 'Maxi Dress', kind: 'dress' },
  { name: 'Wrap Dress', kind: 'dress' },
  { name: 'Slip Dress', kind: 'dress' },
  { name: 'Shirt Dress', kind: 'dress' },
  { name: 'Jumpsuit', kind: 'dress' },
  { name: 'Pleated Skirt', kind: 'bottom' },
  { name: 'Mini Skirt', kind: 'bottom' },
  { name: 'Chinos', kind: 'bottom' },
  { name: 'Cargo Pants', kind: 'bottom' },
  { name: 'Wide Leg Jeans', kind: 'bottom' },
  { name: 'Slim Jeans', kind: 'bottom' },
  { name: 'Joggers', kind: 'bottom' },
  { name: 'Shorts', kind: 'bottom' },
  { name: 'Leggings', kind: 'bottom' },
  { name: 'Bomber Jacket', kind: 'outer' },
  { name: 'Denim Jacket', kind: 'outer' },
  { name: 'Puffer Jacket', kind: 'outer' },
  { name: 'Trench Coat', kind: 'outer' },
  { name: 'Blazer', kind: 'outer' },
  { name: 'Overshirt', kind: 'outer' }
];

const COLORS = [
  'Black',
  'White',
  'Ivory',
  'Navy',
  'Olive',
  'Sage',
  'Terracotta',
  'Burgundy',
  'Charcoal',
  'Sand',
  'Camel',
  'Dusty Rose',
  'Sky Blue',
  'Forest Green',
  'Mustard',
  'Lavender',
  'Cream',
  'Chocolate',
  'Stone Grey',
  'Coral',
  'Denim Blue',
  'Mint',
  'Rust',
  'Plum'
];

const FABRICS = [
  'Cotton',
  'Linen',
  'Organic Cotton',
  'Denim',
  'Wool Blend',
  'Silk',
  'Satin',
  'Jersey',
  'Fleece',
  'Corduroy',
  'Rib Knit',
  'Chambray',
  'Twill',
  'Viscose',
  'Cashmere Blend',
  'Tencel'
];

const FITS = [
  'Relaxed',
  'Oversized',
  'Slim',
  'Classic',
  'Cropped',
  'Tailored',
  'Loose',
  'Boxy',
  'Fitted'
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
  'dia',
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

const ADJECTIVES = [
  'soft',
  'breathable',
  'lightweight',
  'cozy',
  'effortless',
  'versatile',
  'timeless',
  'polished',
  'comfortable',
  'easygoing',
  'refined',
  'airy',
  'durable',
  'flattering',
  'modern',
  'minimal',
  'elegant',
  'laid-back',
  'smooth',
  'structured'
];

const OCCASIONS = [
  'weekend brunches',
  'long office days',
  'city walks',
  'evenings out',
  'travel days',
  'summer holidays',
  'casual Fridays',
  'date nights',
  'lazy Sundays',
  'festival season',
  'layering in cooler months',
  'everyday wear',
  'coffee runs',
  'family gatherings'
];

const DETAILS = [
  'a clean neckline',
  'reinforced seams',
  'a soft brushed finish',
  'side pockets',
  'a relaxed drop shoulder',
  'a subtle texture',
  'tonal stitching',
  'a gentle stretch',
  'a tailored waist',
  'adjustable cuffs',
  'a curved hem',
  'a smooth lining'
];

const PRAISE = [
  'You will look effortlessly put together in it.',
  'It is the piece you will reach for again and again.',
  'Wear it once and it becomes a favourite.',
  'You will feel confident from morning to night.',
  'It makes getting dressed the easy part of the day.',
  'Simple to style, hard to take off.',
  'You will be unstoppable in it.'
];

const CARE = [
  'Machine washable and made to last.',
  'Easy care: wash cold, hang dry.',
  'Keeps its shape wash after wash.',
  'Pre-washed for a lived-in feel.'
];

const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];

const pick = <T>(items: readonly T[], random: () => number): T =>
  items[Math.floor(random() * items.length)]!;

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

function modelName(random: () => number): string {
  const length = random() < 0.6 ? 2 : 3;
  let name = '';
  for (let index = 0; index < length; index += 1) name += pick(SYLLABLES, random);
  return capitalize(name);
}

const words = (text: string) => text.split(/\s+/u).filter(Boolean);

function title(
  parts: {
    model: string;
    color: string;
    fabric: string;
    fit: string;
    garment: string;
  },
  random: () => number
): string {
  const orders = [
    [parts.model, parts.fit, parts.fabric, parts.garment],
    [parts.color, parts.fabric, parts.garment, parts.model],
    [parts.model, parts.color, parts.fit, parts.garment],
    [parts.fit, parts.color, parts.garment, parts.model],
    [parts.model, parts.color, parts.fabric, parts.garment]
  ];
  let chosen = words(pick(orders, random).join(' '));
  // Four to six words, whatever the parts added up to.
  if (chosen.length > 6) chosen = words([parts.model, parts.color, parts.garment].join(' '));
  if (chosen.length < 4)
    chosen = words([parts.model, parts.color, parts.fabric, parts.garment].join(' '));
  return chosen.slice(0, 6).join(' ');
}

function description(
  parts: { model: string; color: string; fabric: string; fit: string; garment: string },
  random: () => number
): string {
  const garment = parts.garment.toLowerCase();
  const [low, high] = [Math.floor(random() * 3), 3 + Math.floor(random() * 3)];
  const sentences = [
    `The ${parts.model} ${garment} is made from ${parts.fabric.toLowerCase()} in a ${parts.color.toLowerCase()} shade that pairs with almost anything.`,
    `${capitalize(pick(ADJECTIVES, random))} and ${pick(ADJECTIVES, random)}, it is perfect for ${pick(OCCASIONS, random)}.`,
    `A ${parts.fit.toLowerCase()} fit with ${pick(DETAILS, random)}.`,
    pick(PRAISE, random),
    `Available in sizes ${SIZES[low]} to ${SIZES[high]}.`,
    pick(CARE, random),
    `Style it with your favourite basics for ${pick(OCCASIONS, random)}.`
  ];
  // Some sentences, in their order, always the first one: ten words at least, a hundred at most.
  const chosen = [sentences[0]!, ...sentences.slice(1).filter(() => random() < 0.6)];
  let text = chosen.join(' ');
  if (words(text).length < 10) text = `${text} ${sentences[3]}`;
  const all = words(text);
  return all.length > 100
    ? `${all
        .slice(0, 100)
        .join(' ')
        .replace(/[,;:]$/u, '')}.`
    : text;
}

/** `count` distinct names with a description each. */
export function generateApparelTexts(
  count: number,
  random: () => number = Math.random
): ApparelText[] {
  const wanted = Math.max(0, Math.min(APPAREL_POOL_MAX, Math.floor(count)));
  const seen = new Set<string>();
  const texts: ApparelText[] = [];
  let attempts = 0;
  while (texts.length < wanted && attempts < wanted * 20) {
    attempts += 1;
    const parts = {
      model: modelName(random),
      color: pick(COLORS, random),
      fabric: pick(FABRICS, random),
      fit: pick(FITS, random),
      garment: pick(GARMENTS, random).name
    };
    const name = title(parts, random);
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    texts.push({ title: name, description: description(parts, random) });
  }
  return texts;
}
