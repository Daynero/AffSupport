import { describe, it, expect } from 'vitest';
import { validateRepairPaths } from '../scripts/lib/release/repair-source.mjs';
import { budgetReason, reserveAttempt } from '../scripts/lib/release/repair-budget.mjs';
import policy from '../config/release-automation-policy.json';
import { createRepairExecutor } from '../scripts/lib/release/repair-dispatch.mjs';
describe('independent repair fences', () => {
  it('refuses source edits after a publication-affecting step before launching any provider', async () => {
    const execute = createRepairExecutor({
      root: '/private/tmp/not-used',
      repositoryRoot: '/private/tmp/not-used',
      executable: '/private/tmp/not-used',
      capabilityPath: '/private/tmp/not-used',
      policy,
      bindingsPath: '/private/tmp/not-used',
      runner: {}
    });
    for (const stepId of ['publish', 'manifest', 'backend_apply', 'deploy']) {
      await expect(
        execute(
          { budget: { attempts: [] } },
          { events: [{ type: 'step_started', payload: { stepId } }] },
          { update: async () => {} }
        )
      ).rejects.toThrow('PUBLISHED_INPUT_REPAIR_REQUIRES_OWNER');
    }
  });
  it('permits product source, never verification/governance/credentials/version files', () => {
    expect(
      validateRepairPaths(['apps/web/src/component.tsx', 'packages/shared/src/example.ts'])
    ).toHaveLength(2);
    for (const file of [
      '../outside',
      '/etc/passwd',
      '.github/workflows/verify.yml',
      'scripts/verify-all.mjs',
      'tests/test.ts',
      'config/release-automation-policy.json',
      'AGENTS.md',
      'apps/web/package.json',
      'apps/web/.env',
      'apps/web/.git/config',
      'apps/web/src/private.key'
    ]) {
      expect(() => validateRepairPaths([file])).toThrow('REPAIR_PATH_SCOPE_DENIED');
    }
  });
  it('caps task attempts across causes and preserves unknown terminal usage', () => {
    let budget = { attempts: [] as any[], totalTokens: null };
    for (let index = 0; index < 6; index++)
      budget = reserveAttempt(budget, `cause-${index}`, policy, `execution-${index}`, 0);
    expect(budgetReason(budget, 'next', policy, 1)).toBe('REPAIR_TASK_BUDGET_EXHAUSTED');
    expect(
      budgetReason(
        { attempts: [{ finished: true, usage: null, activeMs: 1 }], totalTokens: null },
        'next',
        policy,
        1
      )
    ).toBe('REPAIR_USAGE_UNKNOWN');
  });
});
