import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import { seedSyncScenario } from './fixtures/catalog-sync';

/**
 * 028, release B — a request is a row with a key, "Stop" acts on the request,
 * counters on the job only grow, and the detailed status says why a scan is
 * blocked.
 */

const owner = '28200000-0000-4000-8000-000000000001';
const admin = '28200000-0000-4000-8000-000000000002';
const viewer = '28200000-0000-4000-8000-000000000003';
let db: TeamTestDb;
let credential: string;
let teamCounter = 0;

async function connect(): Promise<{ team: string; connection: string }> {
  teamCounter += 1;
  const [team] = await db.asUser<{ id: string }>(owner, 'select id from public.create_team($1)', [
    `Cancel ${teamCounter}`
  ]);
  for (const [user, role] of [
    [admin, 'admin'],
    [viewer, 'viewer']
  ] as const) {
    await db.root(
      `insert into public.team_members(team_id, user_id, base_role, status) values ($1, $2, $3, 'active')
       on conflict do nothing`,
      [team!.id, user, role]
    );
  }
  const [connection] = await db.root<{ id: string }>(
    `insert into public.team_drive_connections
      (team_id, credential_id, root_folder_id, root_folder_name, drive_kind, state, change_page_token)
     values ($1, $2, 'root', 'Root', 'my_drive', 'connected', 'token-0') returning id`,
    [team!.id, credential]
  );
  await db.root(
    `insert into public.team_materials (team_id, connection_id, drive_file_id, name, kind)
     values ($1, $2, 'docs', 'Docs', 'folder'), ($1, $2, 'other', 'Other', 'folder')`,
    [team!.id, connection!.id]
  );
  return { team: team!.id, connection: connection!.id };
}

type Accepted = { sync_job_id: string; request_id: string; outcome: string };
const requestFolder = (actor: string, team: string, folder: string, key: string) =>
  db.asUser<Accepted>(
    actor,
    'select sync_job_id, request_id, outcome from public.request_team_folder_resync($1, $2, $3)',
    [team, folder, key]
  );
const status = async (actor: string, team: string, job: string) =>
  (
    await db.asUser<{ status: Record<string, unknown> }>(
      actor,
      'select public.get_team_folder_sync_status($1, $2) as status',
      [team, job]
    )
  )[0]!.status;
const jobRow = async (id: string) =>
  (
    await db.root<{
      state: string;
      last_error_code: string | null;
      cancel_requested_at: string | null;
    }>(
      'select state, last_error_code, cancel_requested_at from private.catalog_sync_jobs where id = $1',
      [id]
    )
  )[0]!;

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'cancel-owner@example.test' });
  await createUser(db, { id: admin, email: 'cancel-admin@example.test' });
  await createUser(db, { id: viewer, email: 'cancel-viewer@example.test' });
  await db.root('insert into public.admin_users(user_id) values ($1)', [owner]);
  const [row] = await db.root<{ id: string }>(
    `insert into private.google_drive_credentials
      (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
     values ('cancel', 'cancel-owner@example.test', 'https://www.googleapis.com/auth/drive.file',
       gen_random_uuid(), $1) returning id`,
    [owner]
  );
  credential = row!.id;
}, 60_000);

afterAll(async () => db?.close());

