import { expect, it, vi } from 'vitest';
import {
  runCatalogPublicationScheduler,
  type CatalogPublicationIo
} from '../supabase/functions/catalog-updater/publication-authority';
const id = (n: number) => '77000000-0000-4000-8000-' + String(n).padStart(12, '0');
const clock = Date.parse('2030-01-01T00:00:00Z');
const item = {
  catalogId: id(1),
  teamId: id(2),
  actorId: id(3),
  jobId: id(4),
  policy: { mode: 'immediate', revision: 1, dueAt: null, timeZone: null },
  job: {
    revision: 1,
    state: 'waiting',
    writerFence: null,
    target: { kind: 'source', materialId: id(5), sourceVersion: 'v1' }
  },
  active: null
};
function fixture() {
  const calls: string[] = [];
  const rpc = vi.fn(async (name: string): Promise<{ data: unknown; error: unknown }> => {
    calls.push(name);
    return {
      error: null,
      data:
        name === 'service_mark_due_catalog_publications_unsupported'
          ? 0
          : name === 'service_claim_catalog_publication_jobs'
            ? { serverNow: clock, items: [item] }
            : name === 'service_reserve_catalog_publication'
              ? id(6)
              : true
    };
  });
  const io: CatalogPublicationIo = {
    writerPolicy: 'soty_owned_video_cells',
    availability: vi.fn(async () => 'ready' as const),
    apply: vi.fn(async () => {}),
    verify: vi.fn(async () => ({
      outcome: 'verified' as const,
      providerRevision: 'v2',
      verifiedAt: new Date(clock).toISOString()
    }))
  };
  return { rpc, io, calls };
}
it('diagnoses due unsupported jobs without claiming or dispatching provider work', async () => {
  const a = fixture();
  expect(await runCatalogPublicationScheduler({ service: a, workerId: id(7), io: null })).toEqual({
    enabled: false,
    code: 'CATALOG_WRITE_UNSUPPORTED',
    blockedCount: 0
  });
  expect(a.rpc).toHaveBeenCalledOnce();
  expect(a.rpc).toHaveBeenCalledWith('service_mark_due_catalog_publications_unsupported', {
    p_limit: 3
  });
  expect(a.io.apply).not.toHaveBeenCalled();
});
it('uses real RPC names and exact original fence through dispatch and verified settlement', async () => {
  const a = fixture();
  expect(
    await runCatalogPublicationScheduler({ service: a, workerId: id(7), io: a.io })
  ).toMatchObject({ enabled: true, verified: 1 });
  expect(a.calls).toEqual([
    'service_claim_catalog_publication_jobs',
    'service_reserve_catalog_publication',
    'service_dispatch_catalog_publication',
    'service_settle_catalog_publication'
  ]);
  expect(a.rpc).toHaveBeenLastCalledWith(
    'service_settle_catalog_publication',
    expect.objectContaining({
      p_job: id(4),
      p_worker: id(7),
      p_fence: id(6),
      p_outcome: 'verified' as const,
      p_provider_revision: 'v2'
    })
  );
});
it('does not apply when the original dispatch reply is missing', async () => {
  const a = fixture();
  a.rpc.mockImplementation(async (name: string) => {
    if (name === 'service_dispatch_catalog_publication')
      return { error: { message: 'lost' }, data: null };
    return {
      error: null,
      data:
        name === 'service_claim_catalog_publication_jobs'
          ? { serverNow: clock, items: [item] }
          : id(6)
    };
  });
  expect(
    await runCatalogPublicationScheduler({ service: a, workerId: id(7), io: a.io })
  ).toMatchObject({ uncertain: 1 });
  expect(a.io.apply).not.toHaveBeenCalled();
});
