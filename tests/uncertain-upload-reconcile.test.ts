import { expect, it, vi } from 'vitest';
import { reconcileUncertainProcessUploads } from '../supabase/functions/drive-ops/uncertain-upload-reconcile.js';
import type { DriveFileMetadata } from '../supabase/functions/_shared/drive.js';
import { TeamFunctionError } from '../supabase/functions/_shared/errors.js';
import { deliverQuiescence } from '../apps/agent/src/team-bridge/process';

/**
 * Beta 2026-11-11 with the failure moved into the upload: the gateway went away
 * while the variant's output was being uploaded, so the agent cannot know
 * whether the file landed. The server looks the generated Drive id up and
 * settles the variant in minutes instead of the 12-hour rule.
 */
const plan = {
  operationId: 'c3470000-0000-4000-8000-000000000010',
  actorId: 'c3470000-0000-4000-8000-000000000001',
  teamId: 'c3470000-0000-4000-8000-000000000011',
  credentialId: 'credential',
  connectionId: 'connection',
  rootId: 'root',
  parentId: 'catalog-folder',
  fileId: 'generated-id',
  nonce: 'private-nonce',
  name: 'TR 7_v1.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 1234,
  checksum: 'c'.repeat(32),
  state: 'started',
  fence: '3',
  setId: 'set',
  variantIndex: 0,
  attempt: 1
};
const folder: DriveFileMetadata = {
  id: 'catalog-folder',
  name: 'Catalog',
  mimeType: 'application/vnd.google-apps.folder',
  parents: ['root'],
  trashed: false,
  driveId: null,
  resourceKey: null,
  shortcutTargetId: null,
  shortcutTargetResourceKey: null,
  capabilities: {} as DriveFileMetadata['capabilities'],
  size: null,
  modifiedAt: null,
  version: '1',
  checksum: null,
  appProperties: {}
};
const output = (): DriveFileMetadata => ({
  ...folder,
  id: 'generated-id',
  name: 'TR 7_v1.mp4',
  mimeType: 'video/mp4',
  parents: ['catalog-folder'],
  size: 1234,
  checksum: 'c'.repeat(32),
  version: '2',
  modifiedAt: '2026-11-11T14:08:30.000Z',
  appProperties: { 'soty.process.output': 'private-nonce' }
});
function fixture(drive: {
  probe?: () => Promise<'present' | 'absent'>;
  file?: () => Promise<DriveFileMetadata>;
  folder?: () => Promise<DriveFileMetadata>;
}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const service = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push([name, args]);
      if (name === 'service_claim_uncertain_process_uploads') return { data: [plan], error: null };
      if (name === 'service_settle_uncertain_process_upload')
        return {
          data:
            args.p_result === 'registered'
              ? 'registered'
              : args.p_result === 'absent'
                ? 'not_created'
                : args.p_result === 'mismatch'
                  ? 'attention'
                  : 'waiting',
          error: null
        };
      if (name === 'service_finalize_uploaded_material')
        return { data: { materialId: 'material', state: 'succeeded' }, error: null };
      if (name === 'service_record_restitch_output') return { data: 'recorded', error: null };
      throw Error('UNEXPECTED_RPC ' + name);
    })
  };
  const client = {
    getFile: vi.fn(async (id: string) =>
      id === 'catalog-folder' ? (drive.folder ?? (async () => folder))() : (drive.file ?? output)()
    ),
    probeProcessOutput: vi.fn(drive.probe ?? (async () => 'present' as const)),
    listAnyonePermissions: vi.fn(async () => []),
    createAnyoneReaderPermission: vi.fn(async () => undefined)
  };
  const run = () =>
    reconcileUncertainProcessUploads(service as never, async () => client as never, {
      owner: 'reconciler',
      operationId: plan.operationId
    });
  const settled = () =>
    calls.filter(([name]) => name === 'service_settle_uncertain_process_upload');
  return { run, calls, settled, client };
}

