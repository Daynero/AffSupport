import { describe, expect, it } from 'vitest';
import policy from '../config/release-automation-policy.json';
import {
  reserveAttempt,
  recordUsage,
  budgetReason
} from '../scripts/lib/release/repair-budget.mjs';
describe('repair budgets survive candidates', () => {
  it('caps causes independently of SHA and keeps unknown usage unknown', () => {
    let budget = { attempts: [], totalTokens: null };
    for (let i = 0; i < 3; i++)
      budget = reserveAttempt(budget, 'candidate_gate:GATE_FAILED', policy, `execution-${i}`, 0);
    expect(budgetReason(budget, 'candidate_gate:GATE_FAILED', policy)).toBe(
      'REPAIR_CAUSE_BUDGET_EXHAUSTED'
    );
    expect(budget.totalTokens).toBeNull();
  });
  it('deduplicates cumulative usage and reports in-flight overshoot', () => {
    let budget = reserveAttempt({ attempts: [], totalTokens: null }, 'build:FAIL', policy, 'a', 0);
    budget = recordUsage(budget, 'a', { totalTokens: 100 }, 1);
    budget = recordUsage(budget, 'a', { totalTokens: 100 }, 2);
    expect(budget.totalTokens).toBe(100);
    budget = recordUsage(budget, 'a', { totalTokens: 80001 }, 3);
    expect(budget.attempts[0].overshootTokens).toBe(1);
    expect(budgetReason(budget, 'build:FAIL', policy)).toBe('REPAIR_TOKEN_BUDGET_EXHAUSTED');
  });
});
