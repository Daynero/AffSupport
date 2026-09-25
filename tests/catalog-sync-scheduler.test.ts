import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import {
  runCatalogSyncSlice,
  type CatalogSyncDependencies,
  type CatalogSyncJob
} from '../supabase/functions/catalog-sync/engine';
import { catalogFile } from './fixtures/catalog-sync';

const owner = '26700000-0000-4000-8000-000000000001';
let db: TeamTestDb;
let connections: string[];
let canonicalJobs: string[];
let manualJob: string;
let firstTeam: string;

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'scheduler@example.test' });
  await db.root('insert into public.admin_users(user_id) values ($1)', [owner]);
  const [credential] = await db.root<{ id: string }>(
    `insert into private.google_drive_credentials
      (google_permission_id,google_account_email,scope,vault_secret_id,connected_by)
     values ('scheduler','scheduler@example.test','https://www.googleapis.com/auth/drive.file',
       gen_random_uuid(),$1) returning id`,
    [owner]
  );
  connections = [];
  canonicalJobs = [];
  for (let index = 0; index < 10; index += 1) {
    const [team] = await db.asUser<{ id: string }>(owner, `select id from public.create_team($1)`, [
      `Scheduler ${index}`
    ]);
    if (index === 0) firstTeam = team!.id;
    const [connection] = await db.root<{ id: string }>(
      `insert into public.team_drive_connections
        (team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state)
       values ($1,$2,'root','Root','my_drive','connected') returning id`,
      [team!.id, credential!.id]
    );
    connections.push(connection!.id);
    const [job] = await db.root<{ id: string }>(
      `insert into private.catalog_sync_jobs
        (connection_id,job_kind,phase,cursor,next_attempt_at)
       values ($1,'incremental','incremental','{}',now() - interval '1 minute') returning id`,
      [connection!.id]
    );
    canonicalJobs.push(job!.id);
  }
}, 60_000);

afterAll(async () => db?.close());

type Claim = { job_id: string; lease_epoch: number };
const claim = () =>
  db.root<Claim>(
    "select job_id, lease_epoch from public.service_claim_catalog_sync_work('fairness',1,180)"
  );
const release = async (row: Claim) => {
  await db.root('select public.service_release_catalog_sync_job($1,$2,$3)', [
    row.job_id,
    'fairness',
    row.lease_epoch
  ]);
  await db.root(
    "update private.catalog_sync_jobs set next_attempt_at = now() + interval '1 day' where id = $1",
    [row.job_id]
  );
};

describe('bounded catalog scheduler', () => {
  it('prioritizes a ready user request over fresh background polls', async () => {
    const [manual] = await db.root<{ id: string }>(
      `insert into private.catalog_sync_jobs
        (connection_id,job_kind,phase,cursor,requested_folder_id,next_attempt_at)
       values ($1,'user_subtree','initial_scan','{}','root',now()) returning id`,
      [connections[0]]
    );
    manualJob = manual!.id;
    const [picked] = await claim();
    await release(picked!);
    await db.root('update private.catalog_sync_jobs set next_attempt_at = now() where id = $1', [
      picked!.job_id
    ]);
    await db.root(
      "update private.catalog_sync_jobs set next_attempt_at = now() + interval '1 day' where id = $1",
      [manual!.id]
    );
    expect(picked?.job_id).toBe(manual!.id);
  });

  it('serves every ready connection within ten one-slot claims', async () => {
    const served = new Set<string>();
    for (let turn = 0; turn < 10; turn += 1) {
      const [picked] = await claim();
      expect(picked).toBeDefined();
      served.add(picked!.job_id);
      await release(picked!);
    }
    expect(served).toEqual(new Set(canonicalJobs));
  });

  it('does not consume a retry merely because a no-change poll was claimed', async () => {
    const target = canonicalJobs[0]!;
    await db.root(
      `update private.catalog_sync_jobs set attempts = 4,
         next_attempt_at = now(), last_progress_at = now() - interval '7 days'
       where id = $1`,
      [target]
    );
    const [picked] = await claim();
    expect(picked?.job_id).toBe(target);
    expect(
      await db.root<{ attempts: number }>(
        'select attempts from private.catalog_sync_jobs where id = $1',
        [target]
      )
    ).toEqual([{ attempts: 4 }]);
    await release(picked!);
  });

  it('clears consecutive failures only after a fenced successful checkpoint', async () => {
    const target = canonicalJobs[0]!;
    await db.root(
      'update private.catalog_sync_jobs set attempts = 4, next_attempt_at = now() where id = $1',
      [target]
    );
    const [picked] = await claim();
    expect(picked?.job_id).toBe(target);
    const [saved] = await db.root<{ saved: boolean }>(
      `select public.service_save_catalog_sync_progress(
        $1,'fairness',$2,'incremental','c-2','c-2','[]'::jsonb,'[]'::jsonb) as saved`,
      [target, picked!.lease_epoch]
    );
    expect(saved?.saved).toBe(true);
    expect(
      await db.root<{ attempts: number }>(
        'select attempts from private.catalog_sync_jobs where id = $1',
        [target]
      )
    ).toEqual([{ attempts: 0 }]);
    await release(picked!);
  });

  it('reserves one of four claims for background work under repeated manual demand', async () => {
    await db.root(
      'update private.catalog_sync_jobs set next_attempt_at = now() where id in ($1,$2)',
      [manualJob, canonicalJobs[0]]
    );
    const selected: string[] = [];
    for (let turn = 0; turn < 4; turn += 1) {
      const [picked] = await claim();
      selected.push(picked!.job_id);
      await release(picked!);
      await db.root('update private.catalog_sync_jobs set next_attempt_at = now() where id = $1', [
        picked!.job_id
      ]);
    }
    expect(selected.filter(id => id === manualJob)).toHaveLength(3);
    expect(selected.filter(id => id === canonicalJobs[0])).toHaveLength(1);
  });

  it('projects an unprogressing canonical job as delayed rather than healthy', async () => {
    await db.root(
      `update public.team_drive_connections set initial_sync_state = 'ready',
         last_synced_at = now() - interval '1 hour' where id = $1`,
      [connections[0]]
    );
    await db.root(
      `update private.catalog_sync_jobs set last_progress_at = now() - interval '1 hour',
         state = 'pending', lease_owner = null, lease_expires_at = null where id = $1`,
      [canonicalJobs[0]]
    );
    const [health] = await db.asUser<{ value: { syncHealth: string; nextAction: string } }>(
      owner,
      'select public.get_team_storage_health_v2($1) as value',
      [firstTeam]
    );
    expect(health?.value).toMatchObject({ syncHealth: 'delayed', nextAction: 'retry' });
  });
});

