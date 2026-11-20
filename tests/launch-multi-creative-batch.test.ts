/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, expect, it, vi } from 'vitest';
import { acceptLaunchBatch } from '../supabase/functions/drive-ops/launch-batch';
import { catalogPlanSegments } from '../supabase/functions/drive-ops/catalog-video-generation';
import { parseTeamRestitchDefaults } from '../packages/shared/src/team/restitch';
import { launchConfig, launchSources } from './fixtures/launches';

/**
 * 062 (R14, T059/T060): a batch of copies of one Launch with four creatives and a hand-made
 * share admits every copy with the same blocks and its own sets — the batch prepares each
 * member through the same parse, preview and admission as a single Launch.
 */
const id = (n: number) => 'c6200000-0000-4000-8000-' + String(n).padStart(12, '0');
const defaults = parseTeamRestitchDefaults({
  configured: true,
  operation: 'restitch',
  sourceMode: 'drive',
  startEnabled: false,
  endEnabled: true,
  finalDurationMode: 'custom',
  customFinalDurationSeconds: 60
});

const copies = [40, 30, 20, 10];
const creatives = copies.map((count, index) => ({
  materialId: id(100 + index),
  alias: `IN${40 + index}`,
  copies: count,
  pinned: index === 0 ? 1 : null
}));
const config = launchConfig({
  method: 'catalog',
  materialId: creatives[0].materialId,
  creativeAlias: creatives[0].alias,
  creativeKind: 'video',
  creatives,
  catalog: {
    productCount: 100,
    restitchEnabled: true,
    finalDurationMode: 'custom',
    customFinalDurationSeconds: 60,
    catalogVideoProtocolVersion: 1,
    videoVariationCount: 8,
    videoPublication: { mode: 'immediate' }
  }
});
const sources = {
  ...launchSources,
  schemaVersion: 1,
  agentRowId: config.agentRowId,
  offerId: config.offerId,
  buyerId: config.buyerId,
  materialId: config.materialId,
  catalogSettingsVersion: '1',
  restitchSettingsVersion: '1',
  materials: creatives.map(creative => ({
    materialId: creative.materialId,
    type: 'video',
    version: '1'
  }))
};

function service() {
  let accepted: Record<string, unknown> | null = null;
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    switch (name) {
      case 'service_launch_batch_context':
        return {
          data: {
            items: [1, 2, 3].map(n => ({
              launchId: id(n),
              childRequestKey: id(10 + n),
              expectedVersion: '1',
              config,
              sources,
              errorCode: null
            }))
          },
          error: null
        };
      case 'service_launch_worker_ready':
        return { data: true, error: null };
      case 'service_initial_catalog_video_context':
        return { data: { executorId: id(50), defaults: defaults.value }, error: null };
      case 'service_catalog_publication_clock':
        return { data: Date.now(), error: null };
      case 'service_find_launch_catalog_video_reuse':
        throw Error('several videos never reuse a set');
      case 'service_accept_launch_batch':
        accepted = args;
        return { data: null, error: null };
      default:
        throw Error('Unexpected RPC ' + name);
    }
  });
  return { rpc, accepted: () => accepted };
}

describe('a batch of a Launch with four creatives', () => {
  it('prepares every copy with the hand-made blocks and its own sets', async () => {
    const s = service();
    await acceptLaunchBatch(s, id(20), {
      teamId: id(21),
      expectedActorId: id(20),
      requestKey: id(22),
      items: [1, 2, 3].map(n => ({
        launchId: id(n),
        expectedVersion: '1',
        childRequestKey: id(10 + n)
      }))
    }).catch(() => undefined);
    const prepared = s.accepted()?.p_prepared as Array<Record<string, any>>;
    expect(prepared).toHaveLength(3);
    const sets = new Set<string>();
    for (const item of prepared) {
      expect(item.errorCode).toBeNull();
      const segments = catalogPlanSegments(item.video.plan);
      expect(segments.map(segment => segment.rowCount)).toEqual(copies);
      expect(segments.map(segment => segment.variantCount)).toEqual([2, 2, 2, 2]);
      expect(item.video.segmentAssignments).toHaveLength(4);
      for (const segment of segments) sets.add(segment.setId);
    }
    // Twelve sets: four videos in each of three copies, none shared.
    expect(sets.size).toBe(12);
    expect(s.rpc.mock.calls.map(([name]) => name)).not.toContain(
      'service_find_launch_catalog_video_reuse'
    );
  });
});