it('registers a landed upload that matches the bound output exactly', async () => {
  const f = fixture({});
  expect(await f.run()).toEqual(['registered']);
  const finalize = f.calls.find(([name]) => name === 'service_finalize_uploaded_material')!;
  expect(finalize[1]).toMatchObject({
    p_operation: plan.operationId,
    p_actor: plan.actorId,
    p_drive: { driveFileId: 'generated-id', sizeBytes: 1234, checksum: 'c'.repeat(32) }
  });
  // Shared and recorded as the agent's finalize does.
  expect(f.calls.map(([name]) => name)).toContain('service_record_restitch_output');
  expect(f.settled()[0]![1]).toMatchObject({ p_result: 'registered', p_fence: '3' });
});

it('proves absence only while the destination is visible', async () => {
  const f = fixture({ probe: async () => 'absent' });
  expect(await f.run()).toEqual(['not_created']);
  expect(f.client.getFile).toHaveBeenCalledWith('catalog-folder', undefined);
  expect(f.calls.map(([name]) => name)).not.toContain('service_finalize_uploaded_material');
});

it('never takes a 404 as absence when the destination itself cannot be seen', async () => {
  const f = fixture({
    probe: async () => 'absent',
    folder: async () => {
      throw new TeamFunctionError('PERMISSION_DENIED');
    }
  });
  expect(await f.run()).toEqual(['waiting']);
  expect(f.settled()[0]![1]).toMatchObject({ p_result: 'unknown', p_code: 'PERMISSION_DENIED' });
  expect(f.client.probeProcessOutput).not.toHaveBeenCalled();
});

it.each([
  ['a different checksum', { checksum: 'd'.repeat(32) }],
  ['a different size', { size: 99 }],
  ['another nonce', { appProperties: { 'soty.process.output': 'someone-else' } }],
  ['a trashed file', { trashed: true }]
])('leaves %s in place as a mismatch', async (_label, change) => {
  const f = fixture({ file: async () => ({ ...output(), ...change }) });
  expect(await f.run()).toEqual(['attention']);
  expect(f.settled()[0]![1]).toMatchObject({ p_result: 'mismatch', p_code: 'SOURCE_CHANGED' });
  expect(f.calls.map(([name]) => name)).not.toContain('service_finalize_uploaded_material');
});

it('asks again later while Drive has not finished the file', async () => {
  const f = fixture({ file: async () => ({ ...output(), size: null, checksum: null }) });
  expect(await f.run()).toEqual(['waiting']);
  expect(f.settled()[0]![1]).toMatchObject({ p_result: 'unknown' });
});

it('asks again later when Drive is unavailable', async () => {
  const f = fixture({
    probe: async () => {
      throw new TeamFunctionError('DRIVE_UNAVAILABLE');
    }
  });
  expect(await f.run()).toEqual(['waiting']);
  expect(f.settled()[0]![1]).toMatchObject({ p_result: 'unknown', p_code: 'DRIVE_UNAVAILABLE' });
});

it('the agent redelivers its quiescence until the gateway is back, which starts the reconcile', async () => {
  // e1741a2a with the failure moved into the upload: the gateway is down for the
  // first three deliveries, then the server takes the ack and reconciles.
  let attempts = 0;
  const reconciles: string[] = [];
  const f = fixture({ probe: async () => 'absent' });
  const send = async () => {
    attempts += 1;
    if (attempts <= 3) throw new Error('PROCESS_RESULT_UNCERTAIN');
    reconciles.push(...(await f.run()));
  };
  expect(await deliverQuiescence(send, [1, 1, 1, 1])).toBe(true);
  expect(attempts).toBe(4);
  expect(reconciles).toEqual(['not_created']);
});

it('the agent stops redelivering on a refusal and leaves the rest to silence', async () => {
  const send = vi.fn(async () => {
    throw new Error('WRONG_STATE');
  });
  expect(await deliverQuiescence(send, [1, 1, 1])).toBe(false);
  expect(send).toHaveBeenCalledOnce();
});
