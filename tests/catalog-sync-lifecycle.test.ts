import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import { seedSyncScenario } from './fixtures/catalog-sync';

/**
 * 028 — the manual sync lifecycle (release A).
 *
 * A finished folder scan waits for the canonical incremental job to confirm
 * the next change position. These tests pin down what happens when that job
 * dies, sits in retry backoff, loses its lease, or never existed, and that the
 * repair never needs a second person's click.
 */

const owner = '28000000-0000-4000-8000-000000000001';
const M1 = 'supabase/migrations/20261008100000_sync_orphan_recovery.sql';
let db: TeamTestDb;
let credential: string;
let teamCounter = 0;

async function bootstrap(harness: TeamTestDb): Promise<string> {
  await createUser(harness, { id: owner, email: 'lifecycle@example.test' });
  await harness.root('insert into public.admin_users(user_id) values ($1)', [owner]);
  const [row] = await harness.root<{ id: string }>(
    `insert into private.google_drive_credentials
      (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
     values ('lifecycle', 'lifecycle@example.test', 'https://www.googleapis.com/auth/drive.file',
       gen_random_uuid(), $1) returning id`,
    [owner]
  );
  return row!.id;
}

async function connect(
  harness = db,
  cred = credential
): Promise<{ team: string; connection: string }> {
  teamCounter += 1;
  const [team] = await harness.asUser<{ id: string }>(
    owner,
    'select id from public.create_team($1)',
    [`Lifecycle ${teamCounter}`]
  );
  const [connection] = await harness.root<{ id: string }>(
    `insert into public.team_drive_connections
      (team_id, credential_id, root_folder_id, root_folder_name, drive_kind, state, change_page_token)
     values ($1, $2, 'root', 'Root', 'my_drive', 'connected', 'token-0') returning id`,
    [team!.id, cred]
  );
  return { team: team!.id, connection: connection!.id };
}

/** Only the given connection's jobs may be claimed during one test. */
async function freezeOthers(connection: string): Promise<void> {
  await db.root(
    `update private.catalog_sync_jobs set next_attempt_at = now() + interval '1 day'
     where connection_id <> $1 and state in ('pending', 'retry', 'leased')`,
    [connection]
  );
}

type Claim = { job_id: string; lease_epoch: number };
const claim = (worker: string) =>
  db.root<Claim>(
    'select job_id, lease_epoch from public.service_claim_catalog_sync_work($1, 1, 60)',
    [worker]
  );

type JobRow = {
  id: string;
  state: string;
  job_kind: string;
  attempts: number;
  lease_lost_count: number;
  last_error_code: string | null;
  error_detail: string | null;
  replay_after: number | null;
  scan_completed_at: string | null;
  next_attempt_at: string;
};
const job = async (id: string) =>
  (
    await db.root<JobRow>(
      `select id, state, job_kind, attempts, lease_lost_count, last_error_code, error_detail,
        replay_after, scan_completed_at, next_attempt_at
       from private.catalog_sync_jobs where id = $1`,
      [id]
    )
  )[0]!;
const canonicalOf = (connection: string) =>
  db.root<JobRow & { created_at: string }>(
    `select id, state, job_kind, attempts, lease_lost_count, last_error_code, error_detail,
      replay_after, scan_completed_at, next_attempt_at, created_at
     from private.catalog_sync_jobs where connection_id = $1 and job_kind = 'incremental'
     order by created_at`,
    [connection]
  );

beforeAll(async () => {
  db = await createTeamTestDb();
  credential = await bootstrap(db);
}, 60_000);

afterAll(async () => db?.close());

