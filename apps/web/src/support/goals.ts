import type { Language } from '../i18n';
import type { SupportGoalRow, SupportGoalStatus } from '../lib/database.types';

export const SUPPORT_GOAL_SELECT =
  'id,slug,currency,target_cents,raised_cents,title_en,title_uk,description_en,description_uk,status,created_at,updated_at' as const;

const statuses = new Set<SupportGoalStatus>(['draft', 'active', 'archived']);
const maximumCents = 1_000_000_000_000;

function safeCents(value: unknown): number | null {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= maximumCents ? numeric : null;
}

function boundedString(value: unknown, minimum: number, maximum: number): string | null {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum
    ? value
    : null;
}

export function parseSupportGoal(value: unknown): SupportGoalRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const id = boundedString(source.id, 1, 100);
  const slug = boundedString(source.slug, 1, 80);
  const currency = boundedString(source.currency, 3, 3);
  const targetCents = safeCents(source.target_cents);
  const raisedCents = safeCents(source.raised_cents);
  const titleEn = boundedString(source.title_en, 1, 160);
  const titleUk = boundedString(source.title_uk, 1, 160);
  const descriptionEn = boundedString(source.description_en, 1, 2000);
  const descriptionUk = boundedString(source.description_uk, 1, 2000);
  const status =
    typeof source.status === 'string' && statuses.has(source.status as SupportGoalStatus)
      ? (source.status as SupportGoalStatus)
      : null;
  const createdAt = boundedString(source.created_at, 1, 80);
  const updatedAt = boundedString(source.updated_at, 1, 80);

  if (
    !id ||
    !slug ||
    !currency ||
    targetCents === null ||
    targetCents === 0 ||
    raisedCents === null ||
    !titleEn ||
    !titleUk ||
    !descriptionEn ||
    !descriptionUk ||
    !status ||
    !createdAt ||
    !updatedAt
  ) {
    return null;
  }

  return {
    id,
    slug,
    currency,
    target_cents: targetCents,
    raised_cents: raisedCents,
    title_en: titleEn,
    title_uk: titleUk,
    description_en: descriptionEn,
    description_uk: descriptionUk,
    status,
    created_at: createdAt,
    updated_at: updatedAt
  };
}

export function supportGoalProgress(goal: SupportGoalRow) {
  const rawPercent = (goal.raised_cents / goal.target_cents) * 100;
  const visualPercent = Math.min(100, Math.max(0, rawPercent));
  return {
    visualPercent,
    displayPercent: Math.round(visualPercent),
    remainingCents: Math.max(0, goal.target_cents - goal.raised_cents),
    complete: goal.raised_cents >= goal.target_cents
  };
}

export function formatSupportAmount(cents: number, currency: string, language: Language): string {
  const hasFraction = cents % 100 !== 0;
  const amount = new Intl.NumberFormat(language === 'uk' ? 'uk-UA' : 'en-US', {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2
  }).format(cents / 100);
  return currency === 'USD' ? `$${amount}` : `${amount} ${currency}`;
}

export function supportGoalTitle(goal: SupportGoalRow, language: Language): string {
  return language === 'uk' ? goal.title_uk : goal.title_en;
}

export function supportGoalDescription(goal: SupportGoalRow, language: Language): string {
  return language === 'uk' ? goal.description_uk : goal.description_en;
}

/** Parses the admin's total amount without introducing floating-point cents. */
export function parseSupportAmountInput(value: string): number | null {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= maximumCents ? cents : null;
}

export function supportAmountInputValue(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}
