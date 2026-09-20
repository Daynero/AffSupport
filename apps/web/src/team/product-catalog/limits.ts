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

export function validateWebLink(raw: string, max: number): FieldCheck<string> {
  const link = raw.trim();
  if (link === '') return { ok: false, reason: 'required' };
  if (link.length > max || /\s/u.test(link)) return { ok: false, reason: 'invalid' };
  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname === '') {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, value: link };
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
