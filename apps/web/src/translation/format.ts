/**
 * Minutes of translation as people read them (063). The decision is always made in characters;
 * these numbers only have to agree with it: when a translation fits, the shown cost is never
 * above the shown remainder, and when it does not, it is always above (FR-012).
 */
import { TRANSLATION_UNITS_PER_MINUTE } from '@video-compressor/shared';

/** Tenths of a minute, rounded to the nearest. */
function tenths(units: number): number {
  return Math.round((units / TRANSLATION_UNITS_PER_MINUTE) * 10);
}

export interface AllowanceFigures {
  /** Cost of this text, in minutes with one decimal. */
  need: number;
  /** What is left today. */
  left: number;
  /** The whole daily limit. */
  limit: number;
  fits: boolean;
  /** The text is longer than a whole day's limit. */
  overDaily: boolean;
}

export function allowanceFigures(
  neededUnits: number,
  usedUnits: number,
  limitUnits: number
): AllowanceFigures {
  const leftUnits = Math.max(0, limitUnits - usedUnits);
  const fits = neededUnits <= leftUnits;
  let need = Math.max(1, tenths(neededUnits));
  const left = tenths(leftUnits);
  if (fits && need > left) need = left;
  if (!fits && need <= left) need = left + 1;
  return {
    need: need / 10,
    left: left / 10,
    limit: tenths(limitUnits) / 10,
    fits,
    overDaily: neededUnits > limitUnits
  };
}

export function formatMinutes(value: number, uiLanguage: string): string {
  return new Intl.NumberFormat(uiLanguage === 'uk' ? 'uk-UA' : 'en-US', {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0
  }).format(value);
}

/** The moment the allowance renews, as Kyiv wall-clock time ("00:00"). */
export function formatResetTime(resetsAt: string, uiLanguage: string): string {
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return '00:00';
  return new Intl.DateTimeFormat(uiLanguage === 'uk' ? 'uk-UA' : 'en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Europe/Kyiv'
  }).format(date);
}
