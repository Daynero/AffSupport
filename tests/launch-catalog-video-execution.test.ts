import { expect, it, vi } from 'vitest';
import {
  executeLaunchCatalog,
  type LaunchCatalogExecutionDeps
} from '../supabase/functions/drive-ops/launch-catalog';
import { launchConfig, launchSources } from './fixtures/launches';
it.each(['preparing', 'unknown'] as const)(
  'keeps immediate N %s honest without attaching or publishing a Launch result',
  async state => {
    const durable = await import('../supabase/functions/drive-ops/catalog-durable');
    const create = vi.spyOn(durable, 'createDurableProductCatalog').mockResolvedValueOnce({
      outcome: 'preparing_video',
      catalogIntentId: 'intent',
      videoSetId: 'set',
      requestedCount: 2,
      registeredCount: 0,
      state
    });
    const payload = {
      teamId: 'team',
      videoMaterialId: '44444444-4444-4444-8444-444444444444',
      catalogVideoProtocolVersion: 1,
      restitchEnabled: true,
      videoVariationCount: 2,
      videoPublication: { mode: 'immediate' },
      idempotencyKey: 'launch:generation:catalog'
    };
    const config = launchConfig({
      method: 'catalog',
      catalog: {
        productCount: 100,
        restitchEnabled: true,
        finalDurationMode: 'custom',
        customFinalDurationSeconds: 120,
        catalogVideoProtocolVersion: 1,
        videoVariationCount: 2,
        videoPublication: { mode: 'immediate' }
      }
    });
    const rpc = vi.fn(async (name: string) => ({
      error: null,
      data:
        name === 'service_claim_launch_generation'
          ? {
              state: 'running',
              catalogImageContractVersion: 2,
              fence: '2',
              config,
              sources: launchSources,
              advertisingUrl: 'https://synthetic.invalid/'
            }
          : name === 'service_read_launch_catalog_video_context'
            ? {
                requestPayload: payload,
                executorId: 'c1710000-0000-4000-8000-000000000002',
                settings: {
                  configured: true,
                  operation: 'restitch',
                  sourceMode: 'drive',
                  startEnabled: false,
                  endEnabled: true,
                  finalDurationMode: 'custom',
                  customFinalDurationSeconds: 120
                }
              }
            : name === 'service_restore_registered_launch_catalog'
              ? false
              : null
    }));
    const factory = vi.fn(async () => ({
      serverNow: vi.fn(),
      prepare: vi.fn(),
      registerCreated: vi.fn()
    }));
    try {
      const result = await executeLaunchCatalog(
        {
          service: { rpc },
          catalog: {} as LaunchCatalogExecutionDeps['catalog'],
          driveFor: vi.fn(),
          proveSource: vi.fn(),
          proveCatalog: vi.fn(),
          createInitialVideoAuthority: factory,
          readCatalogVideoFailure: async () => 'STITCH_VERIFICATION_FAILED'
        },
        'team',
        'generation',
        'actor'
      );
      expect(result).toEqual({
        id: 'generation',
        state: state === 'unknown' ? 'interrupted' : 'accepted'
      });
      expect(create.mock.calls[0]![3]).toEqual(payload);
      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedExecutorId: 'c1710000-0000-4000-8000-000000000002',
          frozenRestitchDefaults: expect.objectContaining({ customFinalDurationSeconds: 120 })
        })
      );
      const calls = rpc.mock.calls.map(([name]) => name);
      expect(calls.includes('service_wait_launch_catalog_video')).toBe(state === 'preparing');
      if (state === 'unknown')
        expect(rpc).toHaveBeenCalledWith(
          'service_interrupt_launch_generation',
          expect.objectContaining({ p_code: 'STITCH_VERIFICATION_FAILED' })
        );
      expect(calls).not.toContain('service_launch_restitch_receipt');
      expect(calls).not.toContain('service_attach_launch_catalog');
      expect(calls).not.toContain('service_publish_launch_generation');
    } finally {
      create.mockRestore();
    }
  }
);
it.each(['preparing', 'ready', 'unknown'] as const)(
  'keeps the same registered scheduled blank receipt while N is %s, attaching only after ready',
  async state => {
    const durable = await import('../supabase/functions/drive-ops/catalog-durable'),
      create = vi.spyOn(durable, 'createDurableProductCatalog');
    const config = launchConfig({
      method: 'catalog',
      catalog: {
        productCount: 5,
        restitchEnabled: true,
        finalDurationMode: 'custom',
        customFinalDurationSeconds: 120,
        catalogVideoProtocolVersion: 1,
        videoVariationCount: 5,
        videoPublication: {
          mode: 'scheduled',
          localDateTime: '2030-01-01T12:00',
          timeZone: 'Europe/Kyiv',
          resolvedOffset: '+02:00',
          dueAt: '2030-01-01T10:00:00.000Z'
        }
      }
    });
    const rpc = vi.fn(async (name: string) => ({
      error: null,
      data:
        name === 'service_claim_launch_generation'
          ? {
              state: 'running',
              catalogImageContractVersion: 2,
              fence: '2',
              config,
              sources: launchSources,
              advertisingUrl: 'https://synthetic.invalid/'
            }
          : name === 'service_read_launch_catalog_video_context'
            ? { requestPayload: { idempotencyKey: 'launch:generation:catalog' } }
            : name === 'service_read_initial_catalog_video'
              ? {
                  outcome: 'created',
                  catalog: { materialId: 'same' },
                  videoGenerationObservation: {
                    videoSetId: 'c1800000-0000-4000-8000-000000000001',
                    requestedCount: 5,
                    registeredCount: state === 'ready' ? 5 : 0,
                    state,
                    catalogVideoCells: 'deferred_blank'
                  }
                }
              : name === 'service_restore_registered_launch_catalog'
                ? true
                : name === 'service_publish_launch_generation'
                  ? { state: 'succeeded' }
                  : null
    }));
    const proveSource = vi.fn(),
      driveFor = vi.fn();
    try {
      expect(
        await executeLaunchCatalog(
          {
            service: { rpc },
            catalog: {} as LaunchCatalogExecutionDeps['catalog'],
            driveFor,
            proveSource,
            proveCatalog: vi.fn(),
            readCatalogVideoFailure: async () =>
              state === 'unknown' ? 'STITCH_PLAN_VIDEO_CODEC' : null
          },
          'team',
          'generation',
          'actor'
        )
      ).toEqual(
        state === 'ready'
          ? { state: 'succeeded' }
          : { id: 'generation', state: state === 'unknown' ? 'interrupted' : 'accepted' }
      );
      const names = rpc.mock.calls.map(([name]) => name);
      expect(names.includes('service_wait_launch_catalog_video')).toBe(state === 'preparing');
      expect(names.includes('service_restore_registered_launch_catalog')).toBe(state === 'ready');
      expect(names.includes('service_interrupt_launch_generation')).toBe(state === 'unknown');
      if (state === 'unknown')
        expect(rpc).toHaveBeenCalledWith(
          'service_interrupt_launch_generation',
          expect.objectContaining({ p_code: 'STITCH_PLAN_VIDEO_CODEC' })
        );
      expect(proveSource).not.toHaveBeenCalled();
      expect(driveFor).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    } finally {
      create.mockRestore();
    }
  }
);
