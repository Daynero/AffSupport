import { expect, it, vi } from 'vitest';
import type { ServiceRpcClient } from '../supabase/functions/_shared/credentials';
import { dispatchControlledRestitchScreenRange } from '../supabase/functions/drive-ops/restitch-controlled-range-dispatch';
vi.mock('../supabase/functions/drive-ops/restitch-range-authority.ts', () => ({
  readRestitchSelectionSource: vi.fn(async () => ({
    credentialId: id(9),
    source: { fileId: 'fixture', sizeBytes: 4, mimeType: 'image/png' }
  }))
}));
vi.mock('../supabase/functions/drive-ops/restitch-range-source.ts', () => ({
  createRestitchRangeOpener:
    () =>
    async (
      io: { fetch: typeof fetch; fetchPayload: typeof fetch },
      range: { start: number; end: number }
    ) => {
      await (await io.fetch('https://oauth.invalid/token')).text();
      await (await io.fetch('https://metadata.invalid/file')).text();
      return io.fetchPayload('https://www.googleapis.com/drive/v3/files/fixture?alt=media', {
        headers: { range: `bytes=${range.start}-${range.end}` }
      });
    }
}));
const settled = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../supabase/functions/drive-ops/restitch-selection-store.ts', async importOriginal => {
  const original =
    await importOriginal<
      typeof import('../supabase/functions/drive-ops/restitch-selection-store')
    >();
  return {
    ...original,
    RestitchSelectionSlotStore: class extends original.RestitchSelectionSlotStore {
      override settle = settled;
    }
  };
});
const id = (n: number) => 'b1790000-0000-4000-8000-' + String(n).padStart(12, '0');
function grant() {
  return {
    grantId: id(1),
    rootOperationId: id(2),
    teamId: id(3),
    actorId: id(4),
    slot: 'end',
    versionId: id(5),
    requestId: id(6),
    executorId: id(7),
    epoch: 1,
    nativeInstanceId: id(8),
    state: 'consumed',
    acquisition: 0,
    reservation: {
      requestId: id(6),
      candidateVersionId: id(5),
      acquisition: 0,
      offset: 0,
      bytesReserved: 4,
      ioMsReserved: 120000,
      retry: false,
      settlement: null
    }
  };
}
function setup(denyAt: number | null) {
  settled.mockClear();
  let checks = 0;
  const rpc = vi.fn<ServiceRpcClient['rpc']>().mockImplementation(async name => {
    if (name === 'service_consume_restitch_control_screen_range')
      return { data: { dispatch: true, grant: grant() }, error: null };
    if (name === 'service_check_restitch_control_screen_range')
      return ++checks === denyAt
        ? { data: null, error: { message: 'AUTH_REQUIRED' } }
        : { data: { consumedByInvocation: true, grant: grant() }, error: null };
    if (name === 'service_settle_restitch_selection_transfer_owned')
      return { data: true, error: null };
    throw Error('UNEXPECTED_RPC');
  });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async input =>
    String(input).includes('alt=media')
      ? new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 206,
          headers: {
            'content-range': 'bytes 0-3/4',
            'content-length': '4',
            'content-type': 'image/png'
          }
        })
      : new Response('{}')
  );
  const readCredentials = vi.fn(async () => ({}) as never);
  return { rpc, fetcher, readCredentials };
}
it('checks the bound current session before credentials and every metered provider request', async () => {
  const f = setup(null);
  const response = await dispatchControlledRestitchScreenRange(
    { service: { rpc: f.rpc }, ticket: 'b'.repeat(43) },
    { fetch: f.fetcher, readCredentials: f.readCredentials }
  );
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3, 4]);
  expect(f.fetcher).toHaveBeenCalledTimes(3);
  expect(
    f.rpc.mock.calls.filter(c => c[0] === 'service_check_restitch_control_screen_range')
  ).toHaveLength(4);
  expect(f.rpc.mock.calls.filter(c => c[0].includes('reserve'))).toHaveLength(0);
  expect(settled).toHaveBeenCalledTimes(1);
  expect(settled).toHaveBeenCalledWith(
    id(6),
    expect.objectContaining({ bytes: 4, complete: true })
  );
});
it.each([1, 2, 3, 4])(
  'refuses revoked authority at boundary %i without the next provider request',
  async boundary => {
    const f = setup(boundary);
    await expect(
      dispatchControlledRestitchScreenRange(
        { service: { rpc: f.rpc }, ticket: 'b'.repeat(43) },
        { fetch: f.fetcher, readCredentials: f.readCredentials }
      )
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(f.fetcher).toHaveBeenCalledTimes(Math.max(0, boundary - 2));
    if (boundary === 1) expect(f.readCredentials).not.toHaveBeenCalled();
    expect(f.rpc.mock.calls.filter(c => c[0].includes('consume'))).toHaveLength(1);
  }
);
it('does not dispatch provider I/O after cancellation during an authority read', async () => {
  const f = setup(null),
    controller = new AbortController();
  const original = f.rpc.getMockImplementation()!;
  let checks = 0;
  f.rpc.mockImplementation(async (name, args) => {
    const result = await original(name, args);
    if (name === 'service_check_restitch_control_screen_range' && ++checks === 2)
      controller.abort();
    return result;
  });
  await expect(
    dispatchControlledRestitchScreenRange(
      { service: { rpc: f.rpc }, ticket: 'b'.repeat(43), signal: controller.signal },
      { fetch: f.fetcher, readCredentials: f.readCredentials }
    )
  ).rejects.toMatchObject({ code: 'PROCESS_CANCELED' });
  expect(f.fetcher).not.toHaveBeenCalled();
});
