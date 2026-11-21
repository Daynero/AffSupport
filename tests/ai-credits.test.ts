import { describe, expect, it, vi } from 'vitest';
import {
  callUpperUsd,
  CreditRefusal,
  creditRefusal,
  CreditsUnavailable,
  debitCredits,
  refundCredits,
  translationUpperUsd
} from '../supabase/functions/_shared/ai-credits';
import {
  callStructured,
  ClaudeTransportError,
  type ClaudeClient
} from '../supabase/functions/_shared/claude';
import { recordModelUsage } from '../supabase/functions/_shared/ai-allowance';

const input = {
  userId: '64000000-0000-4000-8000-000000000001',
  opKey: 'launch_assistant:op-00000001',
  feature: 'launch_assistant' as const,
  amount: 2,
  priceVersion: 'v1',
  subjectId: null,
  usdUpper: 0.0018
};

describe('064 credits in edge functions', () => {
  it('debits through the service function with the exact price and the held estimate', async () => {
    const rpc = vi.fn(async () => ({
      data: { replayed: false, credits: { available: 98 } },
      error: null
    }));
    await expect(debitCredits(rpc, input)).resolves.toEqual({
      replayed: false,
      credits: { available: 98 }
    });
    expect(rpc).toHaveBeenCalledWith('service_ai_credit_debit', {
      p_user: input.userId,
      p_op_key: input.opKey,
      p_feature: 'launch_assistant',
      p_amount: 2,
      p_price_version: 'v1',
      p_subject: null,
      p_usd_upper: 0.0018
    });
  });

  it('turns database refusals into typed refusals with their numbers', async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: {
        code: 'PT409',
        message: 'INSUFFICIENT_CREDITS',
        details: '{"needed":2,"available":1,"resetsAt":"2026-11-21T22:00:00Z"}'
      }
    }));
    const error = await debitCredits(rpc, input).catch(caught => caught);
    expect(error).toBeInstanceOf(CreditRefusal);
    expect(error).toMatchObject({
      code: 'INSUFFICIENT_CREDITS',
      details: { needed: 2, available: 1 }
    });
    expect(creditRefusal({ code: 'PT409', message: 'AI_MONTH_EXHAUSTED' })?.code).toBe(
      'AI_MONTH_EXHAUSTED'
    );
    expect(creditRefusal({ code: 'PT409', message: 'PERMISSION_DENIED' })).toBeNull();
  });

  it('treats an unreachable ledger as unavailable, never as paid', async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: { code: '08006', message: 'connection' }
    }));
    await expect(debitCredits(rpc, input)).rejects.toBeInstanceOf(CreditsUnavailable);
  });

  it('refunds without throwing when the ledger is down', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: '08006', message: 'down' } }));
    await expect(refundCredits(rpc, input.userId, input.opKey)).resolves.toBeNull();
  });

  it('estimates the worst call from the model price and holds translations generously', () => {
    expect(callUpperUsd('claude-haiku-5-5', 8_000, 2_048)).toBeCloseTo(0.001824, 9);
    expect(translationUpperUsd(3, 0.001)).toBeCloseTo(0.075, 9);
  });

  it('records a transport failure as unknown usage, not as a free call', async () => {
    const client: ClaudeClient = {
      create: async () => {
        throw new ClaudeTransportError(529);
      }
    };
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    await callStructured(
      client,
      {
        model: 'claude-haiku-5-5',
        effort: 'low',
        system: 's',
        user: 'u',
        schema: {},
        maxTokens: 10
      },
      {
        signal: new AbortController().signal,
        record: entry =>
          recordModelUsage(rpc, {
            feature: 'launch_assistant',
            userId: input.userId,
            subjectId: null,
            entry,
            opKey: input.opKey
          })
      }
    );
    expect(rpc).toHaveBeenCalledWith(
      'service_ai_usage_record_v2',
      expect.objectContaining({ p_op_key: input.opKey, p_usage_known: false, p_cost_micro_usd: 0 })
    );
  });
});
