import type { Language } from '../../i18n';

/**
 * Tariff dates, as people read them (034).
 *
 * The server sends a Kyiv day (`YYYY-MM-DD`) or the moment that day ends; the
 * page never computes a term, only prints one (FR-016). A day is formatted as
 * the calendar date it names, whatever zone this browser is in. A moment is the
 * end of a day — `kyiv_day_end` — so it is read one millisecond earlier, in
 * Kyiv, which names the same day whether the server ends it at 23:59:59.999 or
 * at the next midnight.
 */

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;

function instantOf(value: string): Date | null {
  const day = DAY.exec(value);
  if (day) return new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 12));
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed - 1);
}

function zoneOf(value: string): string {
  return DAY.test(value) ? 'UTC' : 'Europe/Kyiv';
}

function locale(language: Language): string {
  return language === 'uk' ? 'uk-UA' : 'en-GB';
}

/** «14 жовтня» / "14 October"; the year only when it is not this one. */
export function formatTariffDay(
  value: string | null | undefined,
  language: Language,
  tariffToday?: string
): string {
  if (!value) return '';
  const instant = instantOf(value);
  if (!instant) return '';
  const timeZone = zoneOf(value);
  const year = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric' }).format(instant);
  const thisYear =
    tariffToday && DAY.test(tariffToday)
      ? tariffToday.slice(0, 4)
      : new Intl.DateTimeFormat('en', {
          timeZone: 'Europe/Kyiv',
          year: 'numeric'
        }).format(new Date());
  return new Intl.DateTimeFormat(locale(language), {
    timeZone,
    day: 'numeric',
    month: 'long',
    ...(year === thisYear ? {} : { year: 'numeric' })
  }).format(instant);
}

/** «14.10» — the badge on the home tile and the admin table. */
export function formatTariffShortDay(value: string | null | undefined, language: Language): string {
  if (!value) return '';
  const instant = instantOf(value);
  if (!instant) return '';
  return new Intl.DateTimeFormat(locale(language), {
    timeZone: zoneOf(value),
    day: '2-digit',
    month: '2-digit'
  }).format(instant);
}

/** A moment the person did something — «10 жовтня, 14:05». */
export function formatTariffMoment(value: string | null | undefined, language: Language): string {
  if (!value) return '';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return '';
  return new Intl.DateTimeFormat(locale(language), {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(parsed));
}

/** The plan's own name in the reader's language, or its code when it has none. */
export function planName(
  plan: { planNameUk?: string | null; planNameEn?: string | null; planCode?: string | null } | null,
  language: Language
): string {
  if (!plan) return '';
  const name = language === 'uk' ? plan.planNameUk : (plan.planNameEn ?? plan.planNameUk);
  return name ?? plan.planNameUk ?? plan.planCode ?? '';
}

/** The three Ukrainian plural forms (two in English), picked by the platform's own rules. */
export function pluralForm<T>(
  language: Language,
  count: number,
  forms: { one: T; few: T; many: T }
): T {
  const category = new Intl.PluralRules(language).select(count);
  if (category === 'one') return forms.one;
  if (category === 'few') return forms.few;
  return forms.many;
}
