/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { prepareLaunchCatalogVideoAdmission } from '../supabase/functions/drive-ops/launch-catalog-video.js';
import { catalogInitialVideoAuthority } from '../supabase/functions/drive-ops/catalog-initial-video-authority.js';
import {
  catalogPlanSegments,
  catalogSegmentSeed
} from '../supabase/functions/drive-ops/catalog-video-generation.js';
import { parseTeamRestitchDefaults } from '../packages/shared/src/team/restitch';
import { launchConfig } from './fixtures/launches';

/**
 * 062 (R4–R6, T039/T041): a catalog Launch of several videos gets one restitch set per video,
 * the variations handed round-robin, each set's rows shuffled with its own seed, and always the
 * background executor — the foreground controller follows exactly one set.
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
if (!defaults.ok) throw Error('Invalid fixture defaults');

function config(
  options: { k?: number; variations?: number; restitch?: boolean; image?: boolean } = {}
) {
  const k = options.k ?? 4;
  const copies = Array.from({ length: k }, () => 100 / k);
  const creatives = copies.map((count, index) => ({
    materialId: id(100 + index),
    alias: `IN${40 + index}`,
    copies: count,
    pinned: null
  }));
  return launchConfig({
    method: 'catalog',
    materialId: creatives[0].materialId,
    creativeAlias: creatives[0].alias,
    creativeKind: options.image ? 'image' : 'video',
    creatives,
    catalog: {
      productCount: 100,
      restitchEnabled: options.restitch ?? true,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 60,
      catalogVideoProtocolVersion: 1,
      videoVariationCount: options.variations ?? 30,
      videoPublication: { mode: 'immediate' }
    }
  });
}

function service(executorId: string | null = id(20)) {
  const rpc = vi.fn(async (name: string) => {
    switch (name) {
      case 'service_initial_catalog_video_context':
        return { data: { executorId, defaults: defaults.value }, error: null };
      case 'service_catalog_publication_clock':
        return { data: Date.now(), error: null };
      case 'service_retire_unused_catalog_video_foreground':
        return { data: null, error: null };
      case 'service_find_launch_catalog_video_reuse':
        throw Error('several videos never reuse a set');
      default:
        throw Error('Unexpected RPC ' + name);
    }
  });
  return { rpc };
}

describe('several videos at admission', () => {
  it('splits 30 variations over 4 videos as 8 · 8 · 7 · 7, one set each', async () => {
    const s = service();
    const admission = await prepareLaunchCatalogVideoAdmission(s, {
      teamId: id(1),
      actorId: id(2),
      launchId: id(3),
      config: config({ variations: 30 })
    });
    const segments = catalogPlanSegments(admission.plan);
    expect(segments.map(segment => segment.variantCount)).toEqual([8, 8, 7, 7]);
    expect(segments.map(segment => [segment.rowStart, segment.rowCount])).toEqual([
      [0, 25],
      [25, 25],
      [50, 25],
      [75, 25]
    ]);
    expect(new Set(segments.map(segment => segment.setId)).size).toBe(4);
    expect(admission.plan.setId).toBe(segments[0].setId);
    // One request list whose slices belong to the segments: the old length check holds.
    expect(admission.plan.childRequestIds).toHaveLength(30);
    expect(segments.flatMap(segment => segment.childRequestIds)).toEqual(
      admission.plan.childRequestIds
    );
    expect(admission.plan.preferences.creatives.map(c => c.materialId)).toEqual(
      segments.map(segment => segment.materialId)
    );
    expect(s.rpc.mock.calls.map(([name]) => name)).not.toContain(
      'service_find_launch_catalog_video_reuse'
    );
  });

  it('derives each segment seed as SQL does and shuffles only its own rows', async () => {
    const admission = await prepareLaunchCatalogVideoAdmission(service(), {
      teamId: id(1),
      actorId: id(2),
      config: config({ variations: 30 })
    });
    const segments = catalogPlanSegments(admission.plan);
    for (const segment of segments) {
      const expected = createHash('sha256')
        .update(`${admission.plan.assignmentSeed}:${segment.ordinal}`)
        .digest('hex');
      expect(segment.assignmentSeed).toBe(expected);
      expect(await catalogSegmentSeed(admission.plan.assignmentSeed, segment.ordinal)).toBe(
        expected
      );
    }
    expect(admission.segmentAssignments).toHaveLength(4);
    for (const [ordinal, assignments] of admission.segmentAssignments.entries()) {
      const rows = new Set(
        admission.plan.recipeRowIds.slice(
          segments[ordinal].rowStart,
          segments[ordinal].rowStart + 25
        )
      );
      expect(assignments).toHaveLength(25);
      expect(assignments.every(row => rows.has(row.recipeRowId))).toBe(true);
      expect(Math.max(...assignments.map(row => row.videoVariantIndex))).toBe(
        segments[ordinal].variantCount - 1
      );
    }
    expect(admission.assignments).toHaveLength(100);
  });

  it('retires an offered foreground enrollment and takes the background executor', async () => {
    const s = service(id(20));
    const admission = await prepareLaunchCatalogVideoAdmission(s, {
      teamId: id(1),
      actorId: id(2),
      config: config(),
      foregroundExecutor: {
        mode: 'paired_session',
        enrollmentId: id(50),
        nativeInstanceId: id(51)
      }
    });
    expect(admission.executorId).toBe(id(20));
    expect(admission.plan.preferences.foregroundExecutor).toBeUndefined();
    expect(admission.plan.preferences.expectedExecutorId).toBe(id(20));
    expect(s.rpc.mock.calls.map(([name]) => name)).toContain(
      'service_retire_unused_catalog_video_foreground'
    );
  });

  it('needs a background agent for several restitched videos', async () => {
    await expect(
      prepareLaunchCatalogVideoAdmission(service(null), {
        teamId: id(1),
        actorId: id(2),
        config: config()
      })
    ).rejects.toMatchObject({ code: 'AGENT_REQUIRED' });
  });

  it('plans one original per video without restitch', async () => {
    const admission = await prepareLaunchCatalogVideoAdmission(service(null), {
      teamId: id(1),
      actorId: id(2),
      config: config({ restitch: false, variations: 1 })
    });
    const segments = catalogPlanSegments(admission.plan);
    expect(segments.map(segment => [segment.variantCount, segment.setId])).toEqual([
      [1, null],
      [1, null],
      [1, null],
      [1, null]
    ]);
    expect(admission.assignments).toEqual([]);
  });

  it('plans image segments with no sets and no variations', async () => {
    const admission = await prepareLaunchCatalogVideoAdmission(service(null), {
      teamId: id(1),
      actorId: id(2),
      config: config({ image: true, restitch: false, variations: 1, k: 2 })
    });
    const segments = catalogPlanSegments(admission.plan);
    expect(segments.map(segment => [segment.kind, segment.variantCount, segment.setId])).toEqual([
      ['image', 0, null],
      ['image', 0, null]
    ]);
    expect(admission.plan.preferences.creativeKind).toBe('image');
  });

  it('keeps a single video exactly as before: plan seed, one set', async () => {
    const admission = await prepareLaunchCatalogVideoAdmission(service(), {
      teamId: id(1),
      actorId: id(2),
      config: config({ k: 1, variations: 3 })
    });
    const [segment] = catalogPlanSegments(admission.plan);
    expect(segment.assignmentSeed).toBe(admission.plan.assignmentSeed);
    expect(segment.setId).toBe(admission.plan.setId);
    expect(segment.childRequestIds).toEqual(admission.plan.childRequestIds);
    expect(admission.segmentAssignments).toBeUndefined();
  });
});

describe('several sets when the catalog is made', () => {
  async function plan() {
    const admission = await prepareLaunchCatalogVideoAdmission(service(), {
      teamId: id(1),
      actorId: id(2),
      config: config({ k: 2, variations: 3 })
    });
    return admission.plan;
  }
  function authority(states: Record<string, string[]>, intentId: string) {
    const resolved: Array<[string, number]> = [];
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (
        name === 'service_read_catalog_video_acceptance' ||
        name === 'service_retry_failed_catalog_video_variants'
      ) {
        const children = (states[args.p_set as string] ?? []).map((state, index) => ({
          state,
          outputId: state === 'registered' ? `out-${index}` : null
        }));
        return {
          data: {
            catalogIntentId: intentId,
            parentState: children.every(child => child.state === 'registered')
              ? 'ready'
              : 'preparing',
            snapshot: { setId: args.p_set, children }
          },
          error: null
        };
      }
      throw Error('Unexpected RPC ' + name);
    });
    const value = catalogInitialVideoAuthority(
      { rpc },
      {
        teamId: id(1),
        actorId: id(2),
        executorId: id(20),
        sourceMaterialId: id(100),
        readRestitchDefaults: async () => defaults.value,
        captureFreshSource: async () => {
          throw Error('never accepted here');
        },
        resolveReadyLinks: async (setId, _revision, rows) => {
          resolved.push([setId, rows.length]);
          return rows.map(row => `https://drive.google.com/file/d/${setId}/view?row=${row}`);
        },
        verifyAndRegisterCreated: async () => undefined
      }
    );
    return { value, rpc, resolved };
  }

  it('waits for every set and counts all registered variations', async () => {
    const p = await plan();
    const [first, second] = catalogPlanSegments(p);
    const { value } = authority(
      { [first.setId]: ['registered', 'registered'], [second.setId]: ['working'] },
      'intent'
    );
    await expect(value.prepare({ intentId: 'intent', plan: p })).resolves.toEqual({
      state: 'preparing',
      registeredCount: 2
    });
  });

  it('joins each set’s links over its own rows, in row order', async () => {
    const p = await plan();
    const [first, second] = catalogPlanSegments(p);
    const { value, resolved } = authority(
      { [first.setId]: ['registered', 'registered'], [second.setId]: ['registered'] },
      'intent'
    );
    const ready = await value.prepare({ intentId: 'intent', plan: p });
    expect(ready.state).toBe('ready');
    expect(resolved).toEqual([
      [first.setId, 50],
      [second.setId, 50]
    ]);
    expect(ready.videoLinks).toHaveLength(100);
    expect(ready.videoLinks.slice(0, 50).every(link => link.includes(first.setId))).toBe(true);
    expect(ready.videoLinks[50]).toContain(second.setId);
    expect(ready.videoLinks[50]).toContain(p.recipeRowIds[50]);
  });

  it('reports a set that cannot be proven as unknown, never as ready', async () => {
    const p = await plan();
    const [first, second] = catalogPlanSegments(p);
    const { value } = authority(
      { [first.setId]: ['registered', 'registered'], [second.setId]: ['unknown'] },
      'intent'
    );
    await expect(value.prepare({ intentId: 'intent', plan: p })).resolves.toMatchObject({
      state: 'unknown'
    });
  });

  it('refuses a set accepted for another catalog', async () => {
    const p = await plan();
    const [first, second] = catalogPlanSegments(p);
    const { value } = authority(
      { [first.setId]: ['registered', 'registered'], [second.setId]: ['registered'] },
      'other-intent'
    );
    await expect(value.prepare({ intentId: 'intent', plan: p })).rejects.toMatchObject({
      code: 'PROCESS_RESULT_UNCERTAIN'
    });
  });
});
