import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../scripts/analytics/db', () => ({ query: vi.fn() }));
import { query } from '../scripts/analytics/db';
import { getAssistantCommand, getAssistantSummary } from '../scripts/analytics/assistant';

/**
 * 064 FR-037: one command's trail from the read-only projections — stage, reason, model calls,
 * the credit debit/refund and the month hold — with findings, and nothing private selected.
 */
const mocked = vi.mocked(query);
const ID = '64700000-0000-4000-8000-000000000001';

function answer(sql: string): unknown[] {
  if (sql.includes('information_schema.views')) return [{ count: '3' }];
  if (sql.includes('analytics_assistant_commands') && sql.includes('where id')) {
    return [
      {
        id: ID,
        kind: 'message',
        status: 'rejected',
        reason_code: 'PLAN_TOO_LARGE',
        model: 'claude-haiku-5-5',
        price: 1,
        created_at: 'a',
        updated_at: 'b',
        effects: 0,
        undone_effects: 0,
        card_kinds: ['refusal'],
        launched_reviews: 0
      }
    ];
  }
  if (sql.includes('analytics_ai_usage_events'))
    return [
      { outcome: 'failed', input_tokens: 0, output_tokens: 0, cost_micro_usd: 0, created_at: 'c' }
    ];
  if (sql.includes('analytics_ai_credit_ledger'))
    return [{ kind: 'debit', amount: 1, kyiv_day: '2026-11-21', created_at: 'd' }];
  if (sql.includes('analytics_ai_month_holds'))
    return [{ usd_upper: 0.0018, usd_actual: 0, state: 'settled' }];
  return [];
}

beforeEach(() => {
  mocked.mockReset();
  mocked.mockImplementation(async (sql: string) => answer(sql) as never);
});

describe('064 assistant diagnostics', () => {
  it('explains one command: stage, reason, model calls, credits and hold', async () => {
    const trail = await getAssistantCommand(ID);
    expect(trail.last_proven_stage).toBe('rejected');
    expect(trail.command?.reason_code).toBe('PLAN_TOO_LARGE');
    expect(trail.credits).toEqual([
      { kind: 'debit', amount: 1, kyiv_day: '2026-11-21', created_at: 'd' }
    ]);
    expect(trail.findings.join(' ')).toContain('not refunded');
    expect(trail.findings.join(' ')).toContain('unknown, not zero');
  });

  it('never selects message text, plans, cards or links', async () => {
    await getAssistantCommand(ID);
    await getAssistantSummary({
      start: '2026-11-14T00:00:00Z',
      end: '2026-11-21T00:00:00Z'
    } as never);
    const sql = mocked.mock.calls.map(call => String(call[0])).join('\n');
    // `::text` is a cast, not a column; no column named text, plan or payload is read.
    expect(sql.replace(/::text/gu, '')).not.toMatch(
      /\btext\b|\bplan\b|payload|url_slots|assistant_messages/u
    );
  });

  it('says plainly when the command is unknown', async () => {
    mocked.mockImplementation(
      async (sql: string) => (sql.includes('information_schema') ? [{ count: '3' }] : []) as never
    );
    const trail = await getAssistantCommand(ID);
    expect(trail.command).toBeNull();
    expect(trail.findings[0]).toMatch(/^insufficient/u);
  });
});
