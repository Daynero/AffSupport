import { expect, it, vi } from 'vitest';
import { catalogInitialVideoAuthority } from '../supabase/functions/drive-ops/catalog-initial-video-authority';
import { createCatalogInitialVideoPlan } from '../supabase/functions/drive-ops/catalog-video-generation';
const id = (n: number) => '77000000-0000-4000-8000-' + String(n).padStart(12, '0');
function setup(valid = true, admitted = true, withExecutor = false) {
  const plan = createCatalogInitialVideoPlan(
    {
      catalogVideoProtocolVersion: 1,
      restitchEnabled: true,
      videoVariationCount: 1,
      videoPublication: { mode: 'immediate' }
    },
    1,
    Date.parse('2030-01-01T00:00:00Z')
  );
  const readRestitchDefaults = vi.fn(async () => {
      throw Error('UNEXPECTED_NEW_SETTINGS');
    }),
    captureFreshSource = vi.fn(async () => {
      throw Error('UNEXPECTED_NEW_CAPTURE');
    }),
    resolveReadyLinks = vi.fn(async () => ['https://example.invalid/owned-output']);
  const rpc = vi.fn(async (name: string) => ({
    error: null,
    data:
      name === 'service_read_initial_catalog_ready_binding'
        ? valid
          ? { videoSetId: plan.setId, catalogIntentId: id(1) }
          : null
        : admitted
          ? {
              catalogIntentId: id(1),
              parentState: 'ready',
              snapshot: {
                setId: plan.setId,
                children: [
                  {
                    index: 0,
                    requestId: plan.childRequestIds[0],
                    state: 'registered',
                    outputId: id(6)
                  }
                ]
              }
            }
          : null
  }));
  const authority = catalogInitialVideoAuthority(
    { rpc },
    {
      ...(withExecutor ? { executorId: id(9) } : {}),
      teamId: id(2),
      actorId: id(3),
      sourceMaterialId: id(4),
      initialCatalogKey: 'product-catalog:' + id(5),
      readRestitchDefaults,
      captureFreshSource,
      resolveReadyLinks,
      verifyAndRegisterCreated: vi.fn(async () => {})
    }
  );
  return { plan, authority, rpc, readRestitchDefaults, captureFreshSource, resolveReadyLinks };
}
it('reuses only a proved original READY set without an executor and still resolves provider-proved links', async () => {
  const f = setup();
  expect(await f.authority.prepare({ intentId: id(1), plan: f.plan })).toMatchObject({
    state: 'ready',
    videoLinks: ['https://example.invalid/owned-output']
  });
  expect(f.resolveReadyLinks).toHaveBeenCalledOnce();
  expect(f.captureFreshSource).not.toHaveBeenCalled();
  expect(f.readRestitchDefaults).not.toHaveBeenCalled();
});
it('does not let an online/other path bypass a failed original READY receipt proof', async () => {
  const f = setup(false, true, true);
  await expect(f.authority.prepare({ intentId: id(1), plan: f.plan })).rejects.toMatchObject({
    code: 'SOURCE_CHANGED'
  });
  expect(f.resolveReadyLinks).not.toHaveBeenCalled();
});
it('never turns a missing original admission into a new process without an executor', async () => {
  const f = setup(false, false);
  await expect(f.authority.prepare({ intentId: id(1), plan: f.plan })).rejects.toMatchObject({
    code: 'TEAM_TRANSPORT_UNAVAILABLE'
  });
  expect(f.captureFreshSource).not.toHaveBeenCalled();
  expect(f.resolveReadyLinks).not.toHaveBeenCalled();
});
