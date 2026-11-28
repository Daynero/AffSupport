import { describe, expect, it, vi } from 'vitest';
import { RESTITCH_CONTRACT_VERSION } from '../packages/shared/src/team/restitch';
import { sampleCatalogVideoDuration } from '../supabase/functions/drive-ops/catalog-video-duration';
import {
  claimSpaceCatalogVariantJob,
  completeSpaceCatalogVariantJob,
  heartbeatSpaceCatalogVariantJob,
  SPACE_VARIANT_LEASE_SECONDS,
  SPACE_VARIANT_SCREEN_DEFER_SECONDS,
  type SpaceVariantRecoveryDeps
} from '../supabase/functions/space-storage/catalog-variant-recovery';
import { SPACE_RESTITCHED_FOLDER_NAME } from '../supabase/functions/space-storage/catalog-variants';

/**
 * 057 T106: the variations of an R2 catalog are finished by the member's delegated agent when
 * no page is open (team-recovery → space-storage). A claim leases the next variation, draws its
 * pictures with a ticket each, opens its run exactly as `/catalog-variants/run` does and binds it
 * under the lease, then hands the agent an R2 job; heartbeats keep the lease; complete releases
 * it. Pictures that cannot be drawn hold the lease for an hour without a run; a lost bind cancels
 * the run before any agent sees it; an executor older than the pictures is told before any run.
 */

const ACTOR = '05791070-0000-4000-8000-000000000002';
const TEAM = '05791070-0000-4000-8000-000000000011';
const ROOT = '05791070-0000-4000-8000-000000000101';
const FOLDER = '05791070-0000-4000-8000-000000000102';
const SOURCE = '05791070-0000-4000-8000-0000000000a1';
const PICTURE = '05791070-0000-4000-8000-0000000000a2';
const SET = '05791070-0000-4000-8000-0000000000b1';
const REQUEST = '05791070-0000-4000-8000-0000000000b2';
const JOB = '05791070-0000-4000-8000-0000000000b3';
const OPERATION = '05791070-0000-4000-8000-0000000000c1';
const DIGEST = 'd'.repeat(64);
const LEASE = 'L'.repeat(43);
const SOURCE_URL = 'https://api.test/functions/v1/space-storage/agent/source';
const settings = (sourceMode: 'drive' | 'legacy') => ({
  operation: 'restitch',
  startImageIds: sourceMode === 'legacy' ? ['start-1'] : [],
  endImageIds: sourceMode === 'legacy' ? ['end-1'] : [],
  sourceMode,
  builtin: { version: 1, start: true, end: true },
  fitMode: 'cover',
  finalDurationMode: 'random-40-50',
  customFinalDurationSeconds: 2700,
  startEnabled: true,
  endEnabled: true,
  startDurationMode: 'one-frame',
  customStartDurationMs: 100,
  configured: true,
  updatedAt: 'rev-1',
  updatedBy: null
});
const lease = (sourceMode: 'drive' | 'legacy' = 'drive') => ({
  jobId: JOB,
  setId: SET,
  index: 2,
  requestId: REQUEST,
  attempt: 1,
  sourceMaterialId: SOURCE,
  sourceName: 'Clip.mp4',
  variantCount: 3,
  settings: settings(sourceMode),
  settingsDigest: DIGEST
});

