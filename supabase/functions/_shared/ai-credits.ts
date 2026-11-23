/**
 * Чарунки (064) for edge functions: debit the shown price, settle or refund it, and estimate the
 * USD a call may cost so the month can hold it.
 *
 * Pure: the database owns the rules (the Kyiv day, the grant, the month lock); this file names
 * the service functions and turns their refusals into typed errors. Shared by
 * transcript-translate and assistant.
 */
import type { ClaudeModel } from './claude.ts';
import { modelPrice } from './claude.ts';
import type { Rpc, RpcFailure } from './ai-allowance.ts';

export type CreditFeature = 'transcript_translation' | 'launch_assistant';

export type CreditRefusalCode =
  'INSUFFICIENT_CREDITS' | 'AI_MONTH_EXHAUSTED' | 'PRICE_CHANGED' | 'KEY_REUSED';

export class CreditRefusal extends Error {
  readonly code: CreditRefusalCode;
  readonly details: Record<string, unknown>;
  constructor(code: CreditRefusalCode, details: Record<string, unknown> = {}) {
    super(code);
    this.name = 'CreditRefusal';
    this.code = code;
    this.details = details;
  }
}

/** Thrown when the ledger could not be reached; nothing was charged and nothing may be called. */
export class CreditsUnavailable extends Error {
  constructor() {
    super('CREDITS_UNAVAILABLE');
    this.name = 'CreditsUnavailable';
  }
}

const REFUSALS: readonly CreditRefusalCode[] = [
  'INSUFFICIENT_CREDITS',
  'AI_MONTH_EXHAUSTED',
  'PRICE_CHANGED',
  'KEY_REUSED'
];

/** The refusal the database raised, with its numbers, or null for any other error. */
export function creditRefusal(error: RpcFailure | null): CreditRefusal | null {
  if (!error) return null;
  const text = `${error.message ?? ''} ${error.code ?? ''}`;
  const code = REFUSALS.find(candidate => text.includes(candidate));
  if (!code) return null;
  let details: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(error.details ?? '');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      details = parsed as Record<string, unknown>;
    }
  } catch {
    // The code is known even when the numbers are not.
  }
  return new CreditRefusal(code, details);
}

export interface DebitInput {
  userId: string;
  /** `<feature>:<stable id>`; the same key replays, another amount under it is KEY_REUSED. */
  opKey: string;
  feature: CreditFeature;
  amount: number;
  priceVersion: string;
  /** The row the provider cost is recorded against (translation id, assistant command id). */
  subjectId: string | null;
  /** Upper USD estimate of every call this action may make; held against the month. */
  usdUpper: number;
}

export interface DebitResult {
  replayed: boolean;
  credits: unknown;
}

export async function debitCredits(rpc: Rpc, input: DebitInput): Promise<DebitResult> {
  const { data, error } = await rpc('service_ai_credit_debit', {
    p_user: input.userId,
    p_op_key: input.opKey,
    p_feature: input.feature,
    p_amount: input.amount,
    p_price_version: input.priceVersion,
    p_subject: input.subjectId,
    p_usd_upper: Number(input.usdUpper.toFixed(8))
  });
  if (error) {
    const refusal = creditRefusal(error);
    if (refusal) throw refusal;
    throw new CreditsUnavailable();
  }
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  return { replayed: record.replayed === true, credits: record.credits ?? null };
}

/** Settles the month hold at the real cost. Never throws: a failed settle only delays release. */
export async function settleCredits(rpc: Rpc, opKey: string): Promise<void> {
  const { error } = await rpc('service_ai_credit_settle', { p_op_key: opKey });
  if (error) console.error('ai_credit_settle failed', error.code ?? 'unknown');
}

/** Gives the debit back. Returns the fresh status, or null when the ledger was unreachable. */
export async function refundCredits(rpc: Rpc, userId: string, opKey: string): Promise<unknown> {
  const { data, error } = await rpc('service_ai_credit_refund', {
    p_user: userId,
    p_op_key: opKey
  });
  if (error) {
    console.error('ai_credit_refund failed', error.code ?? 'unknown');
    return null;
  }
  return data;
}

/** USD for at most `input` and `output` tokens of one call to `model`. */
export function callUpperUsd(model: ClaudeModel, input: number, output: number): number {
  const price = modelPrice(model);
  return (input * price.input + output * price.output) / 1_000_000;
}

/**
 * A translation makes several calls (chunks, a retry, one escalation to a stronger model), so its
 * upper bound is not proven but generous: twenty-five times what the label charges.
 */
export const TRANSLATION_HOLD_FACTOR = 25;

export function translationUpperUsd(price: number, creditUsd: number): number {
  return price * creditUsd * TRANSLATION_HOLD_FACTOR;
}