describe('a waiter whose canonical job dies', () => {
  it('canonical non-retryable terminal failure marks waiters failed with CANONICAL_FAILED and error_detail', async () => {
    const { team, connection } = await connect();
    const seeded = await seedSyncScenario(db, connection, 'waiter-canonical-retry');
    await db.root(
      "update private.catalog_sync_jobs set state = 'pending', next_attempt_at = now() where id = $1",
      [seeded.canonical]
    );
    await freezeOthers(connection);
    const [lease] = await claim('feed');
    expect(lease?.job_id).toBe(seeded.canonical);
    const [saved] = await db.root<{ ok: boolean }>(
      `select public.service_retry_catalog_sync_job($1, 'feed', $2::bigint, 'NEEDS_REAUTH', now(), true) as ok`,
      [lease!.job_id, lease!.lease_epoch]
    );
    expect(saved?.ok).toBe(true);
    const waiter = await job(seeded.job);
    expect(waiter.state).toBe('failed');
    expect(waiter.last_error_code).toBe('CANONICAL_FAILED');
    expect(waiter.error_detail).toBe('NEEDS_REAUTH');
    expect(
      await db.root('select initial_sync_state from public.team_drive_connections where id = $1', [
        connection
      ])
    ).toEqual([{ initial_sync_state: 'failed' }]);
    // The web still on 1.2.5 reads this through the three-value projection.
    expect(
      await db.asUser(owner, 'select status from public.get_team_folder_resync_status($1, $2)', [
        team,
        seeded.job
      ])
    ).toEqual([{ status: 'failed' }]);
  });

  it('retryable exhaustion inserts a new canonical, bumps recovery_count and leaves waiters pending', async () => {
    const { connection } = await connect();
    const seeded = await seedSyncScenario(db, connection, 'waiter-canonical-retry');
    await db.root(
      `update private.catalog_sync_jobs set state = 'pending', attempts = 9, next_attempt_at = now()
       where id = $1`,
      [seeded.canonical]
    );
    await freezeOthers(connection);
    const [lease] = await claim('feed');
    expect(lease?.job_id).toBe(seeded.canonical);
    await db.root(
      `select public.service_retry_catalog_sync_job($1, 'feed', $2::bigint, 'DRIVE_UNAVAILABLE', now(), false)`,
      [lease!.job_id, lease!.lease_epoch]
    );
    const canonicals = await canonicalOf(connection);
    expect(canonicals.map(row => row.state)).toEqual(['failed', 'pending']);
    expect(canonicals[0]!.last_error_code).toBe('DRIVE_UNAVAILABLE');
    expect(new Date(canonicals[1]!.next_attempt_at).getTime()).toBeGreaterThan(
      Date.now() + 4 * 60_000
    );
    expect((await job(seeded.job)).state).toBe('pending');
    expect(
      await db.root(
        'select recovery_count from private.catalog_sync_authority where connection_id = $1',
        [connection]
      )
    ).toEqual([{ recovery_count: 1 }]);
  });

  it('sixth recovery within 24h is treated as non-retryable', async () => {
    const { connection } = await connect();
    const seeded = await seedSyncScenario(db, connection, 'waiter-canonical-retry');
    await db.root(
      `update private.catalog_sync_authority set recovery_count = 6, last_recovery_at = now()
       where connection_id = $1`,
      [connection]
    );
    await db.root(
      `update private.catalog_sync_jobs set state = 'pending', attempts = 9, next_attempt_at = now()
       where id = $1`,
      [seeded.canonical]
    );
    await freezeOthers(connection);
    const [lease] = await claim('feed');
    await db.root(
      `select public.service_retry_catalog_sync_job($1, 'feed', $2::bigint, 'DRIVE_UNAVAILABLE', now(), false)`,
      [lease!.job_id, lease!.lease_epoch]
    );
    expect((await canonicalOf(connection)).map(row => row.state)).toEqual(['failed']);
    const waiter = await job(seeded.job);
    expect(waiter.state).toBe('failed');
    expect(waiter.last_error_code).toBe('CANONICAL_FAILED');
    expect(waiter.error_detail).toBe('DRIVE_UNAVAILABLE');
  });
});

