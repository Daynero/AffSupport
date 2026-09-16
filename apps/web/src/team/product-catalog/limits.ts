/**
 * What a person may type into the product catalog dialog and settings (feature 022).
 *
 * The Edge Function holds the same rules in `supabase/functions/_shared/product-catalog.ts` and
 * is the one that decides; these exist so a field can say what is wrong before anything is sent.
 * They are a copy rather than an import because the shared package cannot change without a
 * desktop release, and this feature ships as a web update — `tests/product-catalog-parity.test.ts`
 * fails the moment the two disagree.
 */

export const PRODUCT_COUNT_MIN = 1;
export const PRODUCT_COUNT_MAX = 400;
export const PRODUCT_COUNT_DEFAULT = 100;
export const PRICE_MIN = 1;
export const PRICE_MAX = 999_999;
export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 9999;
export const IMAGE_LINK_MAX = 2048;
export const SOURCE_LINK_MAX = 8192;

export type FieldCheck<T> = { ok: true; value: T } | { ok: false; reason: 'required' | 'invalid' };

export function validateProductCount(raw: string): FieldCheck<number> {
  const digits = raw.trim();
  if (digits === '') return { ok: false, reason: 'required' };
  if (!/^\d{1,3}$/u.test(digits)) return { ok: false, reason: 'invalid' };
  const count = Number(digits);
  return count >= PRODUCT_COUNT_MIN && count <= PRODUCT_COUNT_MAX
    ? { ok: true, value: count }
    : { ok: false, reason: 'invalid' };
}

/**
 * A link as pasted, taken as it is (024: "no validation needed"). Spaces and line breaks a paste
 * brings along are dropped, and a link typed without its scheme — `offer.com/?sub=1` — gets
 * `https://` in front, which is what the sheet and Meta need. Nothing else is refused but an empty
 * field or one past the length the database keeps.
 */
export function validateWebLink(raw: string, max: number): FieldCheck<string> {
  const compact = raw.replace(/\s+/gu, '');
  if (compact === '') return { ok: false, reason: 'required' };
  const link = /^https?:\/\//iu.test(compact) ? compact : `https://${compact}`;
  return link.length > max ? { ok: false, reason: 'invalid' } : { ok: true, value: link };
}

/** A whole number of dollars, typed without currency, decimals or separators. */
export function validatePrice(raw: string): FieldCheck<number> {
  const digits = raw.trim();
  if (digits === '') return { ok: false, reason: 'required' };
  if (!/^\d{1,6}$/u.test(digits)) return { ok: false, reason: 'invalid' };
  const price = Number(digits);
  return price >= PRICE_MIN && price <= PRICE_MAX
    ? { ok: true, value: price }
    : { ok: false, reason: 'invalid' };
}

function validateText(raw: string, max: number): FieldCheck<string> {
  const text = raw.trim();
  if (text === '') return { ok: false, reason: 'required' };
  return text.length <= max ? { ok: true, value: text } : { ok: false, reason: 'invalid' };
}

export const validateTitle = (raw: string) => validateText(raw, TITLE_MAX);
export const validateDescription = (raw: string) => validateText(raw, DESCRIPTION_MAX);

/** How a saved price appears in the sheet — the owner's form, comma and all. */
export function formatPricePreview(price: number): string {
  return `${price},00 USD`;
}
