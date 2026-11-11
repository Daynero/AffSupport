import { expect, it, vi } from 'vitest';
import { catalogInitialVideoAuthority } from '../supabase/functions/drive-ops/catalog-initial-video-authority';
import { createCatalogInitialVideoPlan } from '../supabase/functions/drive-ops/catalog-video-generation';

/**
 * 1.4.3: preparation requeues a variant whose operation provably failed without
 * output before it calls the set unknown, so one failed video out of N no
 * longer buries the whole set.
 */
const id = (n: number) => '77930000-0000-4000-8000-' + String(n).padStart(12, '0');
function setup(settled: unknown, failing = false) {
  const plan = createCatalogInitialVideoPlan(
    {
      catalogVideoProtocolVersion: 1,
      restitchEnabled: true,
      videoVariationCount: 2,
      videoPublication: { mode: 'immediate' }
    },
    2,
    Date.parse('2030-01-01T00:00:00Z')
  );
  const child = (index: number, state: string, operationId: string | null) => ({
    index,
    requestId: plan.childRequestIds[index],
    operationId,
    state,
    outputId: state === 'registered' ? id(60 + index) : null
  });
  const stuck = [child(0, 'registered', id(50)), child(1, 'unknown', id(51))];
  const rpc = vi.fn(async (name: string) => {
    if (name === 'service_retry_failed_catalog_video_variants') {
      if (failing) throw new Error('network');
      return { error: null, data: settled };
    }
    return {
      error: null,
      data: {
        catalogIntentId: id(1),
        parentState: 'unknown',
        snapshot: { setId: plan.setId, children: stuck }
      }
    };
  });
  const authority = catalogInitialVideoAuthority(
    { rpc },
    {
      executorId: id(9),
      teamId: id(2),
      actorId: id(3),
      sourceMaterialId: id(4),
      readRestitchDefaults: vi.fn(),
      captureFreshSource: vi.fn(),
      resolveReadyLinks: vi.fn(),
      verifyAndRegisterCreated: vi.fn(async () => {})
    }
  );
  return { plan, authority, rpc, stuck, child };
}

it('reports the set as preparing once its failed variant was requeued', async () => {
  const f = setup(null);
  f.rpc.mockImplementation(async (name: string) => ({
    error: null,
    data:
      name === 'service_retry_failed_catalog_video_variants'
        ? {
            retried: 1,
            terminal: 0,
            parentState: 'preparing',
            snapshot: {
              setId: f.plan.setId,
              children: [f.stuck[0], { ...f.child(1, 'queued', null), requestId: id(77) }]
            }
          }
        : {
            catalogIntentId: id(1),
            parentState: 'unknown',
            snapshot: { setId: f.plan.setId, children: f.stuck }
          }
  }));
  expect(await f.authority.prepare({ intentId: id(1), plan: f.plan })).toEqual({
    state: 'preparing',
    registeredCount: 1
  });
  expect(f.rpc).toHaveBeenCalledWith('service_retry_failed_catalog_video_variants', {
    p_set: f.plan.setId,
    p_team: id(2),
    p_actor: id(3)
  });
});

it.each([
  ['no retry is left', false],
  ['the settle cannot be read', true]
])('keeps the set unknown when %s', async (_name, failing) => {
  const f = setup(
    {
      retried: 0,
      terminal: 1,
      parentState: 'unknown',
      snapshot: { setId: 'not-this-set', children: [] }
    },
    failing
  );
  expect(await f.authority.prepare({ intentId: id(1), plan: f.plan })).toEqual({
    state: 'unknown',
    registeredCount: 1
  });
});

it('does not ask for a retry while every video is registered or queued', async () => {
  const f = setup(null);
  f.rpc.mockImplementation(async () => ({
    error: null,
    data: {
      catalogIntentId: id(1),
      parentState: 'preparing',
      snapshot: {
        setId: f.plan.setId,
        children: [f.stuck[0], f.child(1, 'queued', null)]
      }
    }
  }));
  expect(await f.authority.prepare({ intentId: id(1), plan: f.plan })).toMatchObject({
    state: 'preparing'
  });
  expect(f.rpc.mock.calls.map(([name]) => name)).not.toContain(
    'service_retry_failed_catalog_video_variants'
  );
});

it('asks the server to settle a working video, which may have been abandoned', async () => {
  const f = setup(null);
  f.rpc.mockImplementation(async () => ({
    error: null,
    data: {
      catalogIntentId: id(1),
      parentState: 'preparing',
      snapshot: {
        setId: f.plan.setId,
        children: [f.stuck[0], f.child(1, 'working', id(51))]
      }
    }
  }));
  await f.authority.prepare({ intentId: id(1), plan: f.plan });
  expect(f.rpc.mock.calls.map(([name]) => name)).toContain(
    'service_retry_failed_catalog_video_variants'
  );
});
