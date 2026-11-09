import { expect, it, vi } from 'vitest';
import { runInitialCatalogRecovery } from '../supabase/functions/drive-ops/catalog-initial-recovery';
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