function world(
  claimed: unknown,
  options: { bind?: Error; draw?: Error; screens?: unknown[]; heartbeat?: unknown } = {}
) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    calls.push([name, args]);
    switch (name) {
      case 'service_claim_space_catalog_variant':
        return claimed;
      case 'service_draw_restitch_screens':
        if (options.draw) throw options.draw;
        return {
          sourceMode: 'drive',
          screens: options.screens ?? [
            { slot: 'start', materialId: PICTURE, checksum: 'c'.repeat(32), mimeType: 'image/png' }
          ]
        };
      case 'service_space_storage_context':
        return {
          member: true,
          storageBackend: 'r2',
          storagePilot: true,
          actorPilot: true,
          workspaceAllowed: true,
          archived: false,
          allowed: true,
          accessEpoch: '7',
          contentRevision: '0',
          rootMaterialId: ROOT
        };
      case 'service_read_space_materials':
        return [
          {
            id: PICTURE,
            teamId: TEAM,
            parentMaterialId: ROOT,
            name: 'Start.png',
            kind: 'file',
            lifecycle: 'active',
            materialRevision: '0',
            contentId: 'e'.repeat(64),
            sizeBytes: '10',
            mimeType: 'image/png'
          }
        ];
      case 'service_mutate_space_materials':
        return {
          kind: 'ok',
          materials: [{ id: FOLDER, name: SPACE_RESTITCHED_FOLDER_NAME, kind: 'folder' }],
          created: false
        };
      case 'service_space_process_source':
        return {
          materialId: SOURCE,
          name: 'Clip.mp4',
          category: 'video',
          mimeType: 'video/mp4',
          sizeBytes: '400',
          contentId: 'a'.repeat(64),
          destinationFolderId: FOLDER,
          childNames: []
        };
      case 'service_start_team_operation':
        return [{ operation_id: OPERATION, state: 'pending', reused: false }];
      case 'service_bind_space_catalog_variant_job':
        if (options.bind) throw options.bind;
        return { bound: true, operationId: OPERATION };
      case 'service_heartbeat_space_catalog_variant_job':
        return options.heartbeat ?? { cancel: false };
      case 'service_complete_space_catalog_variant_job':
        return { recorded: true };
      case 'service_defer_space_catalog_variant_job':
        return { deferred: true };
      case 'service_set_team_operation_intent':
      case 'service_transition_team_operation':
      case 'issue_team_transfer_grant':
        return null;
      default:
        throw new Error(`unexpected rpc ${name}`);
    }
  });
  let ticket = 0;
  const deps: SpaceVariantRecoveryDeps = {
    actorId: ACTOR,
    rpc,
    bucket: null,
    readGrant: null,
    journal: vi.fn(async () => true),
    operationId: 'journal',
    client: { kind: 'server', version: 'test' },
    ticket: () => `ticket-${++ticket}-${'x'.repeat(40)}`,
    sourceUrl: SOURCE_URL,
    randomToken: () => LEASE
  };
  return { deps, rpc, calls, names: () => calls.map(([name]) => name) };
}

const body = { teamId: TEAM, restitchContractVersion: RESTITCH_CONTRACT_VERSION };
const leaseHashOf = async (token: string) =>
  '\\x' +
  Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString(
    'hex'
  );