describe('requests are idempotent by key', () => {
  it('the same request key returns the same job and request', async () => {
    const { team } = await connect();
    const [first] = await requestFolder(owner, team, 'docs', 'key-aaaaaaaa');
    const [again] = await requestFolder(owner, team, 'docs', 'key-aaaaaaaa');
    expect(first!.outcome).toBe('created');
    expect(again).toEqual(first);
    const [other] = await requestFolder(admin, team, 'docs', 'key-bbbbbbbb');
    expect(other!.sync_job_id).toBe(first!.sync_job_id);
    expect(other!.outcome).toBe('joined');
    expect(other!.request_id).not.toBe(first!.request_id);
    expect(
      await db.asUser(
        owner,
        "select sync_job_id, state from public.find_team_folder_sync_request_by_key($1, 'key-aaaaaaaa')",
        [team]
      )
    ).toEqual([{ sync_job_id: first!.sync_job_id, state: 'pending' }]);
    expect((await status(owner, team, first!.sync_job_id)).sharedWith).toBe(1);
  });

  it('a short key is refused and a viewer may not request', async () => {
    const { team } = await connect();
    await expect(requestFolder(owner, team, 'docs', 'short')).rejects.toThrow(/INVALID_INPUT/);
    await expect(requestFolder(viewer, team, 'docs', 'key-cccccccc')).rejects.toThrow(
      /PERMISSION_DENIED/
    );
  });

  it('a request on a scan already behind the replay barrier gets a follow-up, not a join', async () => {
    const { team, connection } = await connect();
    const waiter = await seedSyncScenario(db, connection, 'waiter-canonical-retry', {
      folder: 'docs'
    });
    const [accepted] = await requestFolder(owner, team, 'docs', 'key-dddddddd');
    expect(accepted!.sync_job_id).not.toBe(waiter.job);
    expect(accepted!.outcome).toBe('created');
  });
});

describe('stop acts on the request', () => {
  const cancel = (actor: string, team: string, request: string) =>
    db.asUser<{ job_state: string; request_outcome: string }>(
      actor,
      'select job_state, request_outcome from public.cancel_team_folder_sync($1, $2)',
      [team, request]
    );

  it('cancel of a shared job detaches only this request', async () => {
    const { team } = await connect();
    const [first] = await requestFolder(owner, team, 'docs', 'key-eeeeeeee');
    const [second] = await requestFolder(admin, team, 'docs', 'key-ffffffff');
    expect(await cancel(admin, team, second!.request_id)).toEqual([
      { job_state: 'pending', request_outcome: 'detached' }
    ]);
    expect((await jobRow(first!.sync_job_id)).state).toBe('pending');
    expect((await status(owner, team, first!.sync_job_id)).sharedWith).toBe(0);
  });

  it('cancel in pending cancels immediately with CANCELED_BY_USER', async () => {
    const { team } = await connect();
    const [accepted] = await requestFolder(owner, team, 'docs', 'key-gggggggg');
    expect(await cancel(owner, team, accepted!.request_id)).toEqual([
      { job_state: 'canceled', request_outcome: 'canceled' }
    ]);
    const row = await jobRow(accepted!.sync_job_id);
    expect(row.state).toBe('canceled');
    expect(row.last_error_code).toBe('CANCELED_BY_USER');
    expect((await status(owner, team, accepted!.sync_job_id)).state).toBe('canceled');
  });

  it('cancel of a leased job makes the lease lock refuse and the claim retires it canceled', async () => {
    const { team, connection } = await connect();
    const [accepted] = await requestFolder(owner, team, 'docs', 'key-hhhhhhhh');
    await db.root(
      `update private.catalog_sync_jobs set next_attempt_at = now() + interval '1 day'
       where connection_id <> $1 or job_kind = 'incremental'`,
      [connection]
    );
    const [lease] = await db.root<{ job_id: string; lease_epoch: number }>(
      "select job_id, lease_epoch from public.service_claim_catalog_sync_work('w', 1, 60)"
    );
    expect(lease?.job_id).toBe(accepted!.sync_job_id);
    expect(await cancel(owner, team, accepted!.request_id)).toEqual([
      { job_state: 'canceling', request_outcome: 'canceled' }
    ]);
    expect((await status(owner, team, accepted!.sync_job_id)).state).toBe('canceling');
    expect(
      await db.root("select private.lock_catalog_sync_lease($1, 'w', $2::bigint) as valid", [
        lease!.job_id,
        lease!.lease_epoch
      ])
    ).toEqual([{ valid: false }]);
    // The lease ends; the next claim retires the job instead of handing it out.
    await db.root(
      "update private.catalog_sync_jobs set lease_expires_at = now() - interval '1 second' where id = $1",
      [lease!.job_id]
    );
    expect(
      await db.root("select job_id from public.service_claim_catalog_sync_work('w2', 1, 60)")
    ).toEqual([]);
    expect((await jobRow(accepted!.sync_job_id)).state).toBe('canceled');
  });

  it('cancel racing completion yields exactly one terminal state', async () => {
    const { team } = await connect();
    const [accepted] = await requestFolder(owner, team, 'docs', 'key-iiiiiiii');
    await db.root(
      "update private.catalog_sync_jobs set state = 'succeeded', completed_at = now() where id = $1",
      [accepted!.sync_job_id]
    );
    expect(await cancel(owner, team, accepted!.request_id)).toEqual([
      { job_state: 'succeeded', request_outcome: 'created' }
    ]);
    expect((await jobRow(accepted!.sync_job_id)).state).toBe('succeeded');
  });

  it("a viewer cannot cancel another user's request; an admin can", async () => {
    const { team } = await connect();
    const [accepted] = await requestFolder(owner, team, 'docs', 'key-jjjjjjjj');
    await expect(cancel(viewer, team, accepted!.request_id)).rejects.toThrow(/PERMISSION_DENIED/);
    expect(await cancel(admin, team, accepted!.request_id)).toEqual([
      { job_state: 'canceled', request_outcome: 'canceled' }
    ]);
  });
});

