/**
 * Чарунки (064): one AI currency for every feature that calls a model.
 *
 * A price is known before the button is pressed, rounded up to a whole credit and shown on the
 * button; exactly that price is charged. The web computes it for the label and the server
 * computes it again to refuse a stale label. The real provider cost is recorded separately for
 * the admin and never charged back to the person.
 */
import { TRANSLATION_UNITS_PER_MINUTE } from './transcript-translation.js';

/** USD value of one credit. Fixed for the pilot; the server holds the authoritative copy. */
export const AI_CREDIT_USD = 0.001;

/** Version of the price tables below; the server refuses a label priced by another version. */
export const AI_PRICE_VERSION = 'v1';

export const AI_CREDIT_FEATURES = ['transcript_translation', 'launch_assistant'] as const;
export type AiCreditFeature = (typeof AI_CREDIT_FEATURES)[number];

/** Longest assistant message in characters (code points). */
export const ASSISTANT_MESSAGE_MAX_CHARACTERS = 4_000;

/** Messages up to this length cost one credit; longer ones (to the maximum) cost two. */
export const ASSISTANT_SHORT_MESSAGE_CHARACTERS = 1_500;

/**
 * Credits per translated minute (900 characters) by target language. Every language starts at 1;
 * the benchmark of 064 may raise one whose script needs more tokens.
 */
const TRANSLATION_RATE: Readonly<Record<string, number>> = {};
const TRANSLATION_DEFAULT_RATE = 1;

export function characterCount(text: string): number {
  return [...text].length;
}

/** Price of one assistant message, or null when it is empty or longer than allowed. */
export function assistantMessagePrice(text: string): number | null {
  const count = characterCount(text.trim());
  if (count === 0 || count > ASSISTANT_MESSAGE_MAX_CHARACTERS) return null;
  return count <= ASSISTANT_SHORT_MESSAGE_CHARACTERS ? 1 : 2;
}

/** Price of translating `units` characters (see translationUnits) into `language`. */
export function translationPrice(units: number, language: string): number {
  if (!Number.isFinite(units) || units <= 0) return 1;
  const rate = TRANSLATION_RATE[language.toLowerCase()] ?? TRANSLATION_DEFAULT_RATE;
  return Math.max(1, Math.ceil((units / TRANSLATION_UNITS_PER_MINUTE) * rate - 1e-9));
}

/** What the server says about one person's credits. */
export interface AiCreditsStatus {
  /** Today's grant (base or personal). */
  grant: number;
  /** Everything that can be spent now: what is left of today's grant plus bonus credits. */
  available: number;
  /** What is left of today's grant; renews at Kyiv midnight. */
  daily: number;
  /** Bonus credits: given by Soty, do not expire, spent after the day's grant. */
  bonus: number;
  /** Kyiv business day, YYYY-MM-DD. */
  day: string;
  /** The next Kyiv midnight as an ISO instant. */
  resetsAt: string;
  /** False while the shared monthly budget cannot take another paid call. */
  paidOpen: boolean;
  /** Newest first, at most ten; no text of the person's requests. */
  recent: AiCreditEntry[];
}

export interface AiCreditEntry {
  feature: AiCreditFeature;
  kind: 'debit' | 'refund';
  amount: number;
  at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function parseAiCreditsStatus(value: unknown): AiCreditsStatus | null {
  if (!isRecord(value)) return null;
  const { grant, available, day, resetsAt, paidOpen, recent } = value;
  // A server before bonus credits sends only `available`, which was then all daily.
  const daily = value.daily === undefined ? available : value.daily;
  const bonus = value.bonus === undefined ? 0 : value.bonus;
  if (!nonNegativeInteger(daily) || !nonNegativeInteger(bonus)) return null;
  if (
    !nonNegativeInteger(grant) ||
    !nonNegativeInteger(available) ||
    typeof day !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(day) ||
    typeof resetsAt !== 'string' ||
    !Number.isFinite(Date.parse(resetsAt)) ||
    typeof paidOpen !== 'boolean' ||
    !Array.isArray(recent)
  ) {
    return null;
  }
  const entries: AiCreditEntry[] = [];
  for (const row of recent.slice(0, 10)) {
    if (
      !isRecord(row) ||
      !(AI_CREDIT_FEATURES as readonly unknown[]).includes(row.feature) ||
      (row.kind !== 'debit' && row.kind !== 'refund') ||
      !nonNegativeInteger(row.amount) ||
      typeof row.at !== 'string' ||
      !Number.isFinite(Date.parse(row.at))
    ) {
      return null;
    }
    entries.push({
      feature: row.feature as AiCreditFeature,
      kind: row.kind,
      amount: row.amount,
      at: row.at
    });
  }
  return {
    grant,
    available,
    daily: daily as number,
    bonus: bonus as number,
    day,
    resetsAt,
    paidOpen,
    recent: entries
  };
}

/** Machine codes a paid action can be refused with, before anything is charged or called. */
export const AI_CREDIT_REFUSALS = [
  'INSUFFICIENT_CREDITS',
  'AI_MONTH_EXHAUSTED',
  'PRICE_CHANGED',
  'CLIENT_UPGRADE'
] as const;
export type AiCreditRefusal = (typeof AI_CREDIT_REFUSALS)[number];