describe('a manual request does not wait for feed backoff', () => {
  it('finite completion pulls a retrying canonical forward and stamps scan_completed_at', async () => {
    const { connection } = await connect();
    const seeded = await seedSyncScenario(db, connection, 'waiter-canonical-retry');
    // Put the finite job back in front of the barrier so a worker can finish it.
    await db.root(
      `update private.catalog_sync_jobs set state = 'pending', phase = 'initial_scan',
        replay_after = null, scan_completed_at = null, next_attempt_at = now() where id = $1`,
      [seeded.job]
    );
    await freezeOthers(connection);
    await db.root(
      `update private.catalog_sync_jobs set next_attempt_at = now() + interval '14 minutes'
       where id = $1`,
      [seeded.canonical]
    );
    const [lease] = await claim('scan');
    expect(lease?.job_id).toBe(seeded.job);
    const [done] = await db.root<{ ok: boolean }>(
      `select public.service_complete_catalog_sync_job($1, 'scan', $2::bigint, 'finite-token') as ok`,
      [lease!.job_id, lease!.lease_epoch]
    );
    expect(done?.ok).toBe(true);
    const waiter = await job(seeded.job);
    expect(waiter.state).toBe('pending');
    expect(waiter.replay_after).not.toBeNull();
    expect(waiter.scan_completed_at).not.toBeNull();
    const [canonical] = await canonicalOf(connection);
    expect(canonical!.state).toBe('retry');
    expect(new Date(canonical!.next_attempt_at).getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it('folder and root request RPCs pull a retrying canonical forward', async () => {
    const { team, connection } = await connect();
    await db.root(
      `insert into public.team_materials (team_id, connection_id, drive_file_id, name, kind)
       values ($1, $2, 'docs', 'Docs', 'folder')`,
      [team, connection]
    );
    const seeded = await seedSyncScenario(db, connection, 'waiter-canonical-retry');
    const retrying = async () =>
      db.root(
        `update private.catalog_sync_jobs set state = 'retry', next_attempt_at = now() + interval '14 minutes'
         where id = $1`,
        [seeded.canonical]
      );
    const pulled = async () =>
      new Date((await job(seeded.canonical!)).next_attempt_at).getTime() <= Date.now() + 1_000;

    await retrying();
    const [folder] = await db.asUser<{ sync_job_id: string }>(
      owner,
      "select sync_job_id from public.request_team_folder_resync($1, 'docs')",
      [team]
    );
    expect(folder?.sync_job_id).toBeTruthy();
    expect(await pulled()).toBe(true);

    await retrying();
    const [root] = await db.asUser<{ sync_job_id: string }>(
      owner,
      'select sync_job_id from public.request_team_catalog_resync($1)',
      [team]
    );
    expect(root?.sync_job_id).toBeTruthy();
    expect(await pulled()).toBe(true);
  });
});

describe('expired leases count as failures', () => {
  it('claiming an expired lease increments attempts and lease_lost_count', async () => {
    const { connection } = await connect();
    const seeded = await seedSyncScenario(db, connection, 'leased-expired');
    await freezeOthers(connection);
    await db.root(
      "update private.catalog_sync_jobs set next_attempt_at = now() + interval '1 day' where id = $1",
      [seeded.canonical]
    );
    const [lease] = await claim('next');
    expect(lease?.job_id).toBe(seeded.job);
    const row = await job(seeded.job);
    expect(row.state).toBe('leased');
    expect(row.attempts).toBe(1);
    expect(row.lease_lost_count).toBe(1);
  });

  it('tenth expired-lease reclaim retires the job as LEASE_LOST_EXHAUSTED', async () => {
    const { connection } = await connect();
    const seeded = await seedSyncScenario(db, connection, 'leased-expired');
    await db.root('update private.catalog_sync_jobs set attempts = 9 where id = $1', [seeded.job]);
    await freezeOthers(connection);
    await db.root(
      "update private.catalog_sync_jobs set next_attempt_at = now() + interval '1 day' where id = $1",
      [seeded.canonical]
    );
    expect(await claim('next')).toEqual([]);
    const row = await job(seeded.job);
    expect(row.state).toBe('failed');
    expect(row.last_error_code).toBe('LEASE_LOST_EXHAUSTED');
    expect(row.lease_lost_count).toBe(1);
  });

  it('invoke gate ignores replay waiters', async () => {
    const { connection } = await connect();
    await seedSyncScenario(db, connection, 'waiter-canonical-missing');
    await freezeOthers(connection);
    // Leases from earlier tests must not satisfy the "three live leases" exit.
    await db.root(
      "update private.catalog_sync_jobs set lease_expires_at = now() - interval '1 second' where state = 'leased'"
    );
    // Only this waiter is runnable-looking; without the gate the cron would
    // read Vault (absent here) and raise CATALOG_SYNC_CONFIG_INVALID.
    expect(await db.root('select private.invoke_catalog_sync_worker() as request')).toEqual([
      { request: null }
    ]);
  });
});

describe('the sweeper repairs orphans without anyone clicking', () => {
  it('creates a canonical for a waiter orphaned longer than 2 minutes', async () => {
    const { connection } = await connect();
    await seedSyncScenario(db, connection, 'waiter-canonical-missing');
    const [result] = await db.root<{ sweep: { canonical_created: number } }>(
      'select private.sweep_catalog_sync_orphans(200) as sweep'
    );
    expect(result!.sweep.canonical_created).toBeGreaterThanOrEqual(1);
    const canonicals = await canonicalOf(connection);
    expect(canonicals.map(row => row.state)).toEqual(['canceled', 'pending']);
  });

  it('leaves a fresh waiter alone for its first two minutes', async () => {
    const { connection } = await connect();
    await seedSyncScenario(db, connection, 'waiter-canonical-missing', {
      scanCompletedAgo: '30 seconds'
    });
    await db.root('select private.sweep_catalog_sync_orphans(200)');
    expect((await canonicalOf(connection)).map(row => row.state)).toEqual(['canceled']);
  });

  it('fails a waiter 60 minutes after scan_completed_at with REPLAY_TIMEOUT', async () => {
    const { connection } = await connect();
    const seeded = await seedSyncScenario(db, connection, 'waiter-canonical-missing', {
      scanCompletedAgo: '61 minutes'
    });
    const [result] = await db.root<{ sweep: { replay_timeout: number } }>(
      'select private.sweep_catalog_sync_orphans(200) as sweep'
    );
    expect(result!.sweep.replay_timeout).toBeGreaterThanOrEqual(1);
    const row = await job(seeded.job);
    expect(row.state).toBe('failed');
    expect(row.last_error_code).toBe('REPLAY_TIMEOUT');
  });

  it('cancels jobs of detached connections', async () => {
    const { connection } = await connect();
    const seeded = await seedSyncScenario(db, connection, 'detached');
    await db.root('select private.sweep_catalog_sync_orphans(200)');
    const row = await job(seeded.job);
    expect(row.state).toBe('canceled');
    expect(row.last_error_code).toBe('CONNECTION_DETACHED');
    expect((await job(seeded.canonical!)).state).toBe('canceled');
  });

  it('respects p_limit and runs from the retention maintenance entry point', async () => {
    const { connection } = await connect();
    await seedSyncScenario(db, connection, 'detached', { folder: 'a' });
    const [limited] = await db.root<{ sweep: { detached: number } }>(
      'select private.sweep_catalog_sync_orphans(1) as sweep'
    );
    expect(limited!.sweep.detached).toBe(1);
    const [maintenance] = await db.root<{ run: Record<string, unknown> }>(
      'select private.run_catalog_sync_maintenance() as run'
    );
    expect(maintenance!.run).toHaveProperty('sweep');
    expect(maintenance!.run).toHaveProperty('retention');
    // The PGlite cron stub keeps no command text; pgTAP checks the live schedule.
    expect(
      await db.root(
        "select count(*)::int as defined from pg_proc where proname = 'run_catalog_sync_maintenance'"
      )
    ).toEqual([{ defined: 1 }]);
  });
});

describe('the migration repairs rows that were already stuck', () => {
  it('applying the migration repairs pre-existing stuck rows without deleting catalog rows', async () => {
    const older = await createTeamTestDb({
      throughMigration: '20261006120000_manual_root_resync_status.sql'
    });
    try {
      const cred = await bootstrap(older);
      const orphan = await connect(older, cred);
      const expired = await connect(older, cred);
      const detached = await connect(older, cred);
      await older.root(
        `insert into public.team_materials (team_id, connection_id, drive_file_id, name, kind)
         values ($1, $2, 'kept', 'Kept', 'file')`,
        [orphan.team, orphan.connection]
      );
      const orphanSeed = await seedSyncScenario(
        older,
        orphan.connection,
        'waiter-canonical-missing'
      );
      const expiredSeed = await seedSyncScenario(older, expired.connection, 'leased-expired');
      const detachedSeed = await seedSyncScenario(older, detached.connection, 'detached');

      await older.db.exec(readFileSync(M1, 'utf8'));

      const state = async (id: string) =>
        (
          await older.root<{ state: string; attempts: number; last_error_code: string | null }>(
            'select state, attempts, last_error_code from private.catalog_sync_jobs where id = $1',
            [id]
          )
        )[0]!;
      expect((await state(orphanSeed.job)).state).toBe('pending');
      expect(
        await older.root(
          `select count(*)::int as live from private.catalog_sync_jobs
           where connection_id = $1 and job_kind = 'incremental' and state = 'pending'`,
          [orphan.connection]
        )
      ).toEqual([{ live: 1 }]);
      const reclaimed = await state(expiredSeed.job);
      expect(reclaimed.state).toBe('pending');
      expect(reclaimed.attempts).toBe(1);
      expect((await state(detachedSeed.job)).last_error_code).toBe('CONNECTION_DETACHED');
      expect(
        await older.root(
          'select count(*)::int as rows from public.team_materials where team_id = $1',
          [orphan.team]
        )
      ).toEqual([{ rows: 1 }]);
      expect(
        await older.root(
          'select confirmed_cursor from private.catalog_sync_authority where connection_id = $1',
          [orphan.connection]
        )
      ).toEqual([{ confirmed_cursor: null }]);
    } finally {
      await older.close();
    }
  }, 60_000);
});

describe('a browser can find the job it lost the answer for', () => {
  it('find_team_folder_sync_request returns the latest job of the scope within 30 minutes for a member and null otherwise', async () => {
    const { team, connection } = await connect();
    const seeded = await seedSyncScenario(db, connection, 'waiter-canonical-retry', {
      folder: 'docs'
    });
    expect(
      await db.asUser(
        owner,
        "select sync_job_id, state from public.find_team_folder_sync_request($1, 'docs')",
        [team]
      )
    ).toEqual([{ sync_job_id: seeded.job, state: 'pending' }]);
    expect(
      await db.asUser(
        owner,
        "select sync_job_id from public.find_team_folder_sync_request($1, 'other')",
        [team]
      )
    ).toEqual([]);
    await db.root(
      "update private.catalog_sync_jobs set created_at = now() - interval '31 minutes' where id = $1",
      [seeded.job]
    );
    expect(
      await db.asUser(
        owner,
        "select sync_job_id from public.find_team_folder_sync_request($1, 'docs')",
        [team]
      )
    ).toEqual([]);
    await expect(
      db.asUser(null, "select sync_job_id from public.find_team_folder_sync_request($1, 'docs')", [
        team
      ])
    ).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it('get_team_folder_sync_status returns root scans with scope __root__ and lastProgressAt', async () => {
    const { team, connection } = await connect();
    const [root] = await db.asUser<{ sync_job_id: string }>(
      owner,
      'select sync_job_id from public.request_team_catalog_resync($1)',
      [team]
    );
    const [status] = await db.asUser<{ status: Record<string, unknown> }>(
      owner,
      'select public.get_team_folder_sync_status($1, $2) as status',
      [team, root!.sync_job_id]
    );
    expect(status!.status).toMatchObject({
      jobId: root!.sync_job_id,
      scopeFolderId: '__root__',
      state: 'queued',
      phase: 'listing'
    });
    expect(status!.status).toHaveProperty('lastProgressAt');
    expect(
      await db.asUser(
        owner,
        'select sync_job_id from public.find_team_folder_sync_request($1, null)',
        [team]
      )
    ).toEqual([{ sync_job_id: root!.sync_job_id }]);
    void connection;
  });
});