describe('the detailed status explains itself', () => {
  it('a waiter without a live canonical is reported blocked with canonical_failed; retrying feeds say so', async () => {
    const { team, connection } = await connect();
    const failed = await seedSyncScenario(db, connection, 'waiter-canonical-missing', {
      folder: 'docs'
    });
    expect(await status(owner, team, failed.job)).toMatchObject({
      state: 'blocked',
      blockedReason: 'canonical_failed',
      phase: 'replaying_changes',
      cancelable: false
    });
    await db.root(
      `update private.catalog_sync_jobs set state = 'retry', next_attempt_at = now() + interval '14 minutes'
       where id = $1`,
      [failed.canonical]
    );
    await db.root(
      "update private.catalog_sync_jobs set scan_completed_at = now() - interval '11 minutes' where id = $1",
      [failed.job]
    );
    expect(await status(owner, team, failed.job)).toMatchObject({
      state: 'blocked',
      blockedReason: 'canonical_retrying'
    });
  });

  it('a retrying job is reported retry_wait with nextAttemptAt; counters are present and non-negative', async () => {
    const { team } = await connect();
    const [accepted] = await requestFolder(owner, team, 'docs', 'key-kkkkkkkk');
    await db.root(
      `update private.catalog_sync_jobs set state = 'retry', next_attempt_at = now() + interval '2 minutes',
        last_error_code = 'RATE_LIMITED', files_listed = 12, files_added = 3, files_updated = 2,
        files_removed = 1, items_unavailable = 1, folders_done = 4 where id = $1`,
      [accepted!.sync_job_id]
    );
    const value = await status(owner, team, accepted!.sync_job_id);
    expect(value).toMatchObject({
      state: 'retry_wait',
      errorCode: 'RATE_LIMITED',
      filesListed: 12,
      filesAdded: 3,
      filesUpdated: 2,
      filesRemoved: 1,
      itemsUnavailable: 1,
      foldersDone: 4,
      progressRevision: 6,
      requestId: accepted!.request_id,
      cancelable: true
    });
    expect(typeof value.nextAttemptAt).toBe('string');
  });

  it('page, candidate and folder commits increment the job counters', async () => {
    const { team, connection } = await connect();
    const [accepted] = await requestFolder(owner, team, 'docs', 'key-llllllll');
    await db.root(
      `update private.catalog_sync_jobs set next_attempt_at = now() + interval '1 day'
       where connection_id <> $1 or job_kind = 'incremental'`,
      [connection]
    );
    const [lease] = await db.root<{ job_id: string; lease_epoch: number }>(
      "select job_id, lease_epoch from public.service_claim_catalog_sync_work('counter', 1, 60)"
    );
    expect(lease?.job_id).toBe(accepted!.sync_job_id);
    const [begun] = await db.root<{ generation: string }>(
      `select generation from public.service_begin_catalog_folder($1, 'counter', $2::bigint, 'docs', false)`,
      [lease!.job_id, lease!.lease_epoch]
    );
    const files = JSON.stringify([
      {
        drive_file_id: 'f1',
        name: 'one.mp4',
        kind: 'file',
        parent_folder_id: 'docs',
        drive_version: '1'
      },
      {
        drive_file_id: 'f2',
        name: 'two.mp4',
        kind: 'file',
        parent_folder_id: 'docs',
        drive_version: '1'
      }
    ]);
    expect(
      await db.root(
        `select public.service_commit_catalog_scan_page($1, 'counter', $2::bigint, $3, null, null, $4::jsonb, true) as ok`,
        [lease!.job_id, lease!.lease_epoch, begun!.generation, files]
      )
    ).toEqual([{ ok: true }]);
    expect(
      await db.root(
        'select files_listed, files_added, files_updated from private.catalog_sync_jobs where id = $1',
        [lease!.job_id]
      )
    ).toEqual([{ files_listed: 2, files_added: 2, files_updated: 0 }]);
    expect(
      await db.root(
        `select public.service_finish_catalog_folder($1, 'counter', $2::bigint, $3) as ok`,
        [lease!.job_id, lease!.lease_epoch, begun!.generation]
      )
    ).toEqual([{ ok: true }]);
    expect(
      await db.root('select folders_done from private.catalog_sync_jobs where id = $1', [
        lease!.job_id
      ])
    ).toEqual([{ folders_done: 1 }]);
  });

  it('a fenced replay upsert counts added and updated files and refuses a stale epoch', async () => {
    const { team, connection } = await connect();
    const [accepted] = await requestFolder(owner, team, 'docs', 'key-mmmmmmmm');
    await db.root(
      `update private.catalog_sync_jobs set next_attempt_at = now() + interval '1 day'
       where connection_id <> $1 or job_kind = 'incremental'`,
      [connection]
    );
    const [lease] = await db.root<{ job_id: string; lease_epoch: number }>(
      "select job_id, lease_epoch from public.service_claim_catalog_sync_work('replay', 1, 60)"
    );
    expect(lease?.job_id).toBe(accepted!.sync_job_id);
    const files = JSON.stringify([
      { drive_file_id: 'r1', name: 'r1.mp4', kind: 'file', drive_version: '1' },
      { drive_file_id: 'docs', name: 'Docs renamed', kind: 'folder', drive_version: '2' }
    ]);
    const [affected] = await db.root<{ n: number }>(
      `select public.service_upsert_catalog_page($1, 'replay', $2::bigint, $3, 'root', $4::jsonb) as n`,
      [lease!.job_id, lease!.lease_epoch, connection, files]
    );
    expect(affected!.n).toBe(2);
    expect(
      await db.root(
        'select files_added, files_updated, files_removed from private.catalog_sync_jobs where id = $1',
        [lease!.job_id]
      )
    ).toEqual([{ files_added: 1, files_updated: 1, files_removed: 0 }]);
    const [removed] = await db.root<{ n: number }>(
      `select public.service_tombstone_catalog_files($1, 'replay', $2::bigint, $3,
        '[{"file_id":"r1","lifecycle":"trashed"}]'::jsonb) as n`,
      [lease!.job_id, lease!.lease_epoch, connection]
    );
    expect(removed!.n).toBe(1);
    expect(
      await db.root('select files_removed from private.catalog_sync_jobs where id = $1', [
        lease!.job_id
      ])
    ).toEqual([{ files_removed: 1 }]);
    await expect(
      db.root(
        `select public.service_upsert_catalog_page($1, 'replay', $2::bigint, $3, 'root', '[]'::jsonb)`,
        [lease!.job_id, lease!.lease_epoch - 1, connection]
      )
    ).rejects.toThrow(/LEASE_LOST/);
    void team;
  });
});