describe('the background agent finishes an R2 catalog’s variations', () => {
  it('answers no job when nothing is owed', async () => {
    const f = world(null);
    await expect(claimSpaceCatalogVariantJob(f.deps, body)).resolves.toEqual({ job: null });
    expect(f.calls).toEqual([
      [
        'service_claim_space_catalog_variant',
        {
          p_team: TEAM,
          p_actor: ACTOR,
          p_lease_hash: await leaseHashOf(LEASE),
          p_lease_seconds: SPACE_VARIANT_LEASE_SECONDS
        }
      ]
    ]);
  });

  it('leases a variation, draws its pictures, opens and binds its run, and hands over an R2 job', async () => {
    const f = world(lease());
    const answer = await claimSpaceCatalogVariantJob(f.deps, body);
    expect(f.names()).toEqual([
      'service_claim_space_catalog_variant',
      'service_draw_restitch_screens',
      'service_space_storage_context',
      'service_space_storage_context',
      'service_read_space_materials',
      'issue_team_transfer_grant',
      'service_mutate_space_materials',
      'service_space_storage_context',
      'service_space_process_source',
      'service_start_team_operation',
      'service_set_team_operation_intent',
      'service_transition_team_operation',
      'service_bind_space_catalog_variant_job',
      'issue_team_transfer_grant',
      'issue_team_transfer_grant'
    ]);
    const started = f.calls.find(([name]) => name === 'service_start_team_operation')![1];
    expect(started.p_idempotency_key).toBe(`space-variant:${REQUEST}:1`);
    expect(started.p_destination_folder).toBe(FOLDER);
    expect(f.calls.find(([name]) => name === 'service_bind_space_catalog_variant_job')![1]).toEqual(
      {
        p_team: TEAM,
        p_actor: ACTOR,
        p_job: JOB,
        p_lease_hash: await leaseHashOf(LEASE),
        p_attempt: 1,
        p_operation: OPERATION
      }
    );
    const job = (answer as { job: Record<string, unknown> }).job;
    expect(job).toMatchObject({
      jobId: JOB,
      leaseToken: LEASE,
      operationId: OPERATION,
      toolId: 'restitch',
      workspaceStorage: 'r2',
      sourceGrant: { purpose: 'process_input' },
      finalizeGrant: { purpose: 'finalize' }
    });
    const options = job.options as Record<string, unknown>;
    expect(options.prepared).toBeNull();
    expect(options.teamId).toBe(TEAM);
    expect(options.screens).toEqual([
      expect.objectContaining({
        materialId: PICTURE,
        transfer: {
          transferUrl: SOURCE_URL,
          grant: expect.objectContaining({ purpose: 'download_range' })
        }
      })
    ]);
    // The duration is the variation's own, drawn from its identity: a second hand-out matches.
    expect(options.defaults).toEqual(
      await sampleCatalogVideoDuration(settings('drive') as never, {
        setId: SET,
        requestId: REQUEST,
        settingsDigest: DIGEST
      })
    );
  });

  it('a space whose pictures come from the agent’s library draws none', async () => {
    const f = world(lease('legacy'));
    const answer = (await claimSpaceCatalogVariantJob(f.deps, body)) as {
      job: Record<string, unknown>;
    };
    expect(f.names()).not.toContain('service_draw_restitch_screens');
    expect((answer.job.options as Record<string, unknown>).screens).toBeUndefined();
  });

  it('pictures that cannot be drawn hold the lease for an hour and open no run', async () => {
    const f = world(lease(), { draw: new Error('RESTITCH_POOL_EMPTY') });
    await expect(claimSpaceCatalogVariantJob(f.deps, body)).resolves.toEqual({ job: null });
    expect(f.names()).toEqual([
      'service_claim_space_catalog_variant',
      'service_draw_restitch_screens',
      'service_defer_space_catalog_variant_job'
    ]);
    expect(f.calls[2]![1].p_seconds).toBe(SPACE_VARIANT_SCREEN_DEFER_SECONDS);
  });

  it('a picture this computer refused before is drawn around, not handed over again', async () => {
    const f = world(lease(), {
      screens: [{ slot: 'start', materialId: PICTURE, checksum: 'c'.repeat(32) }]
    });
    await claimSpaceCatalogVariantJob(f.deps, {
      ...body,
      screenRefusals: [
        { settingsRevision: 'rev-1', slot: 'start', materialId: PICTURE, checksum: 'C'.repeat(32) }
      ]
    });
    const draws = f.calls.filter(([name]) => name === 'service_draw_restitch_screens');
    expect(draws.map(([, args]) => args.p_exclude)).toEqual([[], [PICTURE]]);
    expect(f.names()).toContain('service_defer_space_catalog_variant_job');
  });

  it('an executor older than the space’s pictures is told before any run, and the lease is released', async () => {
    const f = world(lease());
    await expect(
      claimSpaceCatalogVariantJob(f.deps, { ...body, restitchContractVersion: 1 })
    ).rejects.toMatchObject({ code: 'RESTITCH_CLIENT_OUTDATED' });
    expect(f.names()).toEqual([
      'service_claim_space_catalog_variant',
      'service_complete_space_catalog_variant_job'
    ]);
  });

  it('a run that loses the bind is canceled before any agent sees it, and the lease is released', async () => {
    const f = world(lease('legacy'), { bind: new Error('WRONG_STATE') });
    await expect(claimSpaceCatalogVariantJob(f.deps, body)).resolves.toEqual({ job: null });
    const names = f.names();
    expect(names.slice(-2)).toEqual([
      'service_transition_team_operation',
      'service_complete_space_catalog_variant_job'
    ]);
    expect(f.calls.at(-2)![1]).toMatchObject({ p_operation: OPERATION, p_state: 'canceled' });
    expect(names.filter(name => name === 'issue_team_transfer_grant')).toHaveLength(0);
  });

  it('a heartbeat keeps the lease and passes on when to stop; complete releases it', async () => {
    const f = world(null);
    await expect(
      heartbeatSpaceCatalogVariantJob(f.deps, { jobId: JOB, leaseToken: LEASE })
    ).resolves.toEqual({ cancel: false });
    expect(f.calls[0]).toEqual([
      'service_heartbeat_space_catalog_variant_job',
      {
        p_actor: ACTOR,
        p_job: JOB,
        p_lease_hash: await leaseHashOf(LEASE),
        p_lease_seconds: SPACE_VARIANT_LEASE_SECONDS
      }
    ]);
    const stop = world(null, { heartbeat: { cancel: true } });
    await expect(
      heartbeatSpaceCatalogVariantJob(stop.deps, { jobId: JOB, leaseToken: LEASE })
    ).resolves.toEqual({ cancel: true });
    await expect(
      completeSpaceCatalogVariantJob(f.deps, {
        jobId: JOB,
        leaseToken: LEASE,
        outcome: 'finalized'
      })
    ).resolves.toEqual({ recorded: true });
    await expect(
      completeSpaceCatalogVariantJob(f.deps, { jobId: JOB, leaseToken: 'short', outcome: 'failed' })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
