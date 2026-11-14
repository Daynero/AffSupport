import { expect, it, vi } from 'vitest';
import { runTaskCleanupTick } from '../supabase/functions/drive-ops/task-cleanup';
import type { ServiceRpcClient } from '../supabase/functions/_shared/credentials';
import type { GoogleDriveClient } from '../supabase/functions/_shared/drive';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
const plan = {
  id: '37000000-0000-4000-8000-000000000001',
  operationId: '37000000-0000-4000-8000-000000000002',
  fileId: 'file',
  parentId: 'root',
  credentialId: 'credential',
  rootId: 'root'
};
function setup(moved = false, lostReply = false) {
  let trashed = false;
  let etag = '"original"';
  const rpc = vi.fn(async (name: string) => ({
    data:
      name === 'service_claim_task_cleanup'
        ? [plan]
        : name === 'service_authorize_task_cleanup'
          ? true
          : null,
    error: null
  }));
  const getFile = vi.fn(async (id: string) => ({
    id,
    name: 'fixture',
    mimeType: 'image/png',
    trashed: id === 'file' && trashed,
    parents: id === 'file' ? [moved ? 'other' : 'root'] : []
  }));
  const updateFileMetadata = vi.fn(async () => {
    trashed = true;
    if (lostReply) throw new Error('reply lost');
    return {};
  });
  const getProcessOutputRecoveryFile = vi.fn(async (id: string) => ({
    ...(await getFile(id)),
    etag,
    canTrash: true
  }));
  const trashProcessOutputConditionally = vi.fn(async (_id: string, expected: string) => {
    if (expected !== etag) throw new TeamFunctionError('SOURCE_CHANGED');
    await updateFileMetadata();
  });
  return {
    rpc,
    drive: {
      getFile,
      updateFileMetadata,
      getProcessOutputRecoveryFile,
      trashProcessOutputConditionally
    },
    service: { rpc } as ServiceRpcClient,
    move: () => {
      moved = true;
      etag = '"moved"';
    },
    isTrashed: () => trashed
  };
}

it('does not trash a file moved after the final authority check', async () => {
  const test = setup();
  const original = test.rpc.getMockImplementation()!;
  test.rpc.mockImplementation(async name => {
    const result = await original(name);
    if (name === 'service_authorize_task_cleanup') test.move();
    return result;
  });
  await runTaskCleanupTick(test.service, async () => test.drive as unknown as GoogleDriveClient);
  expect(test.isTrashed()).toBe(false);
  expect(test.drive.updateFileMetadata).not.toHaveBeenCalled();
  expect(test.rpc).toHaveBeenCalledWith('service_settle_task_cleanup', {
    p_id: plan.id,
    p_result: 'retained'
  });
});
it('confirms the exact provider postcondition after a lost mutation reply', async () => {
  const test = setup(false, true);
  expect(
    await runTaskCleanupTick(test.service, async () => test.drive as unknown as GoogleDriveClient)
  ).toEqual({ completed: 1, pending: 0 });
  expect(test.rpc).toHaveBeenCalledWith('service_settle_task_cleanup', {
    p_id: plan.id,
    p_result: 'trashed'
  });
});
it('retains a moved file and never substitutes another provider object', async () => {
  const test = setup(true);
  await runTaskCleanupTick(test.service, async () => test.drive as unknown as GoogleDriveClient);
  expect(test.drive.updateFileMetadata).not.toHaveBeenCalled();
  expect(test.rpc).toHaveBeenCalledWith('service_settle_task_cleanup', {
    p_id: plan.id,
    p_result: 'retained'
  });
});
it('preserves a stable provider permission reason while keeping uncertain work fenced', async () => {
  const { TeamFunctionError } = await import('../supabase/functions/_shared/errors');
  const test = setup();
  test.drive.getFile.mockRejectedValue(new TeamFunctionError('PERMISSION_DENIED'));
  expect(
    await runTaskCleanupTick(test.service, async () => test.drive as unknown as GoogleDriveClient)
  ).toEqual({ completed: 0, pending: 1 });
  expect(test.drive.updateFileMetadata).not.toHaveBeenCalled();
  expect(test.rpc).toHaveBeenCalledWith('service_settle_task_cleanup', {
    p_id: plan.id,
    p_result: 'permission_denied'
  });
});
