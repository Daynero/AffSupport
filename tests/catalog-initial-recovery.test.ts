import { expect, it, vi } from 'vitest';
import { runInitialCatalogRecovery } from '../supabase/functions/drive-ops/catalog-initial-recovery';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
const teamId = '77000000-0000-4000-8000-000000000001',
  actorId = '77000000-0000-4000-8000-000000000002',
  key = 'product-catalog:77000000-0000-4000-8000-000000000003';
it('does no background admission when the beta protocol is disabled', async () => {
  const rpc = vi.fn(),
    executeFrozen = vi.fn();
  expect(await runInitialCatalogRecovery({ rpc }, { enabled: false, executeFrozen })).toEqual({
    enabled: false,
    completed: 0,
    pending: 0
  });
  expect(rpc).not.toHaveBeenCalled();
});
it('resumes only the canonical accepted body and original actor through the existing lease owner', async () => {
  const body = {
    teamId,
    idempotencyKey: key,
    catalogVideoProtocolVersion: 1,
    videoPublication: { mode: 'scheduled', dueAt: '2020-01-01T00:00:00Z' }
  };
  const rpc = vi.fn(async (name: string) => ({
    data:
      name === 'service_list_initial_catalog_recovery'
        ? [{ teamId, actorId, idempotencyKey: key }]
        : body,
    error: null
  }));
  const executeFrozen = vi.fn(async () => ({ outcome: 'created' }));
  expect(await runInitialCatalogRecovery({ rpc }, { enabled: true, executeFrozen })).toMatchObject({
    completed: 1,
    pending: 0
  });
  expect(executeFrozen).toHaveBeenCalledWith(body, actorId);
  expect(rpc).toHaveBeenLastCalledWith('service_read_initial_catalog_request', {
    p_team: teamId,
    p_actor: actorId,
    p_key: key
  });
});
it('keeps unknown completion pending and refuses an oversized recovery list', async () => {
  const rpc = vi.fn(async () => ({
      data: Array.from({ length: 4 }, () => ({ teamId, actorId, idempotencyKey: key })),
      error: null
    })),
    executeFrozen = vi.fn();
  await expect(
    runInitialCatalogRecovery({ rpc }, { enabled: true, executeFrozen })
  ).rejects.toMatchObject({ code: 'PROCESS_RESULT_UNCERTAIN' });
  expect(executeFrozen).not.toHaveBeenCalled();
});
it('names and paces a recovery failure instead of relisting the intent on every pass', async () => {
  // Beta 2026-11-11: an accepted body the parser refused failed before the paced
  // claim, the error was swallowed, and the intent was listed again every minute.
  const rpc = vi.fn(async (name: string) => ({
    data:
      name === 'service_list_initial_catalog_recovery'
        ? [{ teamId, actorId, idempotencyKey: key }]
        : name === 'service_read_initial_catalog_request'
          ? { teamId, idempotencyKey: key, catalogVideoProtocolVersion: 1 }
          : 'deferred',
    error: null
  }));
  const executeFrozen = vi.fn(async () => {
    throw new TeamFunctionError('INVALID_INPUT');
  });
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    expect(
      await runInitialCatalogRecovery({ rpc }, { enabled: true, executeFrozen })
    ).toMatchObject({ completed: 0, pending: 1 });
    expect(rpc).toHaveBeenLastCalledWith('service_defer_initial_catalog_recovery', {
      p_team: teamId,
      p_actor: actorId,
      p_key: key,
      p_code: 'INVALID_INPUT'
    });
    expect(logged).toHaveBeenCalledWith(
      '[catalog] initial recovery pass failed',
      key,
      'INVALID_INPUT',
      expect.any(Array)
    );
  } finally {
    logged.mockRestore();
  }
});
it('keeps the pass going when pacing the failure itself fails', async () => {
  const rpc = vi.fn(async (name: string) => {
    if (name === 'service_defer_initial_catalog_recovery') throw new Error('offline');
    return {
      data:
        name === 'service_list_initial_catalog_recovery'
          ? [{ teamId, actorId, idempotencyKey: key }]
          : { teamId, idempotencyKey: key, catalogVideoProtocolVersion: 1 },
      error: null
    };
  });
  const executeFrozen = vi.fn(async () => {
    throw new TeamFunctionError('SOURCE_CHANGED');
  });
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    expect(
      await runInitialCatalogRecovery({ rpc }, { enabled: true, executeFrozen })
    ).toMatchObject({ pending: 1 });
  } finally {
    logged.mockRestore();
  }
});
