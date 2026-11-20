/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, expect, it, vi } from 'vitest';
import { executeLaunchCatalog } from '../supabase/functions/drive-ops/launch-catalog';
import { launchConfig, launchSources } from './fixtures/launches';

/**
 * 062: a scheduled catalog of several restitched videos is registered blank and waits for
 * every segment set before it attaches — not only the first set the SQL observation names.
 */
const set = (n: number) => 'c1800000-0000-4000-8000-00000000000' + n;
const source = (n: number) => 'c1800000-0000-4000-8000-00000000010' + n;
const config = launchConfig({
  method: 'catalog',
  catalog: {
    productCount: 6,
    restitchEnabled: true,
    finalDurationMode: 'custom',
    customFinalDurationSeconds: 120,
    catalogVideoProtocolVersion: 1,
    videoVariationCount: 3,
    videoPublication: {
      mode: 'scheduled',
      localDateTime: '2030-01-01T12:00',
      timeZone: 'Europe/Kyiv',
      resolvedOffset: '+02:00',
      dueAt: '2030-01-01T10:00:00.000Z'
    }
  }
});
const videoSets = [0, 1, 2].map(n => ({ ordinal: n, setId: set(n), sourceMaterialId: source(n) }));

function run(
  states: string[],
  options: { settled?: string[]; cause?: string | null; waited?: string } = {}
) {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    const index = videoSets.findIndex(s => s.setId === args.p_set);
    const data =
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
                // The stored receipt lists every set; the live observation names only the first.
                videoGeneration: {
                  videoSetId: set(0),
                  requestedCount: 3,
                  registeredCount: 0,
                  state: 'preparing',
                  catalogVideoCells: 'deferred_blank',
                  videoSets
                },
                videoGenerationObservation: {
                  videoSetId: set(0),
                  requestedCount: 1,
                  registeredCount: 1,
                  state: 'ready',
                  catalogVideoCells: 'deferred_blank'
                }
              }
            : name === 'service_read_catalog_video_acceptance'
              ? { parentState: states[index] }
              : name === 'service_retry_failed_catalog_video_variants'
                ? { parentState: options.settled?.[index] ?? states[index], terminal: 1 }
                : name === 'service_wait_launch_catalog_video'
                  ? { state: options.waited ?? 'preparing', setCount: 3 }
                  : name === 'service_restore_registered_launch_catalog'
                    ? true
                    : name === 'service_publish_launch_generation'
                      ? { state: 'succeeded' }
                      : null;
    return { error: null, data };
  });
  const result = executeLaunchCatalog(
    {
      service: { rpc },
      catalog: {},
      driveFor: vi.fn(),
      proveSource: vi.fn(),
      proveCatalog: vi.fn(),
      readCatalogVideoFailure: vi.fn(async () => options.cause ?? null)
    },
    'team',
    'generation',
    'actor'
  );
  return { rpc, result, names: () => rpc.mock.calls.map(([name]) => name) };
}

describe('the scheduled wait of several videos', () => {
  it('keeps waiting while a later set is still preparing, though the first is ready', async () => {
    const r = run(['ready', 'ready', 'preparing']);
    await expect(r.result).resolves.toEqual({ id: 'generation', state: 'accepted' });
    expect(
      r.rpc.mock.calls
        .filter(([n]) => n === 'service_read_catalog_video_acceptance')
        .map(([, a]) => a.p_set)
    ).toEqual([set(0), set(1), set(2)]);
    expect(r.names()).toContain('service_wait_launch_catalog_video');
    expect(r.names()).not.toContain('service_restore_registered_launch_catalog');
  });

  it('attaches once every set is ready, including one settled just now', async () => {
    const r = run(['ready', 'preparing', 'ready'], { settled: [undefined, 'ready'] });
    await expect(r.result).resolves.toEqual({ state: 'succeeded' });
    expect(r.names()).not.toContain('service_wait_launch_catalog_video');
  });

  it('stops for the cause of the set that cannot be proven, reading its own video', async () => {
    const r = run(['ready', 'unknown', 'ready'], { cause: 'STITCH_PLAN_VIDEO_CODEC' });
    await expect(r.result).resolves.toEqual({ id: 'generation', state: 'interrupted' });
    expect(r.names()).toContain('service_fail_launch_catalog_video');
  });

  it('reports failed when the SQL aggregate is unknown and no cause is known', async () => {
    const r = run(['ready', 'unknown', 'ready'], { cause: null, waited: 'unknown' });
    await expect(r.result).resolves.toEqual({ id: 'generation', state: 'interrupted' });
  });
});
