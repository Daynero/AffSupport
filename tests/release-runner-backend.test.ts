import { describe, expect, it } from 'vitest';
import { resolveBackendPlan } from '../scripts/lib/release/backend-plan.mjs';
import { preflight } from '../scripts/lib/release/preflight.mjs';
import { sandboxIntent } from './support/release-runner/fixtures';
import { preparedReceipt, reconcileReceipt } from '../scripts/lib/release/migration-evidence.mjs';
import { rehearseBackendBeta } from '../scripts/lib/release/adapters/backend-beta.mjs';
import { applyBackendPlan } from '../scripts/lib/release/adapters/backend.mjs';

describe('tracked backend plan', () => {
  it('allows only compatible tracked changes for the exact target', () => {
    expect(resolveBackendPlan(null, 'sandbox-local')).toEqual({ changes: [] });
    expect(() =>
      resolveBackendPlan(
        {
          changes: [
            {
              id: 'x',
              kind: 'migration',
              targetId: 'production',
              digest: 'a'.repeat(64),
              compatibleWithPrevious: true,
              position: 'before-readiness'
            }
          ]
        },
        'sandbox-local'
      )
    ).toThrow('BACKEND_PLAN_INVALID');
  });
  it('blocks unknown or partial migration provenance instead of guessing rollback', () => {
    const receipt = preparedReceipt({
      targetId: 'sandbox-local',
      version: '001',
      digest: 'a'.repeat(64),
      sourceSha: 'b'.repeat(40),
      transaction: 'nontransactional'
    });
    expect(
      reconcileReceipt(receipt, { targetId: 'sandbox-local', historyPresent: false })
    ).toMatchObject({ code: 'MIGRATION_EFFECT_AMBIGUOUS' });
    expect(reconcileReceipt(null, {})).toMatchObject({ code: 'MIGRATION_PROVENANCE_UNKNOWN' });
  });
  it('rehearses only sandbox backend changes under a lease', async () => {
    await expect(
      rehearseBackendBeta({
        binding: { kind: 'production', bindingId: 'production' },
        plan: { changes: [] },
        lease: { leaseId: 'x' },
        adapter: {}
      })
    ).rejects.toThrow('TARGET_MISMATCH');
    await expect(
      rehearseBackendBeta({
        binding: { kind: 'sandbox', bindingId: 'sandbox-local' },
        plan: { changes: [{ id: 'one', targetId: 'sandbox-local' }] },
        lease: { leaseId: 'x' },
        adapter: { verify: async () => ({ ok: true }) }
      })
    ).resolves.toEqual({ ok: true, changes: 1 });
  });
  it('plans zero backend effects when no plan was declared', async () => {
    const result = await preflight(sandboxIntent, {
      bindings: {
        'sandbox-local': {
          kind: 'sandbox',
          bindingId: 'sandbox-local',
          repository: 'x/y',
          releaseRepository: 'x/z',
          siteOrigin: 'https://sandbox.example',
          cloudflareProject: 'sandbox',
          supabaseProject: 'sandbox',
          signingKeyFingerprint: 'sandbox-key',
          artifactUrlBase: 'https://artifacts.example'
        }
      },
      probe: { inspect: async () => ({ ok: true }) },
      bridge: { inspect: async () => ({ ok: true }) }
    });
    expect(result.backendPlan.changes).toEqual([]);
  });
});

describe('applying a declared backend plan', () => {
  const binding = { kind: 'sandbox', bindingId: 'sandbox-local' };
  const change = {
    id: '001_add_column',
    kind: 'migration',
    targetId: 'sandbox-local',
    digest: 'a'.repeat(64),
    compatibleWithPrevious: true,
    position: 'before-readiness',
    transaction: 'transactional'
  };
  const plan = { changes: [change] };

  function backend(overrides: Record<string, unknown> = {}) {
    return {
      pendingMigrations: async () => ['001_add_column'],
      digestOf: async () => change.digest,
      backwardsCompatible: async () => true,
      apply: async () => ({ ok: true, transaction: 'transactional' }),
      observe: async () => ({
        historyPresent: true,
        postconditionsPass: true,
        targetId: 'sandbox-local'
      }),
      ...overrides
    };
  }

  it('writes the prepared receipt before the migration, never after', async () => {
    const order: string[] = [];
    const result = await applyBackendPlan({
      binding,
      plan,
      sourceSha: 'b'.repeat(40),
      adapter: backend({
        apply: async () => {
          order.push('apply');
          return { ok: true, transaction: 'transactional' };
        }
      }),
      journal: {
        flush: async receipt => {
          order.push(`flush:${receipt.state}`);
        }
      }
    });
    expect(order).toEqual(['flush:prepared', 'apply']);
    expect(result).toMatchObject({ ok: true, writes: 1 });
  });

  it('refuses an extra pending migration that this release never declared', async () => {
    await expect(
      applyBackendPlan({
        binding,
        plan,
        sourceSha: 'b'.repeat(40),
        adapter: backend({
          pendingMigrations: async () => ['001_add_column', '002_from_another_branch']
        }),
        journal: { flush: async () => {} }
      })
    ).rejects.toMatchObject({ code: 'BACKEND_PENDING_SET_MISMATCH' });
  });

  it('refuses content that no longer matches the digest that was reviewed', async () => {
    await expect(
      applyBackendPlan({
        binding,
        plan,
        sourceSha: 'b'.repeat(40),
        adapter: backend({ digestOf: async () => 'c'.repeat(64) }),
        journal: { flush: async () => {} }
      })
    ).rejects.toMatchObject({ code: 'BACKEND_CONTENT_MISMATCH' });
  });

  it('refuses a change the currently released client could not survive', async () => {
    let flushed = 0;
    await expect(
      applyBackendPlan({
        binding,
        plan,
        sourceSha: 'b'.repeat(40),
        adapter: backend({ backwardsCompatible: async () => false }),
        journal: {
          flush: async () => {
            flushed += 1;
          }
        }
      })
    ).rejects.toMatchObject({ code: 'BACKEND_INCOMPATIBLE' });
    // Refused before anything was prepared, so there is nothing to reconcile.
    expect(flushed).toBe(0);
  });

  it('blocks a partial nontransactional result instead of inventing a rollback', async () => {
    await expect(
      applyBackendPlan({
        binding,
        plan: { changes: [{ ...change, transaction: 'nontransactional' }] },
        sourceSha: 'b'.repeat(40),
        adapter: backend({
          apply: async () => ({ ok: false, partial: true, transaction: 'nontransactional' }),
          observe: async () => ({
            historyPresent: false,
            postconditionsPass: false,
            targetId: 'sandbox-local'
          })
        }),
        journal: { flush: async () => {} }
      })
    ).rejects.toMatchObject({ code: 'MIGRATION_EFFECT_AMBIGUOUS' });
  });

  it('writes nothing at all when no plan was declared', async () => {
    let touched = 0;
    const result = await applyBackendPlan({
      binding,
      plan: { changes: [] },
      sourceSha: 'b'.repeat(40),
      adapter: backend({
        pendingMigrations: async () => {
          touched += 1;
          return [];
        }
      }),
      journal: { flush: async () => {} }
    });
    expect(result).toEqual({ ok: true, applied: [], writes: 0 });
    expect(touched).toBe(0);
  });

  it('refuses a change aimed at a different target than the validated binding', async () => {
    await expect(
      applyBackendPlan({
        binding,
        plan: { changes: [{ ...change, targetId: 'production' }] },
        sourceSha: 'b'.repeat(40),
        adapter: backend(),
        journal: { flush: async () => {} }
      })
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' });
  });
});