describe('change-feed work over a fake clock', () => {
  const baseJob: CatalogSyncJob = {
    jobId: 'feed',
    connectionId: 'connection',
    phase: 'incremental',
    rootFolderId: 'root',
    driveId: null,
    folderQueue: [],
    pageToken: 'c-0',
    changeToken: 'c-0',
    attempts: 0,
    jobKind: 'incremental'
  };
  const dependencies = (): CatalogSyncDependencies => ({
    listChildren: vi.fn(),
    listChanges: vi.fn().mockImplementation(async ({ pageToken }: { pageToken: string }) => ({
      changes:
        pageToken === 'c-10080'
          ? [{ fileId: 'new-file', removed: false, file: catalogFile({ id: 'new-file' }) }]
          : [],
      nextPageToken: null,
      newStartPageToken: `c-${Number(pageToken.slice(2)) + 1}`
    })),
    getFile: vi.fn(),
    isWithinRoot: vi.fn().mockResolvedValue(true),
    isHiddenSystemFile: vi.fn().mockResolvedValue(false),
    invalidateLandingRenders: vi.fn(),
    upsertFiles: vi.fn().mockResolvedValue(true),
    enqueueDiscoveredFolder: vi.fn().mockResolvedValue(true),
    tombstoneFiles: vi.fn(),
    requeueTranscripts: vi.fn(),
    checkpoint: vi.fn(),
    complete: vi.fn().mockResolvedValue(true),
    reconcile: vi.fn(),
    markFolderIndexed: vi.fn(),
    markRootState: vi.fn(),
    touchReconciled: vi.fn()
  });

  it('still processes a new event after seven simulated days of no-change polls', async () => {
    vi.useFakeTimers();
    try {
      const deps = dependencies();
      vi.setSystemTime(new Date('2026-09-25T00:00:00Z'));
      for (let minute = 0; minute < 10_080; minute += 1) {
        await runCatalogSyncSlice(
          { ...baseJob, pageToken: `c-${minute}`, changeToken: `c-${minute}` },
          deps
        );
        vi.setSystemTime(Date.now() + 60_000);
      }
      expect(deps.upsertFiles).not.toHaveBeenCalled();
      await runCatalogSyncSlice({ ...baseJob, pageToken: 'c-10080', changeToken: 'c-10080' }, deps);
      expect(deps.upsertFiles).toHaveBeenCalledWith(
        expect.objectContaining({ files: [expect.objectContaining({ id: 'new-file' })] })
      );
      expect(deps.complete).toHaveBeenLastCalledWith(
        expect.objectContaining({ changeToken: 'c-10081' })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('processes 100 external changes per minute without dropping a cursor page', async () => {
    vi.useFakeTimers();
    try {
      const deps = dependencies();
      deps.listChanges = vi
        .fn()
        .mockImplementation(async ({ pageToken }: { pageToken: string }) => {
          const minute = Number(pageToken.slice(2));
          return {
            changes: Array.from({ length: 100 }, (_, index) => ({
              fileId: `file-${minute}-${index}`,
              removed: false,
              file: catalogFile({ id: `file-${minute}-${index}` })
            })),
            nextPageToken: null,
            newStartPageToken: `c-${minute + 1}`
          };
        });
      let processed = 0;
      for (let minute = 0; minute < 5; minute += 1) {
        const result = await runCatalogSyncSlice(
          { ...baseJob, pageToken: `c-${minute}`, changeToken: `c-${minute}` },
          deps
        );
        processed += result.processed;
        vi.setSystemTime(Date.now() + 60_000);
      }
      expect(processed).toBe(500);
      expect(deps.complete).toHaveBeenCalledTimes(5);
      expect(deps.complete).toHaveBeenLastCalledWith(
        expect.objectContaining({ changeToken: 'c-5' })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
