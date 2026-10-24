import { expect, it, vi } from 'vitest';
import {
  requireProcessUploadProducer,
  startOwnedProcessUpload,
  verifyOwnedProcessUploadResult
} from '../supabase/functions/drive-ops/process-output-upload.js';

function fixture() {
  const binding = {
    operationId: 'operation',
    teamId: 'team',
    connectionId: 'connection',
    rootId: 'root',
    parentId: 'parent',
    name: 'output.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 123,
    checksum: 'a'.repeat(32),
    fileId: 'durable-id',
    nonce: '36000000-0000-4000-8000-000000000139',
    state: 'prepared'
  };
  const order: string[] = [];
  const rpc = vi.fn(async (name: string) => {
    order.push(name);
    return name === 'service_prepare_process_upload' ? binding : true;
  });
  const client = {
    generateFileId: vi.fn(async () => {
      order.push('generate');
      return 'unused-candidate';
    }),
    startResumableUpload: vi.fn(async () => {
      order.push('provider-create');
      return { sessionUri: 'synthetic-session', expiresAt: '2026-10-23T00:00:00Z' };
    })
  };
  const input = {
    rpc,
    client,
    operationId: binding.operationId,
    teamId: binding.teamId,
    actorId: 'actor',
    connectionId: binding.connectionId,
    rootId: binding.rootId,
    parentId: binding.parentId,
    name: binding.name,
    mimeType: binding.mimeType,
    sizeBytes: binding.sizeBytes,
    checksum: binding.checksum
  };
  return { binding, order, rpc, client, run: () => startOwnedProcessUpload(input) };
}

it('commits durable identity and start before provider create, using the stored ID rather than a new candidate', async () => {
  const f = fixture();
  expect(await f.run()).toMatchObject({ providerFileId: 'durable-id' });
  expect(f.order).toEqual([
    'generate',
    'service_prepare_process_upload',
    'service_start_process_upload',
    'provider-create'
  ]);
  expect(f.client.startResumableUpload).toHaveBeenCalledWith(
    expect.objectContaining({
      newFileId: 'durable-id',
      appProperties: { 'soty.process.output': f.binding.nonce }
    })
  );
});
it('never opens a replacement session after a lost provider start reply', async () => {
  const f = fixture();
  f.binding.state = 'started';
  await expect(f.run()).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  expect(f.client.startResumableUpload).not.toHaveBeenCalled();
  expect(f.rpc).toHaveBeenCalledTimes(1);
});
it('does not write to the provider when prepare or start fails', async () => {
  for (const stage of ['service_prepare_process_upload', 'service_start_process_upload']) {
    const f = fixture();
    const original = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async name => {
      if (name === stage) throw Error('PERMISSION_DENIED');
      return original(name);
    });
    await expect(f.run()).rejects.toThrow('PERMISSION_DENIED');
    expect(f.client.startResumableUpload).not.toHaveBeenCalled();
  }
});
it.each(['checksum', 'parentId', 'connectionId', 'rootId', 'name', 'mimeType', 'nonce'] as const)(
  'refuses a malformed or changed %s binding before provider create',
  async key => {
    const f = fixture();
    f.binding[key] = 'changed';
    await expect(f.run()).rejects.toThrow('INVALID_RESPONSE');
    expect(f.client.startResumableUpload).not.toHaveBeenCalled();
  }
);
it.each([
  {},
  { outputUploadProtocolVersion: 1, checksum: 'a'.repeat(32) },
  { outputUploadProtocolVersion: 2 },
  { outputUploadProtocolVersion: 2, checksum: 'invalid' }
])('requires an upgraded producer with binary checksum: %j', body => {
  expect(() => requireProcessUploadProducer(body)).toThrow('AGENT_UPDATE_REQUIRED');
});
it('accepts the explicit producer protocol and checksum', () => {
  expect(
    requireProcessUploadProducer({ outputUploadProtocolVersion: 2, checksum: 'a'.repeat(32) })
  ).toBe('a'.repeat(32));
});
it('requires exact final provider identity, private nonce and content', () => {
  const f = fixture();
  f.binding.state = 'started';
  const result = {
    id: f.binding.fileId,
    name: f.binding.name,
    mimeType: f.binding.mimeType,
    size: f.binding.sizeBytes,
    checksum: f.binding.checksum,
    parents: [f.binding.parentId],
    trashed: false,
    appProperties: { 'soty.process.output': f.binding.nonce }
  };
  expect(() => verifyOwnedProcessUploadResult(f.binding, result, 'operation')).not.toThrow();
  for (const patch of [
    { id: 'original' },
    { checksum: 'b'.repeat(32) },
    { appProperties: {} },
    { parents: ['moved'] },
    { trashed: true }
  ]) {
    expect(() =>
      verifyOwnedProcessUploadResult(f.binding, { ...result, ...patch }, 'operation')
    ).toThrow('SOURCE_CHANGED');
  }
  expect(() => verifyOwnedProcessUploadResult(null, result, 'operation')).not.toThrow();
});
