import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * 028, release D — every replay write goes through the lease fence, a stale
 * worker is refused before it touches Drive, and a folder that keeps
 * restarting without finishing is retired as NO_PROGRESS.
 */

const owner = '28300000-0000-4000-8000-000000000001';
let db: TeamTestDb;
let team: string;
let connection: string;
type Lease = { job_id: string; lease_epoch: number };

async function manualJob(folder: string): Promise<Lease> {
  const [job] = await db.root<{ id: string }>(
    `insert into private.catalog_sync_jobs
      (connection_id, job_kind, phase, cursor, folder_queue, requested_folder_id, next_attempt_at)
     values ($1, 'user_subtree', 'initial_scan', '{"changePageToken":"t"}', $2::jsonb, $3, now())
     returning id`,
    [connection, JSON.stringify([folder]), folder]
  );
  await db.root(
    `update private.catalog_sync_jobs set next_attempt_at = now() + interval '1 day'
     where connection_id = $1 and id <> $2`,
    [connection, job!.id]
  );
  const [lease] = await db.root<Lease>(
    "select job_id, lease_epoch from public.service_claim_catalog_sync_work('fence', 1, 60)"
  );
  expect(lease?.job_id).toBe(job!.id);
  return lease!;
}

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'fence@example.test' });
  await db.root('insert into public.admin_users(user_id) values ($1)', [owner]);
  const [created] = await db.asUser<{ id: string }>(
    owner,
    "select id from public.create_team('Fence')"
  );
  team = created!.id;
  const [credential] = await db.root<{ id: string }>(
    `insert into private.google_drive_credentials
      (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
     values ('fence', 'fence@example.test', 'https://www.googleapis.com/auth/drive.file', gen_random_uuid(), $1)
     returning id`,
    [owner]
  );
  const [row] = await db.root<{ id: string }>(
    `insert into public.team_drive_connections
      (team_id, credential_id, root_folder_id, root_folder_name, drive_kind, state, change_page_token)
     values ($1, $2, 'root', 'Root', 'my_drive', 'connected', 'token-0') returning id`,
    [team, credential!.id]
  );
  connection = row!.id;
  await db.root(
    `insert into public.team_materials (team_id, connection_id, drive_file_id, name, kind)
     values ($1, $2, 'docs', 'Docs', 'folder'), ($1, $2, 'file-a', 'a.mp4', 'file')`,
    [team, connection]
  );
}, 60_000);

afterAll(async () => db?.close());

describe('fenced replay writes', () => {
  const calls: Array<[string, (lease: Lease, epoch: number) => Promise<unknown>]> = [
    [
      'service_invalidate_landing_renders',
      (l, e) =>
        db.root(
          `select * from public.service_invalidate_landing_renders($1, 'fence', $2::bigint, $3, array['file-a'])`,
          [l.job_id, e, connection]
        )
    ],
    [
      'service_mark_folder_indexed',
      (l, e) =>
        db.root(`select public.service_mark_folder_indexed($1, 'fence', $2::bigint, $3, 'docs')`, [
          l.job_id,
          e,
          connection
        ])
    ],
    [
      'service_mark_root_state',
      (l, e) =>
        db.root(
          `select public.service_mark_root_state($1, 'fence', $2::bigint, $3, 'connected', 'Root')`,
          [l.job_id, e, connection]
        )
    ],
    [
      'service_touch_catalog_reconciled',
      (l, e) =>
        db.root(`select public.service_touch_catalog_reconciled($1, 'fence', $2::bigint, $3)`, [
          l.job_id,
          e,
          connection
        ])
    ],
    [
      'service_enqueue_catalog_reconciliation',
      (l, e) =>
        db.root(
          `select public.service_enqueue_catalog_reconciliation($1, 'fence', $2::bigint, $3)`,
          [l.job_id, e, connection]
        )
    ]
  ];

  it.each(calls)('%s accepts the live lease and refuses a stale epoch', async (_name, call) => {
    const lease = await manualJob(`fence-${_name}`);
    await expect(call(lease, lease.lease_epoch)).resolves.toBeDefined();
    await expect(call(lease, lease.lease_epoch - 1)).rejects.toThrow(/LEASE_LOST/);
    await db.root(
      "update private.catalog_sync_jobs set state = 'pending', lease_owner = null where id = $1",
      [lease.job_id]
    );
  });

  it('the read-only liveness check answers false once the job is stopped', async () => {
    const lease = await manualJob('fence-live');
    const live = (epoch: number) =>
      db.root<{ live: boolean }>(
        "select public.service_catalog_sync_lease_live($1, 'fence', $2::bigint) as live",
        [lease.job_id, epoch]
      );
    expect(await live(lease.lease_epoch)).toEqual([{ live: true }]);
    expect(await live(lease.lease_epoch - 1)).toEqual([{ live: false }]);
    await db.root(
      'update private.catalog_sync_jobs set cancel_requested_at = now() where id = $1',
      [lease.job_id]
    );
    expect(await live(lease.lease_epoch)).toEqual([{ live: false }]);
    await db.root(
      "update private.catalog_sync_jobs set state = 'canceled', lease_owner = null where id = $1",
      [lease.job_id]
    );
  });
});

describe('no progress is counted', () => {
  it('a generation restart increments no_progress_runs, finishing a folder resets it, the tenth retires the job', async () => {
    const lease = await manualJob('docs');
    const begin = (restart: boolean) =>
      db.root<{ generation: string }>(
        `select generation from public.service_begin_catalog_folder($1, 'fence', $2::bigint, 'docs', $3)`,
        [lease.job_id, lease.lease_epoch, restart]
      );
    await begin(false);
    await begin(true);
    await begin(true);
    const runs = async () =>
      (
        await db.root<{ no_progress_runs: number }>(
          'select no_progress_runs from private.catalog_sync_jobs where id = $1',
          [lease.job_id]
        )
      )[0]!.no_progress_runs;
    expect(await runs()).toBe(2);
    const [generation] = await begin(false);
    await db.root(
      `select public.service_commit_catalog_scan_page($1, 'fence', $2::bigint, $3, null, null, '[]'::jsonb, true)`,
      [lease.job_id, lease.lease_epoch, generation!.generation]
    );
    await db.root(`select public.service_finish_catalog_folder($1, 'fence', $2::bigint, $3)`, [
      lease.job_id,
      lease.lease_epoch,
      generation!.generation
    ]);
    expect(await runs()).toBe(0);
    await db.root(
      `update private.catalog_sync_jobs set no_progress_runs = 10, state = 'pending', lease_owner = null,
        lease_expires_at = null, next_attempt_at = now() where id = $1`,
      [lease.job_id]
    );
    expect(
      await db.root("select job_id from public.service_claim_catalog_sync_work('fence2', 1, 60)")
    ).toEqual([]);
    expect(
      await db.root('select state, last_error_code from private.catalog_sync_jobs where id = $1', [
        lease.job_id
      ])
    ).toEqual([{ state: 'failed', last_error_code: 'NO_PROGRESS' }]);
  });
});
