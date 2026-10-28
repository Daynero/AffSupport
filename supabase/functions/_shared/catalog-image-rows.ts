import {
  CATALOG_IMAGE_GARMENTS,
  CATALOG_IMAGE_COLORS,
  isR2CatalogImage,
  type R2CatalogImage,
  type CatalogImageClassification
} from '../../../packages/shared/dist/team/catalog-images.js';
import type { ProductCatalogRowValues } from './product-catalog.ts';
import { garmentOf, pictureFacts, drawProductDetails } from './product-details.ts';
import { TeamFunctionError } from './errors.ts';

export interface LegacyDrawnImage {
  driveFileId: string;
  resourceKey: string | null;
  name?: string | null;
}
export type CatalogDrawnImage = LegacyDrawnImage | R2CatalogImage;
export interface CatalogImageDrawOptions {
  contractVersion?: 2;
  attemptId?: string;
  scope?: 'create' | 'growth' | 'refresh';
}
export function r2Image(image: CatalogDrawnImage): image is R2CatalogImage {
  return isR2CatalogImage(image);
}
export function legacyImage(image: CatalogDrawnImage): image is LegacyDrawnImage {
  return !r2Image(image);
}
export function catalogImageUrl(image: CatalogDrawnImage): string {
  if (r2Image(image)) return image.publicUrl;
  const base = `https://drive.google.com/uc?export=view&id=${encodeURIComponent(image.driveFileId)}`;
  return image.resourceKey ? `${base}&resourcekey=${encodeURIComponent(image.resourceKey)}` : base;
}
export function catalogImageName(image: CatalogDrawnImage): string | null {
  return r2Image(image) ? null : (image.name ?? null);
}
export function catalogImageFacts(image: CatalogDrawnImage) {
  if (!r2Image(image)) return pictureFacts(image.name ?? '');
  return image.classification.mode === 'matched'
    ? { garment: garmentOf(image.classification.garment), color: image.classification.color }
    : { garment: null, color: null };
}
export function rowImageFacts(row: ProductCatalogRowValues) {
  return row.pictureImage
    ? catalogImageFacts(row.pictureImage)
    : pictureFacts(row.pictureName ?? '');
}
/** Actual outgoing references, including images retained from older updater rounds. */
export function catalogImagesInRows(
  rows: readonly ProductCatalogRowValues[] | undefined
): R2CatalogImage[] {
  const images: R2CatalogImage[] = [];
  for (const row of rows ?? []) {
    if (!row.pictureImage) continue;
    if (!isR2CatalogImage(row.pictureImage) || row.imageLink !== row.pictureImage.publicUrl)
      throw new TeamFunctionError('INVALID_RESPONSE');
    images.push(row.pictureImage);
  }
  return images;
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const phrasePattern = (text: string): string =>
  text === 'T-Shirt'
    ? '\\bt[-\\s]?shirt\\b'
    : `\\b${text.split(/[ -]+/u).map(escape).join('[ -]+')}\\b`;
function factsInText(text: string) {
  const garments = CATALOG_IMAGE_GARMENTS.map(([, name]) => name).filter(name =>
    new RegExp(phrasePattern(name), 'iu').test(text)
  );
  const colors = CATALOG_IMAGE_COLORS.map(c => c.replace(/-/gu, ' ')).filter(c =>
    new RegExp(phrasePattern(c), 'iu').test(text)
  );
  return { garments, colors };
}
function replaceFact(text: string, from: string, to: string): string {
  return text.replace(new RegExp(phrasePattern(from), 'giu'), match =>
    match[0] === match[0]?.toUpperCase()
      ? to.replace(/\b[a-z]/gu, c => c.toUpperCase())
      : to.toLowerCase()
  );
}
const canonical = (facts: Extract<CatalogImageClassification, { mode: 'matched' }>) => ({
  title: `${facts.color.replace(/\b[a-z]/gu, c => c.toUpperCase())} ${facts.garment} Essential Style`,
  description: `This catalog item is a ${facts.color} ${facts.garment.toLowerCase()}. See the product image for its appearance.`
});

/** Type/color-only corrections; never silently regenerate text under the disabled toggle. */
export function pairCatalogImageRow(
  row: ProductCatalogRowValues,
  image: CatalogDrawnImage,
  options: { allowTextGeneration: boolean }
): ProductCatalogRowValues {
  if (!r2Image(image))
    return {
      ...row,
      imageLink: catalogImageUrl(image),
      pictureName: catalogImageName(image),
      pictureImage: undefined
    };
  const base = { ...row, imageLink: image.publicUrl, pictureName: null, pictureImage: image };
  if (image.classification.mode === 'unclassified') return base;
  const facts = image.classification;
  const title = factsInText(row.title),
    description = factsInText(row.description);
  const allGarments = new Set([...title.garments, ...description.garments]);
  const allColors = new Set([...title.colors, ...description.colors]);
  const prior = row.pictureImage?.classification;
  const safe =
    title.garments.length === 1 &&
    allGarments.size === 1 &&
    allColors.size <= 1 &&
    !(
      !options.allowTextGeneration &&
      prior?.mode === 'matched' &&
      (title.garments[0] !== prior.garment || (allColors.size === 1 && !allColors.has(prior.color)))
    );
  let words: { title: string; description: string };
  if (!safe) {
    if (!options.allowTextGeneration) throw new TeamFunctionError('IMAGE_TEXT_PAIRING_CONFLICT');
    words = canonical(facts);
  } else {
    const from = title.garments[0]!;
    let newTitle = replaceFact(row.title, from, facts.garment);
    let newDescription = replaceFact(row.description, from, facts.garment);
    const oldColor = [...allColors][0];
    if (oldColor) {
      newTitle = replaceFact(newTitle, oldColor, facts.color);
      newDescription = replaceFact(newDescription, oldColor, facts.color);
    }
    words = { title: newTitle, description: newDescription };
  }
  if (words.title.length > 200 || words.description.length > 9999) {
    if (!options.allowTextGeneration) throw new TeamFunctionError('IMAGE_TEXT_PAIRING_CONFLICT');
    words = canonical(facts);
  }
  const details = drawProductDetails({
    title: `${facts.color} ${facts.garment}`,
    price: row.price,
    brand: row.brand ?? '',
    pictureColor: facts.color
  });
  return {
    ...base,
    ...words,
    color: facts.color,
    googleCategory: details.googleCategory,
    fbCategory: details.fbCategory,
    tags: details.tags
  };
}

/** Strict persisted union reader, with the old shape accepted only as Drive. */
export function parseCatalogDrawnImage(value: unknown): CatalogDrawnImage | null {
  if (isR2CatalogImage(value)) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if ('kind' in value && value.kind !== undefined && value.kind !== 'legacy_drive') return null;
  if (!('driveFileId' in value) || typeof value.driveFileId !== 'string' || !value.driveFileId)
    return null;
  if (
    !('resourceKey' in value) ||
    (value.resourceKey !== null && typeof value.resourceKey !== 'string')
  )
    return null;
  if (
    'name' in value &&
    value.name !== null &&
    value.name !== undefined &&
    typeof value.name !== 'string'
  )
    return null;
  return {
    driveFileId: value.driveFileId,
    resourceKey: value.resourceKey,
    name: 'name' in value && typeof value.name === 'string' ? value.name : null
  };
}
