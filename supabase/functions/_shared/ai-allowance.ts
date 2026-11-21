/**
 * Calls to the shared allowance and cost ledger (063), for any function that uses a model.
 *
 * The database owns the rules (limits, the Kyiv day, the held-reservation window); this file only
 * names the service functions and narrows their answers. A function that adds a new model
 * feature inserts its row into `private.ai_feature_allowances` and calls these.
 */
import type { UsageRecord } from './claude.ts';

export interface RpcFailure {
  code?: string;
  message?: string;
  details?: string | null;
}

export type Rpc = (
  name: string,
  parameters: Record<string, unknown>
) => PromiseLike<{ data: unknown; error: RpcFailure | null }>;

export class AllowanceExceededError extends Error {
  readonly neededUnits: number;
  readonly usedUnits: number;
  readonly limitUnits: number;
  constructor(details: { neededUnits: number; usedUnits: number; limitUnits: number }) {
    super('ALLOWANCE_EXCEEDED');
    this.name = 'AllowanceExceededError';
    this.neededUnits = details.neededUnits;
    this.usedUnits = details.usedUnits;
    this.limitUnits = details.limitUnits;
  }
}

/** The numbers the database attached to ALLOWANCE_EXCEEDED, or null when the error is another. */
export function allowanceExceeded(error: RpcFailure | null): AllowanceExceededError | null {
  if (!error || !/ALLOWANCE_EXCEEDED/u.test(`${error.message ?? ''} ${error.code ?? ''}`)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(error.details ?? '');
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const number = (value: unknown) =>
        typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
      const neededUnits = number(record.neededUnits);
      const usedUnits = number(record.usedUnits);
      const limitUnits = number(record.limitUnits);
      if (neededUnits !== null && usedUnits !== null && limitUnits !== null) {
        return new AllowanceExceededError({ neededUnits, usedUnits, limitUnits });
      }
    }
  } catch {
    // fall through: the code is known even when the numbers are not
  }
  return new AllowanceExceededError({ neededUnits: 0, usedUnits: 0, limitUnits: 0 });
}

export async function recordModelUsage(
  rpc: Rpc,
  input: { feature: string; userId: string; subjectId: string | null; entry: UsageRecord }
): Promise<void> {
  const { entry } = input;
  // The ledger never blocks the work it describes: a failed write is logged and dropped.
  const { error } = await rpc('service_ai_usage_record', {
    p_feature: input.feature,
    p_user: input.userId,
    p_subject: input.subjectId,
    p_model: entry.model,
    p_outcome: entry.outcome,
    p_stop_reason: entry.stopReason,
    p_input: entry.usage.input,
    p_output: entry.usage.output,
    p_cache_read: entry.usage.cacheRead,
    p_cache_write: entry.usage.cacheWrite,
    p_cost_micro_usd: entry.costMicroUsd,
    p_duration_ms: entry.durationMs
  });
  if (error) console.error('ai_usage_record failed', error.code ?? 'unknown');
}
