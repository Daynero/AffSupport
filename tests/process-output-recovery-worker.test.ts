import { expect, it, vi } from 'vitest';
import { runProcessOutputCleanupTick } from '../supabase/functions/drive-ops/process-output-recovery.js';
import type { ProcessOutputRecoveryFile } from '../supabase/functions/_shared/drive.js';
import { TeamFunctionError } from '../supabase/functions/_shared/errors.js';

function fixture() {
  const plan = {
    operationId: 'operation',
    credentialId: 'credential',
    fileId: 'new-file',
    parentId: 'root',
    rootId: 'root',
    nonce: 'private-nonce',
    name: 'output.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 123,
    checksum: 'a'.repeat(32),
    fence: '1',
    state: 'started'
  };
  const file: ProcessOutputRecoveryFile = {
    id: 'new-file',
    parents: ['root'],
    name: 'output.mp4',
    mimeType: 'video/mp4',
    size: 123,
    checksum: 'a'.repeat(32),
    etag: '"revision-1"',
    trashed: false,
    ownedByMe: true,
    canTrash: true,
    driveId: null,
    appProperties: { 'soty.process.output': 'private-nonce' }
  };
  const rpc = vi.fn(
    async (
      name: string,
      args: Record<string, unknown>
    ): Promise<{ data: unknown; error: null }> => {
      if (name === 'service_claim_process_output_cleanup') return { data: [plan], error: null };
      if (
        name === 'service_authorize_process_output_cleanup' ||
        name === 'service_begin_process_output_trash'
      )
        return { data: true, error: null };
      if (name === 'service_settle_process_output_cleanup')
        return { data: args.p_result === 'trashed' ? 'trashed' : 'waiting', error: null };
      throw Error('UNEXPECTED_RPC');
    }
  );
  const read = vi.fn(async (_fileId: string, _signal: AbortSignal) => structuredClone(file));
  const trash = vi.fn(async () => {
    file.trashed = true;
  });
  const driveFor = vi.fn(async () => ({
    getProcessOutputRecoveryFile: read,
    trashProcessOutputConditionally: trash
  }));
  const run = (budgetMs = 1000) =>
    runProcessOutputCleanupTick({ rpc }, driveFor, { owner: 'worker', budgetMs });
  return { plan, file, rpc, read, trash, driveFor, run };
}

it('uses both lease authorizations, exact conditional mutation and positive readback', async () => {
  const f = fixture();
  expect(await f.run()).toEqual({ completed: 1, pending: 0, retained: 0 });
  expect(
    f.rpc.mock.calls.filter(([name]) => name === 'service_authorize_process_output_cleanup')
  ).toHaveLength(2);
  expect(f.trash).toHaveBeenCalledWith('new-file', '"revision-1"', expect.any(AbortSignal));
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(f.rpc).toHaveBeenLastCalledWith('service_settle_process_output_cleanup', {
    p_operation: 'operation',
    p_owner: 'worker',
    p_fence: '1',
    p_result: 'trashed',
    p_code: null
  });
});

it('reconciles a lost trash reply by positive readback of the same identity', async () => {
  const f = fixture();
  f.trash.mockImplementation(async () => {
    f.file.trashed = true;
    throw new TeamFunctionError('DRIVE_UNAVAILABLE');
  });
  expect(await f.run()).toMatchObject({ completed: 1 });
  expect(f.trash).toHaveBeenCalledOnce();
});

it('recovers a previous worker trash without a second mutation', async () => {
  const f = fixture();
  f.file.trashed = true;
  expect(await f.run()).toMatchObject({ completed: 1 });
  expect(f.trash).not.toHaveBeenCalled();
});

it.each(['name', 'checksum', 'id', 'mimeType'] as const)(
  'preserves an output with changed %s',
  async key => {
    const f = fixture();
    f.file[key] = 'changed';
    expect(await f.run()).toEqual({ completed: 0, pending: 0, retained: 1 });
    expect(f.trash).not.toHaveBeenCalled();
  }
);

it.each(['moved', 'nonce', 'ownership'])('preserves missing %s proof', async kind => {
  const f = fixture();
  if (kind === 'moved') f.file.parents = ['elsewhere'];
  if (kind === 'nonce') f.file.appProperties = {};
  if (kind === 'ownership') f.file.ownedByMe = false;
  expect(await f.run()).toMatchObject({ retained: 1, completed: 0 });
  expect(f.trash).not.toHaveBeenCalled();
});

