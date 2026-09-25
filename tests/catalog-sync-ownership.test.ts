import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

const owner = '26000000-0000-4000-8000-000000000001';
let db: TeamTestDb;
let connection: string;

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'sync-owner@example.test' });
  await db.root('insert into public.admin_users(user_id) values ($1)', [owner]);
  const [team] = await db.asUser<{ id: string }>(
    owner,
    "select id from public.create_team('Sync ownership')"
  );
  const [credential] = await db.root<{ id: string }>(
    `insert into private.google_drive_credentials
    (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
    values ('sync-owner', 'sync-owner@example.test', 'https://www.googleapis.com/auth/drive.file',
      gen_random_uuid(), $1) returning id`,
    [owner]
  );
  const [row] = await db.root<{ id: string }>(
    `insert into public.team_drive_connections
    (team_id, credential_id, root_folder_id, root_folder_name, drive_kind, state)
    values ($1, $2, 'root', 'Root', 'my_drive', 'connected') returning id`,
    [team!.id, credential!.id]
  );
  connection = row!.id;
}, 60_000);

afterAll(async () => db?.close());

describe('catalog sync ownership', () => {
  it('creates exactly one canonical cursor owner while keeping scans finite', async () => {
    await db.root(
      `select private.enqueue_catalog_sync($1, 'initial_scan',
      '{"changePageToken":"opaque/bootstrap"}', '["root"]')`,
      [connection]
    );
    await db.root(`select private.enqueue_catalog_sync($1, 'initial_scan', '{}', '["child"]')`, [
      connection
    ]);
    const jobs = await db.root<{ job_kind: string }>(
      'select job_kind from private.catalog_sync_jobs where connection_id = $1',
      [connection]
    );
    expect(jobs.filter(job => job.job_kind === 'incremental')).toHaveLength(1);
    expect(jobs.filter(job => job.job_kind === 'initial')).toHaveLength(2);
  });

  it('leases at most one job per connection even in a batch; stale epochs cannot write', async () => {
    const claimed = await db.root<{ id: string; lease_epoch: number }>(
      "select id, lease_epoch from private.claim_catalog_sync_jobs('first', 3, 60)"
    );
    expect(claimed).toHaveLength(1);
    const job = claimed[0]!;
    expect(
      await db.root("select id from private.claim_catalog_sync_jobs('second', 3, 60)")
    ).toEqual([]);
    expect(
      await db.root<{ valid: boolean }>(
        "select private.lock_catalog_sync_lease($1, 'first', $2) as valid",
        [job.id, job.lease_epoch]
      )
    ).toEqual([{ valid: true }]);
    await db.root(
      "update private.catalog_sync_jobs set lease_expires_at = now() - interval '1 second' where id = $1",
      [job.id]
    );
    expect(
      await db.root<{ valid: boolean }>(
        "select private.lock_catalog_sync_lease($1, 'first', $2) as valid",
        [job.id, job.lease_epoch]
      )
    ).toEqual([{ valid: false }]);
    const next = await db.root<{ lease_epoch: number }>(
      "select lease_epoch from private.claim_catalog_sync_jobs('second', 3, 60)"
    );
    expect(next).toHaveLength(1);
    expect(next[0]!.lease_epoch).toBeGreaterThan(job.lease_epoch);
    expect(
      await db.root(
        "select public.service_retry_catalog_sync_job($1, 'first', $2, 'LATE_FAILURE', now(), true) as saved",
        [job.id, job.lease_epoch]
      )
    ).toEqual([{ saved: false }]);
    await db.root(
      "update private.catalog_sync_jobs set state = 'pending', lease_owner = null, lease_expires_at = null, next_attempt_at = now()"
    );
  });

  it('waits for canonical replay and never commits a finite job token', async () => {
    const [finite] = await db.root<{ id: string }>(
      `select id from private.catalog_sync_jobs
      where connection_id = $1 and job_kind = 'initial' order by created_at limit 1`,
      [connection]
    );
    await db.root(
      `update private.catalog_sync_jobs set next_attempt_at = now() + interval '1 hour'
      where id <> $1`,
      [finite!.id]
    );
    await db.root("select id from private.claim_catalog_sync_jobs('scan', 1, 60)");
    expect(
      await db.root<{ saved: boolean }>(
        "select public.service_complete_catalog_sync_job($1, 'scan', 'finite-must-not-win') as saved",
        [finite!.id]
      )
    ).toEqual([{ saved: true }]);
    expect(
      await db.root<{ state: string; replay_after: number }>(
        'select state, replay_after from private.catalog_sync_jobs where id = $1',
        [finite!.id]
      )
    ).toEqual([{ state: 'pending', replay_after: 1 }]);
    expect(
      await db.root<{ change_page_token: string | null }>(
        'select change_page_token from public.team_drive_connections where id = $1',
        [connection]
      )
    ).toEqual([{ change_page_token: null }]);
    const [canonical] = await db.root<{ id: string }>(
      "select id from private.claim_catalog_sync_jobs('feed', 1, 60)"
    );
    expect(canonical).toBeDefined();
    await db.root(
      "select public.service_complete_catalog_sync_job($1, 'feed', 'confirmed/opaque')",
      [canonical!.id]
    );
    expect(
      await db.root<{ state: string }>(
        'select state from private.catalog_sync_jobs where id = $1',
        [finite!.id]
      )
    ).toEqual([{ state: 'succeeded' }]);
    expect(
      await db.root<{ confirmed_cursor: string; confirmed_sequence: number }>(
        'select confirmed_cursor, confirmed_sequence from private.catalog_sync_authority where connection_id = $1',
        [connection]
      )
    ).toEqual([{ confirmed_cursor: 'confirmed/opaque', confirmed_sequence: 1 }]);
  });

  it('keeps lifetime claims separate from consecutive failures after 1,005 runs', async () => {
    await db.root(
      `update private.catalog_sync_jobs set next_attempt_at = now() + interval '1 day'`
    );
    await db.root(`do $$ declare canonical uuid; claimed uuid; begin
      select id into canonical from private.catalog_sync_jobs where connection_id = '${connection}'
        and job_kind = 'incremental' and state = 'pending';
      update private.catalog_sync_jobs set run_count = 1005 where id = canonical;
      for i in 1..5 loop
        update private.catalog_sync_jobs set next_attempt_at = clock_timestamp() where id = canonical;
        select id into claimed from private.claim_catalog_sync_jobs('no-change', 1, 60);
        if claimed is distinct from canonical then raise exception 'LOST_CANONICAL'; end if;
        perform public.service_complete_catalog_sync_job(canonical, 'no-change', 'same-opaque-token');
      end loop;
    end $$`);
    expect(
      await db.root(
        "select state, attempts, run_count from private.catalog_sync_jobs where connection_id = $1 and job_kind = 'incremental'",
        [connection]
      )
    ).toEqual([{ state: 'pending', attempts: 0, run_count: 1010 }]);
  });
  it('allows a connection cascade without discarding a cursor on its own', async () => {
    await expect(
      db.root(
        "delete from private.catalog_sync_jobs where connection_id = $1 and job_kind = 'incremental'",
        [connection]
      )
    ).rejects.toThrow(/foreign key constraint/);
    await db.root('delete from public.team_drive_connections where id = $1', [connection]);
    expect(
      await db.root(
        'select connection_id from private.catalog_sync_authority where connection_id = $1',
        [connection]
      )
    ).toEqual([]);
  });
});
