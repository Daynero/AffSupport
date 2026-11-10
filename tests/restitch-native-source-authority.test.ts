import {
  nativeRestitchBetaIsolated,
  targetedCatalogWriterEnabled,
  nativeRestitchEnabled
} from '../supabase/functions/_shared/restitch-native';
import { expect, it, vi } from 'vitest';
import type { ServiceRpcClient } from '../supabase/functions/_shared/credentials';
import { authorizeNativeRestitchSource } from '../supabase/functions/drive-transfer/restitch-source-authority';
const id = (n: number) => 'b1840000-0000-4000-8000-' + String(n).padStart(12, '0');
const owner = {
  controlGrantId: id(1),
  rootOperationId: id(2),
  teamId: id(3),
  actorId: id(4),
  poolNamespaceId: id(5),
  executorId: id(6),
  epoch: 1,
  nativeInstanceId: id(7),
  source: { materialId: id(8), checksum: 'a'.repeat(32), sizeBytes: 4, mimeType: 'video/mp4' }
};
const grant = {
  teamId: owner.teamId,
  actorId: owner.actorId,
  materialId: owner.source.materialId,
  purpose: 'download_range' as const,
  maxRangeBytes: 2097152,
  toolId: null
};
const live = {
  fileId: 'fixture',
  sizeBytes: 4,
  mimeType: 'video/mp4',
  sourceChecksum: 'a'.repeat(32)
};
function request(signal?: AbortSignal) {
  return new Request('https://project.invalid/functions/v1/drive-transfer/restitch/source-range', {
    signal,
    headers: {
      range: 'bytes=0-3',
      'x-restitch-control-grant': id(1),
      'x-restitch-control-ticket': 'c'.repeat(43),
      'x-restitch-source-purpose': 'restitch_source_range_v1'
    }
  });
}
function setup() {
  const rpc = vi
    .fn<ServiceRpcClient['rpc']>()
    .mockImplementation(async name =>
      name === 'service_read_restitch_control_selection'
        ? { data: owner, error: null }
        : { data: { ...owner, grantId: id(1) }, error: null }
    );
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
  return { rpc, fetcher };
}
it('requires both the enrolled scope and a consumed download grant for the original source before provider I/O', async () => {
  const f = setup(),
    authority = await authorizeNativeRestitchSource(request(), { rpc: f.rpc }, f.fetcher);
  await authority.bindGrant(grant);
  authority.assertSource(live);
  await authority.fetch('https://oauth.invalid/token');
  await authority.fetch('https://www.googleapis.com/drive/v3/files/fixture');
  expect(f.rpc.mock.calls.map(c => c[0])).toEqual([
    'service_read_restitch_control_selection',
    'service_authorize_restitch_native_control',
    'service_authorize_restitch_native_control'
  ]);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(f.rpc.mock.calls)).not.toContain('c'.repeat(43));
});
it.each([
  { materialId: id(88) },
  { actorId: id(88) },
  { teamId: id(88) },
  { purpose: 'preview_range' as const }
])('refuses a source grant outside the frozen root: %j', async override => {
  const f = setup(),
    authority = await authorizeNativeRestitchSource(request(), { rpc: f.rpc }, f.fetcher);
  await expect(authority.bindGrant({ ...grant, ...override })).rejects.toMatchObject({
    code: 'PERMISSION_DENIED'
  });
  expect(f.fetcher).not.toHaveBeenCalled();
});
it('does not fetch after logout wins the next authority check', async () => {
  const f = setup(),
    authority = await authorizeNativeRestitchSource(request(), { rpc: f.rpc }, f.fetcher);
  await authority.bindGrant(grant);
  f.rpc.mockResolvedValueOnce({
    data: null,
    error: { message: 'AUTH_REQUIRED PRIVATE_PROVIDER_PAYLOAD' }
  });
  await expect(
    authority.fetch('https://www.googleapis.com/drive/v3/files/fixture')
  ).rejects.toMatchObject({ code: 'AUTH_REQUIRED', message: 'AUTH_REQUIRED' });
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each([{ sourceChecksum: 'b'.repeat(32) }, { sizeBytes: 5 }, { mimeType: 'video/webm' }])(
  'refuses live source identity drift before its bytes are requested: %j',
  async override => {
    const f = setup(),
      authority = await authorizeNativeRestitchSource(request(), { rpc: f.rpc }, f.fetcher);
    await authority.bindGrant(grant);
    expect(() => authority.assertSource({ ...live, ...override })).toThrow('SOURCE_CHANGED');
    expect(f.fetcher).not.toHaveBeenCalled();
  }
);
it('does not dispatch after cancellation during current-authority verification', async () => {
  const f = setup(),
    controller = new AbortController(),
    authority = await authorizeNativeRestitchSource(
      request(controller.signal),
      { rpc: f.rpc },
      f.fetcher
    );
  await authority.bindGrant(grant);
  f.rpc.mockImplementationOnce(async () => {
    controller.abort();
    return { data: { ...owner, grantId: id(1) }, error: null };
  });
  await expect(authority.fetch('https://oauth.invalid/token')).rejects.toMatchObject({
    code: 'PROCESS_CANCELED'
  });
  expect(f.fetcher).not.toHaveBeenCalled();
});

it('answers in production unconditionally and keeps a beta confined to the isolated stack', () => {
  const beta = {
    enabled: 'true',
    environment: 'beta',
    oauthMode: 'testing',
    siteUrl: 'http://127.0.0.1:5175'
  };
  // Production: shipped in 1.4.1. The switches that once fenced the beta are irrelevant there.
  for (const environment of [undefined, 'production'])
    expect(
      nativeRestitchEnabled({
        enabled: undefined,
        environment,
        oauthMode: 'verified',
        siteUrl: 'x'
      })
    ).toBe(true);
  expect(nativeRestitchEnabled(beta)).toBe(true);
  expect(nativeRestitchBetaIsolated(beta)).toBe(true);
  // A beta stays behind every isolation check; an unknown environment answers nothing.
  for (const override of [
    { enabled: undefined },
    { enabled: 'false' },
    { oauthMode: 'verified' },
    { siteUrl: 'https://soty.example.invalid' },
    { siteUrl: 'http://127.0.0.1:5173' }
  ]) {
    expect(nativeRestitchEnabled({ ...beta, ...override })).toBe(false);
    expect(nativeRestitchBetaIsolated({ ...beta, ...override })).toBe(false);
  }
  expect(nativeRestitchEnabled({ ...beta, environment: 'development' })).toBe(false);
  expect(nativeRestitchBetaIsolated({ ...beta, environment: 'production' })).toBe(false);
});
it('does not dispatch an unvalidated or substituted source media request', async () => {
  const f = setup(),
    authority = await authorizeNativeRestitchSource(request(), { rpc: f.rpc }, f.fetcher);
  await authority.bindGrant(grant);
  const range = { headers: { range: 'bytes=0-3' } };
  await expect(
    authority.fetch('https://www.googleapis.com/drive/v3/files/fixture?alt=media', range)
  ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  authority.assertSource(live);
  await expect(
    authority.fetch('https://www.googleapis.com/drive/v3/files/foreign?alt=media', range)
  ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  await expect(
    authority.fetch('https://www.googleapis.com/drive/v3/files/fixture?alt=media', {
      headers: { range: 'bytes=1-3' }
    })
  ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  expect(f.fetcher).not.toHaveBeenCalled();
  await authority.fetch('https://www.googleapis.com/drive/v3/files/fixture?alt=media', range);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it('binds a restitch process input only to its enrolled original operation before source I/O', async () => {
  const f = setup(),
    authority = await authorizeNativeRestitchSource(request(), { rpc: f.rpc }, f.fetcher);
  await authority.bindGrant({
    ...grant,
    purpose: 'process_input',
    toolId: 'restitch',
    operationId: owner.rootOperationId
  });
  authority.assertSource(live);
  await authority.fetch('https://www.googleapis.com/drive/v3/files/fixture?alt=media', {
    headers: { range: 'bytes=0-3' }
  });
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it.each([
  { operationId: id(99), toolId: 'restitch' },
  { operationId: null, toolId: 'restitch' },
  { operationId: undefined, toolId: 'restitch' },
  { operationId: owner.rootOperationId, toolId: 'compressor' },
  { operationId: owner.rootOperationId, toolId: null }
])('refuses a process grant lacking the exact original restitch operation: %j', async override => {
  const f = setup(),
    authority = await authorizeNativeRestitchSource(request(), { rpc: f.rpc }, f.fetcher);
  await expect(
    authority.bindGrant({ ...grant, purpose: 'process_input', ...override })
  ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  expect(f.fetcher).not.toHaveBeenCalled();
});
it('answers the targeted catalog writer in production and keeps the beta opt-in', () => {
  // 1.4.2: before this every due deferred publication on production was blocked
  // as writer_unsupported, so a scheduled video link never reached the sheet.
  for (const environment of [undefined, 'production'])
    expect(
      targetedCatalogWriterEnabled({
        enabled: undefined,
        variants: undefined,
        environment,
        oauthMode: 'verified',
        siteUrl: 'x'
      })
    ).toBe(true);
  const beta = {
    enabled: 'true',
    variants: 'true',
    environment: 'beta',
    oauthMode: 'testing',
    siteUrl: 'http://127.0.0.1:5175'
  };
  expect(targetedCatalogWriterEnabled(beta)).toBe(true);
  for (const override of [
    { enabled: undefined },
    { enabled: 'false' },
    { variants: undefined },
    { oauthMode: 'verified' },
    { siteUrl: 'https://soty.example.invalid' }
  ])
    expect(targetedCatalogWriterEnabled({ ...beta, ...override })).toBe(false);
  expect(targetedCatalogWriterEnabled({ ...beta, environment: 'development' })).toBe(false);
});