it.each(['size', 'checksum'] as const)('keeps unfinished %s pending', async key => {
  const f = fixture();
  f.file[key] = null;
  expect(await f.run()).toEqual({ completed: 0, pending: 1, retained: 0 });
  expect(f.trash).not.toHaveBeenCalled();
});

it('does not turn provider 404/permission refusal into absence or success', async () => {
  const f = fixture();
  f.read.mockRejectedValue(new TeamFunctionError('PERMISSION_DENIED'));
  expect(await f.run()).toMatchObject({ pending: 1, completed: 0 });
  expect(f.trash).not.toHaveBeenCalled();
});

it('preserves a result after a late provider ETag rejection without fallback', async () => {
  const f = fixture();
  f.trash.mockRejectedValue(new TeamFunctionError('SOURCE_CHANGED'));
  expect(await f.run()).toMatchObject({ retained: 1, completed: 0 });
  expect(f.trash).toHaveBeenCalledOnce();
  expect(f.read).toHaveBeenCalledOnce();
});

it('does not mutate a published/adopted result or a stale lease', async () => {
  const f = fixture();
  const original = f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async (name, args) =>
    name === 'service_authorize_process_output_cleanup'
      ? { data: false, error: null }
      : original(name, args)
  );
  expect(await f.run()).toMatchObject({ retained: 1, completed: 0 });
  expect(f.driveFor).not.toHaveBeenCalled();
});

it('does not count an acknowledgement without trashed readback as cleanup', async () => {
  const f = fixture();
  f.trash.mockImplementation(async () => {});
  expect(await f.run()).toMatchObject({ pending: 1, completed: 0 });
});

it('does not report completion when settlement loses its lease', async () => {
  const f = fixture();
  const original = f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async (name, args) => {
    if (name === 'service_settle_process_output_cleanup')
      throw new TeamFunctionError('WRONG_STATE');
    return original(name, args);
  });
  expect(await f.run()).toMatchObject({ pending: 1, completed: 0 });
});

it('bounds an unresponsive credential dependency without provider mutation', async () => {
  const f = fixture();
  f.driveFor.mockImplementation(() => new Promise(() => {}));
  expect(await f.run(10)).toEqual({ completed: 0, pending: 1, retained: 0 });
  expect(f.trash).not.toHaveBeenCalled();
  expect(
    f.rpc.mock.calls.filter(([name]) => name === 'service_settle_process_output_cleanup')
  ).toHaveLength(0);
});

it('refuses a parent moved beyond the connected root', async () => {
  const f = fixture();
  f.plan.parentId = 'folder';
  f.file.parents = ['folder'];
  f.read.mockImplementation(async () => ({
    ...f.file,
    id: 'folder',
    mimeType: 'application/vnd.google-apps.folder',
    parents: []
  }));
  // Initial output proof passes; only the subsequent parent topology is invalid.
  f.read.mockImplementationOnce(async () => structuredClone(f.file));
  expect(await f.run()).toMatchObject({ retained: 1, completed: 0 });
  expect(f.trash).not.toHaveBeenCalled();
});

it('rechecks authorization after metadata reads before provider mutation', async () => {
  const f = fixture();
  const original = f.rpc.getMockImplementation()!;
  let checks = 0;
  f.rpc.mockImplementation(async (name, args) =>
    name === 'service_authorize_process_output_cleanup'
      ? { data: ++checks === 1, error: null }
      : original(name, args)
  );
  expect(await f.run()).toMatchObject({ retained: 1, completed: 0 });
  expect(checks).toBe(2);
  expect(f.trash).not.toHaveBeenCalled();
});

it('proves the captured nested parent chain within the same deadline', async () => {
  const f = fixture();
  f.plan.parentId = 'folder';
  f.file.parents = ['folder'];
  f.read.mockImplementation(async (id?: string) =>
    id === 'folder'
      ? {
          ...f.file,
          id: 'folder',
          mimeType: 'application/vnd.google-apps.folder',
          parents: ['root']
        }
      : structuredClone(f.file)
  );
  expect(await f.run()).toMatchObject({ completed: 1 });
  expect(f.read.mock.calls.some(call => call[0] === 'folder')).toBe(true);
});

it('does not mutate when the durable adoption reservation is refused', async () => {
  const f = fixture();
  const original = f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async (name, args) =>
    name === 'service_begin_process_output_trash'
      ? { data: false, error: null }
      : original(name, args)
  );
  expect(await f.run()).toMatchObject({ retained: 1, completed: 0 });
  expect(f.trash).not.toHaveBeenCalled();
});
